// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const artifact = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";
const worker = artifact("deploy/systemd/melon-inspiration-concept-worker.service");
const web = artifact("deploy/systemd/melon-web.service");
const override = artifact("deploy/systemd/optional/90-concept-worker-flags.conf");
const probe = artifact("deploy/systemd/optional/99-concept-worker-flags-check.conf");
const sharedPath = "/etc/melon/web.env";
const flagsPath = "/etc/melon/concept-worker-flags.env";
const files = new Map([
  [sharedPath, "INSPIRATION_CONCEPT_IMAGES_ENABLED=false\nINSPIRATION_CONCEPT_RELEASE_APPROVED=false\nDATABASE_URL=postgres://private-secret@unreachable/db\nDASHSCOPE_API_KEY=private-secret\n"],
  [flagsPath, artifact("deploy/systemd/optional/concept-worker-flags.env")],
]);

// Evaluate only the simple, unquoted assignment subset shipped by these artifacts.
// EnvironmentFile has higher precedence than every Environment assignment; later files win.
// This is a deterministic artifact contract, not a substitute for target systemd verification.
function assignment(line: string): [string, string] {
  const match = /^([A-Z_][A-Z_0-9]*)=([^\s"'\\]*)$/.exec(line);
  if (!match) throw Error("Unsupported environment assignment");
  return [match[1]!, match[2]!];
}
function configuration(units: string[], environmentFiles = files) {
  const inline: Record<string, string> = {};
  let paths: string[] = [], commands: string[] = [];
  const service: Record<string, string> = {};
  for (const unit of units) {
    let section = "";
    for (const line of unit.split(/\r?\n/).map((value) => value.trim())) {
      if (!line || /^[#;]/.test(line)) continue;
      if (line.startsWith("[")) { section = line; continue; }
      if (section !== "[Service]") continue;
      const separator = line.indexOf("=");
      if (separator < 1) throw Error("Invalid unit directive");
      const key = line.slice(0, separator), value = line.slice(separator + 1);
      if (key === "Environment") {
        if (!value) Object.keys(inline).forEach((name) => delete inline[name]);
        else { const [name, setting] = assignment(value); inline[name] = setting; }
      } else if (key === "EnvironmentFile") paths = value ? [...paths, value] : [];
      else if (key === "ExecStart") commands = value ? [...commands, value] : [];
      else service[key] = value;
    }
  }
  const env = { ...inline };
  for (const path of paths) {
    const optional = path.startsWith("-"), name = optional ? path.slice(1) : path;
    const content = environmentFiles.get(name);
    if (content === undefined) { if (optional) continue; throw Error("Required environment file missing"); }
    for (const line of content.split(/\r?\n/).map((value) => value.trim())) {
      if (!line || line.startsWith("#")) continue;
      const [key, value] = assignment(line); env[key] = value;
    }
  }
  return { env, paths, commands, service };
}
function runProbe(env: Record<string, string>, extraArgs: string[] = []) {
  const merged = configuration([worker, override, probe]);
  // Never execute an application worker/provider path, even if the probe reset regresses.
  expect(merged.commands).toEqual(["/usr/bin/node /opt/melon/current/scripts/check-inspiration-concept-worker-flags.mjs"]);
  expect(merged.service).toMatchObject({ Type: "oneshot", Restart: "no" });
  const script = merged.commands[0]!.split(" ")[1]!.replace("/opt/melon/current/", "");
  return spawnSync(process.execPath, [resolve(script), ...extraArgs], { env: { ...env, NODE_ENV: "production" }, encoding: "utf8", timeout: 5000 });
}

describe("shipped concept worker systemd override", () => {
  it("overrides shared false flags with the later worker file, unlike an inline Environment drop-in", () => {
    const ineffective = configuration([worker, "[Service]\nEnvironment=INSPIRATION_CONCEPT_IMAGES_ENABLED=true\nEnvironment=INSPIRATION_CONCEPT_RELEASE_APPROVED=true"]);
    expect(ineffective.env.INSPIRATION_CONCEPT_IMAGES_ENABLED).toBe("false");
    const effective = configuration([worker, override]);
    expect(effective.env.INSPIRATION_CONCEPT_IMAGES_ENABLED).toBe("true");
    expect(effective.env.INSPIRATION_CONCEPT_RELEASE_APPROVED).toBe("true");
    expect(effective.env.DATABASE_URL).toBe("postgres://private-secret@unreachable/db");
  });
  it("keeps the public web disabled and returns worker to shared flags after removal", () => {
    expect(configuration([web]).env.INSPIRATION_CONCEPT_IMAGES_ENABLED).toBe("false");
    expect(configuration([worker]).env.INSPIRATION_CONCEPT_IMAGES_ENABLED).toBe("false");
    expect(configuration([worker, override]).paths).toEqual([sharedPath, flagsPath]);
  });
  it("fails closed when the approved override file is missing", () => {
    const missing = new Map(files); missing.delete(flagsPath);
    expect(() => configuration([worker, override], missing)).toThrow("Required environment file missing");
  });
  it("executes the merged probe without importing application services or printing secrets", () => {
    const child = runProbe(configuration([worker, override, probe]).env);
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('{"conceptImagesEnabled":true,"releaseApproved":true}');
    expect(child.stderr).toBe("");
  });
  it("fails for ineffective flags, missing flags and unsupported arguments with bounded output", () => {
    const cases = [
      { env: configuration([worker]).env, want: { conceptImagesEnabled: false, releaseApproved: false } },
      { env: { DATABASE_URL: "private-secret" }, want: { conceptImagesEnabled: false, releaseApproved: false } },
      { env: { INSPIRATION_CONCEPT_IMAGES_ENABLED: "true", INSPIRATION_CONCEPT_RELEASE_APPROVED: "false" }, want: { conceptImagesEnabled: true, releaseApproved: false } },
      { env: { INSPIRATION_CONCEPT_IMAGES_ENABLED: "false", INSPIRATION_CONCEPT_RELEASE_APPROVED: "true" }, want: { conceptImagesEnabled: false, releaseApproved: true } },
    ];
    for (const { env, want } of cases) {
      const child = runProbe(env);
      expect(child.status).toBe(1);
      expect(JSON.parse(child.stdout)).toEqual(want);
      expect(child.stderr).toBe("");
    }
    const child = runProbe(configuration([worker, override]).env, ["private-argument"]);
    expect(child.status).toBe(1); expect(child.stdout.trim()).toBe('{"status":"invalid_arguments"}'); expect(child.stderr).toBe("");
  });
});

// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";

import { parseInspirationConfigCsv, upsertEnv } from "./import-inspiration-config";

const secret = "sk-test-secret";
const host = "ws-test.cn-beijing.maas.aliyuncs.com";
const csv = ["id,8268389", `apiKey,${secret}`, `openAiCompatible,https://${host}/compatible-mode/v1`, `dashScope,https://${host}/api/v1`, "workspaceId,ws-test"].join("\n");
const dirs: string[] = [];
const script = path.resolve("scripts/import-inspiration-config.ts");
const tsx = path.resolve("node_modules/tsx/dist/loader.mjs");
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "melon-config-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "input.csv"), csv);
  return dir;
}
function cli(dir: string, args = ["input.csv"]) {
  return spawnSync(process.execPath, ["--import", tsx, script, ...args], { cwd: dir, encoding: "utf8" });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("inspiration CSV import", () => {
  it("maps the five environment settings", () => {
    expect(parseInspirationConfigCsv(csv)).toEqual({
      INSPIRATION_ENABLED: "true", DASHSCOPE_API_KEY: secret,
      DASHSCOPE_OPENAI_BASE_URL: `https://${host}/compatible-mode/v1`,
      DASHSCOPE_NATIVE_BASE_URL: `https://${host}/api/v1`, DASHSCOPE_WORKSPACE_ID: "ws-test",
    });
  });
  it("accepts BOM, CRLF, quoted cells and escaped quotes", () => {
    const quoted = '\uFEFF' + csv.split("\n").map((line) => line.split(",").map((cell) => `"${cell}"`).join(",")).join("\r\n") + '\r\n';
    expect(parseInspirationConfigCsv(quoted).DASHSCOPE_API_KEY).toBe(secret);
    expect(() => parseInspirationConfigCsv(csv.replace("8268389", '"with ""quotes"", comma"'))).not.toThrow();
  });
  it("accepts export metadata without treating it as configuration", () => {
    expect(parseInspirationConfigCsv(csv + "\nmetadata,ignored").DASHSCOPE_API_KEY).toBe(secret);
    expect(() => parseInspirationConfigCsv(csv + "\nmetadata,one\nmetadata,two")).toThrow();
  });
  it.each(["apiKey", "openAiCompatible", "dashScope", "workspaceId", "id"])("rejects missing %s", (label) => {
    expect(() => parseInspirationConfigCsv(csv.split("\n").filter((line) => !line.startsWith(`${label},`)).join("\n"))).toThrow();
  });
  it.each([
    csv + "\napiKey,other", csv.replace(secret, ""), csv + "\nbroken", csv.replace(secret, '"unterminated'),
    csv.replace(secret, '"line\nvalue"'), csv.replace(secret, '"line\rvalue"'), csv.replace(secret, "a\0b"), csv.replace(secret, "x".repeat(65536)),
    csv.replace(secret, "a,b"), csv.replace(secret, '"a"garbage'),
  ])("rejects malformed, incomplete, duplicate, multiline or oversized input %#", (input) => {
    expect(() => parseInspirationConfigCsv(input)).toThrow();
  });
  it.each([
    `http://${host}/compatible-mode/v1`, `https://evil.test/compatible-mode/v1`,
    `https://ws-test.evilmaas.aliyuncs.com/compatible-mode/v1`,
    `https://user:password@${host}/compatible-mode/v1`, `https://@${host}/compatible-mode/v1`,
    `https://${host}/compatible-mode/v1?secret`, `https://${host}/compatible-mode/v1#secret`,
    `https://${host}/compatible-mode/v1?`, `https://${host}/wrong`,
    "https://other.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    `https://${host}:8443/compatible-mode/v1`, `https://${host}/a/../compatible-mode/v1`,
  ])("rejects unsafe provider URL %#", (url) => {
    expect(() => parseInspirationConfigCsv(csv.replace(`https://${host}/compatible-mode/v1`, url))).toThrow();
  });
  it("rejects different native hosts and wrong native paths", () => {
    expect(() => parseInspirationConfigCsv(csv.replace(`https://${host}/api/v1`, "https://ws-test.cn-shanghai.maas.aliyuncs.com/api/v1"))).toThrow();
    expect(() => parseInspirationConfigCsv(csv.replace("/api/v1", "/chat/completions"))).toThrow();
  });
  it("preserves unrelated settings, multiline values, comments and order while replacing duplicates", () => {
    const original = '# keep\r\nDATABASE_URL=postgres://example\r\nKEY="line\r\nDASHSCOPE_API_KEY=not-an-assignment\r\nend"\r\nexport DASHSCOPE_API_KEY=old # old\r\nKEEP=yes\r\nDASHSCOPE_API_KEY=duplicate\r\n';
    const updated = upsertEnv(original, parseInspirationConfigCsv(csv));
    expect(updated.startsWith('# keep\r\nDATABASE_URL=postgres://example\r\nKEY="line\r\nDASHSCOPE_API_KEY=not-an-assignment\r\nend"\r\n')).toBe(true);
    expect(parseEnv(updated).DASHSCOPE_API_KEY).toBe(secret);
    expect(updated).not.toContain("duplicate");
    expect(updated.indexOf(`DASHSCOPE_API_KEY=${secret}`)).toBeLessThan(updated.indexOf("KEEP=yes"));
    expect(upsertEnv(updated, parseInspirationConfigCsv(csv))).toBe(updated);
  });
  it("round trips env-sensitive characters without interpolation", () => {
    const values = parseInspirationConfigCsv(csv.replace(secret, '"key # with = commas, quote"""'));
    expect(parseEnv(upsertEnv("", values)).DASHSCOPE_API_KEY).toBe('key # with = commas, quote"');
    expect(() => parseInspirationConfigCsv(csv.replace(secret, "$INTERPOLATED"))).toThrow();
  });
  it("writes mode 0600 atomically and prints only a fixed success message", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, ".env.local"), "# preserved\nDATABASE_URL=postgres://example\n");
    const result = cli(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Configured INSPIRATION_ENABLED and DASHSCOPE_* in .env.local\n");
    expect(result.stderr).toBe("");
    const target = path.join(dir, ".env.local");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain("# preserved\nDATABASE_URL=postgres://example\n");
    expect(readdirSync(dir).sort()).toEqual([".env.local", "input.csv"]);
  });
  it.each([{ args: [] }, { args: ["input.csv", "extra"] }, { args: ["missing.csv"] }])("rejects invalid invocation without disclosing values %#", ({ args }) => {
    const dir = sandbox(); const result = cli(dir, args);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Configuration (usage|input|write) error\n$/);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(dir);
  });
  it("rejects symbolic links without modifying their target or leaving temporary files", () => {
    const dir = sandbox(); const target = path.join(dir, "private");
    writeFileSync(target, "unchanged"); symlinkSync(target, path.join(dir, ".env.local"));
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration write error\n");
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    expect(readdirSync(dir).sort()).toEqual([".env.local", "input.csv", "private"]);
  });
  it("leaves an existing target intact when CSV validation fails", () => {
    const dir = sandbox(); writeFileSync(path.join(dir, "input.csv"), `apiKey,${secret}`);
    writeFileSync(path.join(dir, ".env.local"), "keep=yes\n");
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration input error\n");
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe("keep=yes\n");
  });
  it("rejects oversized files without changing local settings or printing input", () => {
    const dir = sandbox(); writeFileSync(path.join(dir, "input.csv"), "x".repeat(65537));
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration input error\n");
    expect(readdirSync(dir)).toEqual(["input.csv"]);
  });
  it("cleans its temporary file after a serialization failure", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, "input.csv"), csv.replace(secret, '\"all \"\"quotes\'`\"'));
    writeFileSync(path.join(dir, ".env.local"), "keep=yes\n");
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration write error\n");
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe("keep=yes\n");
    expect(readdirSync(dir).sort()).toEqual([".env.local", "input.csv"]);
  });
  it("refuses a directory writable by other users", () => {
    const dir = sandbox(); chmodSync(dir, 0o777);
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration write error\n");
    expect(readdirSync(dir)).toEqual(["input.csv"]);
  });
  it("supports concurrent imports without temporary-file collisions", () => {
    const dir = sandbox();
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {spawn} from 'node:child_process'; await Promise.all(Array.from({length: 4}, () => new Promise((resolve,reject) => { const child = spawn(process.execPath, ${JSON.stringify(["--import", tsx, script, "input.csv"])}, {stdio:'ignore'}); child.on('exit', code => code === 0 ? resolve() : reject(new Error('child failed'))); })));`], { cwd: dir });
    expect(parseEnv(readFileSync(path.join(dir, ".env.local"))).DASHSCOPE_API_KEY).toBe(secret);
    expect(readdirSync(dir).sort()).toEqual([".env.local", "input.csv"]);
  });
});

describe("dotenv lexical safety regressions", () => {
  function assertSafeUpdate(existing: string) {
    const updated = upsertEnv(existing, parseInspirationConfigCsv(csv));
    const before = parseEnv(existing), after = parseEnv(updated);
    expect(after.DASHSCOPE_API_KEY).toBe(secret);
    for (const [name, value] of Object.entries(before)) {
      if (name === "INSPIRATION_ENABLED" || name.startsWith("DASHSCOPE_")) continue;
      expect(after[name]).toBe(value);
      expect(after[name]).not.toContain(secret);
    }
    return updated;
  }
  it("keeps a colon-assigned public multiline value byte-identical", () => {
    const banner = 'NEXT_PUBLIC_BANNER: "intro\nDASHSCOPE_API_KEY=placeholder\nend"\n';
    expect(assertSafeUpdate(banner).startsWith(banner)).toBe(true);
  });
  it("replaces equals, colon and export-colon target duplicates exactly once", () => {
    const updated = assertSafeUpdate('DASHSCOPE_API_KEY=old\nDASHSCOPE_API_KEY: stale\nexport DASHSCOPE_API_KEY: exported\nKEEP=yes\n');
    expect(updated).not.toMatch(/old|stale|exported/);
    expect(updated.match(/^DASHSCOPE_API_KEY=sk-test-secret\r?$/gm)).toHaveLength(1);
    expect(updated.indexOf(`DASHSCOPE_API_KEY=${secret}`)).toBeLessThan(updated.indexOf("KEEP=yes"));
  });
  it.each(["public.banner", "public-banner", "1PUBLIC", ".PUBLIC", "-PUBLIC"])("protects multiline values under dotenv key %s", (name) => {
    const existing = `${name}: \`intro\nDASHSCOPE_API_KEY=placeholder\nend\`\n`;
    expect(assertSafeUpdate(existing).startsWith(existing)).toBe(true);
  });
  it.each(['"', "'", "`"])("protects escaped %s quotes and an even backslash closing boundary", (quote) => {
    const odd = `NEXT_PUBLIC_ODD=${quote}intro\\${quote}\nDASHSCOPE_API_KEY=placeholder\nend${quote}\n`;
    const even = `NEXT_PUBLIC_EVEN=${quote}ends\\\\${quote}\nKEEP=yes\n`;
    const existing = odd + even + "DASHSCOPE_API_KEY=stale\n";
    const updated = assertSafeUpdate(existing);
    expect(updated.startsWith(odd + even)).toBe(true);
    expect(updated).not.toContain("stale");
    expect(updated.match(/^DASHSCOPE_API_KEY=sk-test-secret\r?$/gm)).toHaveLength(1);
  });
  it("preserves CRLF bytes around colon multiline blocks and duplicate removal", () => {
    const block = 'NEXT_PUBLIC_BANNER: "intro\r\nDASHSCOPE_API_KEY=placeholder\r\nend"\r\n# unchanged\r\n';
    const updated = assertSafeUpdate(block + 'DASHSCOPE_API_KEY: stale\r\nexport DASHSCOPE_API_KEY=old\r\nKEEP=yes\r\n');
    expect(updated.startsWith(block)).toBe(true);
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
    expect(updated.match(/^DASHSCOPE_API_KEY=sk-test-secret\r?$/gm)).toHaveLength(1);
  });
  it.each(['DASHSCOPE_API_KEY="old\nDATABASE_URL=postgres://example\nKEEP=yes', 'NEXT_PUBLIC_BANNER: "intro\nDATABASE_URL=postgres://example\nKEEP=yes', "OTHER='intro\nKEEP=yes", 'OTHER=`intro\nKEEP=yes', 'OTHER="closed" trailing\nKEEP=yes'])
  ("rejects malformed or unterminated quotes without changing the target %#", (existing) => {
    expect(() => upsertEnv(existing, parseInspirationConfigCsv(csv))).toThrow();
    const dir = sandbox(); const target = path.join(dir, ".env.local");
    writeFileSync(target, existing);
    const result = cli(dir);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Configuration write error\n");
    expect(readFileSync(target, "utf8")).toBe(existing);
    expect(readdirSync(dir).sort()).toEqual([".env.local", "input.csv"]);
  });
});

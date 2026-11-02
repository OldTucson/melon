// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runConceptCleanupCli } from "./cleanup-inspiration-concept-objects";
const summary = { scannedSets: 1, deletedObjects: 0, deletedSets: 0, skippedActiveSets: 2, deletedResearchObjects: 0, failures: 0, scannedReports: 0, deletedReports: 0 };
describe("concept cleanup CLI", () => {
  it.each([{ args: [] }, { args: ["--dry-run"] }])("validates before importing services and closes DB for %j", async ({ args }) => {
    const calls: string[] = [], output: string[] = [];
    const code = await runConceptCleanupCli(args, {
      loadEnv() { calls.push("env"); }, async validate() { calls.push("validate"); },
      async loadServices() { calls.push("services"); return {
        async run(dryRun) { calls.push(String(dryRun)); return { ...summary, privateKey: "secret-object-key" }; },
        async closeDatabase() { calls.push("close"); },
      }; }, write(value) { output.push(value); },
    });
    expect(code).toBe(0); expect(calls).toEqual(["env", "validate", "services", String(args.length === 1), "close"]);
    expect(JSON.parse(output[0]!)).toEqual({ dryRun: args.length === 1, ...summary });
  });
  it.each([["--force"], ["--dry-run", "--dry-run"], ["--prefix", "users/"], ["secret-value"]].map((args) => ({ args })))("rejects unsafe arguments before configuration or database access: %j", async ({ args }) => {
    const output: string[] = [];
    expect(await runConceptCleanupCli(args, { loadEnv() { throw Error("must not load"); }, async validate() { throw Error(); }, async loadServices() { throw Error(); }, write(value) { output.push(value); } })).toBe(1);
    expect(output).toEqual(['{"status":"invalid_arguments"}']);
  });
  it("closes DB and sanitizes operational exceptions", async () => {
    let closed = false; const output: string[] = [];
    expect(await runConceptCleanupCli([], { loadEnv() {}, async validate() {}, async loadServices() { return { async run() { throw Error("postgres://private/provider-task/users/key"); }, async closeDatabase() { closed = true; } }; }, write(value) { output.push(value); } })).toBe(1);
    expect(closed).toBe(true); expect(output).toEqual(['{"status":"failed"}']);
  });
  it("reports retryable partial failures with a nonzero exit", async () => {
    const output: string[] = [];
    expect(await runConceptCleanupCli([], { loadEnv() {}, async validate() {}, async loadServices() { return { async run() { return { ...summary, failures: 1 }; }, async closeDatabase() {} }; }, write(value) { output.push(value); } })).toBe(1);
    expect(JSON.parse(output[0]!).failures).toBe(1);
  });
  it("executes the actual entrypoint with rejected arguments without leaking them", () => {
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/cleanup-inspiration-concept-objects.ts", "secret-invalid-option"], { encoding: "utf8" });
    expect(child.status).toBe(1); expect(child.stdout.trim()).toBe('{"status":"invalid_arguments"}'); expect(child.stderr).toBe("");
  });
});

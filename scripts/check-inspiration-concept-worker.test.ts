// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runConceptStatusCli } from "./check-inspiration-concept-worker";
const status = { healthy: true, status: "healthy" as const, heartbeatAgeMs: 10, counts: { queued: 2, submitting: 0, submitted: 1, failed: 0 }, oldestQueueAgeMs: 500 };
describe("concept status CLI", () => {
  it("prints only bounded status, ages and counts after validating environment", async () => {
    const calls: string[] = [], output: string[] = [];
    expect(await runConceptStatusCli([], { loadEnv() { calls.push("env"); }, async validate() { calls.push("validate"); }, async loadServices() { calls.push("services"); return { async run() { return { ...status, ownerId: "private-owner", prompt: "private prompt", objectKey: "users/private", providerTaskId: "private-task", databaseUrl: "postgres://private" }; }, async closeDatabase() { calls.push("close"); } }; }, write(value) { output.push(value); } })).toBe(0);
    expect(calls).toEqual(["env", "validate", "services", "close"]); expect(JSON.parse(output[0]!)).toEqual(status);
  });
  it.each(["stale", "missing"] as const)("uses nonzero for %s heartbeat and closes DB", async (state) => {
    let closed = false;
    expect(await runConceptStatusCli([], { loadEnv() {}, async validate() {}, async loadServices() { return { async run() { return { ...status, healthy: false, status: state, heartbeatAgeMs: state === "missing" ? null : 100_000 }; }, async closeDatabase() { closed = true; } }; }, write() {} })).toBe(1);
    expect(closed).toBe(true);
  });
  it("does not import database services after invalid environment", async () => {
    let loaded = false; const output: string[] = [];
    expect(await runConceptStatusCli([], { loadEnv() {}, async validate() { throw Error("secret-config"); }, async loadServices() { loaded = true; throw Error(); }, write(value) { output.push(value); } })).toBe(1);
    expect(loaded).toBe(false); expect(output).toEqual(['{"status":"failed"}']);
  });
  it("sanitizes unknown errors and closes DB", async () => {
    let closed = false; const output: string[] = [];
    expect(await runConceptStatusCli([], { loadEnv() {}, async validate() {}, async loadServices() { return { async run() { throw Error("provider-task users/key postgres://private"); }, async closeDatabase() { closed = true; } }; }, write(value) { output.push(value); } })).toBe(1);
    expect(closed).toBe(true); expect(output).toEqual(['{"status":"failed"}']);
  });
  it("actual entrypoint rejects all arguments without echoing them", () => {
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/check-inspiration-concept-worker.ts", "--secret"], { encoding: "utf8" });
    expect(child.status).toBe(1); expect(child.stdout.trim()).toBe('{"status":"invalid_arguments"}'); expect(child.stderr).toBe("");
  });
});

// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runConceptWorkerCli } from "./run-inspiration-concept-worker";

describe("concept worker CLI", () => {
  it.each(["SIGTERM", "SIGINT"])(
    "loads configuration before services and closes PostgreSQL after %s",
    async (signalName) => {
      const signals = new EventEmitter();
      const calls: string[] = [];
      await runConceptWorkerCli({
        signals,
        loadEnv: () => {
          calls.push("env");
        },
        validate: async () => {
          calls.push("validate");
        },
        loadServices: async () => {
          calls.push("services");
          return {
            run: async (signal) => {
              calls.push("run");
              signals.emit(signalName);
              expect(signal.aborted).toBe(true);
            },
            closeDatabase: async () => {
              calls.push("close");
            },
          };
        },
      });
      expect(calls).toEqual(["env", "validate", "services", "run", "close"]);
      expect(signals.listenerCount(signalName)).toBe(0);
    },
  );
  it("does not construct services after invalid configuration", async () => {
    let loaded = false;
    await expect(
      runConceptWorkerCli({
        signals: new EventEmitter(),
        loadEnv() {},
        validate: async () => {
          throw Error("secret config");
        },
        loadServices: async () => {
          loaded = true;
          throw Error("should not load");
        },
      }),
    ).rejects.toThrow("Concept worker configuration invalid.");
    expect(loaded).toBe(false);
  });
  it("closes database on worker failure and does not expose private exception details", async () => {
    let closed = false;
    const signals = new EventEmitter();
    await expect(
      runConceptWorkerCli({
        signals,
        loadEnv() {},
        validate: async () => {},
        loadServices: async () => ({
          run: async () => {
            throw Error("private provider URL and credentials");
          },
          closeDatabase: async () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toThrow("Concept worker failed.");
    expect(closed).toBe(true);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});

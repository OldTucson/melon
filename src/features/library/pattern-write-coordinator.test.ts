import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { enqueuePatternWrite } from "./pattern-write-coordinator";

it("reserves every batch ID while permitting unrelated writes and releases all IDs after failure", async () => {
  const client = new QueryClient();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = enqueuePatternWrite(client, "owner", ["a"], () => gate);
  const batchTask = vi.fn(async () => {
    throw new Error("failed");
  });
  const batch = enqueuePatternWrite(
    client,
    "owner",
    ["b", "a"],
    batchTask,
  ).catch(() => undefined);
  const nextTask = vi.fn(async () => "done");
  const next = enqueuePatternWrite(client, "owner", ["b"], nextTask);
  expect(
    await enqueuePatternWrite(
      client,
      "owner",
      ["c"],
      async () => "independent",
    ),
  ).toBe("independent");
  expect(batchTask).not.toHaveBeenCalled();
  expect(nextTask).not.toHaveBeenCalled();
  release();
  await first;
  await batch;
  expect(await next).toBe("done");
});

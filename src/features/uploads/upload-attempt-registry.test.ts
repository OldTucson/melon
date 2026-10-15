import { describe, expect, it, vi } from "vitest";

import { UploadAttemptRegistry } from "./upload-attempt-registry";

describe("UploadAttemptRegistry", () => {
  it("accepts updates only from the latest attempt for a task", () => {
    const registry = new UploadAttemptRegistry();
    const update = vi.fn();
    const first = registry.begin("task");
    const second = registry.begin("task");

    registry.runIfCurrent("task", first, () => update("old"));
    registry.runIfCurrent("task", second, () => update("new"));

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith("new");
  });

  it("does not let a finished or invalidated attempt write again", () => {
    const registry = new UploadAttemptRegistry();
    const update = vi.fn();
    const finished = registry.begin("task");
    registry.finish("task", finished);
    registry.runIfCurrent("task", finished, update);

    const invalidated = registry.begin("task");
    registry.invalidate("task");
    registry.runIfCurrent("task", invalidated, update);

    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a newer tracked run when an older run settles", async () => {
    const registry = new UploadAttemptRegistry();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((resolve) => (resolveFirst = resolve));
    const second = new Promise<void>((resolve) => (resolveSecond = resolve));
    registry.track("task", first);
    registry.track("task", second);

    resolveFirst();
    await first;
    expect(registry.runningTask("task")).toBe(second);

    resolveSecond();
    await second;
    expect(registry.runningTask("task")).toBeUndefined();
  });
});

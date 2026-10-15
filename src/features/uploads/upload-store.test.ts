import { afterEach, describe, expect, it } from "vitest";

import type { UploadCheckpointRow } from "./upload-db";
import { useUploadStore } from "./upload-store";

const checkpoint = (): UploadCheckpointRow => ({
  localTaskId: "local-1",
  ownerId: "10000000-0000-4000-8000-000000000000",
  patternId: "00000000-0000-4000-8000-000000000001",
  sourceAssetId: "00000000-0000-4000-8000-000000000002",
  previewAssetId: "00000000-0000-4000-8000-000000000003",
  thumbnailAssetId: "00000000-0000-4000-8000-000000000004",
  operationId: "00000000-0000-4000-8000-000000000005",
  sessionId: "00000000-0000-4000-8000-000000000006",
  filename: "leaf.png",
  extension: "png",
  size: 123,
  lastModified: 456,
  contentHash: "a".repeat(64),
  objectKeys: { source: "users/u/patterns/p/source/id.png" },
  sdkCheckpoints: { source: { completed: true } },
  completionAssets: [
    {
      assetId: "00000000-0000-4000-8000-000000000002",
      role: "source",
      objectKey: "users/u/patterns/p/source/id.png",
      extension: "png",
      sizeBytes: 123,
    },
  ],
  completionStartedAt: 700,
  updatedAt: 789,
});

afterEach(() => useUploadStore.setState({ tasks: [] }));

describe("upload store recovery", () => {
  it("restores an exact completion checkpoint as directly recoverable", () => {
    useUploadStore.getState().restore([checkpoint()]);

    expect(useUploadStore.getState().tasks[0]).toMatchObject({
      status: "processing",
      progress: 99,
      completionStartedAt: 700,
      canRecoverCompletion: true,
      needsReselect: false,
    });
  });

  it("keeps an incomplete checkpoint paused for file reselection", () => {
    const incomplete = checkpoint();
    delete incomplete.completionAssets;
    incomplete.sdkCheckpoints = {};
    useUploadStore.getState().restore([incomplete]);

    expect(useUploadStore.getState().tasks[0]).toMatchObject({
      status: "paused",
      canRecoverCompletion: false,
      needsReselect: true,
    });
  });
});

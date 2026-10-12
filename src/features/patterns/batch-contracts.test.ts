import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parsePatternBatchMutation,
  patternBatchMutationSchema,
} from "./batch-contracts";

const patternRef = () => ({ id: randomUUID(), version: 0 });

describe("pattern batch contracts", () => {
  it("parses each supported action", () => {
    const operationId = randomUUID();
    const patterns = [patternRef()];
    const folderId = randomUUID();

    expect(
      parsePatternBatchMutation({
        operationId,
        action: "move",
        patterns,
        folderId,
      }),
    ).toEqual({ operationId, action: "move", patterns, folderId });
    expect(
      parsePatternBatchMutation({ operationId, action: "trash", patterns }),
    ).toEqual({ operationId, action: "trash", patterns });
    expect(
      parsePatternBatchMutation({
        operationId,
        action: "favorite",
        patterns,
        isFavorite: false,
      }),
    ).toEqual({ operationId, action: "favorite", patterns, isFavorite: false });
  });

  it("rejects duplicate pattern IDs", () => {
    const ref = patternRef();

    expect(() =>
      patternBatchMutationSchema.parse({
        operationId: randomUUID(),
        action: "trash",
        patterns: [ref, { ...ref, version: 1 }],
      }),
    ).toThrow();
  });

  it("rejects an empty batch", () => {
    expect(() =>
      patternBatchMutationSchema.parse({
        operationId: randomUUID(),
        action: "trash",
        patterns: [],
      }),
    ).toThrow();
  });

  it("rejects a batch of 101 valid UUID references", () => {
    const patterns = Array.from({ length: 101 }, () => patternRef());

    expect(() =>
      patternBatchMutationSchema.parse({
        operationId: randomUUID(),
        action: "trash",
        patterns,
      }),
    ).toThrow();
  });

  it.each([
    { action: "archive", patterns: [patternRef()] },
    { action: "move", patterns: [patternRef()] },
    { action: "move", patterns: [patternRef()], folderId: null, isFavorite: true },
    { action: "trash", patterns: [patternRef()], folderId: null },
    { action: "favorite", patterns: [patternRef()] },
    {
      action: "favorite",
      patterns: [patternRef()],
      isFavorite: true,
      folderId: null,
    },
  ])("rejects malformed or ambiguous action payload %#", (payload) => {
    expect(() =>
      patternBatchMutationSchema.parse({
        operationId: randomUUID(),
        ...payload,
      }),
    ).toThrow();
  });

  it("maps only an oversized patterns array to BATCH_LIMIT_EXCEEDED", () => {
    expect(() =>
      parsePatternBatchMutation({
        operationId: randomUUID(),
        action: "trash",
        patterns: Array.from({ length: 101 }, () => patternRef()),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "BATCH_LIMIT_EXCEEDED",
        status: 400,
        message: "A batch can contain at most 100 patterns",
      }),
    );
  });

  it("maps other invalid requests to VALIDATION_ERROR", () => {
    expect(() =>
      parsePatternBatchMutation({
        operationId: randomUUID(),
        action: "trash",
        patterns: [{ id: "not-a-uuid", version: 0 }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
        status: 400,
        message: "Invalid request",
      }),
    );
  });
});

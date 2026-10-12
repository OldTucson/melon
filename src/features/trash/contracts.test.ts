import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  folderBatchPurgeMutationSchema,
  folderBatchRestoreMutationSchema,
  parsePatternPurgeMutation,
  parsePatternRestoreMutation,
  patternPurgeMutationSchema,
  patternRestoreMutationSchema,
} from "./contracts";

describe("trash contracts", () => {
  it("parses ordinary pattern restore and purge requests", () => {
    const operationId = randomUUID();
    const patternIds = [randomUUID(), randomUUID()];

    expect(parsePatternRestoreMutation({ operationId, patternIds })).toEqual({
      operationId,
      patternIds,
    });
    expect(parsePatternPurgeMutation({ operationId, patternIds })).toEqual({
      operationId,
      patternIds,
    });
    expect(
      patternRestoreMutationSchema.parse({ operationId, patternIds }),
    ).toEqual({ operationId, patternIds });
    expect(patternPurgeMutationSchema.parse({ operationId, patternIds })).toEqual({
      operationId,
      patternIds,
    });
  });

  it("rejects duplicate, empty, and invalid pattern IDs", () => {
    const operationId = randomUUID();
    const id = randomUUID();

    for (const patternIds of [[], [id, id], ["not-a-uuid"]]) {
      expect(() =>
        patternRestoreMutationSchema.parse({ operationId, patternIds }),
      ).toThrow();
    }
  });

  it("rejects 101 valid pattern IDs", () => {
    expect(() =>
      patternPurgeMutationSchema.parse({
        operationId: randomUUID(),
        patternIds: Array.from({ length: 101 }, () => randomUUID()),
      }),
    ).toThrow();
  });

  it("maps oversized restore and purge requests to BATCH_LIMIT_EXCEEDED", () => {
    const oversized = {
      operationId: randomUUID(),
      patternIds: Array.from({ length: 101 }, () => randomUUID()),
    };

    for (const parse of [parsePatternRestoreMutation, parsePatternPurgeMutation]) {
      expect(() => parse(oversized)).toThrowError(
        expect.objectContaining({
          code: "BATCH_LIMIT_EXCEEDED",
          status: 400,
          message: "A batch can contain at most 100 patterns",
        }),
      );
    }
  });

  it("maps other invalid pattern actions to VALIDATION_ERROR", () => {
    expect(() =>
      parsePatternRestoreMutation({
        operationId: randomUUID(),
        patternIds: ["not-a-uuid"],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
        status: 400,
        message: "Invalid request",
      }),
    );
  });

  it("keeps owner and target fields out of parsed pattern actions", () => {
    const operationId = randomUUID();
    const patternIds = [randomUUID()];

    expect(
      parsePatternRestoreMutation({
        operationId,
        patternIds,
        ownerId: randomUUID(),
        trashBatchId: randomUUID(),
        targetFolderId: randomUUID(),
      }),
    ).toEqual({ operationId, patternIds });
  });

  it("parses folder batch bodies without accepting path or owner data as output", () => {
    const operationId = randomUUID();
    const input = {
      operationId,
      ownerId: randomUUID(),
      trashBatchId: randomUUID(),
      targetFolderId: randomUUID(),
    };

    expect(folderBatchRestoreMutationSchema.parse(input)).toEqual({ operationId });
    expect(folderBatchPurgeMutationSchema.parse(input)).toEqual({ operationId });
  });
});

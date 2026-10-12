import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  folderBatchPurgeMutationSchema,
  folderBatchRestoreMutationSchema,
  parseFolderBatchPurgeMutation,
  parseFolderBatchRestoreMutation,
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

  it("maps duplicate, empty, and invalid pattern IDs to VALIDATION_ERROR", () => {
    const operationId = randomUUID();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    for (const parse of [parsePatternRestoreMutation, parsePatternPurgeMutation]) {
      for (const patternIds of [
        [],
        [id, id],
        [id, id.toUpperCase()],
        ["not-a-uuid"],
      ]) {
        expect(() => parse({ operationId, patternIds })).toThrowError(
          expect.objectContaining({ code: "VALIDATION_ERROR" }),
        );
      }
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

  it.each([
    ["ownerId", randomUUID()],
    ["trashBatchId", randomUUID()],
    ["targetFolderId", randomUUID()],
    ["patternIdz", [randomUUID()]],
  ])("rejects extra %s fields in pattern action envelopes", (key, value) => {
    const operationId = randomUUID();
    const patternIds = [randomUUID()];

    for (const parse of [parsePatternRestoreMutation, parsePatternPurgeMutation]) {
      expect(() =>
        parse({ operationId, patternIds, [key]: value }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("parses exact folder batch bodies", () => {
    const operationId = randomUUID();

    expect(folderBatchRestoreMutationSchema.parse({ operationId })).toEqual({
      operationId,
    });
    expect(folderBatchPurgeMutationSchema.parse({ operationId })).toEqual({
      operationId,
    });
  });

  it.each([
    ["patternIds", [randomUUID()]],
    ["trashBatchId", randomUUID()],
    ["ownerId", randomUUID()],
    ["targetFolderId", randomUUID()],
    ["operatonId", randomUUID()],
  ])("rejects extra %s fields in folder batch envelopes", (key, value) => {
    const operationId = randomUUID();

    for (const parse of [
      parseFolderBatchRestoreMutation,
      parseFolderBatchPurgeMutation,
    ]) {
      expect(() => parse({ operationId, [key]: value })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });
});

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  folderCreateMutationSchema,
  folderNameInputSchema,
  folderRenameMutationSchema,
  folderTrashMutationSchema,
  parseFolderName,
} from "./contracts";

describe("folder contracts", () => {
  it("trims and NFC-normalizes display and comparison names", () => {
    expect(parseFolderName("  Cafe\u0301  ")).toEqual({
      name: "Caf\u00e9",
      normalizedName: "caf\u00e9",
    });
    expect(parseFolderName("Caf\u00e9")).toEqual(parseFolderName("Cafe\u0301"));
  });

  it("applies length limits after canonical normalization", () => {
    const composedAtLimit = "\u00e9".repeat(80);
    const decomposedAtLimit = "e\u0301".repeat(80);
    const composedOverLimit = `${composedAtLimit}\u00e9`;
    const decomposedOverLimit = `${decomposedAtLimit}e\u0301`;

    expect(folderNameInputSchema.parse(composedAtLimit)).toBe(composedAtLimit);
    expect(folderNameInputSchema.parse(decomposedAtLimit)).toBe(composedAtLimit);
    expect(folderNameInputSchema.safeParse(composedOverLimit).success).toBe(false);
    expect(folderNameInputSchema.safeParse(decomposedOverLimit).success).toBe(
      false,
    );
  });

  it.each(["", "   ", "x".repeat(81), "safe\0unsafe"])(
    "rejects invalid folder name %j",
    (name) => {
      expect(() => parseFolderName(name)).toThrow();
    },
  );

  it("accepts create mutations with root or nested parents", () => {
    const operationId = randomUUID();
    const parentId = randomUUID();

    expect(
      folderCreateMutationSchema.parse({
        operationId,
        input: { name: "  Cafe\u0301  ", parentId: null },
      }),
    ).toEqual({ operationId, input: { name: "Caf\u00e9", parentId: null } });
    expect(
      folderCreateMutationSchema.parse({
        operationId,
        input: { name: "Child", parentId },
      }),
    ).toEqual({ operationId, input: { name: "Child", parentId } });
  });

  it("requires nonnegative integer versions for rename and trash mutations", () => {
    const operationId = randomUUID();

    expect(
      folderRenameMutationSchema.parse({
        operationId,
        patch: { name: "  Renomme\u0301  ", version: 0 },
      }),
    ).toEqual({
      operationId,
      patch: { name: "Renomm\u00e9", version: 0 },
    });
    expect(
      folderTrashMutationSchema.parse({ operationId, version: 4 }),
    ).toEqual({ operationId, version: 4 });

    expect(() =>
      folderRenameMutationSchema.parse({
        operationId,
        patch: { name: "Renamed", version: -1 },
      }),
    ).toThrow();
    expect(() =>
      folderTrashMutationSchema.parse({ operationId, version: 1.5 }),
    ).toThrow();
  });
});

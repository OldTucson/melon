import { describe, expect, it } from "vitest";

import { patternMutationSchema } from "@/features/patterns/contracts";
import {
  patternTagMutationSchema,
  tagCreateMutationSchema,
  tagDeleteMutationSchema,
  tagPatchMutationSchema,
} from "@/features/tags/contracts";
import {
  uploadCancelSchema,
  uploadCompleteSchema,
  uploadCredentialsSchema,
  uploadInitSchema,
} from "@/features/uploads/contracts";

import { publicOperationIdSchema } from "./operation-id";

const PUBLIC_V4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTERNAL_V5 = "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";

describe("public operation IDs", () => {
  it("accepts and normalizes UUID v4 values only", () => {
    expect(publicOperationIdSchema.parse(PUBLIC_V4.toUpperCase())).toBe(PUBLIC_V4);
    expect(publicOperationIdSchema.safeParse(INTERNAL_V5).success).toBe(false);
  });

  it.each([
    ["pattern update", patternMutationSchema, { operationId: INTERNAL_V5, patch: { version: 0, isFavorite: true } }],
    ["tag create", tagCreateMutationSchema, { operationId: INTERNAL_V5, input: { name: "flora", colorToken: "green" } }],
    ["tag patch", tagPatchMutationSchema, { operationId: INTERNAL_V5, patch: { name: "flora" } }],
    ["tag delete", tagDeleteMutationSchema, { operationId: INTERNAL_V5 }],
    ["pattern tag", patternTagMutationSchema, { operationId: INTERNAL_V5 }],
    [
      "upload init",
      uploadInitSchema,
      {
        patternId: PUBLIC_V4,
        sourceAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        operationId: INTERNAL_V5,
        originalFilename: "flora.psd",
        extension: "psd",
        sizeBytes: 4,
        lastModified: 0,
      },
    ],
    [
      "upload complete",
      uploadCompleteSchema,
      {
        operationId: INTERNAL_V5,
        assets: [
          {
            assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            role: "source",
            objectKey: "source",
            extension: "psd",
            sizeBytes: 4,
          },
        ],
      },
    ],
    ["upload credentials", uploadCredentialsSchema, { operationId: INTERNAL_V5 }],
    ["upload cancel", uploadCancelSchema, { operationId: INTERNAL_V5 }],
  ] as const)("rejects an internal UUID for the %s contract", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

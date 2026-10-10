import { z } from "zod";

import { normalizedUuidSchema } from "./identifiers";

export const storageObjectRoles = ["source", "preview", "thumbnail"] as const;
export const storageObjectKinds = ["source", "derived"] as const;
export const storageSourceExtensions = [
  "psd",
  "ai",
  "jpg",
  "jpeg",
  "png",
  "procreate",
] as const;
export const storageDerivedExtensions = ["jpg", "jpeg", "png", "webp"] as const;
export const storageExtensions = [
  ...storageSourceExtensions,
  "webp",
] as const;

export type StorageObjectRole = (typeof storageObjectRoles)[number];
export type StorageObjectKind = (typeof storageObjectKinds)[number];
export type StorageExtension = (typeof storageExtensions)[number];

const sourceExtensionInputSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(storageSourceExtensions));
const derivedExtensionInputSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(storageDerivedExtensions));

const objectIdentityShape = {
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
  assetId: normalizedUuidSchema,
};

const objectKeyInputSchema = z.discriminatedUnion("role", [
  z.object({
    ...objectIdentityShape,
    role: z.literal("source"),
    extension: sourceExtensionInputSchema,
  }),
  z.object({
    ...objectIdentityShape,
    role: z.literal("preview"),
    extension: derivedExtensionInputSchema,
  }),
  z.object({
    ...objectIdentityShape,
    role: z.literal("thumbnail"),
    extension: derivedExtensionInputSchema,
  }),
]);

const objectKeyPartsSchema = z.discriminatedUnion("kind", [
  z.object({
    ...objectIdentityShape,
    kind: z.literal("source"),
    extension: z.enum(storageSourceExtensions),
  }),
  z.object({
    ...objectIdentityShape,
    kind: z.literal("derived"),
    extension: z.enum(storageDerivedExtensions),
  }),
]);

const derivedAssetIdsSchema = z
  .object({
    previewAssetId: normalizedUuidSchema,
    thumbnailAssetId: normalizedUuidSchema,
  })
  .refine(
    ({ previewAssetId, thumbnailAssetId }) =>
      previewAssetId !== thumbnailAssetId,
    { message: "Derived asset IDs must be distinct" },
  );

export type ObjectKeyParts = z.output<typeof objectKeyPartsSchema>;

type RoleObjectKeyInput = {
  ownerId: string;
  patternId: string;
  assetId: string;
  extension: string;
};

function formatObjectKey(parts: ObjectKeyParts) {
  return [
    "users",
    parts.ownerId,
    "patterns",
    parts.patternId,
    parts.kind,
    `${parts.assetId}.${parts.extension}`,
  ].join("/");
}

export function storageObjectKey(input: z.input<typeof objectKeyInputSchema>) {
  const parsed = objectKeyInputSchema.parse(input);

  return parsed.role === "source"
    ? formatObjectKey({
        ownerId: parsed.ownerId,
        patternId: parsed.patternId,
        assetId: parsed.assetId,
        kind: "source",
        extension: parsed.extension,
      })
    : formatObjectKey({
        ownerId: parsed.ownerId,
        patternId: parsed.patternId,
        assetId: parsed.assetId,
        kind: "derived",
        extension: parsed.extension,
      });
}

export function assertDistinctDerivedAssetIds(
  input: z.input<typeof derivedAssetIdsSchema>,
) {
  return derivedAssetIdsSchema.parse(input);
}

export function sourceObjectKey(input: RoleObjectKeyInput) {
  return storageObjectKey({ ...input, role: "source" });
}

export function previewObjectKey(input: RoleObjectKeyInput) {
  return storageObjectKey({ ...input, role: "preview" });
}

export function thumbnailObjectKey(input: RoleObjectKeyInput) {
  return storageObjectKey({ ...input, role: "thumbnail" });
}

export function parseObjectKey(key: string): ObjectKeyParts {
  const segments = key.split("/");
  const filename = segments[5];
  const separator = filename?.lastIndexOf(".") ?? -1;

  if (
    segments.length !== 6 ||
    segments[0] !== "users" ||
    segments[2] !== "patterns" ||
    separator <= 0
  ) {
    throw new Error("Invalid OSS object key");
  }

  try {
    const parsed = objectKeyPartsSchema.parse({
      ownerId: segments[1],
      patternId: segments[3],
      kind: segments[4],
      assetId: filename?.slice(0, separator),
      extension: filename?.slice(separator + 1),
    });

    if (formatObjectKey(parsed) !== key) {
      throw new Error("Noncanonical OSS object key");
    }

    return parsed;
  } catch {
    throw new Error("Invalid OSS object key");
  }
}

type PatternObjectScope = {
  key: string;
  ownerId: string;
  patternId: string;
};

export function objectKeyBelongsToPattern(input: PatternObjectScope) {
  const scope = z
    .object({
      ownerId: normalizedUuidSchema,
      patternId: normalizedUuidSchema,
    })
    .parse(input);

  try {
    const key = parseObjectKey(input.key);
    return key.ownerId === scope.ownerId && key.patternId === scope.patternId;
  } catch {
    return false;
  }
}

export function assertObjectKeyBelongsToPattern(
  input: PatternObjectScope,
): ObjectKeyParts {
  let key: ObjectKeyParts;

  try {
    key = parseObjectKey(input.key);
  } catch {
    throw new Error("Invalid OSS object key");
  }

  const scope = z
    .object({
      ownerId: normalizedUuidSchema,
      patternId: normalizedUuidSchema,
    })
    .parse(input);

  if (key.ownerId !== scope.ownerId || key.patternId !== scope.patternId) {
    throw new Error("OSS object key is outside the requested pattern scope");
  }

  return key;
}

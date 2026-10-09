import { z } from "zod";

export const storageObjectRoles = ["source", "preview", "thumbnail"] as const;
export const storageExtensions = [
  "psd",
  "ai",
  "jpg",
  "jpeg",
  "png",
  "procreate",
] as const;

export type StorageObjectRole = (typeof storageObjectRoles)[number];
export type StorageExtension = (typeof storageExtensions)[number];

const uuidSchema = z.string().uuid();
const roleSchema = z.enum(storageObjectRoles);
const canonicalExtensionSchema = z.enum(storageExtensions);
const extensionInputSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(canonicalExtensionSchema);

const objectKeyInputSchema = z.object({
  ownerId: uuidSchema,
  patternId: uuidSchema,
  assetId: uuidSchema,
  role: roleSchema,
  extension: extensionInputSchema,
});

const objectKeyPartsSchema = z.object({
  ownerId: uuidSchema,
  patternId: uuidSchema,
  assetId: uuidSchema,
  role: roleSchema,
  extension: canonicalExtensionSchema,
});

export type ObjectKeyParts = z.output<typeof objectKeyPartsSchema>;

type RoleObjectKeyInput = Omit<z.input<typeof objectKeyInputSchema>, "role">;

export function storageObjectKey(input: z.input<typeof objectKeyInputSchema>) {
  const parsed = objectKeyInputSchema.parse(input);

  return [
    "users",
    parsed.ownerId,
    "patterns",
    parsed.patternId,
    parsed.role,
    `${parsed.assetId}.${parsed.extension}`,
  ].join("/");
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
    return objectKeyPartsSchema.parse({
      ownerId: segments[1],
      patternId: segments[3],
      role: segments[4],
      assetId: filename?.slice(0, separator),
      extension: filename?.slice(separator + 1),
    });
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
    .object({ ownerId: uuidSchema, patternId: uuidSchema })
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
    .object({ ownerId: uuidSchema, patternId: uuidSchema })
    .parse(input);

  if (key.ownerId !== scope.ownerId || key.patternId !== scope.patternId) {
    throw new Error("OSS object key is outside the requested pattern scope");
  }

  return key;
}

import Dexie, { type Table } from "dexie";

import type { UploadCompletionAsset } from "./contracts";

export type SafeSdkCheckpoint = Record<string, unknown>;
export type UploadAssetKind = "source" | "preview" | "thumbnail";

export type UploadCheckpointRow = {
  localTaskId: string;
  ownerId: string;
  patternId: string;
  sourceAssetId: string;
  previewAssetId: string;
  thumbnailAssetId: string;
  operationId: string;
  sessionId?: string;
  filename: string;
  extension: string;
  size: number;
  lastModified: number;
  contentHash: string;
  objectKeys: Partial<Record<UploadAssetKind, string>>;
  sdkCheckpoints: Partial<Record<UploadAssetKind, SafeSdkCheckpoint>>;
  completionAssets?: UploadCompletionAsset[];
  completionStartedAt?: number;
  updatedAt: number;
};

export class UploadDatabase extends Dexie {
  uploadCheckpoints!: Table<UploadCheckpointRow, string>;

  constructor(name = "melon-upload-v1") {
    super(name);
    this.version(1).stores({
      uploadCheckpoints: "localTaskId,ownerId,sessionId,patternId,updatedAt",
    });
  }
}

const forbiddenCheckpointKey =
  /^(?:file|blob|credentials?|accessKeyId|accessKeySecret|securityToken|stsToken)$/i;

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") return undefined;
  if (typeof Blob !== "undefined" && value instanceof Blob) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, seen))
      .filter((entry) => entry !== undefined);
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenCheckpointKey.test(key)) continue;
    const sanitized = sanitizeValue(entry, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function sanitizeSdkCheckpoint(value: unknown): SafeSdkCheckpoint {
  const sanitized = sanitizeValue(value, new WeakSet());
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as SafeSdkCheckpoint)
    : {};
}

export const createUploadDatabase = (name?: string) => new UploadDatabase(name);

export async function saveCheckpoint(
  database: UploadDatabase,
  row: UploadCheckpointRow,
) {
  const sdkCheckpoints = Object.fromEntries(
    Object.entries(row.sdkCheckpoints).map(([role, checkpoint]) => [
      role,
      sanitizeSdkCheckpoint(checkpoint),
    ]),
  );
  await database.uploadCheckpoints.put({ ...row, sdkCheckpoints });
}

export async function loadCheckpoint(
  database: UploadDatabase,
  localTaskId: string,
) {
  return database.uploadCheckpoints.get(localTaskId);
}

export async function deleteCheckpoint(
  database: UploadDatabase,
  localTaskId: string,
) {
  await database.uploadCheckpoints.delete(localTaskId);
}

export async function listRecoverableUploads(
  database: UploadDatabase,
  ownerId?: string,
) {
  const rows = await database.uploadCheckpoints.orderBy("updatedAt").reverse().toArray();
  return ownerId ? rows.filter((row) => row.ownerId === ownerId) : rows;
}

import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";

import { createAlibabaBrowserCredentialIssuer } from "@/features/storage/cloud-credentials";
import type {
  BrowserCredentialIssuer,
  BrowserOssCredentials,
  OssAdapter,
} from "@/features/storage/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { storageObjectKey } from "@/features/storage/object-keys";
import { createAlibabaOssAdapter } from "@/features/storage/oss-adapter";
import {
  UPLOAD_CREDENTIAL_ISSUE_TIMEOUT_MS,
  UPLOAD_CREDENTIAL_LIFETIME_MS,
  UPLOAD_WRITE_DRAIN_GRACE_MS,
} from "@/features/storage/upload-timing";
import { detectFileSignature } from "@/features/uploads/file-signatures";
import { db } from "@/lib/db/client";
import { nextChangeSeq } from "@/lib/db/change-seq";
import {
  assets,
  changeLog,
  operations,
  patterns,
  uploadSessions,
} from "@/lib/db/schema";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import {
  parseManualPreviewComplete,
  parseManualPreviewCancel,
  parseManualPreviewInit,
  type ManualPreviewAsset,
  type ManualPreviewCancelInput,
  type ManualPreviewCompleteInput,
  type ManualPreviewInitInput,
} from "./manual-preview-contracts";

type ManualPreviewDatabase = typeof db;

type InitializedAsset = {
  assetId: string;
  objectKey: string;
  extension: ManualPreviewInitInput["extension"];
};

type Initialization = {
  operationId: string;
  patternId: string;
  version: number;
  extension: ManualPreviewInitInput["extension"];
  assets: {
    preview: InitializedAsset & { role: "preview" };
    thumbnail: InitializedAsset & { role: "thumbnail" };
  };
};

type CompletionResult = {
  pattern: { id: string; version: number; previewStatus: "manual"; updatedAt: string };
  assets: Array<{
    id: string;
    role: "preview" | "thumbnail";
    width: number;
    height: number;
  }>;
};

type Lifecycle = {
  initialization: Initialization;
  completion?: {
    fingerprint: string;
    claimId: string;
    state: "verifying" | "cleanup";
    result?: CompletionResult;
  };
  cleanup?: { objectKeys: string[] };
};

type Dependencies = {
  database: ManualPreviewDatabase;
  oss: OssAdapter;
  credentialIssuer: BrowserCredentialIssuer;
  now: () => Date;
  credentialIssueTimeoutMs?: number;
};

const MANUAL_PREVIEW_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

const notFound = () => new AppError("NOT_FOUND", 404, "Pattern not found");
const stateChanged = () =>
  new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
const operationMismatch = () =>
  new AppError("OPERATION_ID_REUSED", 409, "Operation ID was already used");
const invalidPreview = () =>
  new AppError("MANUAL_PREVIEW_INVALID", 422, "Manual preview is invalid");
const storageUnavailable = () =>
  new AppError(
    "UPLOAD_STORAGE_UNAVAILABLE",
    503,
    "Upload storage is temporarily unavailable",
  );
const credentialsUnavailable = () =>
  new AppError(
    "UPLOAD_CREDENTIALS_UNAVAILABLE",
    503,
    "Upload credentials are temporarily unavailable",
  );

function parseIdentity(ownerId: string, patternId: string) {
  const owner = normalizedUuidSchema.safeParse(ownerId);
  const pattern = normalizedUuidSchema.safeParse(patternId);
  if (!owner.success || !pattern.success) throw notFound();
  return { ownerId: owner.data, patternId: pattern.data };
}

function lifecycleFrom(value: Record<string, unknown>): Lifecycle {
  const lifecycle = value as Partial<Lifecycle>;
  if (!lifecycle.initialization) throw operationMismatch();
  return lifecycle as Lifecycle;
}

function assertInitializationMatches(
  lifecycle: Lifecycle,
  patternId: string,
  input: ManualPreviewCompleteInput,
) {
  const initialization = lifecycle.initialization;
  if (
    initialization.patternId !== patternId ||
    initialization.operationId !== input.operationId ||
    initialization.version !== input.version
  ) {
    throw operationMismatch();
  }
  for (const asset of input.assets) {
    const expected = initialization.assets[asset.role];
    if (
      asset.assetId !== expected.assetId ||
      asset.objectKey !== expected.objectKey ||
      asset.extension !== expected.extension
    ) {
      throw invalidPreview();
    }
  }
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 24) throw invalidPreview();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function uint24(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 30) throw invalidPreview();
  const chunk = new TextDecoder("latin1").decode(bytes.subarray(12, 16));
  if (chunk === "VP8X") {
    return {
      width: uint24(bytes, 24) + 1,
      height: uint24(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      height:
        1 +
        (bytes[22]! >> 6) +
        (bytes[23]! << 2) +
        ((bytes[24]! & 0x0f) << 10),
    };
  }
  if (
    chunk === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  throw invalidPreview();
}

async function verifyAsset(oss: OssAdapter, asset: ManualPreviewAsset) {
  let metadata: Awaited<ReturnType<OssAdapter["headObject"]>>;
  let bytes: Uint8Array;
  try {
    metadata = await oss.headObject(asset.objectKey);
    if (metadata.sizeBytes !== asset.sizeBytes) throw invalidPreview();
    bytes = await oss.readRange(
      asset.objectKey,
      0,
      Math.min(metadata.sizeBytes - 1, 31),
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageUnavailable();
  }
  try {
    const detected = detectFileSignature(asset.extension, bytes);
    const dimensions =
      asset.extension === "png" ? pngDimensions(bytes) : webpDimensions(bytes);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      throw invalidPreview();
    }
    return { asset, mimeType: detected.mimeType };
  } catch (error) {
    if (error instanceof AppError && error.code === "MANUAL_PREVIEW_INVALID") {
      throw error;
    }
    throw invalidPreview();
  }
}

async function issueCredentials(
  issuer: BrowserCredentialIssuer,
  ownerId: string,
  patternId: string,
  objectKeys: readonly string[],
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(credentialsUnavailable()), timeoutMs);
    });
    return await Promise.race([
      issuer.issue({ ownerId, patternId, objectKeys }),
      timeout,
    ]);
  } catch {
    throw credentialsUnavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function credentialIssueFence(now: Date, timeoutMs: number) {
  return new Date(
    now.getTime() +
      UPLOAD_CREDENTIAL_LIFETIME_MS +
      timeoutMs +
      UPLOAD_WRITE_DRAIN_GRACE_MS,
  );
}

function credentialExpiration(value: string, issuedAt: Date) {
  const expiration = new Date(value);
  if (
    !Number.isFinite(expiration.getTime()) ||
    expiration.getTime() <= issuedAt.getTime()
  ) {
    throw credentialsUnavailable();
  }
  return expiration;
}

export function createManualPreviewService(dependencies: Dependencies) {
  const { database, oss, credentialIssuer, now } = dependencies;
  const credentialIssueTimeoutMs =
    dependencies.credentialIssueTimeoutMs ??
    UPLOAD_CREDENTIAL_ISSUE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(credentialIssueTimeoutMs) ||
    credentialIssueTimeoutMs <= 0
  ) {
    throw new Error("MANUAL_PREVIEW_CREDENTIAL_TIMEOUT_INVALID");
  }

  async function scheduleCleanup(input: {
    ownerId: string;
    patternId: string;
    operationId: string;
    claimId?: string;
    fingerprint?: string;
    allowStaleClaim?: boolean;
    leaseStatus: "aborted" | "failed";
  }) {
    return database.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, input.ownerId),
            eq(operations.operationId, input.operationId),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !operation ||
        !operation.kind.startsWith("manual-preview.initialize:")
      ) {
        return "missing" as const;
      }
      const lifecycle = lifecycleFrom(operation.result);
      const initialization = lifecycle.initialization;
      if (
        initialization.operationId !== input.operationId ||
        initialization.patternId !== input.patternId
      ) {
        return "missing" as const;
      }
      if (lifecycle.completion?.result) return "complete" as const;
      if (
        !input.allowStaleClaim &&
        lifecycle.completion?.state === "verifying" &&
        (lifecycle.completion.claimId !== input.claimId ||
          lifecycle.completion.fingerprint !== input.fingerprint)
      ) {
        return "busy" as const;
      }

      const objectKeys = [
        initialization.assets.preview.objectKey,
        initialization.assets.thumbnail.objectKey,
      ];
      const cleanupClaimId =
        lifecycle.completion?.claimId ?? input.claimId ?? randomUUID();
      const cleanupFingerprint =
        lifecycle.completion?.fingerprint ??
        input.fingerprint ??
        createOperationKey("manual-preview.cleanup", objectKeys);
      await storeOperationResult(input.ownerId, tx, input.operationId, {
        ...lifecycle,
        completion: {
          fingerprint: cleanupFingerprint,
          claimId: cleanupClaimId,
          state: "cleanup",
        },
        cleanup: { objectKeys },
      });
      await tx
        .update(uploadSessions)
        .set({
          status: input.leaseStatus,
          lastErrorCode: "MANUAL_PREVIEW_CLEANUP_PENDING",
          updatedAt: now(),
        })
        .where(
          and(
            eq(uploadSessions.ownerId, input.ownerId),
            eq(uploadSessions.id, input.operationId),
          ),
        );
      return "scheduled" as const;
    });
  }

  async function retryCleanupOperation(ownerId: string, operationId: string) {
    return database.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, ownerId),
            eq(operations.operationId, operationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!operation) return "none" as const;
      const lifecycle = lifecycleFrom(operation.result);
      if (!lifecycle.cleanup) return "none" as const;
      try {
        await oss.deleteObjects(lifecycle.cleanup.objectKeys);
      } catch {
        return "pending" as const;
      }

      const keepCompletion = !(
        lifecycle.completion?.state === "cleanup" &&
        !lifecycle.completion.result
      );
      const nextLifecycle: Lifecycle = {
        initialization: lifecycle.initialization,
        ...(keepCompletion && lifecycle.completion
          ? { completion: lifecycle.completion }
          : {}),
      };
      await storeOperationResult(ownerId, tx, operationId, nextLifecycle);
      return "cleaned" as const;
    });
  }

  return {
    async initialize(input: {
      ownerId: string;
      patternId: string;
      input: ManualPreviewInitInput;
    }): Promise<Initialization & { credentials: BrowserOssCredentials }> {
      const identity = parseIdentity(input.ownerId, input.patternId);
      const parsed = parseManualPreviewInit(input.input);
      const kind = createOperationKey("manual-preview.initialize", {
        patternId: identity.patternId,
        version: parsed.version,
        extension: parsed.extension,
      });
      const initialization = await database.transaction(async (tx) => {
        const operation = await claimOperation(
          identity.ownerId,
          tx,
          parsed.operationId,
          kind,
        );
        if (operation.state === "mismatch") throw operationMismatch();
        const [pattern] = await tx
          .select()
          .from(patterns)
          .where(
            and(
              eq(patterns.ownerId, identity.ownerId),
              eq(patterns.id, identity.patternId),
            ),
          )
          .limit(1)
          .for("update");
        if (!pattern) throw notFound();
        if (pattern.status !== "ready" || pattern.version !== parsed.version) {
          throw stateChanged();
        }
        const [source] = await tx
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.ownerId, identity.ownerId),
              eq(assets.patternId, identity.patternId),
              eq(assets.role, "source"),
            ),
          )
          .limit(1);
        if (!source) throw stateChanged();

        let result: Initialization;
        const timestamp = now();
        if (operation.state === "replay") {
          const lifecycle = lifecycleFrom(operation.result);
          if (lifecycle.completion) throw stateChanged();
          result = lifecycle.initialization;
          if (
            result.patternId !== identity.patternId ||
            result.version !== parsed.version ||
            result.extension !== parsed.extension
          ) {
            throw operationMismatch();
          }
          const [lease] = await tx
            .select()
            .from(uploadSessions)
            .where(
              and(
                eq(uploadSessions.ownerId, identity.ownerId),
                eq(uploadSessions.id, parsed.operationId),
              ),
            )
            .limit(1)
            .for("update");
          if (
            !lease ||
            lease.patternId !== identity.patternId ||
            lease.status === "completed" ||
            lease.status === "aborted" ||
            lease.status === "expired" ||
            timestamp >= lease.expiresAt
          ) {
            throw stateChanged();
          }
          await tx
            .update(uploadSessions)
            .set({
              status: "uploading",
              credentialIssueFenceAt: credentialIssueFence(
                timestamp,
                credentialIssueTimeoutMs,
              ),
              lastErrorCode: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(uploadSessions.ownerId, identity.ownerId),
                eq(uploadSessions.id, parsed.operationId),
              ),
            );
        } else {
          const previewAssetId = randomUUID();
          const thumbnailAssetId = randomUUID();
          result = {
            operationId: parsed.operationId,
            patternId: identity.patternId,
            version: parsed.version,
            extension: parsed.extension,
            assets: {
              preview: {
                assetId: previewAssetId,
                role: "preview",
                extension: parsed.extension,
                objectKey: storageObjectKey({
                  ...identity,
                  assetId: previewAssetId,
                  role: "preview",
                  extension: parsed.extension,
                }),
              },
              thumbnail: {
                assetId: thumbnailAssetId,
                role: "thumbnail",
                extension: parsed.extension,
                objectKey: storageObjectKey({
                  ...identity,
                  assetId: thumbnailAssetId,
                  role: "thumbnail",
                  extension: parsed.extension,
                }),
              },
            },
          };
          await tx.insert(uploadSessions).values({
            id: parsed.operationId,
            ownerId: identity.ownerId,
            patternId: identity.patternId,
            operationId: parsed.operationId,
            sourceObjectKey: result.assets.preview.objectKey,
            fileFingerprint: {
              kind: "manual-preview",
              version: parsed.version,
              extension: parsed.extension,
              previewObjectKey: result.assets.preview.objectKey,
              thumbnailObjectKey: result.assets.thumbnail.objectKey,
            },
            sizeBytes: 0n,
            status: "uploading",
            expiresAt: new Date(
              timestamp.getTime() + MANUAL_PREVIEW_LEASE_DURATION_MS,
            ),
            credentialIssueFenceAt: credentialIssueFence(
              timestamp,
              credentialIssueTimeoutMs,
            ),
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          await storeOperationResult(identity.ownerId, tx, parsed.operationId, {
            initialization: result,
          });
        }
        return result;
      });
      const credentials = await issueCredentials(
        credentialIssuer,
        identity.ownerId,
        identity.patternId,
        [
          initialization.assets.preview.objectKey,
          initialization.assets.thumbnail.objectKey,
        ],
        credentialIssueTimeoutMs,
      );
      const issuedAt = now();
      const expiresAt = credentialExpiration(credentials.expiration, issuedAt);
      await database.transaction(async (tx) => {
        const [pattern] = await tx
          .select({ version: patterns.version, status: patterns.status })
          .from(patterns)
          .where(
            and(
              eq(patterns.ownerId, identity.ownerId),
              eq(patterns.id, identity.patternId),
            ),
          )
          .limit(1)
          .for("update");
        const [lease] = await tx
          .select()
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.ownerId, identity.ownerId),
              eq(uploadSessions.id, parsed.operationId),
            ),
          )
          .limit(1)
          .for("update");
        if (lease) {
          await tx
            .update(uploadSessions)
            .set({
              credentialIssueFenceAt: null,
              credentialsExpireAt:
                lease.credentialsExpireAt && lease.credentialsExpireAt > expiresAt
                  ? lease.credentialsExpireAt
                  : expiresAt,
              updatedAt: issuedAt,
            })
            .where(
              and(
                eq(uploadSessions.ownerId, identity.ownerId),
                eq(uploadSessions.id, parsed.operationId),
              ),
            );
        }
        if (
          !pattern ||
          pattern.status !== "ready" ||
          pattern.version !== parsed.version ||
          !lease ||
          lease.patternId !== identity.patternId ||
          lease.status !== "uploading" ||
          issuedAt >= lease.expiresAt
        ) {
          throw stateChanged();
        }
      });
      return { ...initialization, credentials };
    },

    async complete(input: {
      ownerId: string;
      patternId: string;
      input: ManualPreviewCompleteInput;
    }) {
      const identity = parseIdentity(input.ownerId, input.patternId);
      const parsed = parseManualPreviewComplete(input.input);
      const fingerprint = createOperationKey("manual-preview.complete", {
        version: parsed.version,
        assets: parsed.assets,
      });
      const claimId = randomUUID();
      let preparation: Awaited<ReturnType<typeof prepareCompletion>>;
      async function prepareCompletion() {
        return database.transaction(async (tx) => {
          const [operation] = await tx
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.ownerId, identity.ownerId),
                eq(operations.operationId, parsed.operationId),
              ),
            )
            .limit(1)
            .for("update");
          if (!operation) throw operationMismatch();
          const lifecycle = lifecycleFrom(operation.result);
          assertInitializationMatches(lifecycle, identity.patternId, parsed);
          if (lifecycle.completion?.result) {
            if (lifecycle.completion.fingerprint !== fingerprint) {
              throw operationMismatch();
            }
            return {
              kind: "replay" as const,
              result: lifecycle.completion.result,
            };
          }
          if (lifecycle.completion) {
            if (lifecycle.completion.fingerprint !== fingerprint) {
              throw operationMismatch();
            }
            throw stateChanged();
          }
          const [pattern] = await tx
            .select({ version: patterns.version, status: patterns.status })
            .from(patterns)
            .where(
              and(
                eq(patterns.ownerId, identity.ownerId),
                eq(patterns.id, identity.patternId),
              ),
            )
            .limit(1)
            .for("update");
          if (!pattern) throw notFound();
          if (pattern.status !== "ready" || pattern.version !== parsed.version) {
            throw stateChanged();
          }
          await storeOperationResult(identity.ownerId, tx, parsed.operationId, {
            ...lifecycle,
            completion: { fingerprint, claimId, state: "verifying" },
          });
          return { kind: "verify" as const, claimId };
        });
      }
      try {
        preparation = await prepareCompletion();
      } catch (error) {
        const scheduled = await scheduleCleanup({
          ...identity,
          operationId: parsed.operationId,
          fingerprint,
          leaseStatus: "failed",
        });
        if (scheduled === "scheduled") {
          await retryCleanupOperation(identity.ownerId, parsed.operationId);
        }
        throw error;
      }
      if (preparation.kind === "replay") return preparation.result;

      let verified: Awaited<ReturnType<typeof verifyAsset>>[];
      try {
        verified = await Promise.all(
          parsed.assets.map((asset) => verifyAsset(oss, asset)),
        );
      } catch (error) {
        const scheduled = await scheduleCleanup({
          ...identity,
          operationId: parsed.operationId,
          claimId,
          fingerprint,
          leaseStatus: "failed",
        });
        if (scheduled === "scheduled") {
          await retryCleanupOperation(identity.ownerId, parsed.operationId);
        }
        throw error;
      }

      let oldObjectKeys: string[] = [];
      try {
        const committed = await database.transaction(async (tx) => {
          const [operation] = await tx
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.ownerId, identity.ownerId),
                eq(operations.operationId, parsed.operationId),
              ),
            )
            .limit(1)
            .for("update");
          if (!operation) throw operationMismatch();
          const lifecycle = lifecycleFrom(operation.result);
          assertInitializationMatches(lifecycle, identity.patternId, parsed);
          if (lifecycle.completion?.result) {
            if (lifecycle.completion.fingerprint !== fingerprint) {
              throw operationMismatch();
            }
            return { result: lifecycle.completion.result, oldObjectKeys: [] };
          }
          if (
            lifecycle.completion?.fingerprint !== fingerprint ||
            lifecycle.completion.claimId !== claimId ||
            lifecycle.completion.state !== "verifying"
          ) {
            throw operationMismatch();
          }

          const [pattern] = await tx
            .select()
            .from(patterns)
            .where(
              and(
                eq(patterns.ownerId, identity.ownerId),
                eq(patterns.id, identity.patternId),
              ),
            )
            .limit(1)
            .for("update");
          if (!pattern) throw notFound();
          if (pattern.status !== "ready" || pattern.version !== parsed.version) {
            throw stateChanged();
          }
          const [source] = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                eq(assets.ownerId, identity.ownerId),
                eq(assets.patternId, identity.patternId),
                eq(assets.role, "source"),
              ),
            )
            .limit(1);
          if (!source) throw stateChanged();
          const [lease] = await tx
            .select({
              patternId: uploadSessions.patternId,
              status: uploadSessions.status,
            })
            .from(uploadSessions)
            .where(
              and(
                eq(uploadSessions.ownerId, identity.ownerId),
                eq(uploadSessions.id, parsed.operationId),
              ),
            )
            .limit(1)
            .for("update");
          if (
            !lease ||
            lease.patternId !== identity.patternId ||
            lease.status !== "uploading"
          ) {
            throw stateChanged();
          }
          const conflicts = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(inArray(assets.id, parsed.assets.map((asset) => asset.assetId)));
          if (conflicts.length > 0) throw invalidPreview();

          const oldDerived = await tx
            .select({ objectKey: assets.objectKey })
            .from(assets)
            .where(
              and(
                eq(assets.ownerId, identity.ownerId),
                eq(assets.patternId, identity.patternId),
                inArray(assets.role, ["preview", "thumbnail"]),
              ),
            )
            .for("update");
          await tx
            .delete(assets)
            .where(
              and(
                eq(assets.ownerId, identity.ownerId),
                eq(assets.patternId, identity.patternId),
                inArray(assets.role, ["preview", "thumbnail"]),
              ),
            );
          const timestamp = now();
          const inserted = await tx
            .insert(assets)
            .values(
              verified.map(({ asset, mimeType }) => ({
                id: asset.assetId,
                ownerId: identity.ownerId,
                patternId: identity.patternId,
                role: asset.role,
                objectKey: asset.objectKey,
                originalFilename: `${asset.role}.${asset.extension}`,
                detectedMimeType: mimeType,
                sizeBytes: BigInt(asset.sizeBytes),
                width: asset.width,
                height: asset.height,
                createdAt: timestamp,
                updatedAt: timestamp,
              })),
            )
            .returning();
          const seq = await nextChangeSeq(tx, identity.ownerId);
          const [updated] = await tx
            .update(patterns)
            .set({
              previewStatus: "manual",
              version: sql`${patterns.version} + 1`,
              changeSeq: seq,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(patterns.ownerId, identity.ownerId),
                eq(patterns.id, identity.patternId),
                eq(patterns.version, parsed.version),
              ),
            )
            .returning();
          if (!updated) throw stateChanged();
          const result: CompletionResult = {
            pattern: {
              id: updated.id,
              version: updated.version,
              previewStatus: "manual",
              updatedAt: updated.updatedAt.toISOString(),
            },
            assets: inserted.map((asset) => ({
              id: asset.id,
              role: asset.role as "preview" | "thumbnail",
              width: asset.width!,
              height: asset.height!,
            })),
          };
          await tx.insert(changeLog).values({
            ownerId: identity.ownerId,
            seq,
            operationId: parsed.operationId,
            entityType: "pattern",
            entityId: identity.patternId,
            operation: "pattern.preview-replaced",
            payload: { pattern: result.pattern, assets: result.assets },
            createdAt: timestamp,
          });
          await tx
            .update(uploadSessions)
            .set({ status: "completed", updatedAt: timestamp })
            .where(
              and(
                eq(uploadSessions.ownerId, identity.ownerId),
                eq(uploadSessions.id, parsed.operationId),
              ),
            );
          await storeOperationResult(identity.ownerId, tx, parsed.operationId, {
            ...lifecycle,
            completion: {
              fingerprint,
              claimId,
              state: "verifying",
              result,
            },
            ...(oldDerived.length > 0
              ? {
                  cleanup: {
                    objectKeys: oldDerived.map((asset) => asset.objectKey),
                  },
                }
              : {}),
          });
          return {
            result,
            oldObjectKeys: oldDerived.map((asset) => asset.objectKey),
          };
        });
        oldObjectKeys = committed.oldObjectKeys;
        if (oldObjectKeys.length > 0) {
          await retryCleanupOperation(identity.ownerId, parsed.operationId);
        }
        return committed.result;
      } catch (error) {
        const scheduled = await scheduleCleanup({
          ...identity,
          operationId: parsed.operationId,
          claimId,
          fingerprint,
          leaseStatus: "failed",
        });
        if (scheduled === "scheduled") {
          await retryCleanupOperation(identity.ownerId, parsed.operationId);
        }
        throw error;
      }
    },

    async cancel(input: {
      ownerId: string;
      patternId: string;
      input: ManualPreviewCancelInput;
    }) {
      const identity = parseIdentity(input.ownerId, input.patternId);
      const parsed = parseManualPreviewCancel(input.input);
      const scheduled = await scheduleCleanup({
        ...identity,
        operationId: parsed.operationId,
        leaseStatus: "aborted",
      });
      if (scheduled === "missing") throw operationMismatch();
      if (scheduled === "complete") return { state: "complete" as const };
      if (scheduled === "busy") return { state: "verifying" as const };
      const cleanup = await retryCleanupOperation(
        identity.ownerId,
        parsed.operationId,
      );
      return {
        state:
          cleanup === "cleaned"
            ? ("cancelled" as const)
            : ("cleanup_pending" as const),
      };
    },

    async cleanupPending(input: { limit: number }) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
        throw new Error("MANUAL_PREVIEW_CLEANUP_LIMIT_INVALID");
      }
      const pendingOperations = await database
        .select({
          ownerId: operations.ownerId,
          operationId: operations.operationId,
        })
        .from(operations)
        .where(
          and(
            like(operations.kind, "manual-preview.initialize:%"),
            sql`${operations.result} ? 'cleanup'`,
          ),
        )
        .limit(input.limit);
      let cleaned = 0;
      let pending = 0;
      const processedOperationIds = new Set<string>();
      for (const operation of pendingOperations) {
        processedOperationIds.add(operation.operationId);
        const result = await retryCleanupOperation(
          operation.ownerId,
          operation.operationId,
        );
        if (result === "cleaned") cleaned += 1;
        if (result === "pending") pending += 1;
      }

      const abandonedLeases = await database
        .select({
          ownerId: uploadSessions.ownerId,
          patternId: uploadSessions.patternId,
          operationId: uploadSessions.operationId,
          credentialIssueFenceAt: uploadSessions.credentialIssueFenceAt,
          credentialsExpireAt: uploadSessions.credentialsExpireAt,
          expiresAt: uploadSessions.expiresAt,
        })
        .from(uploadSessions)
        .where(
          and(
            inArray(uploadSessions.status, [
              "initialized",
              "uploading",
              "failed",
              "aborted",
            ]),
            sql`${uploadSessions.fileFingerprint} ->> 'kind' = 'manual-preview'`,
          ),
        )
        .orderBy(asc(uploadSessions.updatedAt))
        .limit(500);
      const timestamp = now();
      for (const lease of abandonedLeases) {
        if (
          cleaned + pending >= input.limit ||
          processedOperationIds.has(lease.operationId)
        ) {
          continue;
        }
        const safeAfterCandidates = [
          lease.credentialIssueFenceAt,
          lease.credentialsExpireAt
            ? new Date(
                lease.credentialsExpireAt.getTime() +
                  UPLOAD_WRITE_DRAIN_GRACE_MS,
              )
            : null,
        ].filter((value): value is Date => value !== null);
        const safeAfter =
          safeAfterCandidates.length > 0
            ? new Date(
                Math.max(...safeAfterCandidates.map((value) => value.getTime())),
              )
            : lease.expiresAt;
        if (timestamp < safeAfter) continue;

        const scheduled = await scheduleCleanup({
          ownerId: lease.ownerId,
          patternId: lease.patternId,
          operationId: lease.operationId,
          allowStaleClaim: true,
          leaseStatus: "aborted",
        });
        if (scheduled !== "scheduled") continue;
        const result = await retryCleanupOperation(
          lease.ownerId,
          lease.operationId,
        );
        if (result === "cleaned") {
          cleaned += 1;
          await database
            .update(uploadSessions)
            .set({
              status: "expired",
              credentialIssueFenceAt: null,
              lastErrorCode: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(uploadSessions.ownerId, lease.ownerId),
                eq(uploadSessions.id, lease.operationId),
              ),
            );
        }
        if (result === "pending") pending += 1;
      }
      return { cleaned, pending };
    },
  };
}

let defaultService: ReturnType<typeof createManualPreviewService> | undefined;

function getDefaultService() {
  if (defaultService) return defaultService;
  const env = getServerEnv();
  const connection = {
    region: env.ALIYUN_OSS_REGION,
    bucket: env.ALIYUN_OSS_BUCKET,
    endpoint: env.ALIYUN_OSS_ENDPOINT,
    cname: env.ALIYUN_OSS_CNAME,
  };
  defaultService = createManualPreviewService({
    database: db,
    oss: createAlibabaOssAdapter(connection),
    credentialIssuer: createAlibabaBrowserCredentialIssuer({
      ...connection,
      roleArn: env.ALIYUN_STS_ROLE_ARN,
    }),
    now: () => new Date(),
  });
  return defaultService;
}

export const initializeManualPreview = (
  input: Parameters<ReturnType<typeof createManualPreviewService>["initialize"]>[0],
) => getDefaultService().initialize(input);

export const completeManualPreview = (
  input: Parameters<ReturnType<typeof createManualPreviewService>["complete"]>[0],
) => getDefaultService().complete(input);

export const cancelManualPreview = (
  input: Parameters<ReturnType<typeof createManualPreviewService>["cancel"]>[0],
) => getDefaultService().cancel(input);

export const cleanupPendingManualPreviews = (limit = 100) =>
  getDefaultService().cleanupPending({ limit });

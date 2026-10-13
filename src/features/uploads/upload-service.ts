import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { createAlibabaBrowserCredentialIssuer } from "@/features/storage/cloud-credentials";
import { lockFolderHierarchy } from "@/features/folders/folder-repository";
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
import { db, type DbTransaction } from "@/lib/db/client";
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
import { AppError, validationError } from "@/lib/http/app-error";

import {
  parseUploadCancel,
  parseUploadComplete,
  parseUploadCredentials,
  parseUploadInit,
  type UploadCancelInput,
  type UploadCompleteInput,
  type UploadCompletionAsset,
  type UploadInitInput,
  type UploadSourceExtension,
} from "./contracts";
import {
  detectFileSignature,
  requiredSignatureBytes,
  type DetectedFileSignature,
} from "./file-signatures";
import { derivePatternName, sanitizeDownloadName } from "./filenames";

const UPLOAD_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 10_000;
const CLEANUP_WARNING = "UPLOAD_MULTIPART_CLEANUP_PENDING" as const;

type UploadDatabase = typeof db;
type PatternRow = typeof patterns.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type UploadSessionRow = typeof uploadSessions.$inferSelect;

type InitializedReplay = {
  operationId: string;
  pattern: ReturnType<typeof toPatternDto>;
  sourceAsset: ReturnType<typeof toAssetDto>;
  session: ReturnType<typeof toSessionDto>;
};

type CompletionResult = {
  pattern: ReturnType<typeof toPatternDto>;
  assets: ReturnType<typeof toAssetDto>[];
  session: ReturnType<typeof toSessionDto>;
};

type CancelResult = {
  session: ReturnType<typeof toSessionDto>;
  warning: typeof CLEANUP_WARNING | null;
};

type LifecycleOperationResult = {
  initialized: InitializedReplay;
  completion?: {
    fingerprint: string;
    result?: CompletionResult;
  };
  cancellation?: CancelResult;
};

type UploadServiceDependencies = {
  database: UploadDatabase;
  oss: OssAdapter;
  credentialIssuer: BrowserCredentialIssuer;
  now: () => Date;
  verificationTimeoutMs?: number;
  credentialIssueTimeoutMs?: number;
};

type ServiceOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

function toPatternDto(row: PatternRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    originalFilename: row.originalFilename,
    extension: row.extension,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes.toString(),
    contentHash: row.contentHash,
    status: row.status,
    previewStatus: row.previewStatus,
    isFavorite: row.isFavorite,
    version: row.version,
    commercialVersion: row.commercialVersion,
    lastErrorCode: row.lastErrorCode,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAssetDto(row: AssetRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    patternId: row.patternId,
    role: row.role,
    objectKey: row.objectKey,
    originalFilename: row.originalFilename,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes.toString(),
    width: row.width,
    height: row.height,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSessionDto(row: UploadSessionRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    patternId: row.patternId,
    operationId: row.operationId,
    sourceObjectKey: row.sourceObjectKey,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseOwnerId(ownerId: string) {
  const parsed = normalizedUuidSchema.safeParse(ownerId);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function notFound(entity: "session" | "asset") {
  return new AppError(
    "NOT_FOUND",
    404,
    entity === "session" ? "Upload session not found" : "Asset not found",
  );
}

function operationMismatch() {
  return new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used with different input",
  );
}

function invalidUploadObject() {
  return new AppError(
    "UPLOAD_OBJECT_INVALID",
    422,
    "Upload object is invalid",
  );
}

function invalidSessionState() {
  return new AppError(
    "UPLOAD_SESSION_INVALID_STATE",
    409,
    "Upload session is not active",
  );
}

function uploadPatternClosed(status: PatternRow["status"]) {
  return status === "trashed" || status === "deleting" || status === "deleted";
}

function expiredSession() {
  return new AppError(
    "UPLOAD_SESSION_EXPIRED",
    410,
    "Upload session has expired",
  );
}

function credentialFailure() {
  return new AppError(
    "UPLOAD_CREDENTIALS_UNAVAILABLE",
    503,
    "Upload credentials are temporarily unavailable",
  );
}

function storageFailure() {
  return new AppError(
    "UPLOAD_STORAGE_UNAVAILABLE",
    503,
    "Upload storage is temporarily unavailable",
  );
}

function uploadIdConflict() {
  return new AppError(
    "UPLOAD_ID_CONFLICT",
    409,
    "Upload identifier is already in use",
  );
}

function postgresConstraint(error: unknown) {
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) return undefined;
    if ("code" in candidate && candidate.code === "23505") {
      return "constraint_name" in candidate &&
        typeof candidate.constraint_name === "string"
        ? candidate.constraint_name
        : undefined;
    }
    if (!("cause" in candidate)) return undefined;
    candidate = candidate.cause;
  }
  return undefined;
}

function isClientUploadIdConflict(error: unknown) {
  return ["patterns_pkey", "assets_pkey"].includes(
    postgresConstraint(error) ?? "",
  );
}

function formatUuid(bytes: Uint8Array) {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uploadLifecycleEventId(
  operationId: string,
  stage: "completed" | "cancelled",
) {
  const normalized = normalizedUuidSchema.parse(operationId);
  const digest = createHash("sha256")
    .update(`melon:upload-lifecycle-event:v1:${stage}:${normalized}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function lifecycleResult(value: Record<string, unknown>): LifecycleOperationResult {
  const initialized = value.initialized;
  if (typeof initialized !== "object" || initialized === null) {
    throw new Error("UPLOAD_OPERATION_RESULT_INVALID");
  }
  return value as LifecycleOperationResult;
}

async function lockOwnedSession(
  tx: DbTransaction,
  ownerId: string,
  sessionId: string,
) {
  const [session] = await tx
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerId, ownerId),
        eq(uploadSessions.id, sessionId),
      ),
    )
    .limit(1)
    .for("update");
  return session;
}

async function lockOwnedUploadState(
  tx: DbTransaction,
  ownerId: string,
  sessionId: string,
) {
  await lockFolderHierarchy(ownerId, tx);
  const [candidate] = await tx
    .select({ patternId: uploadSessions.patternId })
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerId, ownerId),
        eq(uploadSessions.id, sessionId),
      ),
    )
    .limit(1);
  if (!candidate) return undefined;

  const [pattern] = await tx
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, candidate.patternId),
      ),
    )
    .limit(1)
    .for("update");
  const session = await lockOwnedSession(tx, ownerId, sessionId);
  if (!pattern || !session || session.patternId !== pattern.id) {
    throw new Error("UPLOAD_STATE_INVALID");
  }
  return { pattern, session };
}

function credentialIssueFence(now: Date, credentialIssueTimeoutMs: number) {
  return new Date(
    now.getTime() +
      UPLOAD_CREDENTIAL_LIFETIME_MS +
      credentialIssueTimeoutMs +
      UPLOAD_WRITE_DRAIN_GRACE_MS,
  );
}

function credentialExpiration(value: string) {
  const expiration = new Date(value);
  if (!Number.isFinite(expiration.getTime())) throw credentialFailure();
  return expiration;
}

async function readLifecycleOperation(
  tx: DbTransaction,
  ownerId: string,
  operationId: string,
) {
  const [operation] = await tx
    .select({ result: operations.result })
    .from(operations)
    .where(
      and(
        eq(operations.ownerId, ownerId),
        eq(operations.operationId, operationId),
      ),
    )
    .limit(1);
  if (!operation) throw new Error("UPLOAD_OPERATION_MISSING");
  return lifecycleResult(operation.result);
}

async function persistFailure(
  tx: DbTransaction,
  session: UploadSessionRow,
  code: string,
  now: Date,
  status: "failed" | "expired" = "failed",
) {
  await tx
    .update(uploadSessions)
    .set({ status, lastErrorCode: code, updatedAt: now })
    .where(
      and(
        eq(uploadSessions.ownerId, session.ownerId),
        eq(uploadSessions.id, session.id),
      ),
    );
  await tx
    .update(patterns)
    .set({ status: "failed", lastErrorCode: code, updatedAt: now })
    .where(
      and(
        eq(patterns.ownerId, session.ownerId),
        eq(patterns.id, session.patternId),
      ),
    );
}

function sourceFingerprint(session: UploadSessionRow) {
  const value = session.fileFingerprint;
  if (
    typeof value.sourceAssetId !== "string" ||
    typeof value.extension !== "string" ||
    typeof value.originalFilename !== "string"
  ) {
    throw new Error("UPLOAD_FINGERPRINT_INVALID");
  }
  return value as {
    sourceAssetId: string;
    extension: UploadSourceExtension;
    originalFilename: string;
    contentHash?: string;
  };
}

function validateSubmittedAssets(
  ownerId: string,
  session: UploadSessionRow,
  input: UploadCompleteInput,
  sourceRow: AssetRow,
) {
  const fingerprint = sourceFingerprint(session);
  const source = input.assets.find((asset) => asset.role === "source")!;
  if (
    source.assetId !== fingerprint.sourceAssetId ||
    source.assetId !== sourceRow.id ||
    source.objectKey !== session.sourceObjectKey ||
    source.objectKey !== sourceRow.objectKey ||
    source.extension !== fingerprint.extension ||
    BigInt(source.sizeBytes) !== session.sizeBytes ||
    BigInt(source.sizeBytes) !== sourceRow.sizeBytes
  ) {
    throw invalidUploadObject();
  }

  for (const asset of input.assets) {
    const expected = storageObjectKey({
      ownerId,
      patternId: session.patternId,
      assetId: asset.assetId,
      role: asset.role,
      extension: asset.extension,
    });
    if (asset.objectKey !== expected) throw invalidUploadObject();
  }
}

async function verifyAsset(
  oss: OssAdapter,
  asset: UploadCompletionAsset,
): Promise<{ asset: UploadCompletionAsset; detected: DetectedFileSignature }> {
  let metadata: Awaited<ReturnType<OssAdapter["headObject"]>>;
  let bytes: Uint8Array;
  try {
    metadata = await oss.headObject(asset.objectKey);
    if (metadata.sizeBytes !== asset.sizeBytes) throw invalidUploadObject();
    const prefixLength = requiredSignatureBytes(asset.extension);
    bytes = await oss.readRange(asset.objectKey, 0, prefixLength - 1);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageFailure();
  }
  return {
    asset,
    detected: detectFileSignature(asset.extension, bytes),
  };
}

function mapVerificationError(error: unknown) {
  if (
    error instanceof AppError &&
    [
      "UPLOAD_OBJECT_INVALID",
      "UPLOAD_SIGNATURE_MISMATCH",
      "UPLOAD_STORAGE_UNAVAILABLE",
    ].includes(error.code)
  ) {
    return error;
  }
  return storageFailure();
}

async function issueCredentials(
  issuer: BrowserCredentialIssuer,
  ownerId: string,
  patternId: string,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(credentialFailure()), timeoutMs);
    });
    return await Promise.race([issuer.issue({ ownerId, patternId }), timeout]);
  } catch {
    throw credentialFailure();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function revalidateIssuedCredentials(
  database: UploadDatabase,
  ownerId: string,
  sessionId: string,
  operationId: string,
  expiration: string,
  now: () => Date,
) {
  return database.transaction<
    ServiceOutcome<{ session: ReturnType<typeof toSessionDto> }>
  >(async (tx) => {
    const issuedAt = now();
    const expiresAt = credentialExpiration(expiration);
    const state = await lockOwnedUploadState(tx, ownerId, sessionId);
    if (!state) return { ok: false, error: notFound("session") };
    const { pattern, session } = state;
    if (session.operationId !== operationId) {
      return { ok: false, error: operationMismatch() };
    }
    await tx
      .update(uploadSessions)
      .set({
        credentialIssueFenceAt: null,
        credentialsExpireAt:
          session.credentialsExpireAt && session.credentialsExpireAt > expiresAt
            ? session.credentialsExpireAt
            : expiresAt,
        updatedAt: issuedAt,
      })
      .where(
        and(
          eq(uploadSessions.ownerId, ownerId),
          eq(uploadSessions.id, sessionId),
        ),
      );
    if (uploadPatternClosed(pattern.status)) {
      return { ok: false, error: invalidSessionState() };
    }
    if (session.status === "completed" || session.status === "aborted") {
      return { ok: false, error: invalidSessionState() };
    }
    if (session.status === "expired" || now() >= session.expiresAt) {
      const timestamp = now();
      await persistFailure(
        tx,
        session,
        "UPLOAD_SESSION_EXPIRED",
        timestamp,
        "expired",
      );
      return { ok: false, error: expiredSession() };
    }
    if (session.status === "completing") {
      return { ok: false, error: invalidSessionState() };
    }
    if (expiresAt <= issuedAt) {
      return { ok: false, error: credentialFailure() };
    }
    return { ok: true, value: { session: toSessionDto(session) } };
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(storageFailure()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function completionFingerprint(input: UploadCompleteInput) {
  return createOperationKey("upload.complete", input.assets);
}

export function createUploadService(dependencies: UploadServiceDependencies) {
  const { database, oss, credentialIssuer, now } = dependencies;
  const verificationTimeoutMs =
    dependencies.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const credentialIssueTimeoutMs =
    dependencies.credentialIssueTimeoutMs ??
    UPLOAD_CREDENTIAL_ISSUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs <= 0) {
    throw new Error("UPLOAD_VERIFICATION_TIMEOUT_INVALID");
  }
  if (
    !Number.isSafeInteger(credentialIssueTimeoutMs) ||
    credentialIssueTimeoutMs <= 0
  ) {
    throw new Error("UPLOAD_CREDENTIAL_TIMEOUT_INVALID");
  }

  return {
    async initialize(input: { ownerId: string; input: UploadInitInput }) {
      const ownerId = parseOwnerId(input.ownerId);
      const parsed = parseUploadInit(input.input);
      const kind = createOperationKey("upload.initialize", {
        patternId: parsed.patternId,
        sourceAssetId: parsed.sourceAssetId,
        originalFilename: parsed.originalFilename,
        extension: parsed.extension,
        sizeBytes: parsed.sizeBytes,
        lastModified: parsed.lastModified,
        contentHash: parsed.contentHash,
      });

      let initializationOutcome: ServiceOutcome<InitializedReplay>;
      try {
        initializationOutcome = await database.transaction<
          ServiceOutcome<InitializedReplay>
        >(async (tx) => {
        const operation = await claimOperation(
          ownerId,
          tx,
          parsed.operationId,
          kind,
        );
        if (operation.state === "mismatch") throw operationMismatch();
        if (operation.state === "replay") {
          const replay = lifecycleResult(operation.result).initialized;
          const state = await lockOwnedUploadState(
            tx,
            ownerId,
            replay.session.id,
          );
          if (!state) throw new Error("UPLOAD_SESSION_MISSING");
          const { pattern, session } = state;
          if (uploadPatternClosed(pattern.status)) {
            return { ok: false, error: invalidSessionState() };
          }
          if (session.status === "completed" || session.status === "aborted") {
            return { ok: false, error: invalidSessionState() };
          }
          if (session.status === "expired" || now() >= session.expiresAt) {
            const timestamp = now();
            await persistFailure(
              tx,
              session,
              "UPLOAD_SESSION_EXPIRED",
              timestamp,
              "expired",
            );
            return { ok: false, error: expiredSession() };
          }
          await tx
            .update(uploadSessions)
            .set({
              credentialIssueFenceAt: credentialIssueFence(
                now(),
                credentialIssueTimeoutMs,
              ),
              updatedAt: now(),
            })
            .where(
              and(
                eq(uploadSessions.ownerId, ownerId),
                eq(uploadSessions.id, session.id),
              ),
            );
          return { ok: true, value: replay };
        }

        await lockFolderHierarchy(ownerId, tx);
        const timestamp = now();
        const sessionId = randomUUID();
        const expiresAt = new Date(
          timestamp.getTime() + UPLOAD_SESSION_DURATION_MS,
        );
        const objectKey = storageObjectKey({
          ownerId,
          patternId: parsed.patternId,
          assetId: parsed.sourceAssetId,
          role: "source",
          extension: parsed.extension,
        });
        const seq = await nextChangeSeq(tx, ownerId);
        const [pattern] = await tx
          .insert(patterns)
          .values({
            id: parsed.patternId,
            ownerId,
            name: derivePatternName(parsed.originalFilename),
            originalFilename: parsed.originalFilename,
            extension: parsed.extension,
            sizeBytes: BigInt(parsed.sizeBytes),
            contentHash: parsed.contentHash,
            status: "uploading",
            previewStatus: "pending",
            changeSeq: seq,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        const [sourceAsset] = await tx
          .insert(assets)
          .values({
            id: parsed.sourceAssetId,
            ownerId,
            patternId: parsed.patternId,
            role: "source",
            objectKey,
            originalFilename: parsed.originalFilename,
            sizeBytes: BigInt(parsed.sizeBytes),
            contentHash: parsed.contentHash,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        const [session] = await tx
          .insert(uploadSessions)
          .values({
            id: sessionId,
            ownerId,
            patternId: parsed.patternId,
            operationId: parsed.operationId,
            sourceObjectKey: objectKey,
            fileFingerprint: {
              sourceAssetId: parsed.sourceAssetId,
              originalFilename: parsed.originalFilename,
              extension: parsed.extension,
              sizeBytes: parsed.sizeBytes,
              lastModified: parsed.lastModified,
              contentHash: parsed.contentHash,
            },
            sizeBytes: BigInt(parsed.sizeBytes),
            status: "initialized",
            expiresAt,
            credentialIssueFenceAt: credentialIssueFence(
              timestamp,
              credentialIssueTimeoutMs,
            ),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        if (!pattern || !sourceAsset || !session) {
          throw new Error("UPLOAD_INITIALIZATION_FAILED");
        }
        const replay: InitializedReplay = {
          operationId: parsed.operationId,
          pattern: toPatternDto(pattern),
          sourceAsset: toAssetDto(sourceAsset),
          session: toSessionDto(session),
        };
        await tx.insert(changeLog).values({
          ownerId,
          seq,
          operationId: parsed.operationId,
          entityType: "pattern",
          entityId: parsed.patternId,
          operation: "upload.initialized",
          payload: { pattern: replay.pattern, sourceAsset: replay.sourceAsset },
          createdAt: timestamp,
        });
        await storeOperationResult(ownerId, tx, parsed.operationId, {
          initialized: replay,
        });
          return { ok: true, value: replay };
        });
      } catch (error) {
        if (isClientUploadIdConflict(error)) throw uploadIdConflict();
        throw error;
      }

      if (!initializationOutcome.ok) throw initializationOutcome.error;
      const initialized = initializationOutcome.value;

      const credentials = await issueCredentials(
        credentialIssuer,
        ownerId,
        initialized.pattern.id,
        credentialIssueTimeoutMs,
      );
      const revalidated = await revalidateIssuedCredentials(
        database,
        ownerId,
        initialized.session.id,
        initialized.operationId,
        credentials.expiration,
        now,
      );
      if (!revalidated.ok) throw revalidated.error;
      return { ...initialized, session: revalidated.value.session, credentials };
    },

    async refreshCredentials(input: {
      ownerId: string;
      sessionId: string;
      operationId: string;
    }) {
      const ownerId = parseOwnerId(input.ownerId);
      const sessionId = normalizedUuidSchema.parse(input.sessionId);
      const operationId = parseUploadCredentials({
        operationId: input.operationId,
      }).operationId;
      const outcome = await database.transaction<
        ServiceOutcome<{ session: ReturnType<typeof toSessionDto> }>
      >(async (tx) => {
        const state = await lockOwnedUploadState(tx, ownerId, sessionId);
        if (!state) return { ok: false, error: notFound("session") };
        const { pattern, session } = state;
        if (session.operationId !== operationId) {
          return { ok: false, error: operationMismatch() };
        }
        if (uploadPatternClosed(pattern.status)) {
          return { ok: false, error: invalidSessionState() };
        }
        if (session.status === "completed" || session.status === "aborted") {
          return { ok: false, error: invalidSessionState() };
        }
        if (session.status === "expired" || now() >= session.expiresAt) {
          const timestamp = now();
          await persistFailure(
            tx,
            session,
            "UPLOAD_SESSION_EXPIRED",
            timestamp,
            "expired",
          );
          return { ok: false, error: expiredSession() };
        }
        if (session.status === "completing") {
          return { ok: false, error: invalidSessionState() };
        }
        const timestamp = now();
        const [updated] = await tx
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
              eq(uploadSessions.ownerId, ownerId),
              eq(uploadSessions.id, sessionId),
            ),
          )
          .returning();
        await tx
          .update(patterns)
          .set({ status: "uploading", lastErrorCode: null, updatedAt: timestamp })
          .where(
            and(
              eq(patterns.ownerId, ownerId),
              eq(patterns.id, session.patternId),
            ),
          );
        if (!updated) throw new Error("UPLOAD_SESSION_UPDATE_FAILED");
        return { ok: true, value: { session: toSessionDto(updated) } };
      });
      if (!outcome.ok) throw outcome.error;
      const credentials = await issueCredentials(
        credentialIssuer,
        ownerId,
        outcome.value.session.patternId,
        credentialIssueTimeoutMs,
      );
      const revalidated = await revalidateIssuedCredentials(
        database,
        ownerId,
        sessionId,
        operationId,
        credentials.expiration,
        now,
      );
      if (!revalidated.ok) throw revalidated.error;
      return { ...revalidated.value, credentials };
    },

    async complete(input: {
      ownerId: string;
      sessionId: string;
      input: UploadCompleteInput;
    }) {
      const ownerId = parseOwnerId(input.ownerId);
      const sessionId = normalizedUuidSchema.parse(input.sessionId);
      const parsed = parseUploadComplete(input.input);
      const fingerprint = completionFingerprint(parsed);

      type Preparation =
        | { kind: "replay"; result: CompletionResult }
        | { kind: "verify" };

      const preparation = await database.transaction<
        ServiceOutcome<Preparation>
      >(async (tx) => {
        const state = await lockOwnedUploadState(tx, ownerId, sessionId);
        if (!state) return { ok: false, error: notFound("session") };
        const { pattern, session } = state;
        if (session.operationId !== parsed.operationId) {
          return { ok: false, error: operationMismatch() };
        }
        if (uploadPatternClosed(pattern.status)) {
          return { ok: false, error: invalidSessionState() };
        }
        const lifecycle = await readLifecycleOperation(
          tx,
          ownerId,
          session.operationId,
        );
        if (
          lifecycle.completion &&
          lifecycle.completion.fingerprint !== fingerprint
        ) {
          return { ok: false, error: operationMismatch() };
        }
        if (lifecycle.completion?.result) {
          return {
            ok: true,
            value: { kind: "replay", result: lifecycle.completion.result },
          };
        }
        if (session.status === "completed") {
          throw new Error("UPLOAD_COMPLETION_RESULT_MISSING");
        }
        if (session.status === "expired" || now() >= session.expiresAt) {
          await persistFailure(
            tx,
            session,
            "UPLOAD_SESSION_EXPIRED",
            now(),
            "expired",
          );
          return { ok: false, error: expiredSession() };
        }
        if (session.status === "aborted") {
          return { ok: false, error: invalidSessionState() };
        }

        const claimedLifecycle: LifecycleOperationResult = {
          ...lifecycle,
          completion: lifecycle.completion ?? { fingerprint },
        };
        await storeOperationResult(
          ownerId,
          tx,
          session.operationId,
          claimedLifecycle,
        );

        const [sourceRow] = await tx
          .select()
          .from(assets)
          .where(
            and(
              eq(assets.ownerId, ownerId),
              eq(assets.patternId, session.patternId),
              eq(assets.role, "source"),
            ),
          )
          .limit(1)
          .for("update");
        if (!sourceRow) throw new Error("UPLOAD_SOURCE_PLACEHOLDER_MISSING");

        try {
          validateSubmittedAssets(ownerId, session, parsed, sourceRow);
        } catch (error) {
          const mapped = mapVerificationError(error);
          await persistFailure(tx, session, mapped.code, now());
          return { ok: false, error: mapped };
        }

        const conflicts = await tx
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              inArray(
                assets.id,
                parsed.assets.map((asset) => asset.assetId),
              ),
              ne(assets.id, sourceRow.id),
            ),
          );
        if (conflicts.length > 0) {
          const error = invalidUploadObject();
          await persistFailure(tx, session, error.code, now());
          return { ok: false, error };
        }

        const timestamp = now();
        await tx
          .update(uploadSessions)
          .set({ status: "completing", lastErrorCode: null, updatedAt: timestamp })
          .where(
            and(
              eq(uploadSessions.ownerId, ownerId),
              eq(uploadSessions.id, session.id),
            ),
          );
        await tx
          .update(patterns)
          .set({ status: "processing", lastErrorCode: null, updatedAt: timestamp })
          .where(
            and(
              eq(patterns.ownerId, ownerId),
              eq(patterns.id, session.patternId),
            ),
          );
        return { ok: true, value: { kind: "verify" } };
      });
      if (!preparation.ok) throw preparation.error;
      if (preparation.value.kind === "replay") {
        return preparation.value.result;
      }

      const persistVerificationError = async (error: AppError) =>
        database.transaction<ServiceOutcome<CompletionResult>>(async (tx) => {
          const state = await lockOwnedUploadState(tx, ownerId, sessionId);
          if (!state) return { ok: false, error: notFound("session") };
          const { pattern, session } = state;
          if (session.operationId !== parsed.operationId) {
            return { ok: false, error: operationMismatch() };
          }
          if (uploadPatternClosed(pattern.status)) {
            return { ok: false, error: invalidSessionState() };
          }
          const lifecycle = await readLifecycleOperation(
            tx,
            ownerId,
            session.operationId,
          );
          if (lifecycle.completion?.fingerprint !== fingerprint) {
            return { ok: false, error: operationMismatch() };
          }
          if (lifecycle.completion.result) {
            return { ok: true, value: lifecycle.completion.result };
          }
          if (session.status === "completed") {
            throw new Error("UPLOAD_COMPLETION_RESULT_MISSING");
          }
          if (session.status === "expired" || now() >= session.expiresAt) {
            if (session.status !== "expired") {
              await persistFailure(
                tx,
                session,
                "UPLOAD_SESSION_EXPIRED",
                now(),
                "expired",
              );
            }
            return { ok: false, error: expiredSession() };
          }
          if (session.status === "aborted") {
            return { ok: false, error: invalidSessionState() };
          }
          await persistFailure(tx, session, error.code, now());
          return { ok: false, error };
        });

      let verified: Awaited<ReturnType<typeof verifyAsset>>[];
      try {
        verified = await withTimeout(
          Promise.all(parsed.assets.map((asset) => verifyAsset(oss, asset))),
          verificationTimeoutMs,
        );
      } catch (error) {
        const failure = await persistVerificationError(
          mapVerificationError(error),
        );
        if (!failure.ok) throw failure.error;
        return failure.value;
      }

      const outcome = await database.transaction<ServiceOutcome<CompletionResult>>(
        async (tx) => {
          const state = await lockOwnedUploadState(tx, ownerId, sessionId);
          if (!state) return { ok: false, error: notFound("session") };
          const { pattern, session } = state;
          if (session.operationId !== parsed.operationId) {
            return { ok: false, error: operationMismatch() };
          }
          if (uploadPatternClosed(pattern.status)) {
            return { ok: false, error: invalidSessionState() };
          }
          const lifecycle = await readLifecycleOperation(
            tx,
            ownerId,
            session.operationId,
          );
          if (lifecycle.completion?.fingerprint !== fingerprint) {
            return { ok: false, error: operationMismatch() };
          }
          if (lifecycle.completion.result) {
            return { ok: true, value: lifecycle.completion.result };
          }
          if (session.status === "completed") {
            throw new Error("UPLOAD_COMPLETION_RESULT_MISSING");
          }
          if (session.status === "expired" || now() >= session.expiresAt) {
            if (session.status !== "expired") {
              await persistFailure(
                tx,
                session,
                "UPLOAD_SESSION_EXPIRED",
                now(),
                "expired",
              );
            }
            return { ok: false, error: expiredSession() };
          }
          if (session.status === "aborted") {
            return { ok: false, error: invalidSessionState() };
          }
          if (session.status !== "completing" && session.status !== "failed") {
            return { ok: false, error: invalidSessionState() };
          }

          const [sourceRow] = await tx
            .select()
            .from(assets)
            .where(
              and(
                eq(assets.ownerId, ownerId),
                eq(assets.patternId, session.patternId),
                eq(assets.role, "source"),
              ),
            )
            .limit(1)
            .for("update");
          if (!sourceRow) throw new Error("UPLOAD_SOURCE_PLACEHOLDER_MISSING");
          try {
            validateSubmittedAssets(ownerId, session, parsed, sourceRow);
          } catch (error) {
            const mapped = mapVerificationError(error);
            await persistFailure(tx, session, mapped.code, now());
            return { ok: false, error: mapped };
          }
          const conflicts = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                inArray(
                  assets.id,
                  parsed.assets.map((asset) => asset.assetId),
                ),
                ne(assets.id, sourceRow.id),
              ),
            );
          if (conflicts.length > 0) {
            const error = invalidUploadObject();
            await persistFailure(tx, session, error.code, now());
            return { ok: false, error };
          }

          const timestamp = now();
          const sourceVerified = verified.find(
            (entry) => entry.asset.role === "source",
          )!;
          const derived = verified.filter(
            (entry) => entry.asset.role !== "source",
          );
          const seq = await nextChangeSeq(tx, ownerId);
          const [updatedSource] = await tx
            .update(assets)
            .set({
              detectedMimeType: sourceVerified.detected.mimeType,
              sizeBytes: BigInt(sourceVerified.asset.sizeBytes),
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(assets.ownerId, ownerId),
                eq(assets.id, sourceRow.id),
                eq(assets.patternId, session.patternId),
                eq(assets.role, "source"),
              ),
            )
            .returning();
          const insertedDerived = derived.length
            ? await tx
                .insert(assets)
                .values(
                  derived.map(({ asset, detected }) => ({
                    id: asset.assetId,
                    ownerId,
                    patternId: session.patternId,
                    role: asset.role,
                    objectKey: asset.objectKey,
                    originalFilename: `${asset.role}.${asset.extension}`,
                    detectedMimeType: detected.mimeType,
                    sizeBytes: BigInt(asset.sizeBytes),
                    width: asset.role === "source" ? null : asset.width,
                    height: asset.role === "source" ? null : asset.height,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })),
                )
                .returning()
            : [];
          const hasPreview = derived.some(
            (entry) => entry.asset.role === "preview",
          );
          const [updatedPattern] = await tx
            .update(patterns)
            .set({
              detectedMimeType: sourceVerified.detected.mimeType,
              status: "ready",
              previewStatus: hasPreview
                ? "ready"
                : ["jpg", "jpeg", "png"].includes(
                      sourceFingerprint(session).extension,
                    )
                  ? "pending"
                  : "unsupported",
              lastErrorCode: null,
              version: sql`${patterns.version} + 1`,
              changeSeq: seq,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(patterns.ownerId, ownerId),
                eq(patterns.id, session.patternId),
              ),
            )
            .returning();
          const [updatedSession] = await tx
            .update(uploadSessions)
            .set({ status: "completed", lastErrorCode: null, updatedAt: timestamp })
            .where(
              and(
                eq(uploadSessions.ownerId, ownerId),
                eq(uploadSessions.id, session.id),
              ),
            )
            .returning();
          if (!updatedSource || !updatedPattern || !updatedSession) {
            throw new Error("UPLOAD_COMPLETION_FAILED");
          }
          const result: CompletionResult = {
            pattern: toPatternDto(updatedPattern),
            assets: [updatedSource, ...insertedDerived].map(toAssetDto),
            session: toSessionDto(updatedSession),
          };
          await storeOperationResult(ownerId, tx, session.operationId, {
            ...lifecycle,
            completion: { fingerprint, result },
          });
          await tx.insert(changeLog).values({
            ownerId,
            seq,
            operationId: uploadLifecycleEventId(
              session.operationId,
              "completed",
            ),
            entityType: "pattern",
            entityId: session.patternId,
            operation: "upload.completed",
            payload: { pattern: result.pattern, assets: result.assets },
            createdAt: timestamp,
          });
          return { ok: true, value: result };
        },
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },

    async cancel(input: {
      ownerId: string;
      sessionId: string;
      input: UploadCancelInput;
    }) {
      const ownerId = parseOwnerId(input.ownerId);
      const sessionId = normalizedUuidSchema.parse(input.sessionId);
      const parsed = parseUploadCancel(input.input);
      const outcome = await database.transaction<ServiceOutcome<CancelResult>>(
        async (tx) => {
          const state = await lockOwnedUploadState(tx, ownerId, sessionId);
          if (!state) return { ok: false, error: notFound("session") };
          const { pattern, session } = state;
          if (session.operationId !== parsed.operationId) {
            return { ok: false, error: operationMismatch() };
          }
          if (uploadPatternClosed(pattern.status)) {
            return { ok: false, error: invalidSessionState() };
          }
          const lifecycle = await readLifecycleOperation(
            tx,
            ownerId,
            session.operationId,
          );
          if (lifecycle.cancellation) {
            return { ok: true, value: lifecycle.cancellation };
          }
          if (session.status === "completed") {
            return {
              ok: false,
              error: new AppError(
                "UPLOAD_CANNOT_CANCEL_COMPLETED",
                409,
                "Completed upload cannot be cancelled",
              ),
            };
          }
          const timestamp = now();
          const [updated] = await tx
            .update(uploadSessions)
            .set({
              status: "aborted",
              lastErrorCode: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(uploadSessions.ownerId, ownerId),
                eq(uploadSessions.id, session.id),
              ),
            )
            .returning();
          await tx
            .update(patterns)
            .set({
              status: "failed",
              lastErrorCode: "UPLOAD_ABORTED",
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(patterns.ownerId, ownerId),
                eq(patterns.id, session.patternId),
              ),
            );
          if (!updated) throw new Error("UPLOAD_CANCEL_FAILED");
          const result: CancelResult = {
            session: toSessionDto(updated),
            warning:
              parsed.multipartAbort?.attempted === true &&
              parsed.multipartAbort.succeeded
                ? null
                : CLEANUP_WARNING,
          };
          await storeOperationResult(ownerId, tx, session.operationId, {
            ...lifecycle,
            cancellation: result,
          });
          const seq = await nextChangeSeq(tx, ownerId);
          await tx.insert(changeLog).values({
            ownerId,
            seq,
            operationId: uploadLifecycleEventId(
              session.operationId,
              "cancelled",
            ),
            entityType: "pattern",
            entityId: session.patternId,
            operation: "upload.cancelled",
            payload: { session: result.session, warning: result.warning },
            createdAt: timestamp,
          });
          return { ok: true, value: result };
        },
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },

    async signAssetDownload(input: { ownerId: string; assetId: string }) {
      return signAsset(database, oss, input, ["source"], 300);
    },

    async signAssetView(input: { ownerId: string; assetId: string }) {
      return signAsset(database, oss, input, ["preview", "thumbnail"], 60);
    },
  };
}

async function signAsset(
  database: UploadDatabase,
  oss: OssAdapter,
  input: { ownerId: string; assetId: string },
  allowedRoles: Array<"source" | "preview" | "thumbnail">,
  expiresSeconds: number,
) {
  const ownerId = parseOwnerId(input.ownerId);
  const assetId = normalizedUuidSchema.parse(input.assetId);
  const [asset] = await database
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.ownerId, ownerId),
        eq(assets.id, assetId),
        inArray(assets.role, allowedRoles),
      ),
    )
    .limit(1);
  if (!asset) throw notFound("asset");
  try {
    return {
      location: await oss.createSignedGet({
        key: asset.objectKey,
        filename: sanitizeDownloadName(asset.originalFilename, asset.objectKey),
        expiresSeconds,
      }),
    };
  } catch {
    throw storageFailure();
  }
}

let defaultService: ReturnType<typeof createUploadService> | undefined;

function getDefaultUploadService() {
  if (defaultService) return defaultService;
  const env = getServerEnv();
  const connection = {
    region: env.ALIYUN_OSS_REGION,
    bucket: env.ALIYUN_OSS_BUCKET,
    endpoint: env.ALIYUN_OSS_ENDPOINT,
    cname: env.ALIYUN_OSS_CNAME,
  };
  defaultService = createUploadService({
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

export const initializeUpload = (
  input: Parameters<ReturnType<typeof createUploadService>["initialize"]>[0],
) => getDefaultUploadService().initialize(input);

export const refreshUploadCredentials = (
  input: Parameters<
    ReturnType<typeof createUploadService>["refreshCredentials"]
  >[0],
) => getDefaultUploadService().refreshCredentials(input);

export const completeUpload = (
  input: Parameters<ReturnType<typeof createUploadService>["complete"]>[0],
) => getDefaultUploadService().complete(input);

export const cancelUpload = (
  input: Parameters<ReturnType<typeof createUploadService>["cancel"]>[0],
) => getDefaultUploadService().cancel(input);

export const signAssetDownload = (
  input: Parameters<
    ReturnType<typeof createUploadService>["signAssetDownload"]
  >[0],
) => getDefaultUploadService().signAssetDownload(input);

export const signAssetView = (
  input: Parameters<ReturnType<typeof createUploadService>["signAssetView"]>[0],
) => getDefaultUploadService().signAssetView(input);

export type UploadInitializationResponse = InitializedReplay & {
  credentials: BrowserOssCredentials;
};

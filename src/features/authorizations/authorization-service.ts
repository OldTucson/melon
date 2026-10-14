import "server-only";

import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { db, type DbTransaction } from "@/lib/db/client";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { changeLog } from "@/lib/db/schema";
import { AppError, validationError } from "@/lib/http/app-error";

import {
  advancePatternCommercialVersion,
  editAuthorizationRow,
  getAuthorizationReference,
  getAuthorizationSummaryRow,
  getCommercialPatternReadRow,
  getVisibleAuthorizationFieldRow,
  insertAuthorizationRow,
  listAuthorizationHistoryRows,
  listActiveAuthorizationRows,
  lockAuthorizationRow,
  lockCommercialPattern,
  setAuthorizationStatus,
  type AuthorizationRow,
  type CommercialPatternRow,
} from "./authorization-repository";
import { resolveCommercialState } from "./commercial-state";
import {
  authorizationCreateMutationSchema,
  authorizationEditMutationSchema,
  authorizationStatusMutationSchema,
  type AuthorizationDetails,
} from "./contracts";
import { parseAuthorizedOn } from "./dates";
import { formatFen, parseRmbToFen } from "./money";

type CreateAuthorizationInput = {
  ownerId: string;
  patternId: string;
  operationId: string;
  commercialVersion: number;
  kind: AuthorizationDetails["kind"];
  fieldId: string | null;
  licenseeName: string;
  priceYuan: string;
  authorizedOn: string;
  note: string | null;
  historyConfirmed: boolean;
};

type EditAuthorizationInput = Omit<
  CreateAuthorizationInput,
  "patternId"
> & {
  authorizationId: string;
  version: number;
};

type AuthorizationStatusInput = {
  ownerId: string;
  authorizationId: string;
  operationId: string;
  version: number;
  commercialVersion: number;
};

type PreparedAuthorization = Omit<AuthorizationDetails, "priceYuan"> & {
  priceFen: bigint;
};

export type AuthorizationDto = ReturnType<typeof toAuthorizationDto>;

const historyCursorSchema = z.object({
  authorizedOn: z.iso.date(),
  createdAt: z.string().datetime(),
  id: normalizedUuidSchema,
});

const authorizationHistoryQuerySchema = z.object({
  patternId: normalizedUuidSchema,
  includeVoid: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

function toAuthorizationDto(row: AuthorizationRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    patternId: row.patternId,
    operationId: row.operationId,
    kind: row.kind,
    fieldId: row.fieldId,
    fieldNameSnapshot: row.fieldNameSnapshot,
    licenseeName: row.licenseeName,
    priceFen: row.priceFen.toString(),
    priceYuan: formatFen(row.priceFen),
    authorizedOn: row.authorizedOn,
    note: row.note,
    status: row.status,
    version: row.version,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseOrValidationError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

function decodeHistoryCursor(value: string) {
  try {
    const parsed = historyCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return {
      authorizedOn: parsed.authorizedOn,
      createdAt: new Date(parsed.createdAt),
      id: parsed.id,
    };
  } catch {
    throw new AppError("INVALID_CURSOR", 400, "Invalid cursor");
  }
}

function encodeHistoryCursor(row: AuthorizationRow) {
  return Buffer.from(
    JSON.stringify({
      authorizedOn: row.authorizedOn,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}

function notFound(message = "Authorization not found"): never {
  throw new AppError("NOT_FOUND", 404, message);
}

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function patternNotActive(): never {
  throw new AppError(
    "PATTERN_NOT_ACTIVE",
    409,
    "Pattern is not active",
  );
}

function authorizationStateChanged(): never {
  throw new AppError(
    "AUTHORIZATION_STATE_CHANGED",
    409,
    "Authorization state changed",
  );
}

function fieldArchived(): never {
  throw new AppError(
    "AUTHORIZATION_FIELD_ARCHIVED",
    409,
    "Authorization field is archived",
  );
}

function prepareDetails(details: AuthorizationDetails): PreparedAuthorization {
  return {
    ...details,
    priceFen: parseRmbToFen(details.priceYuan),
    authorizedOn: parseAuthorizedOn(details.authorizedOn),
  };
}

function operationDetails(details: PreparedAuthorization) {
  return {
    kind: details.kind,
    fieldId: details.fieldId,
    licenseeName: details.licenseeName,
    priceFen: details.priceFen.toString(),
    authorizedOn: details.authorizedOn,
    note: details.note,
    historyConfirmed: details.historyConfirmed,
  };
}

function requireReadyCommercialPattern(
  pattern: CommercialPatternRow | undefined,
  commercialVersion: number,
) {
  if (!pattern) notFound("Pattern not found");
  if (pattern.status !== "ready") patternNotActive();
  if (pattern.commercialVersion !== commercialVersion) {
    authorizationStateChanged();
  }
  return pattern;
}

async function resolveField(
  ownerId: string,
  tx: DbTransaction,
  details: PreparedAuthorization | AuthorizationRow,
) {
  if (details.kind === "global_buyout") {
    return { fieldId: null, fieldNameSnapshot: null };
  }
  if (details.fieldId === null) throw validationError();

  const field = await getVisibleAuthorizationFieldRow(
    ownerId,
    tx,
    details.fieldId,
  );
  if (!field) notFound("Authorization field not found");
  if (field.status !== "active") fieldArchived();
  return { fieldId: field.id, fieldNameSnapshot: field.name };
}

function assertAuthorizationSetIsValid(input: {
  proposed: { kind: AuthorizationRow["kind"]; fieldId: string | null };
  active: AuthorizationRow[];
  historyConfirmed: boolean;
}) {
  const buyout = input.active.find((row) => row.kind === "global_buyout");
  if (buyout) {
    throw new AppError("PATTERN_BOUGHT_OUT", 409, "Pattern is bought out", {
      authorizationId: buyout.id,
    });
  }

  const fieldExclusive =
    input.proposed.fieldId === null
      ? undefined
      : input.active.find(
          (row) =>
            row.kind === "field_exclusive" &&
            row.fieldId === input.proposed.fieldId,
        );
  if (fieldExclusive) {
    throw new AppError(
      "AUTHORIZATION_FIELD_LOCKED",
      409,
      "Authorization field is exclusive",
      { authorizationId: fieldExclusive.id, fieldId: fieldExclusive.fieldId },
    );
  }

  const history =
    input.proposed.kind === "global_buyout"
      ? input.active
      : input.proposed.kind === "field_exclusive"
        ? input.active.filter(
            (row) => row.fieldId === input.proposed.fieldId,
          )
        : [];

  if (history.length > 0 && !input.historyConfirmed) {
    throw new AppError(
      "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
      409,
      "Authorization history confirmation is required",
      {
        activeCount: history.length,
        recent: history.slice(0, 3).map((row) => ({
          id: row.id,
          kind: row.kind,
          fieldId: row.fieldId,
          fieldNameSnapshot: row.fieldNameSnapshot,
          licenseeName: row.licenseeName,
          priceFen: row.priceFen.toString(),
          authorizedOn: row.authorizedOn,
        })),
      },
    );
  }
}

async function writeAuthorizationChange(
  tx: DbTransaction,
  input: {
    ownerId: string;
    seq: bigint;
    operationId: string;
    operation: string;
    authorization: AuthorizationDto;
    commercialVersion: number;
    now: Date;
  },
) {
  await tx.insert(changeLog).values({
    ownerId: input.ownerId,
    seq: input.seq,
    operationId: input.operationId,
    entityType: "authorization",
    entityId: input.authorization.id,
    operation: input.operation,
    payload: {
      authorization: input.authorization,
      commercialVersion: input.commercialVersion,
    },
    createdAt: input.now,
  });
}

async function finishCommercialMutation(
  tx: DbTransaction,
  input: {
    ownerId: string;
    patternId: string;
    expectedCommercialVersion: number;
    operationId: string;
    operation: string;
    authorization: AuthorizationRow;
    now: Date;
  },
) {
  const seq = await nextChangeSeq(tx, input.ownerId);
  const pattern = await advancePatternCommercialVersion(input.ownerId, tx, {
    patternId: input.patternId,
    commercialVersion: input.expectedCommercialVersion,
    changeSeq: seq,
    now: input.now,
  });
  if (!pattern) authorizationStateChanged();

  const result = toAuthorizationDto(input.authorization);
  await writeAuthorizationChange(tx, {
    ownerId: input.ownerId,
    seq,
    operationId: input.operationId,
    operation: input.operation,
    authorization: result,
    commercialVersion: pattern.commercialVersion,
    now: input.now,
  });
  await storeOperationResult(
    input.ownerId,
    tx,
    input.operationId,
    result,
  );
  return result;
}

export async function listAuthorizations(input: {
  ownerId: string;
  patternId: string;
  includeVoid?: boolean;
  limit?: number;
  cursor?: string;
}) {
  const query = parseOrValidationError(() =>
    authorizationHistoryQuerySchema.parse({
      patternId: input.patternId,
      includeVoid: input.includeVoid,
      limit: input.limit,
      cursor: input.cursor,
    }),
  );
  const pattern = await getCommercialPatternReadRow(
    input.ownerId,
    query.patternId,
  );
  if (!pattern) notFound("Pattern not found");

  const [rows, summary] = await Promise.all([
    listAuthorizationHistoryRows({
      ownerId: input.ownerId,
      patternId: query.patternId,
      includeVoid: query.includeVoid,
      limit: query.limit,
      cursor: query.cursor ? decodeHistoryCursor(query.cursor) : undefined,
    }),
    getAuthorizationSummaryRow(input.ownerId, query.patternId),
  ]);
  if (!summary) throw new Error("AUTHORIZATION_SUMMARY_MISSING");

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toAuthorizationDto),
    nextCursor: hasMore && last ? encodeHistoryCursor(last) : null,
    commercialVersion: pattern.commercialVersion,
    summary: {
      state: resolveCommercialState([
        ...(summary.hasStandard ? (["standard"] as const) : []),
        ...(summary.hasExclusive ? (["field_exclusive"] as const) : []),
        ...(summary.hasBuyout ? (["global_buyout"] as const) : []),
      ]),
      activeCount: summary.activeCount,
      revenueFen: summary.revenueFen,
    },
  };
}

export async function createAuthorization(input: CreateAuthorizationInput) {
  const patternId = parseOrValidationError(() =>
    normalizedUuidSchema.parse(input.patternId),
  );
  const mutation = parseOrValidationError(() =>
    authorizationCreateMutationSchema.parse({
      operationId: input.operationId,
      commercialVersion: input.commercialVersion,
      details: {
        kind: input.kind,
        fieldId: input.fieldId,
        licenseeName: input.licenseeName,
        priceYuan: input.priceYuan,
        authorizedOn: input.authorizedOn,
        note: input.note,
        historyConfirmed: input.historyConfirmed,
      },
    }),
  );
  const details = prepareDetails(mutation.details);
  const operationKey = createOperationKey("authorization.create", {
    patternId,
    commercialVersion: mutation.commercialVersion,
    ...operationDetails(details),
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return operation.result as AuthorizationDto;
    }
    if (operation.state === "mismatch") operationIdReused();

    requireReadyCommercialPattern(
      await lockCommercialPattern(input.ownerId, tx, patternId),
      mutation.commercialVersion,
    );
    const field = await resolveField(input.ownerId, tx, details);
    const active = await listActiveAuthorizationRows(
      input.ownerId,
      tx,
      patternId,
    );
    assertAuthorizationSetIsValid({
      proposed: { kind: details.kind, fieldId: field.fieldId },
      active,
      historyConfirmed: details.historyConfirmed,
    });

    const now = new Date();
    const created = await insertAuthorizationRow(input.ownerId, tx, {
      id: randomUUID(),
      patternId,
      operationId: mutation.operationId,
      kind: details.kind,
      ...field,
      licenseeName: details.licenseeName,
      priceFen: details.priceFen,
      authorizedOn: details.authorizedOn,
      note: details.note,
      now,
    });
    if (!created) throw new Error("AUTHORIZATION_CREATE_FAILED");

    return finishCommercialMutation(tx, {
      ownerId: input.ownerId,
      patternId,
      expectedCommercialVersion: mutation.commercialVersion,
      operationId: mutation.operationId,
      operation: "authorization.created",
      authorization: created,
      now,
    });
  });
}

export async function editAuthorization(input: EditAuthorizationInput) {
  const authorizationId = parseOrValidationError(() =>
    normalizedUuidSchema.parse(input.authorizationId),
  );
  const mutation = parseOrValidationError(() =>
    authorizationEditMutationSchema.parse({
      operationId: input.operationId,
      version: input.version,
      commercialVersion: input.commercialVersion,
      details: {
        kind: input.kind,
        fieldId: input.fieldId,
        licenseeName: input.licenseeName,
        priceYuan: input.priceYuan,
        authorizedOn: input.authorizedOn,
        note: input.note,
        historyConfirmed: input.historyConfirmed,
      },
    }),
  );
  const details = prepareDetails(mutation.details);
  const operationKey = createOperationKey("authorization.edit", {
    authorizationId,
    version: mutation.version,
    commercialVersion: mutation.commercialVersion,
    ...operationDetails(details),
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return operation.result as AuthorizationDto;
    }

    const reference = await getAuthorizationReference(
      input.ownerId,
      tx,
      authorizationId,
    );
    if (!reference) notFound();
    requireReadyCommercialPattern(
      await lockCommercialPattern(input.ownerId, tx, reference.patternId),
      mutation.commercialVersion,
    );
    const current = await lockAuthorizationRow(
      input.ownerId,
      tx,
      authorizationId,
    );
    if (!current) notFound();
    if (operation.state === "mismatch") operationIdReused();
    if (current.status !== "active" || current.version !== mutation.version) {
      authorizationStateChanged();
    }

    const field = await resolveField(input.ownerId, tx, details);
    const active = (
      await listActiveAuthorizationRows(
        input.ownerId,
        tx,
        reference.patternId,
      )
    ).filter((row) => row.id !== authorizationId);
    assertAuthorizationSetIsValid({
      proposed: { kind: details.kind, fieldId: field.fieldId },
      active,
      historyConfirmed: details.historyConfirmed,
    });

    const now = new Date();
    const edited = await editAuthorizationRow(input.ownerId, tx, {
      authorizationId,
      version: mutation.version,
      kind: details.kind,
      ...field,
      licenseeName: details.licenseeName,
      priceFen: details.priceFen,
      authorizedOn: details.authorizedOn,
      note: details.note,
      now,
    });
    if (!edited) authorizationStateChanged();

    return finishCommercialMutation(tx, {
      ownerId: input.ownerId,
      patternId: reference.patternId,
      expectedCommercialVersion: mutation.commercialVersion,
      operationId: mutation.operationId,
      operation: "authorization.updated",
      authorization: edited,
      now,
    });
  });
}

async function changeAuthorizationStatus(
  input: AuthorizationStatusInput,
  action: "void" | "restore",
) {
  const authorizationId = parseOrValidationError(() =>
    normalizedUuidSchema.parse(input.authorizationId),
  );
  const mutation = parseOrValidationError(() =>
    authorizationStatusMutationSchema.parse({
      operationId: input.operationId,
      version: input.version,
      commercialVersion: input.commercialVersion,
    }),
  );
  const operationKey = createOperationKey(`authorization.${action}`, {
    authorizationId,
    version: mutation.version,
    commercialVersion: mutation.commercialVersion,
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return operation.result as AuthorizationDto;
    }

    const reference = await getAuthorizationReference(
      input.ownerId,
      tx,
      authorizationId,
    );
    if (!reference) notFound();
    const pattern = await lockCommercialPattern(
      input.ownerId,
      tx,
      reference.patternId,
    );
    if (!pattern) notFound("Pattern not found");
    const current = await lockAuthorizationRow(
      input.ownerId,
      tx,
      authorizationId,
    );
    if (!current) notFound();
    if (operation.state === "mismatch") operationIdReused();

    const targetStatus = action === "void" ? "void" : "active";
    if (current.status === targetStatus) {
      const result = toAuthorizationDto(current);
      await storeOperationResult(
        input.ownerId,
        tx,
        mutation.operationId,
        result,
      );
      return result;
    }

    requireReadyCommercialPattern(pattern, mutation.commercialVersion);
    if (current.version !== mutation.version) authorizationStateChanged();

    if (action === "restore") {
      try {
        const field = await resolveField(input.ownerId, tx, current);
        const active = await listActiveAuthorizationRows(
          input.ownerId,
          tx,
          reference.patternId,
        );
        assertAuthorizationSetIsValid({
          proposed: { kind: current.kind, fieldId: field.fieldId },
          active,
          historyConfirmed: true,
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          [
            "AUTHORIZATION_FIELD_ARCHIVED",
            "AUTHORIZATION_FIELD_LOCKED",
            "PATTERN_BOUGHT_OUT",
          ].includes(error.code)
        ) {
          throw new AppError(
            "AUTHORIZATION_RESTORE_CONFLICT",
            409,
            "Authorization cannot be restored",
            { reason: error.code },
          );
        }
        throw error;
      }
    }

    const now = new Date();
    const updated = await setAuthorizationStatus(input.ownerId, tx, {
      authorizationId,
      version: mutation.version,
      from: current.status,
      to: targetStatus,
      now,
    });
    if (!updated) authorizationStateChanged();

    return finishCommercialMutation(tx, {
      ownerId: input.ownerId,
      patternId: reference.patternId,
      expectedCommercialVersion: mutation.commercialVersion,
      operationId: mutation.operationId,
      operation:
        action === "void"
          ? "authorization.voided"
          : "authorization.restored",
      authorization: updated,
      now,
    });
  });
}

export function voidAuthorization(input: AuthorizationStatusInput) {
  return changeAuthorizationStatus(input, "void");
}

export function restoreAuthorization(input: AuthorizationStatusInput) {
  return changeAuthorizationStatus(input, "restore");
}

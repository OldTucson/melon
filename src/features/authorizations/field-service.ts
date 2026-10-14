import "server-only";

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

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
  authorizationFieldArchiveMutationSchema,
  authorizationFieldCreateMutationSchema,
  normalizeAuthorizationFieldName,
} from "./contracts";
import {
  archiveAuthorizationFieldRow,
  findAuthorizationFieldByNormalizedName,
  insertAuthorizationFieldRow,
  listAuthorizationFieldRows,
  lockOwnedCustomAuthorizationField,
  type AuthorizationFieldRow,
} from "./field-repository";

export type AuthorizationFieldDto = ReturnType<typeof toAuthorizationFieldDto>;

function toAuthorizationFieldDto(row: AuthorizationFieldRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    scope: row.scope,
    name: row.name,
    normalizedName: row.normalizedName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
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

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function fieldExists(): never {
  throw new AppError(
    "AUTHORIZATION_FIELD_EXISTS",
    409,
    "Authorization field already exists",
  );
}

function fieldNotFound(): never {
  throw new AppError("NOT_FOUND", 404, "Authorization field not found");
}

function postgresUniqueConstraint(error: unknown) {
  let candidate = error;
  const seen = new Set<unknown>();

  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    if (
      "code" in candidate &&
      candidate.code === "23505" &&
      "constraint_name" in candidate &&
      typeof candidate.constraint_name === "string"
    ) {
      return candidate.constraint_name;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }

  return undefined;
}

async function writeFieldChange(
  tx: DbTransaction,
  input: {
    ownerId: string;
    seq: bigint;
    operationId: string;
    field: AuthorizationFieldDto;
    operation: "authorization_field.created" | "authorization_field.archived";
    now: Date;
  },
) {
  await tx.insert(changeLog).values({
    ownerId: input.ownerId,
    seq: input.seq,
    operationId: input.operationId,
    entityType: "authorization_field",
    entityId: input.field.id,
    operation: input.operation,
    payload: { field: input.field },
    createdAt: input.now,
  });
}

export async function listAuthorizationFields(input: {
  ownerId: string;
  includeArchived?: boolean;
}) {
  return (
    await listAuthorizationFieldRows(input.ownerId, {
      includeArchived: input.includeArchived,
    })
  ).map(toAuthorizationFieldDto);
}

export async function createAuthorizationField(input: {
  ownerId: string;
  operationId: string;
  name: string;
}) {
  const mutation = parseOrValidationError(() =>
    authorizationFieldCreateMutationSchema.parse({
      operationId: input.operationId,
      name: input.name,
    }),
  );
  const field = normalizeAuthorizationFieldName(mutation.name);
  const operationKey = createOperationKey("authorization-field.create", field);

  try {
    return await db.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        mutation.operationId,
        operationKey,
      );
      if (operation.state === "replay") {
        return operation.result as AuthorizationFieldDto;
      }
      if (operation.state === "mismatch") operationIdReused();

      const existing = await findAuthorizationFieldByNormalizedName(
        input.ownerId,
        tx,
        field.normalizedName,
      );
      if (existing) fieldExists();

      const now = new Date();
      const seq = await nextChangeSeq(tx, input.ownerId);
      const created = await insertAuthorizationFieldRow(input.ownerId, tx, {
        id: randomUUID(),
        ...field,
        now,
      });
      if (!created) throw new Error("AUTHORIZATION_FIELD_CREATE_FAILED");

      const result = toAuthorizationFieldDto(created);
      await writeFieldChange(tx, {
        ownerId: input.ownerId,
        seq,
        operationId: mutation.operationId,
        field: result,
        operation: "authorization_field.created",
        now,
      });
      await storeOperationResult(
        input.ownerId,
        tx,
        mutation.operationId,
        result,
      );
      return result;
    });
  } catch (error) {
    if (
      postgresUniqueConstraint(error) ===
      "authorization_fields_owner_name_unique"
    ) {
      fieldExists();
    }
    throw error;
  }
}

export async function archiveAuthorizationField(input: {
  ownerId: string;
  fieldId: string;
  operationId: string;
}) {
  const mutation = parseOrValidationError(() =>
    authorizationFieldArchiveMutationSchema.parse({
      operationId: input.operationId,
      fieldId: input.fieldId,
    }),
  );
  const operationKey = createOperationKey("authorization-field.archive", {
    fieldId: mutation.fieldId,
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return operation.result as AuthorizationFieldDto;
    }

    const existing = await lockOwnedCustomAuthorizationField(
      input.ownerId,
      tx,
      mutation.fieldId,
    );
    if (!existing) fieldNotFound();
    if (operation.state === "mismatch") operationIdReused();

    if (existing.status === "archived") {
      const result = toAuthorizationFieldDto(existing);
      await storeOperationResult(
        input.ownerId,
        tx,
        mutation.operationId,
        result,
      );
      return result;
    }

    const now = new Date();
    const seq = await nextChangeSeq(tx, input.ownerId);
    const archived = await archiveAuthorizationFieldRow(input.ownerId, tx, {
      fieldId: mutation.fieldId,
      now,
    });
    if (!archived) fieldNotFound();

    const result = toAuthorizationFieldDto(archived);
    await writeFieldChange(tx, {
      ownerId: input.ownerId,
      seq,
      operationId: mutation.operationId,
      field: result,
      operation: "authorization_field.archived",
      now,
    });
    await storeOperationResult(
      input.ownerId,
      tx,
      mutation.operationId,
      result,
    );
    return result;
  });
}


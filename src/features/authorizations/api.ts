import { readApiResponse } from "@/lib/query/client";

export type AuthorizationKind =
  | "standard"
  | "field_exclusive"
  | "global_buyout";
export type AuthorizationStatus = "active" | "void";
export type CommercialState =
  | "unlicensed"
  | "standard"
  | "field_exclusive"
  | "global_buyout";

export type AuthorizationFieldDto = {
  id: string;
  ownerId: string | null;
  scope: "system" | "custom";
  name: string;
  normalizedName: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type AuthorizationDto = {
  id: string;
  ownerId: string;
  patternId: string;
  operationId: string;
  kind: AuthorizationKind;
  fieldId: string | null;
  fieldNameSnapshot: string | null;
  licenseeName: string;
  priceFen: string;
  priceYuan: string;
  authorizedOn: string;
  note: string | null;
  status: AuthorizationStatus;
  version: number;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthorizationHistoryPage = {
  items: AuthorizationDto[];
  nextCursor: string | null;
  commercialVersion: number;
  summary: {
    state: CommercialState;
    activeCount: number;
    revenueFen: string;
  };
};

export type AuthorizationMutationInput = {
  operationId: string;
  commercialVersion: number;
  version?: number;
  kind: AuthorizationKind;
  fieldId: string | null;
  licenseeName: string;
  priceYuan: string;
  authorizedOn: string;
  note: string | null;
  historyConfirmed: boolean;
};

export async function fetchAuthorizationFields(includeArchived = false) {
  const suffix = includeArchived ? "?includeArchived=true" : "";
  return readApiResponse<AuthorizationFieldDto[]>(
    await fetch(`/api/authorization-fields${suffix}`),
  );
}

export async function createAuthorizationField(input: {
  operationId: string;
  name: string;
}) {
  return readApiResponse<AuthorizationFieldDto>(
    await fetch("/api/authorization-fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function archiveAuthorizationField(input: {
  fieldId: string;
  operationId: string;
}) {
  return readApiResponse<AuthorizationFieldDto>(
    await fetch(`/api/authorization-fields/${input.fieldId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: input.operationId }),
    }),
  );
}

export async function fetchAuthorizationHistory(input: {
  patternId: string;
  includeVoid: boolean;
  cursor?: string | null;
  limit?: number;
}) {
  const search = new URLSearchParams({
    includeVoid: String(input.includeVoid),
    limit: String(input.limit ?? 20),
  });
  if (input.cursor) search.set("cursor", input.cursor);
  return readApiResponse<AuthorizationHistoryPage>(
    await fetch(
      `/api/patterns/${input.patternId}/authorizations?${search.toString()}`,
    ),
  );
}

export async function createAuthorization(
  patternId: string,
  input: AuthorizationMutationInput,
) {
  const body = {
    operationId: input.operationId,
    commercialVersion: input.commercialVersion,
    kind: input.kind,
    fieldId: input.fieldId,
    licenseeName: input.licenseeName,
    priceYuan: input.priceYuan,
    authorizedOn: input.authorizedOn,
    note: input.note,
    historyConfirmed: input.historyConfirmed,
  };
  return readApiResponse<AuthorizationDto>(
    await fetch(`/api/patterns/${patternId}/authorizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function editAuthorization(
  authorizationId: string,
  input: AuthorizationMutationInput & { version: number },
) {
  return readApiResponse<AuthorizationDto>(
    await fetch(`/api/authorizations/${authorizationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function setAuthorizationStatus(input: {
  action: "void" | "restore";
  authorizationId: string;
  commercialVersion: number;
  operationId: string;
  version: number;
}) {
  return readApiResponse<AuthorizationDto>(
    await fetch(
      `/api/authorizations/${input.authorizationId}/${input.action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: input.operationId,
          version: input.version,
          commercialVersion: input.commercialVersion,
        }),
      },
    ),
  );
}

export function formatFenForDisplay(value: string) {
  const fen = BigInt(value);
  const yuan = fen / 100n;
  const fraction = (fen % 100n).toString().padStart(2, "0");
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `¥${grouped}.${fraction}`;
}

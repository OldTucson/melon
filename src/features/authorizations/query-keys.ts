export const authorizationKeys = {
  all: (ownerId: string) => ["owner", ownerId, "authorizations"] as const,
  fieldsRoot: (ownerId: string) =>
    ["owner", ownerId, "authorization-fields"] as const,
  fields: (ownerId: string, includeArchived = false) =>
    ["owner", ownerId, "authorization-fields", { includeArchived }] as const,
  historyRoot: (ownerId: string, patternId: string) =>
    ["owner", ownerId, "authorizations", patternId] as const,
  history: (ownerId: string, patternId: string, includeVoid: boolean) =>
    [
      "owner",
      ownerId,
      "authorizations",
      patternId,
      { includeVoid },
    ] as const,
  dashboard: (ownerId: string) =>
    ["owner", ownerId, "authorization-dashboard"] as const,
};

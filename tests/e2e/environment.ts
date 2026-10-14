export const E2E_PORT = process.env.E2E_PORT ?? "3210";
if (!/^\d+$/.test(E2E_PORT) || Number(E2E_PORT) < 1 || Number(E2E_PORT) > 65535) {
  throw new Error("E2E_PORT_INVALID");
}
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://melon:melon@127.0.0.1:55432/melon_e2e";

export function e2eDatabaseName(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z0-9_]+_e2e$/.test(name)) {
    throw new Error("E2E_DATABASE_NAME_UNSAFE");
  }
  return name;
}
e2eDatabaseName(E2E_DATABASE_URL);

export const E2E_METADATA_ONLY = process.env.E2E_METADATA_ONLY === "1";

export function assertMetadataOnlyRows(rows: readonly unknown[], uploadRows: readonly unknown[] = []) {
  if (rows.length > 0 || uploadRows.length > 0) throw new Error("E2E_METADATA_ASSETS_PRESENT");
}

export const E2E_PASSWORD = "MelonE2E!2026";

export const E2E_USERS = {
  designer: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "e2e-designer@melon.local",
    displayName: "E2E Designer",
  },
  tenant: {
    id: "22222222-2222-4222-8222-222222222222",
    email: "e2e-tenant@melon.local",
    displayName: "E2E Tenant",
  },
} as const;

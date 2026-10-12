export const E2E_BASE_URL = "http://127.0.0.1:3210";
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://melon:melon@127.0.0.1:55432/melon_e2e";

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

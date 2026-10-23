import { describe, expect, it } from "vitest";

import {
  formatProductionReadinessErrors,
  formatServerEnvValidationError,
} from "./check-production";

describe("production preflight output", () => {
  it("prints only fixed readiness codes", () => {
    const output = formatProductionReadinessErrors([
      "APP_ORIGIN_HTTPS_REQUIRED",
      "AUTH_SECRET_PLACEHOLDER",
    ]);

    expect(output).toBe(
      "Production preflight: FAIL\n- APP_ORIGIN_HTTPS_REQUIRED\n- AUTH_SECRET_PLACEHOLDER",
    );
    for (const secret of [
      "super-secret-auth-value",
      "postgres://user:password@db.internal/melon_prod",
      "long-term-access-key",
      "internal-image-token",
      "https://example.test/file?Signature=signed-value",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("reduces malformed environment failures to safe field paths", () => {
    const output = formatServerEnvValidationError({
      issues: [
        {
          path: ["AUTH_SECRET"],
          message: "Invalid value super-secret-auth-value",
          input: "super-secret-auth-value",
        },
        {
          path: ["DATABASE_URL"],
          message: "Invalid URL postgres://user:password@db.internal/melon_prod",
          input: "postgres://user:password@db.internal/melon_prod",
        },
      ],
    });

    expect(output).toBe(
      "Production preflight: INVALID_ENV\n- AUTH_SECRET: invalid configuration\n- DATABASE_URL: invalid configuration",
    );
    expect(output).not.toMatch(/super-secret|postgres:\/\//i);
  });

  it("uses a generic message for unknown failures", () => {
    expect(formatServerEnvValidationError(new Error("private failure"))).toBe(
      "Production preflight: INVALID_ENV\n- environment: invalid configuration",
    );
  });
});

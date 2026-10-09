import { describe, expect, it } from "vitest";

import {
  hashPassword,
  passwordSchema,
  verifyPassword,
} from "@/features/auth/password";

describe("password security", () => {
  it("enforces the password length policy", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(
      passwordSchema.safeParse("correct horse battery staple").success,
    ).toBe(true);
  });

  it("hashes and verifies a valid password", async () => {
    const password = "correct horse battery staple";

    expect(await verifyPassword(password, await hashPassword(password))).toBe(
      true,
    );
  });
});

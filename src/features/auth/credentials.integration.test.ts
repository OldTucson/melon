import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { authorizeCredentials } from "@/features/auth/credentials";
import { hashPassword } from "@/features/auth/password";
import { closeDatabase, db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

describe("credentials authorization", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("normalizes valid credentials and gives every invalid account the same result", async () => {
    const password = "correct horse battery staple";
    const activeId = randomUUID();
    const disabledId = randomUUID();

    await db.insert(users).values([
      {
        id: activeId,
        email: "owner@example.test",
        displayName: "Library Owner",
        passwordHash: await hashPassword(password),
      },
      {
        id: disabledId,
        email: "disabled@example.test",
        displayName: "Disabled Owner",
        passwordHash: await hashPassword(password),
        status: "disabled",
      },
    ]);

    await expect(
      authorizeCredentials({
        email: "  OWNER@EXAMPLE.TEST  ",
        password,
      }),
    ).resolves.toEqual({
      id: activeId,
      email: "owner@example.test",
      name: "Library Owner",
      sessionVersion: 0,
    });

    await expect(
      authorizeCredentials({
        email: "owner@example.test",
        password: "this password is incorrect",
      }),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({
        email: "missing@example.test",
        password,
      }),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({
        email: "disabled@example.test",
        password,
      }),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({ email: "not-an-email", password }),
    ).resolves.toBeNull();
  });
});

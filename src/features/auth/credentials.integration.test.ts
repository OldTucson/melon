import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { authorizeCredentials } from "@/features/auth/credentials";
import { hashPassword } from "@/features/auth/password";
import { closeDatabase, db } from "@/lib/db/client";
import { authLoginRateLimits, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const trustedRequest = new Request("https://app.example.test/login", {
  headers: { "x-forwarded-for": "203.0.113.7" },
});

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
      }, trustedRequest),
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
      }, trustedRequest),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({
        email: "missing@example.test",
        password,
      }, trustedRequest),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({
        email: "disabled@example.test",
        password,
      }, trustedRequest),
    ).resolves.toBeNull();
    await expect(
      authorizeCredentials({ email: "not-an-email", password }, trustedRequest),
    ).resolves.toBeNull();
  });

  it("rejects a correct password after the account failure threshold", async () => {
    const password = "correct horse battery staple";
    await db.insert(users).values({
      id: randomUUID(),
      email: "owner@example.test",
      displayName: "Library Owner",
      passwordHash: await hashPassword(password),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        authorizeCredentials(
          { email: "owner@example.test", password: "wrong password" },
          trustedRequest,
        ),
      ).resolves.toBeNull();
    }

    await expect(
      authorizeCredentials(
        { email: "owner@example.test", password },
        trustedRequest,
      ),
    ).resolves.toBeNull();
  });

  it("clears account and IP failures after a successful login", async () => {
    const password = "correct horse battery staple";
    await db.insert(users).values({
      id: randomUUID(),
      email: "owner@example.test",
      displayName: "Library Owner",
      passwordHash: await hashPassword(password),
    });

    await authorizeCredentials(
      { email: "owner@example.test", password: "wrong password" },
      trustedRequest,
    );
    await expect(db.select().from(authLoginRateLimits)).resolves.toHaveLength(2);

    await expect(
      authorizeCredentials(
        { email: "owner@example.test", password },
        trustedRequest,
      ),
    ).resolves.toMatchObject({ email: "owner@example.test" });
    await expect(db.select().from(authLoginRateLimits)).resolves.toHaveLength(0);
  });

  it("creates only an IP bucket for an unknown account", async () => {
    await expect(
      authorizeCredentials(
        { email: "missing@example.test", password: "wrong password" },
        trustedRequest,
      ),
    ).resolves.toBeNull();

    await expect(
      db
        .select({ scope: authLoginRateLimits.scope })
        .from(authLoginRateLimits),
    ).resolves.toEqual([{ scope: "ip" }]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const userValues = (email: string) => ({
  id: randomUUID(),
  email: normalizeEmail(email),
  displayName: "Test User",
  passwordHash: "test-password-hash",
});

describe("users schema", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("applies account defaults", async () => {
    const [created] = await db
      .insert(users)
      .values(userValues("user@example.test"))
      .returning();

    expect(created).toMatchObject({
      role: "user",
      status: "active",
      themePreference: "system",
      syncSeq: 0n,
    });
  });

  it("enforces uniqueness for emails normalized before persistence", async () => {
    const canonicalEmail = "normalized@example.test";

    await db.insert(users).values(userValues(`  ${canonicalEmail.toUpperCase()}  `));

    await expect(
      db.insert(users).values(userValues(canonicalEmail)),
    ).rejects.toThrow();
  });
});

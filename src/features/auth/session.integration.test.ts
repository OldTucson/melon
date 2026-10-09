import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadSessionUser } from "@/features/auth/session";
import { closeDatabase, db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const insertUser = async (status: "active" | "disabled" = "active") => {
  const id = randomUUID();

  await db.insert(users).values({
    id,
    email: `${id}@example.test`,
    displayName: "Session User",
    passwordHash: "sensitive-password-hash",
    status,
  });

  return id;
};

describe("loadSessionUser", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("returns only the authenticated profile for a current active session", async () => {
    const id = await insertUser();

    const user = await loadSessionUser({ id, sessionVersion: 0 });

    expect(user).toEqual({
      id,
      email: `${id}@example.test`,
      displayName: "Session User",
      role: "user",
      mustChangePassword: true,
      themePreference: "system",
      sessionVersion: 0,
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects a token after its session version changes", async () => {
    const id = await insertUser();
    const token = { id, sessionVersion: 0 };

    expect(await loadSessionUser(token)).not.toBeNull();

    await db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, id));

    expect(await loadSessionUser(token)).toBeNull();
  });

  it("always rejects disabled users", async () => {
    const id = await insertUser("disabled");

    expect(await loadSessionUser({ id, sessionVersion: 0 })).toBeNull();
  });
});

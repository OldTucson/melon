import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyPassword } from "@/features/auth/password";
import { loadSessionUser } from "@/features/auth/session";
import {
  changeUserPassword,
  createUser,
  resetUserPassword,
} from "@/features/auth/user-admin";
import { closeDatabase, db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const originalPassword = "correct horse battery staple";
const replacementPassword = "an entirely new passphrase";

describe("account administration", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates a normalized private account with a forced password change", async () => {
    const created = await createUser({
      email: "  OWNER@Example.Test ",
      displayName: "Library Owner",
      password: originalPassword,
    });

    const [stored] = await db.select().from(users).where(eq(users.id, created.id));

    expect(created).toEqual({ id: stored?.id });
    expect(stored).toMatchObject({
      email: "owner@example.test",
      displayName: "Library Owner",
      mustChangePassword: true,
      sessionVersion: 0,
    });
    expect(
      await verifyPassword(originalPassword, stored?.passwordHash ?? ""),
    ).toBe(true);

    await expect(
      createUser({
        email: "OWNER@example.test",
        displayName: "Another Owner",
        password: originalPassword,
      }),
    ).rejects.toThrow("Unable to create account.");
  });

  it("resets a password and atomically invalidates earlier sessions", async () => {
    const created = await createUser({
      email: "owner@example.test",
      displayName: "Library Owner",
      password: originalPassword,
    });
    const oldToken = { id: created.id, sessionVersion: 0 };

    await resetUserPassword({
      email: " OWNER@EXAMPLE.TEST ",
      password: replacementPassword,
    });

    const [stored] = await db.select().from(users).where(eq(users.id, created.id));
    expect(stored).toMatchObject({
      mustChangePassword: true,
      sessionVersion: 1,
    });
    expect(
      await verifyPassword(replacementPassword, stored?.passwordHash ?? ""),
    ).toBe(true);
    expect(await loadSessionUser(oldToken)).toBeNull();
  });

  it("rejects current-password reuse without changing account or session state", async () => {
    const created = await createUser({
      email: "owner@example.test",
      displayName: "Library Owner",
      password: originalPassword,
    });
    const oldToken = { id: created.id, sessionVersion: 0 };
    const securityFields = {
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      sessionVersion: users.sessionVersion,
      updatedAt: users.updatedAt,
    };
    const [before] = await db
      .select(securityFields)
      .from(users)
      .where(eq(users.id, created.id));

    await expect(
      changeUserPassword({
        userId: created.id,
        currentPassword: originalPassword,
        newPassword: originalPassword,
      }),
    ).rejects.toThrow("Unable to change password.");

    const [after] = await db
      .select(securityFields)
      .from(users)
      .where(eq(users.id, created.id));
    expect(after).toEqual(before);
    expect(await loadSessionUser(oldToken)).not.toBeNull();
  });

  it("changes a verified password, clears the forced-change flag, and invalidates the session", async () => {
    const created = await createUser({
      email: "owner@example.test",
      displayName: "Library Owner",
      password: originalPassword,
    });
    const oldToken = { id: created.id, sessionVersion: 0 };

    await expect(
      changeUserPassword({
        userId: created.id,
        currentPassword: "wrong password value",
        newPassword: replacementPassword,
      }),
    ).rejects.toThrow("Unable to change password.");
    expect(await loadSessionUser(oldToken)).not.toBeNull();

    await changeUserPassword({
      userId: created.id,
      currentPassword: originalPassword,
      newPassword: replacementPassword,
    });

    const [stored] = await db.select().from(users).where(eq(users.id, created.id));
    expect(stored).toMatchObject({
      mustChangePassword: false,
      sessionVersion: 1,
    });
    expect(
      await verifyPassword(replacementPassword, stored?.passwordHash ?? ""),
    ).toBe(true);
    expect(await loadSessionUser(oldToken)).toBeNull();
  });
});

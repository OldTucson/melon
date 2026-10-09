import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const authenticated = vi.hoisted(() => ({
  user: {
    id: "",
    email: "owner@example.test",
    displayName: "Library Owner",
    role: "user" as const,
    mustChangePassword: false,
    themePreference: "system" as const,
    sessionVersion: 0,
  },
}));

const requireUser = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/session", () => ({
  requireUser,
}));

const readTheme = async (id: string) => {
  const [row] = await db
    .select({ themePreference: users.themePreference })
    .from(users)
    .where(eq(users.id, id));
  return row?.themePreference;
};

describe("PATCH /api/settings/theme", () => {
  beforeEach(async () => {
    await resetDatabase();
    requireUser.mockResolvedValue(authenticated.user);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("updates only the authenticated user's preference", async () => {
    const ownerId = randomUUID();
    const otherId = randomUUID();
    authenticated.user.id = ownerId;
    await db.insert(users).values([
      {
        id: ownerId,
        email: "owner@example.test",
        displayName: "Library Owner",
        passwordHash: "hash",
      },
      {
        id: otherId,
        email: "other@example.test",
        displayName: "Other Owner",
        passwordHash: "hash",
      },
    ]);
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost/api/settings/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: "dark" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ themePreference: "dark" });
    expect(await readTheme(ownerId)).toBe("dark");
    expect(await readTheme(otherId)).toBe("system");
  });

  it("rejects invalid or ownership-bearing payloads without updating data", async () => {
    const ownerId = randomUUID();
    authenticated.user.id = ownerId;
    await db.insert(users).values({
      id: ownerId,
      email: "owner@example.test",
      displayName: "Library Owner",
      passwordHash: "hash",
    });
    const { PATCH } = await import("./route");

    for (const body of [
      { themePreference: "blue" },
      { themePreference: "dark", userId: randomUUID() },
    ]) {
      const response = await PATCH(
        new Request("http://localhost/api/settings/theme", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "INVALID_THEME" });
    }

    expect(await readTheme(ownerId)).toBe("system");
  });

  it("authenticates before validating the request body", async () => {
    const { PATCH } = await import("./route");

    await PATCH(
      new Request("http://localhost/api/settings/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: "invalid" }),
      }),
    );

    expect(requireUser).toHaveBeenCalledTimes(1);
  });
});

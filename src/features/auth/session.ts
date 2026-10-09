import "server-only";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export type SessionToken = {
  id: string;
  sessionVersion: number;
};

export async function loadSessionUser(token: SessionToken) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
      themePreference: users.themePreference,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(
      and(
        eq(users.id, token.id),
        eq(users.status, "active"),
        eq(users.sessionVersion, token.sessionVersion),
      ),
    )
    .limit(1);

  return user ?? null;
}

export async function requireUser() {
  const { auth } = await import("@/auth");
  const session = await auth();
  const id = session?.user?.id;
  const sessionVersion = session?.user?.sessionVersion;

  if (!id || typeof sessionVersion !== "number") {
    redirect("/login");
  }

  const user = await loadSessionUser({ id, sessionVersion });
  if (!user) {
    redirect("/login");
  }

  return user;
}

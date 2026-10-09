import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  hashPassword,
  passwordSchema,
  verifyPassword,
} from "@/features/auth/password";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const displayNameSchema = z.string().trim().min(1).max(100);

const genericError = (operation: "create" | "reset" | "change") =>
  new Error(`Unable to ${operation} ${operation === "create" ? "account" : "password"}.`);

export async function createUser(input: {
  email: string;
  displayName: string;
  password: string;
}) {
  try {
    const email = emailSchema.parse(input.email);
    const displayName = displayNameSchema.parse(input.displayName);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        email,
        displayName,
        passwordHash,
        mustChangePassword: true,
      });
    });

    return { id };
  } catch {
    throw genericError("create");
  }
}

export async function resetUserPassword(input: {
  email: string;
  password: string;
}) {
  try {
    const email = emailSchema.parse(input.email);
    const passwordHash = await hashPassword(input.password);

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.email, email))
        .returning({ id: users.id });

      if (!updated) throw genericError("reset");
    });
  } catch {
    throw genericError("reset");
  }
}

export async function changeUserPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  try {
    const userId = z.string().uuid().parse(input.userId);
    const newPassword = passwordSchema.parse(input.newPassword);
    const passwordHash = await hashPassword(newPassword);

    await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.status, "active")))
        .for("update")
        .limit(1);

      if (
        !user ||
        !(await verifyPassword(input.currentPassword, user.passwordHash))
      ) {
        throw genericError("change");
      }

      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    });
  } catch {
    throw genericError("change");
  }
}

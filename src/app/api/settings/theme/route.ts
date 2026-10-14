import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireUser } from "@/features/auth/session";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

const themeInput = z
  .object({
    themePreference: z.enum(["system", "light", "dark"]),
  })
  .strict();

export async function PATCH(request: Request) {
  const user = await requireUser();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_THEME" }, { status: 400 });
  }

  const parsed = themeInput.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "INVALID_THEME" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set({
      themePreference: parsed.data.themePreference,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning({ themePreference: users.themePreference });

  if (!updated) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  return Response.json(updated);
}

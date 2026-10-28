import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/http/app-error";

// Preserve PostgreSQL's microseconds; JavaScript Date would truncate the seek key.
const timestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => {
    const milliseconds = value.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
    const date = new Date(milliseconds);
    return !value.startsWith("0000-") && !Number.isNaN(date.getTime()) && date.toISOString() === milliseconds;
  });
const cursorSchema = z.object({ updatedAt: timestampSchema, id: z.string().uuid() }).strict();
export type InspirationCursor = z.infer<typeof cursorSchema>;

export function encodeInspirationCursor(cursor: InspirationCursor) {
  return Buffer.from(JSON.stringify({ updatedAt: cursor.updatedAt, id: cursor.id })).toString("base64url");
}

export function decodeInspirationCursor(encoded: string): InspirationCursor {
  try {
    if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== encoded) throw new Error();
    return cursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppError("INSPIRATION_INVALID_INPUT", 400, "Invalid inspiration cursor");
  }
}

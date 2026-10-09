import "server-only";

import { z } from "zod";

import { patterns } from "@/lib/db/schema";
import { AppError } from "@/lib/http/app-error";

import type { PatternQuery } from "./contracts";

const uuidSchema = z.string().uuid();
const dateValueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => {
    const millisecondValue = value.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
    const date = new Date(millisecondValue);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString() === millisecondValue
    );
  });

const cursorSchema = z.discriminatedUnion("sort", [
  z
    .object({
      sort: z.literal("updated_desc"),
      value: dateValueSchema,
      id: uuidSchema,
    })
    .strict(),
  z
    .object({
      sort: z.literal("created_desc"),
      value: dateValueSchema,
      id: uuidSchema,
    })
    .strict(),
  z
    .object({
      sort: z.literal("name_asc"),
      value: z.string(),
      id: uuidSchema,
    })
    .strict(),
  z
    .object({
      sort: z.literal("size_desc"),
      value: z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n),
      id: uuidSchema,
    })
    .strict(),
]);

export type PatternCursor = z.output<typeof cursorSchema>;

type PatternCursorRow = typeof patterns.$inferSelect & {
  updatedCursorValue: string;
  createdCursorValue: string;
};

const invalidCursor = () =>
  new AppError("INVALID_CURSOR", 400, "Invalid cursor");

export function decodePatternCursor(
  encoded: string,
  expectedSort: PatternQuery["sort"],
): PatternCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalidCursor();

  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
      throw invalidCursor();
    }
    const cursor = cursorSchema.parse(JSON.parse(decoded));
    if (cursor.sort !== expectedSort) throw invalidCursor();
    return cursor;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidCursor();
  }
}

export function encodePatternCursor(
  row: PatternCursorRow,
  sort: PatternQuery["sort"],
) {
  const value =
    sort === "updated_desc"
      ? row.updatedCursorValue
      : sort === "created_desc"
        ? row.createdCursorValue
        : sort === "name_asc"
          ? row.name
          : row.sizeBytes.toString();

  return Buffer.from(JSON.stringify({ sort, value, id: row.id })).toString(
    "base64url",
  );
}

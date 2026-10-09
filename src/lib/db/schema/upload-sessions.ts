import {
  bigint,
  foreignKey,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { patterns } from "./patterns";
import { users } from "./users";

export const uploadStatuses = [
  "initialized",
  "uploading",
  "completing",
  "completed",
  "aborted",
  "expired",
  "failed",
] as const;

export const uploadStatusEnum = pgEnum("upload_status", uploadStatuses);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    patternId: uuid("pattern_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    sourceObjectKey: text("source_object_key").notNull(),
    ossUploadId: text("oss_upload_id"),
    fileFingerprint: jsonb("file_fingerprint")
      .$type<Record<string, unknown>>()
      .notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    status: uploadStatusEnum("status").notNull().default("initialized"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.patternId],
      foreignColumns: [patterns.ownerId, patterns.id],
      name: "upload_sessions_owner_pattern_patterns_owner_id_fk",
    }),
    unique("upload_sessions_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
  ],
);

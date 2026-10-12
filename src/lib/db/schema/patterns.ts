import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { folders } from "./folders";
import { users } from "./users";

export const patternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
  "trashed",
  "deleting",
  "deleted",
] as const;

export const previewStatuses = [
  "pending",
  "ready",
  "unsupported",
  "failed",
  "manual",
] as const;

export const patternStatusEnum = pgEnum("pattern_status", patternStatuses);
export const previewStatusEnum = pgEnum("preview_status", previewStatuses);

export const patterns = pgTable(
  "patterns",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    folderId: uuid("folder_id"),
    name: text("name").notNull(),
    originalFilename: text("original_filename").notNull(),
    extension: text("extension").notNull(),
    detectedMimeType: text("detected_mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    contentHash: text("content_hash"),
    status: patternStatusEnum("status").notNull().default("draft"),
    previewStatus: previewStatusEnum("preview_status")
      .notNull()
      .default("pending"),
    isFavorite: boolean("is_favorite").notNull().default(false),
    version: integer("version").notNull().default(0),
    commercialVersion: integer("commercial_version").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    trashBatchId: uuid("trash_batch_id"),
    preTrashStatus: patternStatusEnum("pre_trash_status"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    changeSeq: bigint("change_seq", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("patterns_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      name: "patterns_owner_folder_fk",
      columns: [table.ownerId, table.folderId],
      foreignColumns: [folders.ownerId, folders.id],
    }),
    index("patterns_owner_status_updated_id_idx").on(
      table.ownerId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("patterns_owner_folder_status_updated_idx").on(
      table.ownerId,
      table.folderId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("patterns_owner_trash_batch_idx").on(
      table.ownerId,
      table.trashBatchId,
    ),
    index("patterns_owner_name_id_idx").on(
      table.ownerId,
      table.name,
      table.id,
    ),
    index("patterns_owner_original_filename_id_idx").on(
      table.ownerId,
      table.originalFilename,
      table.id,
    ),
  ],
);

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const folderStatuses = [
  "active",
  "trashed",
  "deleting",
  "deleted",
] as const;

export const folderStatusEnum = pgEnum("folder_status", folderStatuses);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    status: folderStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    trashBatchId: uuid("trash_batch_id"),
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
    unique("folders_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      name: "folders_owner_parent_fk",
      columns: [table.ownerId, table.parentId],
      foreignColumns: [table.ownerId, table.id],
    }),
    check(
      "folders_parent_not_self",
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    uniqueIndex("folders_owner_root_name_live_unique")
      .on(table.ownerId, table.normalizedName)
      .where(
        sql`${table.parentId} is null and ${table.status} <> 'deleted'::folder_status`,
      ),
    uniqueIndex("folders_owner_parent_name_live_unique")
      .on(table.ownerId, table.parentId, table.normalizedName)
      .where(
        sql`${table.parentId} is not null and ${table.status} <> 'deleted'::folder_status`,
      ),
    index("folders_owner_parent_status_idx").on(
      table.ownerId,
      table.parentId,
      table.status,
    ),
    index("folders_owner_trash_batch_idx").on(
      table.ownerId,
      table.trashBatchId,
    ),
  ],
);

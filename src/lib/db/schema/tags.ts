import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { patterns } from "./patterns";
import { users } from "./users";

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    colorToken: text("color_token").notNull(),
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
    unique("tags_owner_id_id_unique").on(table.ownerId, table.id),
    uniqueIndex("tags_owner_normalized_name_active_unique")
      .on(table.ownerId, table.normalizedName)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const patternTags = pgTable(
  "pattern_tags",
  {
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(0),
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
    primaryKey({
      columns: [table.ownerId, table.patternId, table.tagId],
      name: "pattern_tags_owner_pattern_tag_pk",
    }),
    foreignKey({
      columns: [table.ownerId, table.patternId],
      foreignColumns: [patterns.ownerId, patterns.id],
      name: "pattern_tags_owner_pattern_patterns_owner_id_fk",
    }),
    foreignKey({
      columns: [table.ownerId, table.tagId],
      foreignColumns: [tags.ownerId, tags.id],
      name: "pattern_tags_owner_tag_tags_owner_id_fk",
    }),
  ],
);

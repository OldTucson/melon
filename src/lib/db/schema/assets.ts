import {
  bigint,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { patterns } from "./patterns";
import { users } from "./users";

export const assetRoles = ["source", "preview", "thumbnail"] as const;
export const assetRoleEnum = pgEnum("asset_role", assetRoles);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    patternId: uuid("pattern_id").notNull(),
    role: assetRoleEnum("role").notNull(),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    detectedMimeType: text("detected_mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    contentHash: text("content_hash"),
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
      name: "assets_owner_pattern_patterns_owner_id_fk",
    }),
    unique("assets_owner_pattern_role_unique").on(
      table.ownerId,
      table.patternId,
      table.role,
    ),
  ],
);

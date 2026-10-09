import {
  bigint,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const changeLog = pgTable(
  "change_log",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    operationId: uuid("operation_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: text("operation").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.seq],
      name: "change_log_owner_seq_pk",
    }),
    unique("change_log_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
  ],
);

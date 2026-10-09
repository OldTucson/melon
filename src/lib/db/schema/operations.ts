import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const operations = pgTable(
  "operations",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    operationId: uuid("operation_id").notNull(),
    kind: text("kind").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.operationId],
      name: "operations_owner_operation_pk",
    }),
  ],
);

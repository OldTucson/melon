import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const inspirationAnalysisStatuses = [
  "pending",
  "completed",
  "failed",
] as const;

export const inspirationAnalysisStatusEnum = pgEnum(
  "inspiration_analysis_status",
  inspirationAnalysisStatuses,
);

export const inspirationAnalyses = pgTable(
  "inspiration_analyses",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    prompt: text("prompt").notNull(),
    title: text("title").notNull(),
    status: inspirationAnalysisStatusEnum("status").notNull(),
    schemaVersion: text("schema_version")
      .notNull()
      .default("inspiration-analysis-v1"),
    sources: jsonb("sources").$type<unknown>(),
    result: jsonb("result").$type<unknown>(),
    searchModel: text("search_model").notNull(),
    structureModel: text("structure_model").notNull(),
    searchRequestId: text("search_request_id"),
    structureRequestId: text("structure_request_id"),
    errorCode: text("error_code"),
    shareId: uuid("share_id").unique("inspiration_analyses_share_id_unique"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("inspiration_analyses_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
    uniqueIndex("inspiration_analyses_owner_pending_unique")
      .on(table.ownerId)
      .where(sql`${table.status} = 'pending'`),
    index("inspiration_analyses_owner_updated_id_idx").on(
      table.ownerId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
    check(
      "inspiration_analyses_prompt_length_check",
      sql`char_length(${table.prompt}) between 5 and 1000`,
    ),
    check(
      "inspiration_analyses_title_length_check",
      sql`char_length(${table.title}) between 1 and 120`,
    ),
    check(
      "inspiration_analyses_share_state_check",
      sql`${table.shareId} is null or ${table.status} = 'completed'`,
    ),
    check(
      "inspiration_analyses_state_check",
      sql`(
        (${table.status} = 'pending'
          and ${table.result} is null
          and ${table.completedAt} is null
          and ${table.errorCode} is null)
        or (${table.status} = 'completed'
          and ${table.sources} is not null
          and ${table.result} is not null
          and ${table.completedAt} is not null
          and ${table.errorCode} is null)
        or (${table.status} = 'failed'
          and ${table.errorCode} is not null
          and ${table.result} is null)
      )`,
    ),
  ],
);

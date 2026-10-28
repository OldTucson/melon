import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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

import type { VisualWarning } from "@/features/inspiration-visuals/contracts";

import { inspirationAnalyses } from "./inspiration-analyses";
import { patterns } from "./patterns";
import { users } from "./users";

export const inspirationVisualJobKinds = [
  "research_visuals",
  "concept_image",
] as const;

export const inspirationVisualJobStatuses = [
  "pending",
  "completed",
  "failed",
] as const;

export const inspirationVisualAssetKinds = [
  "web_evidence",
  "library_match",
  "generated_concept",
] as const;

export const inspirationVisualJobKindEnum = pgEnum(
  "inspiration_visual_job_kind",
  inspirationVisualJobKinds,
);

export const inspirationVisualJobStatusEnum = pgEnum(
  "inspiration_visual_job_status",
  inspirationVisualJobStatuses,
);

export const inspirationVisualAssetKindEnum = pgEnum(
  "inspiration_visual_asset_kind",
  inspirationVisualAssetKinds,
);

export const inspirationVisualJobs = pgTable(
  "inspiration_visual_jobs",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => inspirationAnalyses.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    kind: inspirationVisualJobKindEnum("kind").notNull(),
    directionIndex: integer("direction_index"),
    status: inspirationVisualJobStatusEnum("status").notNull(),
    warnings: jsonb("warnings")
      .$type<VisualWarning[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    providerTaskId: text("provider_task_id"),
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("inspiration_visual_jobs_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
    unique("inspiration_visual_jobs_owner_analysis_id_unique").on(
      table.ownerId,
      table.analysisId,
      table.id,
    ),
    uniqueIndex("inspiration_visual_jobs_target_pending_unique")
      .on(
        table.analysisId,
        table.kind,
        sql`coalesce(${table.directionIndex}, -1)`,
      )
      .where(sql`${table.status} = 'pending'`),
    index("inspiration_visual_jobs_owner_analysis_kind_created_idx").on(
      table.ownerId,
      table.analysisId,
      table.kind,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "inspiration_visual_jobs_target_check",
      sql`(
        (${table.kind} = 'research_visuals' and ${table.directionIndex} is null)
        or (${table.kind} = 'concept_image'
          and ${table.directionIndex} is not null
          and ${table.directionIndex} between 0 and 4)
      )`,
    ),
    check(
      "inspiration_visual_jobs_state_check",
      sql`(
        (${table.status} = 'pending'
          and ${table.completedAt} is null
          and ${table.errorCode} is null)
        or (${table.status} = 'completed'
          and ${table.completedAt} is not null
          and ${table.errorCode} is null)
        or (${table.status} = 'failed'
          and ${table.completedAt} is not null
          and ${table.errorCode} is not null)
      )`,
    ),
    check(
      "inspiration_visual_jobs_metadata_length_check",
      sql`(${table.providerTaskId} is null or char_length(${table.providerTaskId}) between 1 and 500)
        and (${table.providerRequestId} is null or char_length(${table.providerRequestId}) between 1 and 500)
        and (${table.errorCode} is null or char_length(${table.errorCode}) between 1 and 100)`,
    ),
    check(
      "inspiration_visual_jobs_warnings_check",
      sql`jsonb_typeof(${table.warnings}) = 'array'
        and jsonb_array_length(${table.warnings}) <= 5`,
    ),
  ],
);

export const inspirationVisualAssets = pgTable(
  "inspiration_visual_assets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => inspirationAnalyses.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull(),
    kind: inspirationVisualAssetKindEnum("kind").notNull(),
    ordinal: integer("ordinal").notNull(),
    directionIndex: integer("direction_index"),
    title: text("title").notNull(),
    altText: text("alt_text").notNull(),
    sourcePageUrl: text("source_page_url"),
    sourceSiteName: text("source_site_name"),
    sourceQuery: text("source_query"),
    patternId: uuid("pattern_id"),
    savedPatternId: uuid("saved_pattern_id").references(() => patterns.id, {
      onDelete: "set null",
    }),
    saveOperationId: uuid("save_operation_id"),
    objectKey: text("object_key"),
    contentType: text("content_type"),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.analysisId, table.jobId],
      foreignColumns: [
        inspirationVisualJobs.ownerId,
        inspirationVisualJobs.analysisId,
        inspirationVisualJobs.id,
      ],
      name: "inspiration_visual_assets_owner_analysis_job_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.patternId],
      foreignColumns: [patterns.ownerId, patterns.id],
      name: "inspiration_visual_assets_owner_pattern_fk",
    }).onDelete("cascade"),
    unique("inspiration_visual_assets_job_kind_ordinal_unique").on(
      table.jobId,
      table.kind,
      table.ordinal,
    ),
    uniqueIndex("inspiration_visual_assets_owner_save_operation_unique")
      .on(table.ownerId, table.saveOperationId)
      .where(sql`${table.saveOperationId} is not null`),
    index("inspiration_visual_assets_owner_analysis_kind_ordinal_idx").on(
      table.ownerId,
      table.analysisId,
      table.kind,
      table.ordinal,
      table.id,
    ),
    index("inspiration_visual_assets_owner_job_kind_ordinal_idx").on(
      table.ownerId,
      table.jobId,
      table.kind,
      table.ordinal,
      table.id,
    ),
    check(
      "inspiration_visual_assets_ordinal_check",
      sql`${table.ordinal} between 0 and 100`,
    ),
    check(
      "inspiration_visual_assets_direction_check",
      sql`${table.directionIndex} is null or ${table.directionIndex} between 0 and 4`,
    ),
    check(
      "inspiration_visual_assets_display_length_check",
      sql`char_length(btrim(${table.title})) between 1 and 300
        and char_length(btrim(${table.altText})) between 1 and 500`,
    ),
    check(
      "inspiration_visual_assets_source_length_check",
      sql`(${table.sourcePageUrl} is null or char_length(${table.sourcePageUrl}) between 1 and 2048)
        and (${table.sourceSiteName} is null or char_length(btrim(${table.sourceSiteName})) between 1 and 120)
        and (${table.sourceQuery} is null or char_length(btrim(${table.sourceQuery})) between 1 and 300)`,
    ),
    check(
      "inspiration_visual_assets_storage_length_check",
      sql`(${table.objectKey} is null or char_length(${table.objectKey}) between 1 and 1024)
        and (${table.contentType} is null or char_length(${table.contentType}) between 1 and 100)`,
    ),
    check(
      "inspiration_visual_assets_dimensions_check",
      sql`(
        (${table.width} is null and ${table.height} is null)
        or (${table.width} is not null
          and ${table.height} is not null
          and ${table.width} between 1 and 32768
          and ${table.height} between 1 and 32768
          and ${table.width}::bigint * ${table.height}::bigint <= 40000000)
      )`,
    ),
    check(
      "inspiration_visual_assets_save_state_check",
      sql`${table.savedPatternId} is null or ${table.saveOperationId} is not null`,
    ),
    check(
      "inspiration_visual_assets_kind_check",
      sql`(
        (${table.kind} = 'web_evidence'
          and ${table.directionIndex} is null
          and ${table.sourcePageUrl} is not null
          and ${table.sourcePageUrl} ~ '^https://'
          and ${table.sourceSiteName} is not null
          and ${table.sourceQuery} is not null
          and ${table.patternId} is null
          and ${table.savedPatternId} is null
          and ${table.saveOperationId} is null
          and ${table.objectKey} is not null
          and ${table.contentType} is not null
          and ${table.width} is not null
          and ${table.height} is not null)
        or (${table.kind} = 'library_match'
          and ${table.patternId} is not null
          and ${table.savedPatternId} is null
          and ${table.saveOperationId} is null
          and ${table.sourcePageUrl} is null
          and ${table.sourceSiteName} is null
          and ${table.sourceQuery} is null
          and ${table.objectKey} is null
          and ${table.contentType} is null
          and ${table.width} is null
          and ${table.height} is null)
        or (${table.kind} = 'generated_concept'
          and ${table.directionIndex} is not null
          and ${table.directionIndex} between 0 and 4
          and ${table.patternId} is null
          and ${table.sourcePageUrl} is null
          and ${table.sourceSiteName} is null
          and ${table.sourceQuery} is null
          and ${table.objectKey} is not null
          and ${table.contentType} is not null
          and ${table.width} is not null
          and ${table.height} is not null)
      )`,
    ),
  ],
);

export type InspirationVisualJobRow =
  typeof inspirationVisualJobs.$inferSelect;
export type InspirationVisualAssetRow =
  typeof inspirationVisualAssets.$inferSelect;

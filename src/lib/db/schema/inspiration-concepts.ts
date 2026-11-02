import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { InspirationConceptBrief } from "@/features/inspiration-concepts/contracts";
import { inspirationAnalyses } from "./inspiration-analyses";
import { inspirationVisualAssets } from "./inspiration-visuals";
import { users } from "./users";

export const conceptOutputKinds = ["sketch", "effect", "flat"] as const;
export const conceptSetStatuses = [
  "queued",
  "generating",
  "partial",
  "completed",
  "failed",
  "deleting",
] as const;
export const conceptTaskStatuses = [
  "queued",
  "submitting",
  "submitted",
  "completed",
  "failed",
] as const;
export const inspirationConceptOutputKindEnum = pgEnum(
  "inspiration_concept_output_kind",
  conceptOutputKinds,
);
export const inspirationConceptSetStatusEnum = pgEnum(
  "inspiration_concept_set_status",
  conceptSetStatuses,
);
export const inspirationConceptTaskStatusEnum = pgEnum(
  "inspiration_concept_task_status",
  conceptTaskStatuses,
);

export const inspirationConceptSets = pgTable(
  "inspiration_concept_sets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    directionIndex: integer("direction_index").notNull(),
    version: integer("version").notNull(),
    status: inspirationConceptSetStatusEnum("status").notNull(),
    briefSnapshot: jsonb("brief_snapshot")
      .$type<InspirationConceptBrief>()
      .notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletionLeaseOwner: text("deletion_lease_owner"),
    deletionLeaseUntil: timestamp("deletion_lease_until", {
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      name: "inspiration_concept_sets_owner_analysis_fk",
      columns: [table.ownerId, table.analysisId],
      foreignColumns: [inspirationAnalyses.ownerId, inspirationAnalyses.id],
    }).onDelete("cascade"),
    unique("inspiration_concept_sets_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
    unique("inspiration_concept_sets_analysis_direction_version_unique").on(
      table.analysisId,
      table.directionIndex,
      table.version,
    ),
    unique("inspiration_concept_sets_owner_id_unique").on(
      table.ownerId,
      table.id,
    ),
    unique("inspiration_concept_sets_owner_analysis_id_unique").on(
      table.ownerId,
      table.analysisId,
      table.id,
    ),
    uniqueIndex("inspiration_concept_sets_active_direction_unique")
      .on(table.analysisId, table.directionIndex)
      .where(
        sql`${table.status} in ('queued', 'generating') and ${table.deletedAt} is null`,
      ),
    index("inspiration_concept_sets_owner_analysis_created_idx").on(
      table.ownerId,
      table.analysisId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "inspiration_concept_sets_direction_check",
      sql`${table.directionIndex} between 0 and 4`,
    ),
    check("inspiration_concept_sets_version_check", sql`${table.version} >= 1`),
    check(
      "inspiration_concept_sets_brief_check",
      sql`jsonb_typeof(${table.briefSnapshot}) = 'object'`,
    ),
    check(
      "inspiration_concept_sets_metadata_length_check",
      sql`char_length(btrim(${table.promptTemplateVersion})) between 1 and 100 and char_length(btrim(${table.model})) between 1 and 100`,
    ),
    check(
      "inspiration_concept_sets_state_check",
      sql`(${table.status} in ('queued', 'generating') and ${table.completedAt} is null) or (${table.status} in ('partial', 'completed', 'failed') and ${table.completedAt} is not null) or ${table.status} = 'deleting'`,
    ),
    check(
      "inspiration_concept_sets_deletion_check",
      sql`(${table.status} = 'deleting') = (${table.deletedAt} is not null)`,
    ),
    check(
      "inspiration_concept_sets_deletion_lease_check",
      sql`(${table.deletionLeaseOwner} is null and ${table.deletionLeaseUntil} is null) or (${table.status} = 'deleting' and ${table.deletionLeaseOwner} is not null and ${table.deletionLeaseUntil} is not null and char_length(btrim(${table.deletionLeaseOwner})) between 1 and 200)`,
    ),
  ],
);

export const inspirationConceptReferences = pgTable(
  "inspiration_concept_references",
  {
    ownerId: uuid("owner_id").notNull(),
    analysisId: uuid("analysis_id").notNull(),
    setId: uuid("set_id").notNull(),
    visualAssetId: uuid("visual_asset_id").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.setId, table.ordinal] }),
    unique("inspiration_concept_references_set_asset_unique").on(
      table.setId,
      table.visualAssetId,
    ),
    foreignKey({
      name: "inspiration_concept_references_owner_analysis_set_fk",
      columns: [table.ownerId, table.analysisId, table.setId],
      foreignColumns: [
        inspirationConceptSets.ownerId,
        inspirationConceptSets.analysisId,
        inspirationConceptSets.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "inspiration_concept_references_owner_analysis_asset_fk",
      columns: [table.ownerId, table.analysisId, table.visualAssetId],
      foreignColumns: [
        inspirationVisualAssets.ownerId,
        inspirationVisualAssets.analysisId,
        inspirationVisualAssets.id,
      ],
    }).onDelete("restrict"),
    index("inspiration_concept_references_asset_idx").on(table.visualAssetId),
    check(
      "inspiration_concept_references_ordinal_check",
      sql`${table.ordinal} between 0 and 2`,
    ),
  ],
);

export const inspirationConceptTasks = pgTable(
  "inspiration_concept_tasks",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    setId: uuid("set_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    outputKind: inspirationConceptOutputKindEnum("output_kind").notNull(),
    attempt: integer("attempt").notNull(),
    status: inspirationConceptTaskStatusEnum("status").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    providerTaskId: text("provider_task_id"),
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    submitStartedAt: timestamp("submit_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("inspiration_concept_tasks_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
    unique("inspiration_concept_tasks_set_kind_attempt_unique").on(
      table.setId,
      table.outputKind,
      table.attempt,
    ),
    unique("inspiration_concept_tasks_owner_set_id_unique").on(
      table.ownerId,
      table.setId,
      table.id,
    ),
    foreignKey({
      name: "inspiration_concept_tasks_owner_set_fk",
      columns: [table.ownerId, table.setId],
      foreignColumns: [
        inspirationConceptSets.ownerId,
        inspirationConceptSets.id,
      ],
    }).onDelete("cascade"),
    uniqueIndex("inspiration_concept_tasks_active_slot_unique")
      .on(table.setId, table.outputKind)
      .where(sql`${table.status} in ('queued', 'submitting', 'submitted')`),
    index("inspiration_concept_tasks_due_idx").on(
      table.status,
      table.availableAt,
      table.leaseUntil,
    ),
    check(
      "inspiration_concept_tasks_attempt_check",
      sql`${table.attempt} >= 1`,
    ),
    check(
      "inspiration_concept_tasks_state_check",
      sql`(
    (${table.status} = 'queued' and ${table.completedAt} is null and ${table.errorCode} is null and ${table.providerTaskId} is null and ${table.providerRequestId} is null and ${table.submitStartedAt} is null)
    or (${table.status} = 'submitting' and ${table.completedAt} is null and ${table.errorCode} is null and ${table.submitStartedAt} is not null and ${table.providerTaskId} is null and ${table.providerRequestId} is null)
    or (${table.status} = 'submitted' and ${table.completedAt} is null and ${table.errorCode} is null and ${table.submitStartedAt} is not null and ${table.providerTaskId} is not null)
    or (${table.status} = 'completed' and ${table.completedAt} is not null and ${table.errorCode} is null and ${table.submitStartedAt} is not null and ${table.providerTaskId} is not null and ${table.leaseOwner} is null and ${table.leaseUntil} is null)
    or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.errorCode} is not null and ${table.leaseOwner} is null and ${table.leaseUntil} is null)
  )`,
    ),
    check(
      "inspiration_concept_tasks_lease_check",
      sql`(${table.leaseOwner} is null and ${table.leaseUntil} is null) or (${table.leaseOwner} is not null and ${table.leaseUntil} is not null and char_length(btrim(${table.leaseOwner})) between 1 and 200)`,
    ),
    check(
      "inspiration_concept_tasks_metadata_length_check",
      sql`(${table.providerTaskId} is null or char_length(btrim(${table.providerTaskId})) between 1 and 500) and (${table.providerRequestId} is null or char_length(btrim(${table.providerRequestId})) between 1 and 500) and (${table.errorCode} is null or char_length(btrim(${table.errorCode})) between 1 and 100)`,
    ),
  ],
);

export const inspirationConceptOutputs = pgTable(
  "inspiration_concept_outputs",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    analysisId: uuid("analysis_id").notNull(),
    setId: uuid("set_id").notNull(),
    sourceTaskId: uuid("source_task_id").notNull(),
    outputKind: inspirationConceptOutputKindEnum("output_kind").notNull(),
    title: text("title").notNull(),
    altText: text("alt_text").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "inspiration_concept_outputs_owner_analysis_set_fk",
      columns: [table.ownerId, table.analysisId, table.setId],
      foreignColumns: [
        inspirationConceptSets.ownerId,
        inspirationConceptSets.analysisId,
        inspirationConceptSets.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "inspiration_concept_outputs_owner_set_task_fk",
      columns: [table.ownerId, table.setId, table.sourceTaskId],
      foreignColumns: [
        inspirationConceptTasks.ownerId,
        inspirationConceptTasks.setId,
        inspirationConceptTasks.id,
      ],
    }).onDelete("cascade"),
    unique("inspiration_concept_outputs_set_kind_unique").on(
      table.setId,
      table.outputKind,
    ),
    check(
      "inspiration_concept_outputs_display_length_check",
      sql`char_length(btrim(${table.title})) between 1 and 300 and char_length(btrim(${table.altText})) between 1 and 500`,
    ),
    check(
      "inspiration_concept_outputs_storage_check",
      sql`char_length(btrim(${table.objectKey})) between 1 and 1024 and ${table.contentType} = 'image/png'`,
    ),
    check(
      "inspiration_concept_outputs_dimensions_check",
      sql`(${table.outputKind} in ('sketch', 'effect') and ${table.width} = 1536 and ${table.height} = 2048) or (${table.outputKind} = 'flat' and ${table.width} = 2048 and ${table.height} = 1536)`,
    ),
  ],
);
export const inspirationConceptWorkerHeartbeats = pgTable(
  "inspiration_concept_worker_heartbeats",
  {
    workerId: text("worker_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "inspiration_concept_worker_heartbeats_worker_check",
      sql`char_length(btrim(${table.workerId})) between 1 and 200`,
    ),
  ],
);

export type InspirationConceptSetRow =
  typeof inspirationConceptSets.$inferSelect;
export type InspirationConceptReferenceRow =
  typeof inspirationConceptReferences.$inferSelect;
export type InspirationConceptTaskRow =
  typeof inspirationConceptTasks.$inferSelect;
export type InspirationConceptOutputRow =
  typeof inspirationConceptOutputs.$inferSelect;
export type InspirationConceptWorkerHeartbeatRow =
  typeof inspirationConceptWorkerHeartbeats.$inferSelect;

import { sql } from "drizzle-orm";
import {
  bit,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { assets } from "./assets";
import { patterns } from "./patterns";

export const visualSearchDocumentStatuses = [
  "pending",
  "indexing",
  "ready",
  "failed",
  "superseded",
] as const;

export const visualSearchJobStatuses = [
  "pending",
  "leased",
  "complete",
  "failed",
] as const;

export const visualSearchDocumentStatusEnum = pgEnum(
  "visual_search_document_status",
  visualSearchDocumentStatuses,
);

export const visualSearchJobStatusEnum = pgEnum(
  "visual_search_job_status",
  visualSearchJobStatuses,
);

export const visualSearchDocuments = pgTable(
  "visual_search_documents",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    previewAssetId: uuid("preview_asset_id").notNull(),
    previewHash: text("preview_hash").notNull(),
    indexVersion: text("index_version").notNull(),
    status: visualSearchDocumentStatusEnum("status").notNull(),
    phash: bit("phash", { dimensions: 64 }),
    width: integer("width"),
    height: integer("height"),
    localFeatureObjectKey: text("local_feature_object_key"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
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
      name: "visual_search_documents_owner_pattern_fk",
    }),
    foreignKey({
      columns: [table.ownerId, table.patternId, table.previewAssetId],
      foreignColumns: [assets.ownerId, assets.patternId, assets.id],
      name: "visual_search_documents_preview_fk",
    }).onDelete("cascade"),
    unique("visual_search_documents_identity_unique").on(
      table.id,
      table.ownerId,
      table.patternId,
    ),
    unique("visual_search_documents_fingerprint_unique").on(
      table.ownerId,
      table.patternId,
      table.indexVersion,
      table.previewHash,
    ),
    uniqueIndex("visual_search_documents_ready_unique")
      .on(table.ownerId, table.patternId, table.indexVersion)
      .where(sql`${table.status} = 'ready'`),
  ],
);

export const visualSearchEmbeddings = pgTable(
  "visual_search_embeddings",
  {
    documentId: uuid("document_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    regionIndex: integer("region_index").notNull(),
    regionKind: text("region_kind", { enum: ["global", "tile"] }).notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    width: real("width").notNull(),
    height: real("height").notNull(),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.regionIndex] }),
    foreignKey({
      columns: [table.documentId, table.ownerId, table.patternId],
      foreignColumns: [
        visualSearchDocuments.id,
        visualSearchDocuments.ownerId,
        visualSearchDocuments.patternId,
      ],
      name: "visual_search_embeddings_document_owner_fk",
    }).onDelete("cascade"),
    index("visual_search_embeddings_owner_pattern_idx").on(
      table.ownerId,
      table.patternId,
    ),
    index("visual_search_embeddings_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

export const visualSearchPaletteColors = pgTable(
  "visual_search_palette_colors",
  {
    documentId: uuid("document_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    colorIndex: integer("color_index").notNull(),
    displayHex: text("display_hex").notNull(),
    oklabL: real("oklab_l").notNull(),
    oklabA: real("oklab_a").notNull(),
    oklabB: real("oklab_b").notNull(),
    coverage: real("coverage").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.colorIndex] }),
    foreignKey({
      columns: [table.documentId, table.ownerId, table.patternId],
      foreignColumns: [
        visualSearchDocuments.id,
        visualSearchDocuments.ownerId,
        visualSearchDocuments.patternId,
      ],
      name: "visual_search_palette_colors_document_owner_fk",
    }).onDelete("cascade"),
    check(
      "visual_search_palette_colors_index_check",
      sql`${table.colorIndex} between 0 and 4`,
    ),
    check(
      "visual_search_palette_colors_hex_check",
      sql`${table.displayHex} ~ '^#[0-9A-F]{6}$'`,
    ),
    check(
      "visual_search_palette_colors_coverage_check",
      sql`${table.coverage} > 0 and ${table.coverage} <= 1`,
    ),
    check(
      "visual_search_palette_colors_oklab_check",
      sql`${table.oklabL} >= 0 and ${table.oklabL} <= 1
        and ${table.oklabA} >= -0.5 and ${table.oklabA} <= 0.5
        and ${table.oklabB} >= -0.5 and ${table.oklabB} <= 0.5`,
    ),
    index("visual_search_palette_colors_owner_pattern_idx").on(
      table.ownerId,
      table.patternId,
    ),
  ],
);

export const visualSearchJobs = pgTable(
  "visual_search_jobs",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    previewAssetId: uuid("preview_asset_id").notNull(),
    previewHash: text("preview_hash"),
    indexVersion: text("index_version").notNull(),
    status: visualSearchJobStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leasedBy: text("leased_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
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
      name: "visual_search_jobs_owner_pattern_fk",
    }),
    foreignKey({
      columns: [table.ownerId, table.patternId, table.previewAssetId],
      foreignColumns: [assets.ownerId, assets.patternId, assets.id],
      name: "visual_search_jobs_preview_fk",
    }).onDelete("cascade"),
    unique("visual_search_jobs_identity_unique").on(
      table.ownerId,
      table.patternId,
      table.previewAssetId,
      table.indexVersion,
    ),
    index("visual_search_jobs_status_available_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    index("visual_search_jobs_status_lease_until_idx").on(
      table.status,
      table.leaseUntil,
    ),
  ],
);

export const visualSearchWorkers = pgTable("visual_search_workers", {
  workerId: text("worker_id").primaryKey(),
  indexVersion: text("index_version").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

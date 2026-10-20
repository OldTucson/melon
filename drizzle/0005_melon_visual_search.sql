CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."visual_search_document_status" AS ENUM('pending', 'indexing', 'ready', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."visual_search_job_status" AS ENUM('pending', 'leased', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "visual_search_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"preview_asset_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"index_version" text NOT NULL,
	"status" "visual_search_document_status" NOT NULL,
	"phash" bit(64),
	"width" integer,
	"height" integer,
	"local_feature_object_key" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visual_search_documents_identity_unique" UNIQUE("id","owner_id","pattern_id"),
	CONSTRAINT "visual_search_documents_fingerprint_unique" UNIQUE("owner_id","pattern_id","index_version","preview_hash")
);
--> statement-breakpoint
CREATE TABLE "visual_search_embeddings" (
	"document_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"region_index" integer NOT NULL,
	"region_kind" text NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"width" real NOT NULL,
	"height" real NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "visual_search_embeddings_document_id_region_index_pk" PRIMARY KEY("document_id","region_index")
);
--> statement-breakpoint
CREATE TABLE "visual_search_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"preview_asset_id" uuid NOT NULL,
	"preview_hash" text,
	"index_version" text NOT NULL,
	"status" "visual_search_job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_by" text,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visual_search_jobs_identity_unique" UNIQUE("owner_id","pattern_id","preview_asset_id","index_version")
);
--> statement-breakpoint
CREATE TABLE "visual_search_workers" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"index_version" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_pattern_id_unique" UNIQUE("owner_id","pattern_id","id");--> statement-breakpoint
ALTER TABLE "visual_search_documents" ADD CONSTRAINT "visual_search_documents_owner_pattern_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_search_documents" ADD CONSTRAINT "visual_search_documents_preview_fk" FOREIGN KEY ("owner_id","pattern_id","preview_asset_id") REFERENCES "public"."assets"("owner_id","pattern_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_search_embeddings" ADD CONSTRAINT "visual_search_embeddings_document_owner_fk" FOREIGN KEY ("document_id","owner_id","pattern_id") REFERENCES "public"."visual_search_documents"("id","owner_id","pattern_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_search_jobs" ADD CONSTRAINT "visual_search_jobs_owner_pattern_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_search_jobs" ADD CONSTRAINT "visual_search_jobs_preview_fk" FOREIGN KEY ("owner_id","pattern_id","preview_asset_id") REFERENCES "public"."assets"("owner_id","pattern_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visual_search_documents_ready_unique" ON "visual_search_documents" USING btree ("owner_id","pattern_id","index_version") WHERE "visual_search_documents"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "visual_search_embeddings_owner_pattern_idx" ON "visual_search_embeddings" USING btree ("owner_id","pattern_id");--> statement-breakpoint
CREATE INDEX "visual_search_embeddings_hnsw_idx" ON "visual_search_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "visual_search_jobs_status_available_idx" ON "visual_search_jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "visual_search_jobs_status_lease_until_idx" ON "visual_search_jobs" USING btree ("status","lease_until");

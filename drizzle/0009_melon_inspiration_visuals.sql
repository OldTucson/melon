CREATE TYPE "public"."inspiration_visual_asset_kind" AS ENUM('web_evidence', 'library_match', 'generated_concept');--> statement-breakpoint
CREATE TYPE "public"."inspiration_visual_job_kind" AS ENUM('research_visuals', 'concept_image');--> statement-breakpoint
CREATE TYPE "public"."inspiration_visual_job_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "inspiration_visual_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" "inspiration_visual_asset_kind" NOT NULL,
	"ordinal" integer NOT NULL,
	"direction_index" integer,
	"title" text NOT NULL,
	"alt_text" text NOT NULL,
	"source_page_url" text,
	"source_site_name" text,
	"source_query" text,
	"pattern_id" uuid,
	"saved_pattern_id" uuid,
	"save_operation_id" uuid,
	"object_key" text,
	"content_type" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspiration_visual_assets_job_kind_ordinal_unique" UNIQUE("job_id","kind","ordinal"),
	CONSTRAINT "inspiration_visual_assets_ordinal_check" CHECK ("inspiration_visual_assets"."ordinal" between 0 and 100),
	CONSTRAINT "inspiration_visual_assets_direction_check" CHECK ("inspiration_visual_assets"."direction_index" is null or "inspiration_visual_assets"."direction_index" between 0 and 4),
	CONSTRAINT "inspiration_visual_assets_display_length_check" CHECK (char_length(btrim("inspiration_visual_assets"."title")) between 1 and 300
        and char_length(btrim("inspiration_visual_assets"."alt_text")) between 1 and 500),
	CONSTRAINT "inspiration_visual_assets_source_length_check" CHECK (("inspiration_visual_assets"."source_page_url" is null or char_length("inspiration_visual_assets"."source_page_url") between 1 and 2048)
        and ("inspiration_visual_assets"."source_site_name" is null or char_length(btrim("inspiration_visual_assets"."source_site_name")) between 1 and 120)
        and ("inspiration_visual_assets"."source_query" is null or char_length(btrim("inspiration_visual_assets"."source_query")) between 1 and 300)),
	CONSTRAINT "inspiration_visual_assets_storage_length_check" CHECK (("inspiration_visual_assets"."object_key" is null or char_length("inspiration_visual_assets"."object_key") between 1 and 1024)
        and ("inspiration_visual_assets"."content_type" is null or char_length("inspiration_visual_assets"."content_type") between 1 and 100)),
	CONSTRAINT "inspiration_visual_assets_dimensions_check" CHECK ((
        ("inspiration_visual_assets"."width" is null and "inspiration_visual_assets"."height" is null)
        or ("inspiration_visual_assets"."width" is not null
          and "inspiration_visual_assets"."height" is not null
          and "inspiration_visual_assets"."width" between 1 and 32768
          and "inspiration_visual_assets"."height" between 1 and 32768
          and "inspiration_visual_assets"."width"::bigint * "inspiration_visual_assets"."height"::bigint <= 40000000)
      )),
	CONSTRAINT "inspiration_visual_assets_save_state_check" CHECK (("inspiration_visual_assets"."saved_pattern_id" is null) = ("inspiration_visual_assets"."save_operation_id" is null)),
	CONSTRAINT "inspiration_visual_assets_kind_check" CHECK ((
        ("inspiration_visual_assets"."kind" = 'web_evidence'
          and "inspiration_visual_assets"."direction_index" is null
          and "inspiration_visual_assets"."source_page_url" is not null
          and "inspiration_visual_assets"."source_page_url" ~ '^https://'
          and "inspiration_visual_assets"."source_site_name" is not null
          and "inspiration_visual_assets"."source_query" is not null
          and "inspiration_visual_assets"."pattern_id" is null
          and "inspiration_visual_assets"."saved_pattern_id" is null
          and "inspiration_visual_assets"."save_operation_id" is null
          and "inspiration_visual_assets"."object_key" is not null
          and "inspiration_visual_assets"."content_type" is not null
          and "inspiration_visual_assets"."width" is not null
          and "inspiration_visual_assets"."height" is not null)
        or ("inspiration_visual_assets"."kind" = 'library_match'
          and "inspiration_visual_assets"."pattern_id" is not null
          and "inspiration_visual_assets"."saved_pattern_id" is null
          and "inspiration_visual_assets"."save_operation_id" is null
          and "inspiration_visual_assets"."source_page_url" is null
          and "inspiration_visual_assets"."source_site_name" is null
          and "inspiration_visual_assets"."source_query" is null
          and "inspiration_visual_assets"."object_key" is null
          and "inspiration_visual_assets"."content_type" is null
          and "inspiration_visual_assets"."width" is null
          and "inspiration_visual_assets"."height" is null)
        or ("inspiration_visual_assets"."kind" = 'generated_concept'
          and "inspiration_visual_assets"."direction_index" is not null
          and "inspiration_visual_assets"."direction_index" between 0 and 4
          and "inspiration_visual_assets"."pattern_id" is null
          and "inspiration_visual_assets"."source_page_url" is null
          and "inspiration_visual_assets"."source_site_name" is null
          and "inspiration_visual_assets"."source_query" is null
          and "inspiration_visual_assets"."object_key" is not null
          and "inspiration_visual_assets"."content_type" is not null
          and "inspiration_visual_assets"."width" is not null
          and "inspiration_visual_assets"."height" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "inspiration_visual_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" "inspiration_visual_job_kind" NOT NULL,
	"direction_index" integer,
	"status" "inspiration_visual_job_status" NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_task_id" text,
	"provider_request_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspiration_visual_jobs_owner_operation_unique" UNIQUE("owner_id","operation_id"),
	CONSTRAINT "inspiration_visual_jobs_owner_analysis_id_unique" UNIQUE("owner_id","analysis_id","id"),
	CONSTRAINT "inspiration_visual_jobs_target_check" CHECK ((
        ("inspiration_visual_jobs"."kind" = 'research_visuals' and "inspiration_visual_jobs"."direction_index" is null)
        or ("inspiration_visual_jobs"."kind" = 'concept_image'
          and "inspiration_visual_jobs"."direction_index" is not null
          and "inspiration_visual_jobs"."direction_index" between 0 and 4)
      )),
	CONSTRAINT "inspiration_visual_jobs_state_check" CHECK ((
        ("inspiration_visual_jobs"."status" = 'pending'
          and "inspiration_visual_jobs"."completed_at" is null
          and "inspiration_visual_jobs"."error_code" is null)
        or ("inspiration_visual_jobs"."status" = 'completed'
          and "inspiration_visual_jobs"."completed_at" is not null
          and "inspiration_visual_jobs"."error_code" is null)
        or ("inspiration_visual_jobs"."status" = 'failed'
          and "inspiration_visual_jobs"."completed_at" is not null
          and "inspiration_visual_jobs"."error_code" is not null)
      )),
	CONSTRAINT "inspiration_visual_jobs_metadata_length_check" CHECK (("inspiration_visual_jobs"."provider_task_id" is null or char_length("inspiration_visual_jobs"."provider_task_id") between 1 and 500)
        and ("inspiration_visual_jobs"."provider_request_id" is null or char_length("inspiration_visual_jobs"."provider_request_id") between 1 and 500)
        and ("inspiration_visual_jobs"."error_code" is null or char_length("inspiration_visual_jobs"."error_code") between 1 and 100)),
	CONSTRAINT "inspiration_visual_jobs_warnings_check" CHECK (jsonb_typeof("inspiration_visual_jobs"."warnings") = 'array'
        and jsonb_array_length("inspiration_visual_jobs"."warnings") <= 5)
);
--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_analysis_id_inspiration_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."inspiration_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_saved_pattern_id_patterns_id_fk" FOREIGN KEY ("saved_pattern_id") REFERENCES "public"."patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_owner_analysis_job_fk" FOREIGN KEY ("owner_id","analysis_id","job_id") REFERENCES "public"."inspiration_visual_jobs"("owner_id","analysis_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_owner_pattern_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_jobs" ADD CONSTRAINT "inspiration_visual_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_visual_jobs" ADD CONSTRAINT "inspiration_visual_jobs_analysis_id_inspiration_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."inspiration_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspiration_visual_assets_owner_save_operation_unique" ON "inspiration_visual_assets" USING btree ("owner_id","save_operation_id") WHERE "inspiration_visual_assets"."save_operation_id" is not null;--> statement-breakpoint
CREATE INDEX "inspiration_visual_assets_owner_analysis_kind_ordinal_idx" ON "inspiration_visual_assets" USING btree ("owner_id","analysis_id","kind","ordinal","id");--> statement-breakpoint
CREATE INDEX "inspiration_visual_assets_owner_job_kind_ordinal_idx" ON "inspiration_visual_assets" USING btree ("owner_id","job_id","kind","ordinal","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inspiration_visual_jobs_target_pending_unique" ON "inspiration_visual_jobs" USING btree ("analysis_id","kind",coalesce("direction_index", -1)) WHERE "inspiration_visual_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "inspiration_visual_jobs_owner_analysis_kind_created_idx" ON "inspiration_visual_jobs" USING btree ("owner_id","analysis_id","kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);

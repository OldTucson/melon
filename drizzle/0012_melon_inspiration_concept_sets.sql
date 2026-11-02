ALTER TABLE "inspiration_analyses" ADD CONSTRAINT "inspiration_analyses_owner_id_unique" UNIQUE("owner_id","id");--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_owner_analysis_id_unique" UNIQUE("owner_id","analysis_id","id");--> statement-breakpoint
CREATE TYPE "public"."inspiration_concept_output_kind" AS ENUM('sketch', 'effect', 'flat');--> statement-breakpoint
CREATE TYPE "public"."inspiration_concept_set_status" AS ENUM('queued', 'generating', 'partial', 'completed', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."inspiration_concept_task_status" AS ENUM('queued', 'submitting', 'submitted', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "inspiration_concept_outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"output_kind" "inspiration_concept_output_kind" NOT NULL,
	"title" text NOT NULL,
	"alt_text" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspiration_concept_outputs_set_kind_unique" UNIQUE("set_id","output_kind"),
	CONSTRAINT "inspiration_concept_outputs_display_length_check" CHECK (char_length(btrim("inspiration_concept_outputs"."title")) between 1 and 300 and char_length(btrim("inspiration_concept_outputs"."alt_text")) between 1 and 500),
	CONSTRAINT "inspiration_concept_outputs_storage_check" CHECK (char_length(btrim("inspiration_concept_outputs"."object_key")) between 1 and 1024 and "inspiration_concept_outputs"."content_type" = 'image/png'),
	CONSTRAINT "inspiration_concept_outputs_dimensions_check" CHECK (("inspiration_concept_outputs"."output_kind" in ('sketch', 'effect') and "inspiration_concept_outputs"."width" = 1536 and "inspiration_concept_outputs"."height" = 2048) or ("inspiration_concept_outputs"."output_kind" = 'flat' and "inspiration_concept_outputs"."width" = 2048 and "inspiration_concept_outputs"."height" = 1536))
);
--> statement-breakpoint
CREATE TABLE "inspiration_concept_references" (
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"visual_asset_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "inspiration_concept_references_set_id_ordinal_pk" PRIMARY KEY("set_id","ordinal"),
	CONSTRAINT "inspiration_concept_references_set_asset_unique" UNIQUE("set_id","visual_asset_id"),
	CONSTRAINT "inspiration_concept_references_ordinal_check" CHECK ("inspiration_concept_references"."ordinal" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "inspiration_concept_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"direction_index" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "inspiration_concept_set_status" NOT NULL,
	"brief_snapshot" jsonb NOT NULL,
	"prompt_template_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deletion_lease_owner" text,
	"deletion_lease_until" timestamp with time zone,
	CONSTRAINT "inspiration_concept_sets_owner_operation_unique" UNIQUE("owner_id","operation_id"),
	CONSTRAINT "inspiration_concept_sets_analysis_direction_version_unique" UNIQUE("analysis_id","direction_index","version"),
	CONSTRAINT "inspiration_concept_sets_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "inspiration_concept_sets_owner_analysis_id_unique" UNIQUE("owner_id","analysis_id","id"),
	CONSTRAINT "inspiration_concept_sets_direction_check" CHECK ("inspiration_concept_sets"."direction_index" between 0 and 4),
	CONSTRAINT "inspiration_concept_sets_version_check" CHECK ("inspiration_concept_sets"."version" >= 1),
	CONSTRAINT "inspiration_concept_sets_brief_check" CHECK (jsonb_typeof("inspiration_concept_sets"."brief_snapshot") = 'object'),
	CONSTRAINT "inspiration_concept_sets_metadata_length_check" CHECK (char_length(btrim("inspiration_concept_sets"."prompt_template_version")) between 1 and 100 and char_length(btrim("inspiration_concept_sets"."model")) between 1 and 100),
	CONSTRAINT "inspiration_concept_sets_state_check" CHECK (("inspiration_concept_sets"."status" in ('queued', 'generating') and "inspiration_concept_sets"."completed_at" is null) or ("inspiration_concept_sets"."status" in ('partial', 'completed', 'failed') and "inspiration_concept_sets"."completed_at" is not null) or "inspiration_concept_sets"."status" = 'deleting'),
	CONSTRAINT "inspiration_concept_sets_deletion_check" CHECK (("inspiration_concept_sets"."status" = 'deleting') = ("inspiration_concept_sets"."deleted_at" is not null)),
	CONSTRAINT "inspiration_concept_sets_deletion_lease_check" CHECK (("inspiration_concept_sets"."deletion_lease_owner" is null and "inspiration_concept_sets"."deletion_lease_until" is null) or ("inspiration_concept_sets"."status" = 'deleting' and "inspiration_concept_sets"."deletion_lease_owner" is not null and "inspiration_concept_sets"."deletion_lease_until" is not null and char_length(btrim("inspiration_concept_sets"."deletion_lease_owner")) between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "inspiration_concept_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"output_kind" "inspiration_concept_output_kind" NOT NULL,
	"attempt" integer NOT NULL,
	"status" "inspiration_concept_task_status" NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"provider_task_id" text,
	"provider_request_id" text,
	"error_code" text,
	"submit_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "inspiration_concept_tasks_owner_operation_unique" UNIQUE("owner_id","operation_id"),
	CONSTRAINT "inspiration_concept_tasks_set_kind_attempt_unique" UNIQUE("set_id","output_kind","attempt"),
	CONSTRAINT "inspiration_concept_tasks_owner_set_id_unique" UNIQUE("owner_id","set_id","id"),
	CONSTRAINT "inspiration_concept_tasks_attempt_check" CHECK ("inspiration_concept_tasks"."attempt" >= 1),
	CONSTRAINT "inspiration_concept_tasks_state_check" CHECK ((
    ("inspiration_concept_tasks"."status" = 'queued' and "inspiration_concept_tasks"."completed_at" is null and "inspiration_concept_tasks"."error_code" is null and "inspiration_concept_tasks"."provider_task_id" is null and "inspiration_concept_tasks"."provider_request_id" is null and "inspiration_concept_tasks"."submit_started_at" is null)
    or ("inspiration_concept_tasks"."status" = 'submitting' and "inspiration_concept_tasks"."completed_at" is null and "inspiration_concept_tasks"."error_code" is null and "inspiration_concept_tasks"."submit_started_at" is not null and "inspiration_concept_tasks"."provider_task_id" is null and "inspiration_concept_tasks"."provider_request_id" is null)
    or ("inspiration_concept_tasks"."status" = 'submitted' and "inspiration_concept_tasks"."completed_at" is null and "inspiration_concept_tasks"."error_code" is null and "inspiration_concept_tasks"."submit_started_at" is not null and "inspiration_concept_tasks"."provider_task_id" is not null)
    or ("inspiration_concept_tasks"."status" = 'completed' and "inspiration_concept_tasks"."completed_at" is not null and "inspiration_concept_tasks"."error_code" is null and "inspiration_concept_tasks"."submit_started_at" is not null and "inspiration_concept_tasks"."provider_task_id" is not null and "inspiration_concept_tasks"."lease_owner" is null and "inspiration_concept_tasks"."lease_until" is null)
    or ("inspiration_concept_tasks"."status" = 'failed' and "inspiration_concept_tasks"."completed_at" is not null and "inspiration_concept_tasks"."error_code" is not null and "inspiration_concept_tasks"."lease_owner" is null and "inspiration_concept_tasks"."lease_until" is null)
  )),
	CONSTRAINT "inspiration_concept_tasks_lease_check" CHECK (("inspiration_concept_tasks"."lease_owner" is null and "inspiration_concept_tasks"."lease_until" is null) or ("inspiration_concept_tasks"."lease_owner" is not null and "inspiration_concept_tasks"."lease_until" is not null and char_length(btrim("inspiration_concept_tasks"."lease_owner")) between 1 and 200)),
	CONSTRAINT "inspiration_concept_tasks_metadata_length_check" CHECK (("inspiration_concept_tasks"."provider_task_id" is null or char_length(btrim("inspiration_concept_tasks"."provider_task_id")) between 1 and 500) and ("inspiration_concept_tasks"."provider_request_id" is null or char_length(btrim("inspiration_concept_tasks"."provider_request_id")) between 1 and 500) and ("inspiration_concept_tasks"."error_code" is null or char_length(btrim("inspiration_concept_tasks"."error_code")) between 1 and 100))
);
--> statement-breakpoint
CREATE TABLE "inspiration_concept_worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inspiration_concept_worker_heartbeats_worker_check" CHECK (char_length(btrim("inspiration_concept_worker_heartbeats"."worker_id")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "inspiration_concept_outputs" ADD CONSTRAINT "inspiration_concept_outputs_owner_analysis_set_fk" FOREIGN KEY ("owner_id","analysis_id","set_id") REFERENCES "public"."inspiration_concept_sets"("owner_id","analysis_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_outputs" ADD CONSTRAINT "inspiration_concept_outputs_owner_set_task_fk" FOREIGN KEY ("owner_id","set_id","source_task_id") REFERENCES "public"."inspiration_concept_tasks"("owner_id","set_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_references" ADD CONSTRAINT "inspiration_concept_references_owner_analysis_set_fk" FOREIGN KEY ("owner_id","analysis_id","set_id") REFERENCES "public"."inspiration_concept_sets"("owner_id","analysis_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_references" ADD CONSTRAINT "inspiration_concept_references_owner_analysis_asset_fk" FOREIGN KEY ("owner_id","analysis_id","visual_asset_id") REFERENCES "public"."inspiration_visual_assets"("owner_id","analysis_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_sets" ADD CONSTRAINT "inspiration_concept_sets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_sets" ADD CONSTRAINT "inspiration_concept_sets_owner_analysis_fk" FOREIGN KEY ("owner_id","analysis_id") REFERENCES "public"."inspiration_analyses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration_concept_tasks" ADD CONSTRAINT "inspiration_concept_tasks_owner_set_fk" FOREIGN KEY ("owner_id","set_id") REFERENCES "public"."inspiration_concept_sets"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inspiration_concept_references_asset_idx" ON "inspiration_concept_references" USING btree ("visual_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inspiration_concept_sets_active_direction_unique" ON "inspiration_concept_sets" USING btree ("analysis_id","direction_index") WHERE "inspiration_concept_sets"."status" in ('queued', 'generating') and "inspiration_concept_sets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "inspiration_concept_sets_owner_analysis_created_idx" ON "inspiration_concept_sets" USING btree ("owner_id","analysis_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "inspiration_concept_tasks_active_slot_unique" ON "inspiration_concept_tasks" USING btree ("set_id","output_kind") WHERE "inspiration_concept_tasks"."status" in ('queued', 'submitting', 'submitted');--> statement-breakpoint
CREATE INDEX "inspiration_concept_tasks_due_idx" ON "inspiration_concept_tasks" USING btree ("status","available_at","lease_until");

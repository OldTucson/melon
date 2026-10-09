CREATE TYPE "public"."asset_role" AS ENUM('source', 'preview', 'thumbnail');--> statement-breakpoint
CREATE TYPE "public"."pattern_status" AS ENUM('draft', 'hashing', 'uploading', 'processing', 'ready', 'failed', 'trashed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."preview_status" AS ENUM('pending', 'ready', 'unsupported', 'failed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('initialized', 'uploading', 'completing', 'completed', 'aborted', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"role" "asset_role" NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"detected_mime_type" text,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_owner_pattern_role_unique" UNIQUE("owner_id","pattern_id","role")
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"owner_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_log_owner_seq_pk" PRIMARY KEY("owner_id","seq"),
	CONSTRAINT "change_log_owner_operation_unique" UNIQUE("owner_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"owner_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_owner_operation_pk" PRIMARY KEY("owner_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "patterns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"original_filename" text NOT NULL,
	"extension" text NOT NULL,
	"detected_mime_type" text,
	"size_bytes" bigint NOT NULL,
	"content_hash" text,
	"status" "pattern_status" DEFAULT 'draft' NOT NULL,
	"preview_status" "preview_status" DEFAULT 'pending' NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"commercial_version" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"trashed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patterns_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "pattern_tags" (
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pattern_tags_owner_pattern_tag_pk" PRIMARY KEY("owner_id","pattern_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"color_token" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"source_object_key" text NOT NULL,
	"oss_upload_id" text,
	"file_fingerprint" jsonb NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "upload_status" DEFAULT 'initialized' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_owner_operation_unique" UNIQUE("owner_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_pattern_patterns_owner_id_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_tags" ADD CONSTRAINT "pattern_tags_owner_pattern_patterns_owner_id_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_tags" ADD CONSTRAINT "pattern_tags_owner_tag_tags_owner_id_fk" FOREIGN KEY ("owner_id","tag_id") REFERENCES "public"."tags"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_pattern_patterns_owner_id_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patterns_owner_status_updated_id_idx" ON "patterns" USING btree ("owner_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "patterns_owner_name_id_idx" ON "patterns" USING btree ("owner_id","name","id");--> statement-breakpoint
CREATE INDEX "patterns_owner_original_filename_id_idx" ON "patterns" USING btree ("owner_id","original_filename","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_owner_normalized_name_active_unique" ON "tags" USING btree ("owner_id","normalized_name") WHERE "tags"."deleted_at" is null;
CREATE TYPE "public"."folder_status" AS ENUM('active', 'trashed', 'deleting', 'deleted');--> statement-breakpoint
ALTER TYPE "public"."pattern_status" ADD VALUE 'deleting' BEFORE 'deleted';--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"status" "folder_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"trash_batch_id" uuid,
	"trashed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "folders_parent_not_self" CHECK ("folders"."parent_id" is null or "folders"."parent_id" <> "folders"."id")
);
--> statement-breakpoint
ALTER TABLE "patterns" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "patterns" ADD COLUMN "trash_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "patterns" ADD COLUMN "pre_trash_status" "pattern_status";--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_parent_fk" FOREIGN KEY ("owner_id","parent_id") REFERENCES "public"."folders"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_owner_root_name_live_unique" ON "folders" USING btree ("owner_id","normalized_name") WHERE "folders"."parent_id" is null and "folders"."status" <> 'deleted'::folder_status;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_owner_parent_name_live_unique" ON "folders" USING btree ("owner_id","parent_id","normalized_name") WHERE "folders"."parent_id" is not null and "folders"."status" <> 'deleted'::folder_status;--> statement-breakpoint
CREATE INDEX "folders_owner_parent_status_idx" ON "folders" USING btree ("owner_id","parent_id","status");--> statement-breakpoint
CREATE INDEX "folders_owner_trash_batch_idx" ON "folders" USING btree ("owner_id","trash_batch_id");--> statement-breakpoint
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_owner_folder_fk" FOREIGN KEY ("owner_id","folder_id") REFERENCES "public"."folders"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patterns_owner_folder_status_updated_idx" ON "patterns" USING btree ("owner_id","folder_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "patterns_owner_trash_batch_idx" ON "patterns" USING btree ("owner_id","trash_batch_id");
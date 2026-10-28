CREATE TYPE "public"."inspiration_analysis_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "inspiration_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"title" text NOT NULL,
	"status" "inspiration_analysis_status" NOT NULL,
	"schema_version" text DEFAULT 'inspiration-analysis-v1' NOT NULL,
	"sources" jsonb,
	"result" jsonb,
	"search_model" text NOT NULL,
	"structure_model" text NOT NULL,
	"search_request_id" text,
	"structure_request_id" text,
	"error_code" text,
	"share_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspiration_analyses_share_id_unique" UNIQUE("share_id"),
	CONSTRAINT "inspiration_analyses_owner_operation_unique" UNIQUE("owner_id","operation_id"),
	CONSTRAINT "inspiration_analyses_prompt_length_check" CHECK (char_length("inspiration_analyses"."prompt") between 5 and 1000),
	CONSTRAINT "inspiration_analyses_title_length_check" CHECK (char_length("inspiration_analyses"."title") between 1 and 120),
	CONSTRAINT "inspiration_analyses_share_state_check" CHECK ("inspiration_analyses"."share_id" is null or "inspiration_analyses"."status" = 'completed'),
	CONSTRAINT "inspiration_analyses_state_check" CHECK ((
        ("inspiration_analyses"."status" = 'pending'
          and "inspiration_analyses"."result" is null
          and "inspiration_analyses"."completed_at" is null
          and "inspiration_analyses"."error_code" is null)
        or ("inspiration_analyses"."status" = 'completed'
          and "inspiration_analyses"."sources" is not null
          and "inspiration_analyses"."result" is not null
          and "inspiration_analyses"."completed_at" is not null
          and "inspiration_analyses"."error_code" is null)
        or ("inspiration_analyses"."status" = 'failed'
          and "inspiration_analyses"."error_code" is not null
          and "inspiration_analyses"."result" is null)
      ))
);
--> statement-breakpoint
ALTER TABLE "inspiration_analyses" ADD CONSTRAINT "inspiration_analyses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspiration_analyses_owner_pending_unique" ON "inspiration_analyses" USING btree ("owner_id") WHERE "inspiration_analyses"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "inspiration_analyses_owner_updated_id_idx" ON "inspiration_analyses" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE TYPE "public"."authorization_field_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."authorization_kind" AS ENUM('standard', 'field_exclusive', 'global_buyout');--> statement-breakpoint
CREATE TYPE "public"."authorization_scope" AS ENUM('system', 'custom');--> statement-breakpoint
CREATE TYPE "public"."authorization_status" AS ENUM('active', 'void');--> statement-breakpoint
CREATE TABLE "authorization_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"scope" "authorization_scope" NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"status" "authorization_field_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "authorization_fields_scope_owner_check" CHECK (("authorization_fields"."scope" = 'system' and "authorization_fields"."owner_id" is null) or ("authorization_fields"."scope" = 'custom' and "authorization_fields"."owner_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" "authorization_kind" NOT NULL,
	"field_id" uuid,
	"field_name_snapshot" text,
	"licensee_name" text NOT NULL,
	"price_fen" bigint NOT NULL,
	"authorized_on" date NOT NULL,
	"note" text,
	"status" "authorization_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizations_owner_operation_unique" UNIQUE("owner_id","operation_id"),
	CONSTRAINT "authorizations_kind_field_check" CHECK (("authorizations"."kind" = 'global_buyout' and "authorizations"."field_id" is null and "authorizations"."field_name_snapshot" is null) or ("authorizations"."kind" <> 'global_buyout' and "authorizations"."field_id" is not null and "authorizations"."field_name_snapshot" is not null)),
	CONSTRAINT "authorizations_price_nonnegative" CHECK ("authorizations"."price_fen" >= 0)
);
--> statement-breakpoint
ALTER TABLE "authorization_fields" ADD CONSTRAINT "authorization_fields_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_field_id_authorization_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."authorization_fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_owner_pattern_fk" FOREIGN KEY ("owner_id","pattern_id") REFERENCES "public"."patterns"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_fields_system_name_unique" ON "authorization_fields" USING btree ("normalized_name") WHERE "authorization_fields"."scope" = 'system';--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_fields_owner_name_unique" ON "authorization_fields" USING btree ("owner_id","normalized_name") WHERE "authorization_fields"."scope" = 'custom';--> statement-breakpoint
CREATE INDEX "authorizations_owner_pattern_status_date_idx" ON "authorizations" USING btree ("owner_id","pattern_id","status","authorized_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "authorizations_owner_status_date_idx" ON "authorizations" USING btree ("owner_id","status","authorized_on");--> statement-breakpoint
CREATE INDEX "authorizations_owner_field_status_date_idx" ON "authorizations" USING btree ("owner_id","field_id","status","authorized_on");--> statement-breakpoint
CREATE INDEX "authorizations_owner_kind_status_idx" ON "authorizations" USING btree ("owner_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "authorizations_active_buyout_unique" ON "authorizations" USING btree ("owner_id","pattern_id") WHERE "authorizations"."status" = 'active' and "authorizations"."kind" = 'global_buyout';--> statement-breakpoint
CREATE UNIQUE INDEX "authorizations_active_field_exclusive_unique" ON "authorizations" USING btree ("owner_id","pattern_id","field_id") WHERE "authorizations"."status" = 'active' and "authorizations"."kind" = 'field_exclusive';--> statement-breakpoint
INSERT INTO "authorization_fields" (
	"id",
	"owner_id",
	"scope",
	"name",
	"normalized_name",
	"status"
) VALUES
	('00000000-0000-4000-8000-000000000001', NULL, 'system', '家居服', '家居服', 'active'),
	('00000000-0000-4000-8000-000000000002', NULL, 'system', '日用百货', '日用百货', 'active'),
	('00000000-0000-4000-8000-000000000003', NULL, 'system', '口水巾', '口水巾', 'active'),
	('00000000-0000-4000-8000-000000000004', NULL, 'system', '家纺床品', '家纺床品', 'active'),
	('00000000-0000-4000-8000-000000000005', NULL, 'system', '服装服饰', '服装服饰', 'active'),
	('00000000-0000-4000-8000-000000000006', NULL, 'system', '婴童用品', '婴童用品', 'active'),
	('00000000-0000-4000-8000-000000000007', NULL, 'system', '箱包鞋帽', '箱包鞋帽', 'active'),
	('00000000-0000-4000-8000-000000000008', NULL, 'system', '文具纸品', '文具纸品', 'active'),
	('00000000-0000-4000-8000-000000000009', NULL, 'system', '餐厨用品', '餐厨用品', 'active'),
	('00000000-0000-4000-8000-000000000010', NULL, 'system', '家居装饰', '家居装饰', 'active'),
	('00000000-0000-4000-8000-000000000011', NULL, 'system', '包装礼品', '包装礼品', 'active'),
	('00000000-0000-4000-8000-000000000012', NULL, 'system', '数码配件', '数码配件', 'active')
ON CONFLICT DO NOTHING;

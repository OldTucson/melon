CREATE TABLE "auth_login_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"failure_count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_login_rate_limits_hash_check" CHECK ("auth_login_rate_limits"."key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_login_rate_limits_scope_check" CHECK ("auth_login_rate_limits"."scope" in ('account', 'ip')),
	CONSTRAINT "auth_login_rate_limits_failure_count_check" CHECK ("auth_login_rate_limits"."failure_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "auth_login_rate_limits_updated_at_idx" ON "auth_login_rate_limits" USING btree ("updated_at");
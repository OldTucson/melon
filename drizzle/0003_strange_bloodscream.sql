ALTER TABLE "upload_sessions" ADD COLUMN "credential_issue_fence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "credentials_expire_at" timestamp with time zone;--> statement-breakpoint
UPDATE "upload_sessions"
SET "credential_issue_fence_at" = now() + interval '15 minutes 30 seconds';

CREATE TABLE "inspiration_report_cleanup_manifests" (
	"owner_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"set_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	CONSTRAINT "inspiration_report_cleanup_manifests_owner_id_analysis_id_pk" PRIMARY KEY("owner_id","analysis_id"),
	CONSTRAINT "inspiration_report_cleanup_lease_check" CHECK (("inspiration_report_cleanup_manifests"."lease_token" is null) = ("inspiration_report_cleanup_manifests"."lease_until" is null)),
	CONSTRAINT "inspiration_report_cleanup_scopes_check" CHECK (array_position("inspiration_report_cleanup_manifests"."set_ids", null) is null and (cardinality("inspiration_report_cleanup_manifests"."set_ids") = 0 or array_ndims("inspiration_report_cleanup_manifests"."set_ids") = 1))
);
--> statement-breakpoint
ALTER TABLE "inspiration_concept_references" DROP CONSTRAINT "inspiration_concept_references_owner_analysis_asset_fk";
--> statement-breakpoint
CREATE INDEX "inspiration_report_cleanup_due_idx" ON "inspiration_report_cleanup_manifests" USING btree ("created_at","last_attempt_at","analysis_id");--> statement-breakpoint
ALTER TABLE "inspiration_concept_references" ADD CONSTRAINT "inspiration_concept_references_owner_analysis_asset_fk" FOREIGN KEY ("owner_id","analysis_id","visual_asset_id") REFERENCES "public"."inspiration_visual_assets"("owner_id","analysis_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- Explicit application capture and legacy BEFORE DELETE share the same merge.
-- These scopes must outlive their owner and every cascaded report row.
CREATE FUNCTION capture_inspiration_report_cleanup(report_owner uuid, report_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO inspiration_report_cleanup_manifests (owner_id, analysis_id, set_ids)
  SELECT a.owner_id, a.id,
    ARRAY(SELECT s.id FROM inspiration_concept_sets s WHERE s.owner_id = a.owner_id AND s.analysis_id = a.id ORDER BY s.id)
  FROM inspiration_analyses a WHERE a.owner_id = report_owner AND a.id = report_id
  ON CONFLICT (owner_id, analysis_id) DO UPDATE SET
    set_ids = ARRAY(SELECT DISTINCT scope FROM unnest(inspiration_report_cleanup_manifests.set_ids || EXCLUDED.set_ids) scope ORDER BY scope),
    created_at = CURRENT_TIMESTAMP, last_attempt_at = NULL, lease_token = NULL, lease_until = NULL;
$$;
--> statement-breakpoint
CREATE FUNCTION capture_inspiration_report_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM capture_inspiration_report_cleanup(OLD.owner_id, OLD.id);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspiration_report_cleanup_before_delete
BEFORE DELETE ON inspiration_analyses
FOR EACH ROW EXECUTE FUNCTION capture_inspiration_report_before_delete();
--> statement-breakpoint
-- User cascades can visit sets before analyses; capture all report scopes first.
CREATE FUNCTION capture_inspiration_owner_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM capture_inspiration_report_cleanup(OLD.id, a.id)
  FROM inspiration_analyses a WHERE a.owner_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspiration_owner_cleanup_before_delete
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION capture_inspiration_owner_before_delete();

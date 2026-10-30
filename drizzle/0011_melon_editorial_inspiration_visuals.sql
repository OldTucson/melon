CREATE TYPE "public"."inspiration_document_role" AS ENUM('hero', 'evidence', 'product');--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" DROP CONSTRAINT "inspiration_visual_assets_kind_check";--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD COLUMN "document_role" "inspiration_document_role";--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD COLUMN "source_indexes" jsonb;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD COLUMN "price_text" text;--> statement-breakpoint
UPDATE inspiration_visual_assets
SET document_role = 'evidence', source_indexes = '[]'::jsonb
WHERE kind = 'web_evidence';--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_product_length_check" CHECK (("inspiration_visual_assets"."brand" is null or char_length(btrim("inspiration_visual_assets"."brand")) between 1 and 120)
        and ("inspiration_visual_assets"."product_name" is null or char_length(btrim("inspiration_visual_assets"."product_name")) between 1 and 300)
        and ("inspiration_visual_assets"."price_text" is null or char_length(btrim("inspiration_visual_assets"."price_text")) between 1 and 120));--> statement-breakpoint
ALTER TABLE "inspiration_visual_assets" ADD CONSTRAINT "inspiration_visual_assets_kind_check" CHECK ((
        ("inspiration_visual_assets"."kind" = 'web_evidence'
          and "inspiration_visual_assets"."document_role" is not null
          and "inspiration_visual_assets"."source_indexes" is not null
          and jsonb_typeof("inspiration_visual_assets"."source_indexes") = 'array'
          and (("inspiration_visual_assets"."document_role" = 'product'
              and "inspiration_visual_assets"."product_name" is not null)
            or ("inspiration_visual_assets"."document_role" in ('hero', 'evidence')
              and "inspiration_visual_assets"."brand" is null
              and "inspiration_visual_assets"."product_name" is null
              and "inspiration_visual_assets"."price_text" is null))
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
          and "inspiration_visual_assets"."document_role" is null
          and "inspiration_visual_assets"."source_indexes" is null
          and "inspiration_visual_assets"."brand" is null
          and "inspiration_visual_assets"."product_name" is null
          and "inspiration_visual_assets"."price_text" is null
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
          and "inspiration_visual_assets"."document_role" is null
          and "inspiration_visual_assets"."source_indexes" is null
          and "inspiration_visual_assets"."brand" is null
          and "inspiration_visual_assets"."product_name" is null
          and "inspiration_visual_assets"."price_text" is null
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
      ));
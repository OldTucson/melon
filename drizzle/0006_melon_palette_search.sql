CREATE TABLE "visual_search_palette_colors" (
	"document_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"color_index" integer NOT NULL,
	"display_hex" text NOT NULL,
	"oklab_l" real NOT NULL,
	"oklab_a" real NOT NULL,
	"oklab_b" real NOT NULL,
	"coverage" real NOT NULL,
	CONSTRAINT "visual_search_palette_colors_document_id_color_index_pk" PRIMARY KEY("document_id","color_index"),
	CONSTRAINT "visual_search_palette_colors_index_check" CHECK ("visual_search_palette_colors"."color_index" between 0 and 4),
	CONSTRAINT "visual_search_palette_colors_hex_check" CHECK ("visual_search_palette_colors"."display_hex" ~ '^#[0-9A-F]{6}$'),
	CONSTRAINT "visual_search_palette_colors_coverage_check" CHECK ("visual_search_palette_colors"."coverage" > 0 and "visual_search_palette_colors"."coverage" <= 1),
	CONSTRAINT "visual_search_palette_colors_oklab_check" CHECK ("visual_search_palette_colors"."oklab_l" >= 0 and "visual_search_palette_colors"."oklab_l" <= 1
        and "visual_search_palette_colors"."oklab_a" >= -0.5 and "visual_search_palette_colors"."oklab_a" <= 0.5
        and "visual_search_palette_colors"."oklab_b" >= -0.5 and "visual_search_palette_colors"."oklab_b" <= 0.5)
);
--> statement-breakpoint
ALTER TABLE "visual_search_palette_colors" ADD CONSTRAINT "visual_search_palette_colors_document_owner_fk" FOREIGN KEY ("document_id","owner_id","pattern_id") REFERENCES "public"."visual_search_documents"("id","owner_id","pattern_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_search_palette_colors_owner_pattern_idx" ON "visual_search_palette_colors" USING btree ("owner_id","pattern_id");
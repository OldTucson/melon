import { z } from "zod";

import { imageSearchFiltersSchema } from "@/features/image-search/contracts";
import type { PatternItem } from "@/features/library/library-types";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const paletteHexSchema = z.string().regex(/^#[0-9A-F]{6}$/);

const uniqueColorsSchema = z
  .array(paletteHexSchema)
  .min(1)
  .max(5)
  .superRefine((colors, context) => {
    if (new Set(colors).size !== colors.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate colors",
      });
    }
  });

const canonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());

const uniquePatternIdsSchema = z
  .array(canonicalUuidSchema)
  .max(10_000)
  .superRefine((patternIds, context) => {
    if (new Set(patternIds).size !== patternIds.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate pattern IDs",
      });
    }
  });

export const paletteSearchRequestSchema = z
  .object({
    requestId: publicOperationIdSchema,
    colors: uniqueColorsSchema,
    filters: imageSearchFiltersSchema,
  })
  .strict();

export const internalPaletteSearchRequestSchema = z
  .object({
    ownerId: canonicalUuidSchema,
    allowedPatternIds: uniquePatternIdsSchema,
    requestId: canonicalUuidSchema,
    colors: uniqueColorsSchema,
  })
  .strict();

const internalPaletteSearchItemSchema = z
  .object({
    patternId: canonicalUuidSchema,
    distance: z.number().finite().nonnegative(),
  })
  .strict();

export const internalPaletteSearchResponseSchema = z
  .object({
    requestId: canonicalUuidSchema,
    query: z.object({ colors: uniqueColorsSchema }).strict(),
    items: z.array(internalPaletteSearchItemSchema).max(30),
  })
  .strict()
  .superRefine((response, context) => {
    const patternIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (patternIds.has(item.patternId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "patternId"],
          message: "duplicate pattern IDs",
        });
      }
      patternIds.add(item.patternId);
    }
  });

export const paletteSearchErrorCodes = [
  "PALETTE_SEARCH_INVALID_COLORS",
  "PALETTE_SEARCH_NO_INDEX",
  "PALETTE_SEARCH_TIMEOUT",
  "PALETTE_SEARCH_UNAVAILABLE",
] as const;

export type PaletteSearchRequest = z.input<typeof paletteSearchRequestSchema>;
export type ParsedPaletteSearchRequest = z.output<
  typeof paletteSearchRequestSchema
>;
export type InternalPaletteSearchRequest = z.output<
  typeof internalPaletteSearchRequestSchema
>;
export type InternalPaletteSearchResponse = z.output<
  typeof internalPaletteSearchResponseSchema
>;
export type PaletteSearchErrorCode = (typeof paletteSearchErrorCodes)[number];
export type PaletteSearchResponse = {
  query: { colors: string[] };
  items: PatternItem[];
  timing: { totalMs: number };
};

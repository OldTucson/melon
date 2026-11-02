import { conceptSetDtoSchema, publicConceptSetDtoSchema, type ConceptSetDto, type PublicConceptSetDto } from "@/features/inspiration-concepts/contracts";
import { z } from "zod";

import {
  colorFacetSchema, inspirationAnalysisResultSchema, inspirationPromptSchema,
  inspirationSharedDtoSchema, inspirationSourcesSchema, trendFacetSchema,
} from "@/features/inspiration/contracts";
import {
  generatedConceptAssetDtoSchema, libraryMatchAssetDtoSchema,
  publicGeneratedConceptAssetDtoSchema, webEvidenceAssetDtoSchema,
} from "./contracts";

export const inspirationDimensionKeys = ["silhouettes", "productTypes", "styles", "categories", "colors", "materials"] as const;
export type DimensionKey = (typeof inspirationDimensionKeys)[number];

const dimensionSchemas = inspirationDimensionKeys.map((key) => z.object({
  key: z.literal(key),
  label: z.string().min(1).max(80),
  items: z.array(key === "colors" ? colorFacetSchema : trendFacetSchema).max(8),
}).strict());

const documentShape = {
  hero: webEvidenceAssetDtoSchema.refine((asset) => asset.role === "hero").nullable(),
  intro: inspirationAnalysisResultSchema.pick({ headline: true, summary: true, confidenceNote: true }).strict(),
  marketSignals: z.array(z.object({
    signal: trendFacetSchema,
    evidence: z.array(webEvidenceAssetDtoSchema.refine((asset) => asset.role === "evidence")).max(8),
  }).strict()).max(8),
  dimensions: z.array(z.union(dimensionSchemas)).length(6),
  products: z.array(webEvidenceAssetDtoSchema.refine((asset) => asset.role === "product")).max(4),
  directions: z.array(z.object({
    direction: inspirationPromptSchema,
    libraryMatches: z.array(libraryMatchAssetDtoSchema).max(20),
    concepts: z.array(generatedConceptAssetDtoSchema).max(15),
    conceptSets: z.array(conceptSetDtoSchema).max(3),
  }).strict()).min(3).max(5),
  unassignedLibraryMatches: z.array(libraryMatchAssetDtoSchema).max(20),
  sources: inspirationSourcesSchema,
};

const privateDocumentSchema = z.object(documentShape).strict();
const publicDocumentSchema = z.object({
  ...documentShape,
  directions: z.array(z.object({
    direction: inspirationPromptSchema,
    libraryMatches: z.array(z.never()).max(0),
    concepts: z.array(publicGeneratedConceptAssetDtoSchema).max(15),
    conceptSets: z.array(publicConceptSetDtoSchema).max(3),
  }).strict()).min(3).max(5),
  unassignedLibraryMatches: z.array(z.never()).max(0),
}).strict();

type DocumentContent = z.output<typeof privateDocumentSchema> | z.output<typeof publicDocumentSchema>;

function validateDocument(document: DocumentContent, context: z.RefinementCtx) {
  const references = [
    ...(document.hero ? [document.hero] : []),
    ...document.marketSignals.flatMap(({ signal, evidence }) => [signal, ...evidence]),
    ...document.dimensions.flatMap(({ items }) => items),
    ...document.products,
    ...document.directions.map(({ direction }) => direction),
  ];
  for (const reference of references) {
    const indexes = new Set(reference.sourceIndexes);
    const canonical = document.sources.filter(({ index }) => indexes.has(index)).map(({ index }) => index);
    if (canonical.length !== reference.sourceIndexes.length || canonical.some((index, ordinal) => index !== reference.sourceIndexes[ordinal])) {
      context.addIssue({ code: "custom", message: "source indexes must be unique members in report order" });
    }
  }
  if (document.dimensions.some(({ key }, ordinal) => key !== inspirationDimensionKeys[ordinal])) {
    context.addIssue({ code: "custom", message: "invalid dimension order" });
  }
  const sets = document.directions.flatMap<ConceptSetDto | PublicConceptSetDto>(({ conceptSets }) => conceptSets);
  if (new Set(sets.map(({ id }) => id)).size !== sets.length) {
    context.addIssue({ code: "custom", message: "duplicate document concept set" });
  }
  const outputs = sets.flatMap((set) => "outputs" in set ? set.outputs : set.slots.flatMap(({ asset }) => asset ? [asset] : []));
  const assets = [
    ...outputs,
    ...(document.hero ? [document.hero] : []),
    ...document.marketSignals.flatMap(({ evidence }) => evidence),
    ...document.products,
    ...document.directions.flatMap(({ libraryMatches, concepts }) => [...libraryMatches, ...concepts]),
    ...document.unassignedLibraryMatches,
  ];
  if (new Set(assets.map(({ id }) => id)).size !== assets.length) {
    context.addIssue({ code: "custom", message: "duplicate document asset" });
  }
  if (assets.filter(({ kind }) => kind === "web_evidence").length > 8) {
    context.addIssue({ code: "custom", message: "too many web assets" });
  }
  document.directions.forEach(({ libraryMatches, concepts, conceptSets }, index) => {
    if ([...libraryMatches, ...concepts, ...conceptSets].some(({ directionIndex }) => directionIndex !== index)) {
      context.addIssue({ code: "custom", message: "asset direction does not match its section" });
    }
  });
  if (document.unassignedLibraryMatches.some(({ directionIndex }) => directionIndex !== null)) {
    context.addIssue({ code: "custom", message: "unassigned matches must have null direction" });
  }
}

export const inspirationDocumentDtoSchema = privateDocumentSchema.superRefine(validateDocument);
export const publicInspirationDocumentDtoSchema = publicDocumentSchema.superRefine((document, context) => {
  validateDocument(document, context);
  const publicAssets = [
    ...(document.hero ? [document.hero] : []),
    ...document.marketSignals.flatMap(({ evidence }) => evidence),
    ...document.products,
    ...document.directions.flatMap(({ concepts, conceptSets }) => [...concepts, ...conceptSets.flatMap(({ outputs }) => outputs)]),
  ];
  for (const asset of publicAssets) {
    const route = /^\/share\/inspiration\/([^/]+)\/assets\/([^/]+)$/.exec(asset.imageUrl);
    if (!route || !z.string().uuid().safeParse(route[1]).success || route[2] !== asset.id) {
      context.addIssue({ code: "custom", message: "public images require share resource paths" });
    }
  }
});

// Page metadata surrounds document content; jobs, warnings and private owner data never enter it.
export const inspirationSharedDocumentDtoSchema = inspirationSharedDtoSchema
  .pick({ title: true, prompt: true, completedAt: true })
  .extend({ document: publicInspirationDocumentDtoSchema })
  .strict();

export type InspirationDocumentDto = z.output<typeof inspirationDocumentDtoSchema>;
export type PublicInspirationDocumentDto = z.output<typeof publicInspirationDocumentDtoSchema>;
export type InspirationSharedDocumentDto = z.output<typeof inspirationSharedDocumentDtoSchema>;

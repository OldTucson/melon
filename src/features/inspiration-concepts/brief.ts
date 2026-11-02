import { inspirationAnalysisResultSchema, type InspirationAnalysisResult } from "@/features/inspiration/contracts";
import { inspirationConceptBriefSchema, type InspirationConceptBrief } from "./contracts";

/** Plain text only: no reference URLs or transport metadata are carried forward. */
export function sanitizeConceptText(value: string): string {
  // URI schemes may be opaque (mailto:, urn:) or omit slashes (ftp:).
  // CJK punctuation, brackets and quotes delimit prose, rather than belonging
  // to the removed URI. Keep URI query/fragment characters inside the match.
  return value.normalize("NFC").replace(/(?:[a-z][a-z\d+.-]*:|\/\/)[^\s<>"'`()\[\]{}，。；：！？、（）【】《》“”‘’]+/giu, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reference IDs are already authorized external references, in attachment order. */
export function buildInspirationConceptBrief({ result, directionIndex, referenceAssetIds }: {
  result: InspirationAnalysisResult;
  directionIndex: number;
  referenceAssetIds: readonly string[];
}): InspirationConceptBrief {
  const parsed = inspirationAnalysisResultSchema.parse(result);
  if (!Number.isInteger(directionIndex) || directionIndex < 0 || directionIndex >= parsed.inspirationPrompts.length) {
    throw new Error("Invalid concept direction index");
  }
  const selected = parsed.inspirationPrompts[directionIndex]!;
  const text = sanitizeConceptText;
  const brief = inspirationConceptBriefSchema.parse({
    schemaVersion: "inspiration-concept-brief-v1",
    report: {
      headline: text(parsed.headline),
      summary: text(parsed.summary),
      marketSignals: parsed.marketSignals.slice(0, 5).map(({ name, rationale, strength }) => ({ name: text(name), rationale: text(rationale), strength })),
    },
    directionIndex,
    direction: {
      title: text(selected.title), direction: text(selected.direction), silhouette: text(selected.silhouette),
      palette: selected.palette.map(text), materials: selected.materials.map(text), details: selected.details.map(text),
      sourceIndexes: [...selected.sourceIndexes],
    },
    referenceAssetIds: [...referenceAssetIds],
    promptTemplateVersion: "inspiration-concept-prompts-v1",
    model: "qwen-image-3.0-pro",
    sizes: { sketch: "1536*2048", effect: "1536*2048", flat: "2048*1536" },
  });
  if (new Set(brief.referenceAssetIds).size !== brief.referenceAssetIds.length) {
    throw new Error("Duplicate concept references");
  }
  return deepFreeze(brief);
}

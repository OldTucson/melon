import { z } from "zod";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { conceptOutputKindSchema, type ConceptOutputKind } from "./contracts";

const scopeSchema = z.object({ ownerId: normalizedUuidSchema, analysisId: normalizedUuidSchema, setId: normalizedUuidSchema });
const keySchema = scopeSchema.extend({ outputKind: conceptOutputKindSchema, outputId: normalizedUuidSchema });
export type ConceptObjectScope = z.output<typeof scopeSchema>;
export type ConceptObjectKeyParts = ConceptObjectScope & { outputKind: ConceptOutputKind; outputId: string };
const invalid = () => new Error("Invalid concept object key");
const prefix = (parts: ConceptObjectScope) => `users/${parts.ownerId}/inspiration/${parts.analysisId}/concept-sets/${parts.setId}/`;
const format = (parts: ConceptObjectKeyParts) => `${prefix(parts)}${parts.outputKind}/${parts.outputId}.png`;

export function conceptSetObjectPrefix(input: ConceptObjectScope): string {
  try { return prefix(scopeSchema.parse(input)); } catch { throw invalid(); }
}
export function conceptOutputObjectKey(input: ConceptObjectKeyParts): string {
  try { return format(keySchema.parse(input)); } catch { throw invalid(); }
}
export function parseConceptObjectKey(key: string): ConceptObjectKeyParts {
  try {
    const segments = key.split("/");
    if (segments.length !== 8 || segments[0] !== "users" || segments[2] !== "inspiration" || segments[4] !== "concept-sets" || !segments[7]!.endsWith(".png")) throw invalid();
    const parts = keySchema.parse({ ownerId: segments[1], analysisId: segments[3], setId: segments[5], outputKind: segments[6], outputId: segments[7]!.slice(0, -4) });
    if (format(parts) !== key) throw invalid();
    return parts;
  } catch { throw invalid(); }
}
export function assertConceptSetObjectPrefix(value: string): string {
  try {
    const segments = value.split("/");
    if (segments.length !== 7 || segments[6] !== "" || segments[0] !== "users" || segments[2] !== "inspiration" || segments[4] !== "concept-sets") throw invalid();
    const canonical = conceptSetObjectPrefix({ ownerId: segments[1]!, analysisId: segments[3]!, setId: segments[5]! });
    if (canonical !== value) throw invalid();
    return canonical;
  } catch { throw invalid(); }
}

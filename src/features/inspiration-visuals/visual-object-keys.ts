import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";

const identitySchema = z.object({
  ownerId: normalizedUuidSchema,
  analysisId: normalizedUuidSchema,
  jobId: normalizedUuidSchema,
  assetId: normalizedUuidSchema,
});
const keySchema = identitySchema.extend({ extension: z.enum(["png", "jpg", "webp", "gif"]) });
export type VisualObjectKeyParts = z.output<typeof keySchema>;
type ResearchScope = Pick<VisualObjectKeyParts, "ownerId" | "analysisId" | "jobId">;
const invalidKey = () => new Error("Invalid visual object key");
const format = (parts: VisualObjectKeyParts) =>
  `users/${parts.ownerId}/inspiration/${parts.analysisId}/research/${parts.jobId}/${parts.assetId}.${parts.extension}`;

export function researchVisualObjectKey(input: ResearchScope & { assetId: string; extension: string }): string {
  try {
    return format(keySchema.parse({ ...input, extension: input.extension.toLowerCase() }));
  } catch { throw invalidKey(); }
}

export function parseVisualObjectKey(key: string): VisualObjectKeyParts {
  try {
    const segments = key.split("/");
    const filename = segments[6]?.split(".");
    if (segments.length !== 7 || segments[0] !== "users" || segments[2] !== "inspiration" || segments[4] !== "research" || filename?.length !== 2) throw invalidKey();
    const parts = keySchema.parse({ ownerId: segments[1], analysisId: segments[3], jobId: segments[5], assetId: filename[0], extension: filename[1] });
    if (format(parts) !== key) throw invalidKey();
    return parts;
  } catch { throw invalidKey(); }
}

export function assertVisualObjectKeyBelongsToResearch(input: ResearchScope & { key: string }): VisualObjectKeyParts {
  try {
    const parts = parseVisualObjectKey(input.key);
    const scope = identitySchema.omit({ assetId: true }).parse(input);
    if (parts.ownerId !== scope.ownerId || parts.analysisId !== scope.analysisId || parts.jobId !== scope.jobId) throw invalidKey();
    return parts;
  } catch { throw invalidKey(); }
}

import type { InspirationPrompt } from "@/features/inspiration/contracts";
import { webEvidenceAssetDtoSchema, type WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";

/** Assets must come from the authorized active, completed research-visual projection.
 * Job state and ownership are checked by the caller, never inferred from an asset. */
export function selectDefaultConceptReferences({ direction, assets }: {
  direction: InspirationPrompt;
  assets: readonly WebEvidenceAssetDto[];
}): WebEvidenceAssetDto[] {
  const sources = new Set(direction.sourceIndexes);
  const rank = (asset: WebEvidenceAssetDto) => [
    asset.sourceIndexes.some((index) => sources.has(index)) ? 0 : 1,
    asset.role === "product" ? 0 : asset.role === "evidence" ? 1 : 2,
    asset.ordinal,
  ];
  const candidates = assets.flatMap((asset) => {
    const parsed = webEvidenceAssetDtoSchema.safeParse(asset);
    return parsed.success ? [parsed.data] : [];
  }).sort((left, right) => {
    const a = rank(left);
    const b = rank(right);
    for (let i = 0; i < a.length; i++) {
      const difference = a[i]! - b[i]!;
      if (difference) return difference;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const seen = new Set<string>();
  return candidates.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 3);
}

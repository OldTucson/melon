import postgres from "postgres";

import { E2E_DATABASE_URL, E2E_USERS } from "./environment";

const ownerId = E2E_USERS.designer.id;
export const IMAGE_SEARCH_INDEX_VERSION = "visual-search-v2";

export const IMAGE_SEARCH_PALETTE = [
  {
    coverage: 0.5,
    displayHex: "#285947",
    oklab: [0.42, -0.08, 0.03] as const,
  },
  {
    coverage: 0.3,
    displayHex: "#CC9C3F",
    oklab: [0.72, 0.03, 0.11] as const,
  },
  {
    coverage: 0.2,
    displayHex: "#8F4038",
    oklab: [0.48, 0.1, 0.05] as const,
  },
] as const;

export const IMAGE_SEARCH_PATTERN_SEEDS = [
  {
    id: "44444444-4444-4444-8444-444444444441",
    name: "高概率来源图案",
    extension: "png",
    originalFilename: "probable-source.png",
    sourceAssetId: "55555555-5555-4555-8555-555555555541",
    previewAssetId: "66666666-6666-4666-8666-666666666641",
    documentId: "77777777-7777-4777-8777-777777777741",
    kind: "probable_source",
  },
  {
    id: "44444444-4444-4444-8444-444444444442",
    name: "可能来源图案",
    extension: "png",
    originalFilename: "possible-source.png",
    sourceAssetId: "55555555-5555-4555-8555-555555555542",
    previewAssetId: "66666666-6666-4666-8666-666666666642",
    documentId: "77777777-7777-4777-8777-777777777742",
    kind: "possible_source",
  },
  {
    id: "44444444-4444-4444-8444-444444444443",
    name: "视觉相似图案",
    extension: "jpg",
    originalFilename: "visually-similar.jpg",
    sourceAssetId: "55555555-5555-4555-8555-555555555543",
    previewAssetId: "66666666-6666-4666-8666-666666666643",
    documentId: "77777777-7777-4777-8777-777777777743",
    kind: "visually_similar",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "筛选后相似图案",
    extension: "ai",
    originalFilename: "filtered-similar.ai",
    sourceAssetId: "55555555-5555-4555-8555-555555555544",
    previewAssetId: "66666666-6666-4666-8666-666666666644",
    documentId: "77777777-7777-4777-8777-777777777744",
    kind: "visually_similar",
  },
] as const;

type FixtureAssetRow = {
  assetId: string;
  objectKey: string;
  ownerId: string;
  patternId: string;
  role: string;
};

const fixtureAssets: FixtureAssetRow[] = IMAGE_SEARCH_PATTERN_SEEDS.flatMap(
  (pattern) => [
    {
      assetId: pattern.sourceAssetId,
      objectKey: `users/${ownerId}/patterns/${pattern.id}/source/${pattern.sourceAssetId}.${pattern.extension}`,
      ownerId,
      patternId: pattern.id,
      role: "source",
    },
    {
      assetId: pattern.previewAssetId,
      objectKey: `users/${ownerId}/patterns/${pattern.id}/derived/${pattern.previewAssetId}.jpg`,
      ownerId,
      patternId: pattern.id,
      role: "preview",
    },
  ],
);

const fixtureAssetById = new Map<string, FixtureAssetRow>(
  fixtureAssets.map((asset) => [asset.assetId, asset]),
);

export function assertImageSearchFixtureRows(
  rows: readonly FixtureAssetRow[],
  uploadRows: readonly unknown[] = [],
) {
  if (uploadRows.length > 0) {
    throw new Error("E2E_IMAGE_SEARCH_UPLOADS_PRESENT");
  }
  for (const row of rows) {
    const expected = fixtureAssetById.get(row.assetId);
    if (
      !expected ||
      row.objectKey !== expected.objectKey ||
      row.ownerId !== expected.ownerId ||
      row.patternId !== expected.patternId ||
      row.role !== expected.role
    ) {
      throw new Error("E2E_IMAGE_SEARCH_ASSET_UNSAFE");
    }
  }
}

export async function seedImageSearchPatterns(
  databaseUrl: string = E2E_DATABASE_URL,
) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    for (const [index, pattern] of IMAGE_SEARCH_PATTERN_SEEDS.entries()) {
      await client`
        insert into patterns (
          id, owner_id, name, original_filename, extension,
          detected_mime_type, size_bytes, status, preview_status,
          is_favorite, created_at, updated_at
        ) values (
          ${pattern.id}, ${ownerId}, ${pattern.name},
          ${pattern.originalFilename}, ${pattern.extension},
          ${pattern.extension === "jpg" ? "image/jpeg" : "image/png"},
          ${4096 + index}, 'ready', 'ready', false,
          '2026-10-20T00:00:00.000Z',
          ${`2026-10-20T00:00:0${index}.000Z`}
        )
        on conflict (id) do update set
          name = excluded.name,
          original_filename = excluded.original_filename,
          extension = excluded.extension,
          detected_mime_type = excluded.detected_mime_type,
          size_bytes = excluded.size_bytes,
          status = excluded.status,
          preview_status = excluded.preview_status,
          updated_at = excluded.updated_at
      `;
      await client`
        delete from assets
        where owner_id = ${ownerId} and pattern_id = ${pattern.id}
      `;
      await client`
        insert into assets (
          id, owner_id, pattern_id, role, object_key,
          original_filename, detected_mime_type, size_bytes,
          width, height
        ) values
          (
            ${pattern.sourceAssetId}, ${ownerId}, ${pattern.id}, 'source',
            ${fixtureAssetById.get(pattern.sourceAssetId)!.objectKey},
            ${pattern.originalFilename},
            ${pattern.extension === "jpg" ? "image/jpeg" : "application/octet-stream"},
            ${4096 + index}, null, null
          ),
          (
            ${pattern.previewAssetId}, ${ownerId}, ${pattern.id}, 'preview',
            ${fixtureAssetById.get(pattern.previewAssetId)!.objectKey},
            'preview.jpg', 'image/jpeg', 4096, 320, 240
          )
      `;
      await client`
        insert into visual_search_documents (
          id, owner_id, pattern_id, preview_asset_id, preview_hash,
          index_version, status, width, height, indexed_at
        ) values (
          ${pattern.documentId}, ${ownerId}, ${pattern.id},
          ${pattern.previewAssetId}, ${String(index + 1).repeat(64)},
          ${IMAGE_SEARCH_INDEX_VERSION}, 'ready', 320, 240,
          '2026-10-22T00:00:00.000Z'
        )
      `;
      for (const [colorIndex, color] of IMAGE_SEARCH_PALETTE.entries()) {
        await client`
          insert into visual_search_palette_colors (
            document_id, owner_id, pattern_id, color_index, display_hex,
            oklab_l, oklab_a, oklab_b, coverage
          ) values (
            ${pattern.documentId}, ${ownerId}, ${pattern.id}, ${colorIndex},
            ${color.displayHex}, ${color.oklab[0]}, ${color.oklab[1]},
            ${color.oklab[2]}, ${color.coverage}
          )
        `;
      }
    }
  } finally {
    await client.end();
  }
}

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SYSTEM_AUTHORIZATION_FIELD_SEED } from "@/features/authorizations/system-fields";
import { listPatterns } from "@/features/patterns/pattern-service";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  authorizations,
  folders,
  patterns,
  patternTags,
  tags,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import {
  hydrateRankedPatterns,
  resolveImageSearchPatternIds,
} from "./pattern-scope";

const fieldA = SYSTEM_AUTHORIZATION_FIELD_SEED[0]!;
const fieldB = SYSTEM_AUTHORIZATION_FIELD_SEED[1]!;

async function seedUser(email: string) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    displayName: email,
    passwordHash: "test-password-hash",
    mustChangePassword: false,
  });
  return id;
}

async function seedFolder(ownerId: string, name: string, parentId?: string) {
  const id = randomUUID();
  await db.insert(folders).values({
    id,
    ownerId,
    name,
    normalizedName: name.toLowerCase(),
    parentId,
  });
  return id;
}

async function seedPattern(input: {
  ownerId: string;
  name: string;
  folderId?: string | null;
  extension?: string;
  favorite?: boolean;
  previewStatus?: "pending" | "ready" | "unsupported" | "failed" | "manual";
  status?: "ready" | "trashed" | "deleted";
}) {
  const id = randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId,
    name: input.name,
    originalFilename: `${input.name}.${input.extension ?? "png"}`,
    extension: input.extension ?? "png",
    sizeBytes: 1024n,
    isFavorite: input.favorite ?? false,
    previewStatus: input.previewStatus ?? "ready",
    status: input.status ?? "ready",
    deletedAt: input.status === "deleted" ? new Date() : null,
    trashedAt: input.status === "trashed" ? new Date() : null,
  });
  return id;
}

async function seedAuthorization(input: {
  ownerId: string;
  patternId: string;
  fieldId: string;
  kind?: "standard" | "field_exclusive";
}) {
  await db.insert(authorizations).values({
    id: randomUUID(),
    operationId: randomUUID(),
    ownerId: input.ownerId,
    patternId: input.patternId,
    kind: input.kind ?? "standard",
    fieldId: input.fieldId,
    fieldNameSnapshot: "Field",
    licenseeName: "Client",
    priceFen: 12_800n,
    authorizedOn: "2026-10-20",
  });
}

describe("image-search pattern scope", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("image-scope-a@example.test");
    ownerB = await seedUser("image-scope-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("reuses every library filter while isolating owner, trash, and deleted rows", async () => {
    const parent = await seedFolder(ownerA, "Parent");
    const child = await seedFolder(ownerA, "Child", parent);
    const outside = await seedFolder(ownerA, "Outside");
    const summer = randomUUID();
    const floral = randomUUID();
    await db.insert(tags).values([
      {
        id: summer,
        ownerId: ownerA,
        name: "Summer",
        normalizedName: "summer",
        colorToken: "green",
      },
      {
        id: floral,
        ownerId: ownerA,
        name: "Floral",
        normalizedName: "floral",
        colorToken: "blue",
      },
    ]);

    const target = await seedPattern({
      ownerId: ownerA,
      folderId: child,
      name: "Floral hero",
      extension: "png",
      favorite: true,
      previewStatus: "manual",
    });
    const unfiled = await seedPattern({ ownerId: ownerA, name: "Unfiled" });
    const inactiveTagOnly = await seedPattern({
      ownerId: ownerA,
      name: "Inactive tag only",
    });
    const decoys = await Promise.all([
      seedPattern({ ownerId: ownerA, folderId: outside, name: "Floral outside", favorite: true, previewStatus: "manual" }),
      seedPattern({ ownerId: ownerA, folderId: child, name: "Wrong format", extension: "jpg", favorite: true, previewStatus: "manual" }),
      seedPattern({ ownerId: ownerA, folderId: child, name: "Not favorite", previewStatus: "manual" }),
      seedPattern({ ownerId: ownerA, folderId: child, name: "Wrong preview", favorite: true }),
      seedPattern({ ownerId: ownerA, folderId: child, name: "Floral trashed", favorite: true, previewStatus: "manual", status: "trashed" }),
      seedPattern({ ownerId: ownerA, folderId: child, name: "Floral deleted", favorite: true, previewStatus: "manual", status: "deleted" }),
      seedPattern({ ownerId: ownerB, name: "Floral foreign", favorite: true, previewStatus: "manual" }),
    ]);
    await db.insert(patternTags).values([
      { ownerId: ownerA, patternId: target, tagId: summer },
      { ownerId: ownerA, patternId: target, tagId: floral },
      { ownerId: ownerA, patternId: decoys[0]!, tagId: summer },
      { ownerId: ownerA, patternId: inactiveTagOnly, tagId: summer, isActive: false },
    ]);
    await seedAuthorization({ ownerId: ownerA, patternId: target, fieldId: fieldA.id });
    await seedAuthorization({ ownerId: ownerA, patternId: decoys[0]!, fieldId: fieldB.id });

    await expect(
      resolveImageSearchPatternIds({
        ownerId: ownerA,
        filters: {
          q: "floral",
          formats: ["png"],
          tagIds: [summer, floral],
          tagMode: "all",
          favorite: true,
          previewStatus: "manual",
          commercialState: "standard",
          authorizationField: fieldA.id,
          folderId: parent,
          includeDescendants: true,
        },
      }),
    ).resolves.toEqual([target]);

    await expect(
      resolveImageSearchPatternIds({
        ownerId: ownerA,
        filters: { folderId: parent, includeDescendants: false },
      }),
    ).resolves.toEqual([]);
    expect(
      await resolveImageSearchPatternIds({
        ownerId: ownerA,
        filters: { unfiled: true },
      }),
    ).toEqual(expect.arrayContaining([unfiled, inactiveTagOnly]));
    expect(
      await resolveImageSearchPatternIds({
        ownerId: ownerA,
        filters: { untagged: true },
      }),
    ).toEqual(expect.arrayContaining([unfiled, inactiveTagOnly]));
    expect(
      await resolveImageSearchPatternIds({
        ownerId: ownerA,
        filters: { tagIds: [summer, floral], tagMode: "any" },
      }),
    ).toEqual(expect.arrayContaining([target, decoys[0]! ]));
  });

  it("deduplicates all-mode tag IDs like the library listing", async () => {
    const tagId = randomUUID();
    await db.insert(tags).values({
      id: tagId,
      ownerId: ownerA,
      name: "Repeated",
      normalizedName: "repeated",
      colorToken: "green",
    });
    const tagged = await seedPattern({ ownerId: ownerA, name: "Tagged" });
    await db.insert(patternTags).values({
      ownerId: ownerA,
      patternId: tagged,
      tagId,
    });
    const filters = { tagIds: [tagId, tagId], tagMode: "all" as const };

    const library = await listPatterns({ ownerId: ownerA, input: filters });

    expect(library.items.map((item) => item.id)).toEqual([tagged]);
    await expect(
      resolveImageSearchPatternIds({ ownerId: ownerA, filters }),
    ).resolves.toEqual([tagged]);
  });

  it("throws instead of truncating a 10,001-pattern scope", async () => {
    await db.execute(sql`
      insert into patterns (
        id, owner_id, name, original_filename, extension, size_bytes,
        status, preview_status
      )
      select
        md5('image-search-scope-' || value::text)::uuid,
        ${ownerA}::uuid,
        'Pattern ' || value::text,
        'pattern-' || value::text || '.png',
        'png',
        1,
        'ready'::pattern_status,
        'ready'::preview_status
      from generate_series(1, 10001) as value
    `);

    await expect(
      resolveImageSearchPatternIds({ ownerId: ownerA, filters: {} }),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_SCOPE_TOO_LARGE",
      status: 413,
    });
  });

  it("hydrates at most 30 owned rows in rank order with assets and commercial summary", async () => {
    const first = await seedPattern({ ownerId: ownerA, name: "First" });
    const second = await seedPattern({ ownerId: ownerA, name: "Second" });
    const foreign = await seedPattern({ ownerId: ownerB, name: "Foreign" });
    const previewAssetId = randomUUID();
    const sourceAssetId = randomUUID();
    await db.insert(assets).values([
      {
        id: previewAssetId,
        ownerId: ownerA,
        patternId: second,
        role: "preview",
        objectKey: `users/${ownerA}/patterns/${second}/derived/preview.png`,
        originalFilename: "preview.png",
        detectedMimeType: "image/png",
        sizeBytes: 100n,
      },
      {
        id: sourceAssetId,
        ownerId: ownerA,
        patternId: second,
        role: "source",
        objectKey: `users/${ownerA}/patterns/${second}/source/source.png`,
        originalFilename: "source.png",
        detectedMimeType: "image/png",
        sizeBytes: 200n,
      },
    ]);
    await seedAuthorization({
      ownerId: ownerA,
      patternId: second,
      fieldId: fieldA.id,
      kind: "field_exclusive",
    });

    const hydrated = await hydrateRankedPatterns({
      ownerId: ownerA,
      items: [
        { patternId: second, kind: "possible_source" },
        { patternId: foreign, kind: "visually_similar" },
        { patternId: first, kind: "visually_similar" },
      ],
    });

    expect(hydrated.map((item) => item.id)).toEqual([second, first]);
    expect(hydrated[0]).toMatchObject({
      previewAssetId,
      sourceAssetId,
      thumbnailAssetId: null,
      matchKind: "possible_source",
      commercialSummary: {
        state: "field_exclusive",
        activeCount: 1,
        revenueFen: "12800",
      },
    });
    await expect(
      hydrateRankedPatterns({
        ownerId: ownerA,
        items: Array.from({ length: 31 }, () => ({
          patternId: first,
          kind: "visually_similar" as const,
        })),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });
});

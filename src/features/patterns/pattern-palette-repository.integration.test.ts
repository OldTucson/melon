import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const paletteFeature = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/env/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env/server")>();
  return {
    ...actual,
    getServerEnv: () => ({
      ...actual.getServerEnv(),
      IMAGE_SEARCH_ENABLED: paletteFeature.enabled,
    }),
  };
});

import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  patterns,
  users,
  visualSearchDocuments,
  visualSearchJobs,
  visualSearchPaletteColors,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import { loadPatternPaletteStates } from "./pattern-palette-repository";

const INDEX_VERSION = "visual-search-v1";

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

async function seedPattern(ownerId: string, name: string) {
  const patternId = randomUUID();
  const previewAssetId = randomUUID();
  await db.insert(patterns).values({
    id: patternId,
    ownerId,
    name,
    originalFilename: `${name}.png`,
    extension: "png",
    sizeBytes: 1024n,
    status: "ready",
    previewStatus: "ready",
  });
  await db.insert(assets).values({
    id: previewAssetId,
    ownerId,
    patternId,
    role: "preview",
    objectKey: `users/${ownerId}/patterns/${patternId}/derived/${previewAssetId}.png`,
    originalFilename: `${name}-preview.png`,
    detectedMimeType: "image/png",
    sizeBytes: 512n,
    width: 64,
    height: 64,
  });
  return { patternId, previewAssetId };
}

async function seedReadyPalette(input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  indexVersion?: string;
  colorCount?: number;
}) {
  const documentId = randomUUID();
  await db.insert(visualSearchDocuments).values({
    id: documentId,
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    previewHash: randomUUID().replaceAll("-", "").repeat(2),
    indexVersion: input.indexVersion ?? INDEX_VERSION,
    status: "ready",
    phash: "0".repeat(64),
    width: 64,
    height: 64,
    localFeatureObjectKey: `features/${documentId}.npz`,
    indexedAt: new Date("2026-10-22T00:00:00.000Z"),
  });
  const palette = [
    { hex: "#285947", oklab: [0.42, -0.08, 0.03], coverage: 0.5 },
    { hex: "#CC9C3F", oklab: [0.72, 0.03, 0.11], coverage: 0.3 },
    { hex: "#8F4038", oklab: [0.48, 0.1, 0.05], coverage: 0.2 },
  ] as const;
  await db.insert(visualSearchPaletteColors).values(
    palette.slice(0, input.colorCount ?? palette.length).map((color, index) => ({
      documentId,
      ownerId: input.ownerId,
      patternId: input.patternId,
      colorIndex: index,
      displayHex: color.hex,
      oklabL: color.oklab[0],
      oklabA: color.oklab[1],
      oklabB: color.oklab[2],
      coverage: color.coverage,
    })),
  );
}

async function seedJob(input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  status: "pending" | "leased" | "complete" | "failed";
}) {
  await db.insert(visualSearchJobs).values({
    id: randomUUID(),
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    indexVersion: INDEX_VERSION,
    status: input.status,
    lastErrorCode:
      input.status === "failed" ? "INDEX_PREVIEW_INVALID" : null,
  });
}

describe("pattern palette repository", () => {
  beforeEach(async () => {
    paletteFeature.enabled = true;
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("loads ready, pending, and failed states in two scoped batch queries", async () => {
    const ownerA = await seedUser("palette-state-a@example.test");
    const ownerB = await seedUser("palette-state-b@example.test");
    const ready = await seedPattern(ownerA, "Ready");
    const indexing = await seedPattern(ownerA, "Indexing");
    const failed = await seedPattern(ownerA, "Failed");
    const oldVersion = await seedPattern(ownerA, "Old version");
    const foreign = await seedPattern(ownerB, "Foreign");
    await seedReadyPalette({ ownerId: ownerA, ...ready });
    await seedJob({ ownerId: ownerA, ...indexing, status: "leased" });
    await seedJob({ ownerId: ownerA, ...failed, status: "failed" });
    await seedReadyPalette({
      ownerId: ownerA,
      ...oldVersion,
      indexVersion: "visual-search-v0",
    });
    await seedReadyPalette({ ownerId: ownerB, ...foreign });

    const execute = vi.fn((query) => db.execute(query));
    const states = await loadPatternPaletteStates({
      ownerId: ownerA,
      patternIds: [
        ready.patternId,
        indexing.patternId,
        failed.patternId,
        oldVersion.patternId,
        foreign.patternId,
      ],
      indexVersion: INDEX_VERSION,
      executor: { execute } as unknown as Pick<typeof db, "execute">,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect([...states.entries()]).toEqual([
      [
        ready.patternId,
        {
          paletteStatus: "ready",
          palette: [
            { hex: "#285947", coverage: 0.5 },
            { hex: "#CC9C3F", coverage: 0.3 },
            { hex: "#8F4038", coverage: 0.2 },
          ],
        },
      ],
      [indexing.patternId, { paletteStatus: "pending", palette: [] }],
      [failed.patternId, { paletteStatus: "failed", palette: [] }],
      [oldVersion.patternId, { paletteStatus: "pending", palette: [] }],
      [foreign.patternId, { paletteStatus: "pending", palette: [] }],
    ]);
  });

  it("fails closed when a ready document has a malformed palette", async () => {
    const ownerId = await seedUser("palette-invalid@example.test");
    const malformed = await seedPattern(ownerId, "Malformed");
    await seedReadyPalette({
      ownerId,
      ...malformed,
      colorCount: 2,
    });

    await expect(
      loadPatternPaletteStates({
        ownerId,
        patternIds: [malformed.patternId],
        indexVersion: INDEX_VERSION,
      }),
    ).rejects.toThrow("PATTERN_PALETTE_INVALID");
  });

  it("returns pending without querying when image search is disabled", async () => {
    paletteFeature.enabled = false;
    const execute = vi.fn((query) => db.execute(query));
    const patternId = randomUUID();

    const states = await loadPatternPaletteStates({
      ownerId: randomUUID(),
      patternIds: [patternId],
      indexVersion: INDEX_VERSION,
      executor: { execute } as unknown as Pick<typeof db, "execute">,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(states.get(patternId)).toEqual({
      paletteStatus: "pending",
      palette: [],
    });
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { patterns, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import { searchPatternsByPalette } from "./palette-search-service";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const colors = ["#285947", "#CC9C3F"] as const;

describe("palette search service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    await db.insert(users).values([
      {
        id: ownerId,
        email: "palette-service@example.test",
        displayName: "Palette owner",
        passwordHash: "test-password-hash",
        mustChangePassword: false,
      },
      {
        id: otherOwnerId,
        email: "palette-service-other@example.test",
        displayName: "Other owner",
        passwordHash: "test-password-hash",
        mustChangePassword: false,
      },
    ]);
    first = randomUUID();
    second = randomUUID();
    await db.insert(patterns).values([
      {
        id: first,
        ownerId,
        name: "First",
        originalFilename: "first.png",
        extension: "png",
        sizeBytes: 100n,
        status: "ready",
        previewStatus: "ready",
      },
      {
        id: second,
        ownerId,
        name: "Second",
        originalFilename: "second.png",
        extension: "png",
        sizeBytes: 100n,
        status: "ready",
        previewStatus: "ready",
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("resolves filters, preserves server ranking, hydrates DTOs, and strips distance", async () => {
    const client = {
      search: vi.fn(async () => ({
        requestId,
        query: { colors: [...colors] },
        items: [
          { patternId: second, distance: 0.0125 },
          { patternId: first, distance: 0.125 },
        ],
      })),
    };
    const signal = new AbortController().signal;

    const result = await searchPatternsByPalette(
      {
        ownerId,
        colors,
        filters: { favorite: false },
        requestId,
        signal,
      },
      { client, now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(184) },
    );

    expect(client.search).toHaveBeenCalledWith({
      ownerId,
      allowedPatternIds: expect.arrayContaining([first, second]),
      requestId,
      colors,
      signal,
    });
    expect(result.query).toEqual({ colors });
    expect(result.items.map((item) => item.id)).toEqual([second, first]);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: second,
        paletteStatus: "pending",
        palette: [],
      }),
      expect.objectContaining({
        id: first,
        paletteStatus: "pending",
        palette: [],
      }),
    ]);
    expect(result.timing).toEqual({ totalMs: 84 });
    expect(JSON.stringify(result)).not.toMatch(/distance|oklab|objectKey|signed/i);
  });

  it("short-circuits an empty filtered scope without calling the internal service", async () => {
    const client = { search: vi.fn() };

    await expect(
      searchPatternsByPalette(
        {
          ownerId,
          colors,
          filters: { q: "does-not-exist" },
          requestId,
          signal: new AbortController().signal,
        },
        { client },
      ),
    ).rejects.toMatchObject({
      code: "PALETTE_SEARCH_NO_INDEX",
      status: 409,
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("rejects duplicate, out-of-scope, and missing hydrated results", async () => {
    const foreign = randomUUID();
    await db.insert(patterns).values({
      id: foreign,
      ownerId: otherOwnerId,
      name: "Foreign",
      originalFilename: "foreign.png",
      extension: "png",
      sizeBytes: 100n,
      status: "ready",
      previewStatus: "ready",
    });
    const responses = [
      {
        requestId,
        query: { colors: [...colors] },
        items: [
          { patternId: first, distance: 0.1 },
          { patternId: first, distance: 0.2 },
        ],
      },
      {
        requestId,
        query: { colors: [...colors] },
        items: [{ patternId: foreign, distance: 0.1 }],
      },
    ];

    for (const response of responses) {
      await expect(
        searchPatternsByPalette(
          {
            ownerId,
            colors,
            filters: {},
            requestId,
            signal: new AbortController().signal,
          },
          { client: { search: vi.fn(async () => response) } },
        ),
      ).rejects.toMatchObject({
        code: "PALETTE_SEARCH_UNAVAILABLE",
        status: 503,
      });
    }

    const deletingClient = {
      search: vi.fn(async () => {
        await db.delete(patterns).where(eq(patterns.id, first));
        return {
          requestId,
          query: { colors: [...colors] },
          items: [{ patternId: first, distance: 0.1 }],
        };
      }),
    };
    await expect(
      searchPatternsByPalette(
        {
          ownerId,
          colors,
          filters: {},
          requestId,
          signal: new AbortController().signal,
        },
        { client: deletingClient },
      ),
    ).rejects.toMatchObject({
      code: "PALETTE_SEARCH_UNAVAILABLE",
      status: 503,
    });
  });
});

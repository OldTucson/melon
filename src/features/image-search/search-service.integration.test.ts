import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { patterns, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import { searchPatternsByImage } from "./search-service";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("image search service", () => {
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
        email: "search-service@example.test",
        displayName: "Search owner",
        passwordHash: "test-password-hash",
        mustChangePassword: false,
      },
      {
        id: otherOwnerId,
        email: "search-service-other@example.test",
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

  it("resolves scope, hydrates in rank order, groups DTOs, and drops diagnostics", async () => {
    const client = {
      search: vi.fn(async () => ({
        requestId,
        query: { width: 640, height: 480 },
        items: [
          { patternId: second, kind: "probable_source" as const, score: 0.99 },
          { patternId: first, kind: "visually_similar" as const, score: 0.72 },
        ],
      })),
    };
    const signal = new AbortController().signal;

    const result = await searchPatternsByImage(
      {
        ownerId,
        image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
        filters: {},
        requestId,
        signal,
      },
      { client, now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(225) },
    );

    expect(client.search).toHaveBeenCalledWith({
      ownerId,
      image: expect.any(File),
      allowedPatternIds: expect.arrayContaining([first, second]),
      requestId,
      signal,
    });
    expect(result.query).toEqual({ width: 640, height: 480 });
    expect(result.timing).toEqual({ totalMs: 125 });
    expect(result.groups.map((group) => group.kind)).toEqual([
      "probable_source",
      "visually_similar",
    ]);
    expect(result.groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([
      second,
      first,
    ]);
    expect(JSON.stringify(result)).not.toMatch(/score|feature|objectKey|signed/i);
  });

  it("rejects any internal ID outside the allowed owner-scoped set", async () => {
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
    const client = {
      search: vi.fn(async () => ({
        requestId,
        query: { width: 640, height: 480 },
        items: [
          { patternId: foreign, kind: "probable_source" as const, score: 0.99 },
        ],
      })),
    };

    await expect(
      searchPatternsByImage(
        {
          ownerId,
          image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
          filters: {},
          requestId,
          signal: new AbortController().signal,
        },
        { client },
      ),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_UNAVAILABLE",
      status: 503,
    });
  });
});

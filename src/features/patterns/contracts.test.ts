import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parsePatternSearchParams, patternQuerySchema } from "./contracts";

describe("pattern query contracts", () => {
  it("defaults descendant inclusion and scope without changing existing defaults", () => {
    expect(patternQuerySchema.parse({})).toEqual({
      formats: [],
      tagIds: [],
      tagMode: "all",
      includeDescendants: true,
      scope: "library",
      sort: "updated_desc",
      limit: 50,
    });
  });

  it("parses string and boolean folder query flags", () => {
    expect(
      patternQuerySchema.parse({
        unfiled: "false",
        includeDescendants: "false",
      }),
    ).toMatchObject({ unfiled: false, includeDescendants: false });
    expect(
      patternQuerySchema.parse({ unfiled: true, includeDescendants: true }),
    ).toMatchObject({ unfiled: true, includeDescendants: true });
  });

  it("allows unfiled=false with a folder but rejects unfiled=true", () => {
    const folderId = randomUUID();

    expect(
      patternQuerySchema.parse({ folderId, unfiled: false }),
    ).toMatchObject({ folderId, unfiled: false });
    expect(() =>
      patternQuerySchema.parse({ folderId, unfiled: true }),
    ).toThrow();
  });

  it("rejects invalid folder IDs and scopes", () => {
    expect(() => patternQuerySchema.parse({ folderId: "folder-1" })).toThrow();
    expect(() => patternQuerySchema.parse({ scope: "archive" })).toThrow();
  });

  it("canonicalizes repeated existing format and tag parameters", () => {
    const firstTagId = randomUUID();
    const secondTagId = randomUUID();
    const query = parsePatternSearchParams(
      new URLSearchParams(
        `format=psd&formats=png&tag=${firstTagId}&tagIds=${secondTagId}`,
      ),
    );

    expect(query.formats).toEqual(["psd", "png"]);
    expect(query.tagIds).toEqual(
      [firstTagId, secondTagId].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  });

  it("canonicalizes equivalent production search parameter order", () => {
    const firstTagId = "00000000-0000-4000-8000-000000000001";
    const secondTagId = "00000000-0000-4000-8000-000000000002";
    const first = parsePatternSearchParams(
      new URLSearchParams(
        `format=png&formats=psd&tag=${secondTagId}&tagIds=${firstTagId}`,
      ),
    );
    const second = parsePatternSearchParams(
      new URLSearchParams(
        `tag=${firstTagId}&format=psd&tagIds=${secondTagId}&formats=png`,
      ),
    );

    expect(first).toEqual(second);
    expect(first.formats).toEqual(["psd", "png"]);
    expect(first.tagIds).toEqual([firstTagId, secondTagId]);
  });

  it("parses all folder and trash URL parameters", () => {
    const folderId = randomUUID();
    expect(
      parsePatternSearchParams(
        new URLSearchParams(
          `folderId=${folderId}&unfiled=false&includeDescendants=false&scope=trash`,
        ),
      ),
    ).toMatchObject({
      folderId,
      unfiled: false,
      includeDescendants: false,
      scope: "trash",
    });
  });

  it("applies defaults and query exclusivity through URL parsing", () => {
    expect(parsePatternSearchParams(new URLSearchParams())).toMatchObject({
      includeDescendants: true,
      scope: "library",
    });

    expect(() =>
      parsePatternSearchParams(
        new URLSearchParams(`folderId=${randomUUID()}&unfiled=true`),
      ),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { resolvePatternGridColumns } from "./pattern-grid";

describe("resolvePatternGridColumns", () => {
  it.each([
    [1264, "grid", 5],
    [1024, "grid", 4],
    [760, "grid", 3],
    [510, "grid", 1],
    [358, "grid", 1],
    [1264, "list", 1],
  ] as const)(
    "maps a %ipx %s viewport to %i columns",
    (width, mode, expected) => {
      expect(resolvePatternGridColumns(width, mode)).toBe(expected);
    },
  );
});

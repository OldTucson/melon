import { describe, expect, it } from "vitest";

import {
  isTransientPatternStatus,
  patternStatusRefreshInterval,
} from "./pattern-status-watch";

describe("pattern status refresh interval", () => {
  it("uses five seconds for a recent transient state and fifteen seconds afterward", () => {
    const now = Date.parse("2026-10-15T00:00:30.000Z");

    expect(
      patternStatusRefreshInterval(
        "processing",
        "2026-10-15T00:00:10.000Z",
        now,
      ),
    ).toBe(5_000);
    expect(
      patternStatusRefreshInterval(
        "processing",
        "2026-10-14T23:59:00.000Z",
        now,
      ),
    ).toBe(15_000);
  });

  it("stops for terminal states and recognizes every upload transient state", () => {
    expect(
      patternStatusRefreshInterval(
        "ready",
        "2026-10-15T00:00:00.000Z",
        Date.now(),
      ),
    ).toBe(false);
    expect(
      patternStatusRefreshInterval(
        "failed",
        "2026-10-15T00:00:00.000Z",
        Date.now(),
      ),
    ).toBe(false);
    expect(
      ["draft", "hashing", "uploading", "processing"].every(
        isTransientPatternStatus,
      ),
    ).toBe(true);
  });
});

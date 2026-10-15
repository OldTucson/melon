import { describe, expect, it } from "vitest";

import {
  isTransientPatternStatus,
  patternStatusRefreshInterval,
} from "./pattern-status-watch";

describe("pattern status refresh interval", () => {
  it("uses five seconds for a recent transient state and fifteen seconds afterward", () => {
    const now = Date.parse("2026-10-15T00:00:30.000Z");

    expect(
      patternStatusRefreshInterval("processing", now - 20_000, now),
    ).toBe(5_000);
    expect(
      patternStatusRefreshInterval("processing", now - 90_000, now),
    ).toBe(15_000);
  });

  it("stops for terminal states and recognizes every upload transient state", () => {
    expect(
      patternStatusRefreshInterval("ready", Date.now(), Date.now()),
    ).toBe(false);
    expect(
      patternStatusRefreshInterval("failed", Date.now(), Date.now()),
    ).toBe(false);
    expect(
      ["draft", "hashing", "uploading", "processing"].every(
        isTransientPatternStatus,
      ),
    ).toBe(true);
  });
});

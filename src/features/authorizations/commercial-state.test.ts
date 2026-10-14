import { describe, expect, it } from "vitest";

import { resolveCommercialState } from "./commercial-state";

describe("commercial state", () => {
  it("returns unlicensed without active authorization kinds", () => {
    expect(resolveCommercialState([])).toBe("unlicensed");
  });

  it("uses the strongest active authorization kind", () => {
    expect(resolveCommercialState(["standard"])).toBe("standard");
    expect(resolveCommercialState(["standard", "field_exclusive"])).toBe(
      "field_exclusive",
    );
    expect(
      resolveCommercialState([
        "standard",
        "field_exclusive",
        "global_buyout",
      ]),
    ).toBe("global_buyout");
  });
});


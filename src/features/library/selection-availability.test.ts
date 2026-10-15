import { describe, expect, it } from "vitest";

import { selectionAvailability } from "./selection-availability";

describe("selection availability", () => {
  it("distinguishes a missing selection from a transient upload", () => {
    expect(selectionAvailability(["one"], [])).toBe("missing");
    expect(
      selectionAvailability(
        ["one"],
        [{ id: "one", status: "processing" }],
      ),
    ).toBe("transient");
    expect(
      selectionAvailability(["one"], [{ id: "one", status: "ready" }]),
    ).toBe("editable");
    expect(
      selectionAvailability(["one"], [{ id: "one", status: "failed" }]),
    ).toBe("editable");
  });
});

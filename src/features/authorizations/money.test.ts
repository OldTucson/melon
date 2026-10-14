import { describe, expect, it } from "vitest";

import { formatFen, parseRmbToFen } from "./money";

describe("authorization money", () => {
  it.each([
    ["0", 0n],
    ["0.1", 10n],
    ["12.34", 1234n],
    [" 1280.00 ", 128000n],
    ["999999999999999999999999.99", 99999999999999999999999999n],
  ])("parses %s without floating point conversion", (input, expected) => {
    expect(parseRmbToFen(input)).toBe(expected);
  });

  it.each(["", "-1", "+1", "01", ".5", "1.", "1.234", "1,000"])(
    "rejects invalid amount %j",
    (input) => {
      expect(() => parseRmbToFen(input)).toThrowError(
        expect.objectContaining({ code: "AUTHORIZATION_PRICE_INVALID" }),
      );
    },
  );

  it.each([
    [0n, "0.00"],
    [1n, "0.01"],
    [10n, "0.10"],
    [1234n, "12.34"],
  ])("formats %s fen as %s yuan", (input, expected) => {
    expect(formatFen(input)).toBe(expected);
  });
});


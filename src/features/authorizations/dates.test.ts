import { describe, expect, it } from "vitest";

import { currentDateInTimeZone, parseAuthorizedOn } from "./dates";

describe("authorization dates", () => {
  it("accepts today and earlier calendar dates", () => {
    expect(parseAuthorizedOn("2026-10-08", "2026-10-08")).toBe(
      "2026-10-08",
    );
    expect(parseAuthorizedOn("2024-02-29", "2026-10-08")).toBe(
      "2024-02-29",
    );
  });

  it.each(["2026-10-09", "2026-02-29", "2026-2-01", "not-a-date"])(
    "rejects future or invalid date %j",
    (input) => {
      expect(() => parseAuthorizedOn(input, "2026-10-08")).toThrowError(
        expect.objectContaining({ code: "AUTHORIZATION_DATE_INVALID" }),
      );
    },
  );

  it("derives the server date in Asia/Shanghai around UTC midnight", () => {
    expect(
      currentDateInTimeZone(
        new Date("2026-10-08T16:30:00.000Z"),
        "Asia/Shanghai",
      ),
    ).toBe("2026-10-09");
  });
});


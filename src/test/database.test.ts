import { describe, expect, it } from "vitest";

import { resetDatabase } from "./database";

describe("resetDatabase", () => {
  it("rejects a non-test database URL before connecting", async () => {
    await expect(
      resetDatabase("postgres://melon:melon@localhost:55432/melon"),
    ).rejects.toThrow(/_test/);
  });
});

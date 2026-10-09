import { describe, expect, it } from "vitest";

import { parseEmailFlag } from "@/features/auth/account-command";

describe("account command arguments", () => {
  it("requires an explicit email flag", () => {
    expect(parseEmailFlag(["--email", "owner@example.test"])).toBe(
      "owner@example.test",
    );
  });

  const invalidArguments: Array<{ args: string[] }> = [
    { args: ["owner@example.test"] },
    { args: ["--email", "owner@example.test", "password-value"] },
    {
      args: ["--email", "owner@example.test", "--password", "password-value"],
    },
    { args: ["--email"] },
  ];

  it.each(invalidArguments)(
    "rejects positional or password arguments: $args",
    ({ args }) => {
      expect(() => parseEmailFlag(args)).toThrow("--email <email>");
    },
  );
});

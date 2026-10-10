import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "https://configured.example.test" }),
}));

import { assertSameOrigin } from "./route";

const request = (url: string, origin?: string) =>
  new Request(url, { headers: origin === undefined ? {} : { origin } });

describe("assertSameOrigin", () => {
  it("uses configured APP_ORIGIN rather than the request URL", () => {
    expect(() =>
      assertSameOrigin(
        request("http://internal-proxy:3000/api/uploads/init", "https://configured.example.test"),
      ),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(
        request("https://evil.example/api/uploads/init", "https://evil.example"),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN_ORIGIN" }));
  });

  it.each([undefined, "null", "https://evil.example", "https://app.example.test:444"])(
    "rejects missing, opaque, foreign, or wrong-port origin %j",
    (origin) => {
      expect(() =>
        assertSameOrigin(
          request("https://app.example.test/api/uploads/init", origin),
          "https://app.example.test:443/",
        ),
      ).toThrowError(expect.objectContaining({ code: "FORBIDDEN_ORIGIN" }));
    },
  );

  it("normalizes the configured origin and default HTTPS port", () => {
    expect(() =>
      assertSameOrigin(
        request("http://proxy/api/uploads/init", "https://app.example.test"),
        "https://APP.example.test:443/path",
      ),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";
import { SECURITY_HEADERS } from "./src/lib/http/security-headers";

describe("next config security headers", () => {
  it("applies the shared headers to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");

    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ]);
  });
});

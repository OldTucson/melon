import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS } from "./security-headers";

describe("SECURITY_HEADERS", () => {
  it("defines the baseline browser security policy", () => {
    const headers = Object.fromEntries(
      SECURITY_HEADERS.map(({ key, value }) => [key, value]),
    );

    expect(headers).toMatchObject({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    });

    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' blob: data: https:");
    expect(csp).toContain("connect-src 'self' https:");
    expect(csp).toContain("worker-src 'self' blob:");
  });
});

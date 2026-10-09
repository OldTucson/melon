import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

describe("workspace proxy", () => {
  it("optimistically redirects protected paths without an Auth.js cookie", () => {
    const response = proxy(request("/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it.each([
    "authjs.session-token=session-value",
    "__Secure-authjs.session-token=session-value",
  ])("allows protected paths with cookie %s", (cookie) => {
    const response = proxy(request("/library", cookie));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not guard public paths", () => {
    const response = proxy(request("/login"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

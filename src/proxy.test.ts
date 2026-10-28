import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

describe("workspace proxy", () => {
  it.each([
    "/inspiration",
    "/inspiration/history/detail?owner=other&next=/share",
    "/inspiration?prompt=private",
    "/library",
    "/dashboard/reports?range=30",
    "/trash/deleted",
    "/settings/theme",
  ])(
    "protects the workspace path %s and removes its query from login",
    (path) => {
      expect(doesProxyMatch({ config, nextConfig: {}, url: path })).toBe(true);
      const response = proxy(request(path));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("http://localhost/login");
    },
  );

  it.each([
    "/share/inspiration/00000000-0000-4000-8000-000000000009",
    "/share/inspiration/00000000-0000-4000-8000-000000000009?theme=dark",
    "/share",
    "/api/inspiration-analyses",
    "/api/inspiration-analyses/00000000-0000-4000-8000-000000000009/share",
    "/inspiration-public",
    "/login",
  ])("keeps %s outside both workspace guards", (path) => {
    expect(doesProxyMatch({ config, nextConfig: {}, url: path })).toBe(false);
    const response = proxy(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("optimistically redirects protected paths without an Auth.js cookie", () => {
    const response = proxy(request("/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it.each([
    "authjs.session-token=session-value",
    "__Secure-authjs.session-token=session-value",
  ])("allows protected paths with cookie %s", (cookie) => {
    for (const path of [
      "/library",
      "/inspiration",
      "/inspiration/history?view=saved",
    ]) {
      const response = proxy(request(path, cookie));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("does not guard public paths", () => {
    const response = proxy(request("/login"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

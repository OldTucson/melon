import type { NextConfig } from "next";

import { createSecurityHeaders } from "./src/lib/http/security-headers";

const securityHeaders = createSecurityHeaders({
  allowUnsafeEval: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["ali-oss"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders],
      },
    ];
  },
  ...(process.env.MELON_E2E_SERVER === "1" ? { distDir: ".next-e2e" } : {}),
};

export default nextConfig;

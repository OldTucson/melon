import type { NextConfig } from "next";

import { SECURITY_HEADERS } from "./src/lib/http/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["ali-oss"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
  ...(process.env.MELON_E2E_SERVER === "1" ? { distDir: ".next-e2e" } : {}),
};

export default nextConfig;

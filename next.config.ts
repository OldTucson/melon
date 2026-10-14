import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["ali-oss"],
  ...(process.env.MELON_E2E_SERVER === "1" ? { distDir: ".next-e2e" } : {}),
};

export default nextConfig;

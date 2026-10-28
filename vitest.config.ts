import path from "node:path";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Real-service tests load their explicitly allowed local settings only under opt-in flags.
export default defineConfig({
  envDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      "server-only": path.resolve(process.cwd(), "src/test/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: [
      ...configDefaults.exclude,
      ".worktrees/**",
      "tests/e2e/**",
      "**/*.integration.test.ts",
    ],
    clearMocks: true,
  },
});

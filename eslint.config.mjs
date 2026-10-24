import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  {
    ignores: [
      ".next-e2e/**",
      ".venv-visual-search/**",
      ".worktrees/**",
      "services/visual-search/.venv/**",
    ],
  },
  ...nextVitals,
  ...nextTypeScript,
]);

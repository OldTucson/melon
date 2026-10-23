import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

import {
  validateProductionReadiness,
  type ProductionReadinessError,
} from "@/lib/env/production-readiness";

export function formatProductionReadinessErrors(
  errors: ProductionReadinessError[],
) {
  return ["Production preflight: FAIL", ...errors.map((error) => `- ${error}`)]
    .join("\n");
}

type SafeIssue = {
  path?: unknown;
};

export function formatServerEnvValidationError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    const paths = error.issues.map((issue: SafeIssue) => {
      const path = Array.isArray(issue.path)
        ? issue.path
            .filter(
              (part): part is string | number =>
                typeof part === "string" || typeof part === "number",
            )
            .join(".")
        : "";
      return path || "environment";
    });
    const uniquePaths = [...new Set(paths)];
    return [
      "Production preflight: INVALID_ENV",
      ...uniquePaths.map((path) => `- ${path}: invalid configuration`),
    ].join("\n");
  }

  return (
    "Production preflight: INVALID_ENV\n" +
    "- environment: invalid configuration"
  );
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd());

  try {
    const { getServerEnv } = await import("@/lib/env/server");
    const errors = validateProductionReadiness(getServerEnv());
    if (errors.length > 0) {
      console.error(formatProductionReadinessErrors(errors));
      process.exitCode = 1;
      return;
    }

    console.log("Production preflight: PASS");
  } catch (error) {
    console.error(formatServerEnvValidationError(error));
    process.exitCode = 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) void main();

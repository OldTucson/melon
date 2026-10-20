import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const [{ cleanupPendingManualPreviews }, { closeDatabase }] = await Promise.all([
  import("@/features/preview/manual-preview-service"),
  import("@/lib/db/client"),
]);

try {
  const result = await cleanupPendingManualPreviews();
  console.log(
    `Manual preview cleanup: ${result.cleaned} cleaned, ${result.pending} pending`,
  );
  if (result.pending > 0) process.exitCode = 1;
} finally {
  await closeDatabase();
}

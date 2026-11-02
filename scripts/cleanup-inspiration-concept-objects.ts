import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import type { ConceptCleanupSummary } from "@/features/inspiration-concepts/cleanup";

type Services = { run(dryRun: boolean): Promise<ConceptCleanupSummary>; closeDatabase(): Promise<void> };
type Dependencies = { loadEnv(): void; validate(): Promise<void>; loadServices(): Promise<Services>; write(value: string): void };
const count = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw Error(); return n; };
export async function runConceptCleanupCli(args: readonly string[], deps: Dependencies): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    deps.write(JSON.stringify({ status: "invalid_arguments" })); return 1;
  }
  let services: Services | undefined;
  let output: object = { status: "failed" }, code = 1;
  try {
    deps.loadEnv(); await deps.validate(); services = await deps.loadServices();
    const result = await services.run(args.length === 1);
    output = { dryRun: args.length === 1, scannedSets: count(result.scannedSets), deletedObjects: count(result.deletedObjects), deletedSets: count(result.deletedSets), skippedActiveSets: count(result.skippedActiveSets), deletedResearchObjects: count(result.deletedResearchObjects), scannedReports: count(result.scannedReports), deletedReports: count(result.deletedReports), failures: count(result.failures) };
    code = result.failures ? 1 : 0;
  } catch { output = { status: "failed" }; }
  finally {
    try { await services?.closeDatabase(); } catch { code = 1; output = { status: "failed" }; }
  }
  deps.write(JSON.stringify(output)); return code;
}
async function validate() {
  const { getServerEnv } = await import("@/lib/env/server");
  if (getServerEnv().OSS_ADAPTER !== "real") throw Error();
}
async function loadServices(): Promise<Services> {
  const { getServerEnv } = await import("@/lib/env/server");
  const env = getServerEnv();
  const database = await import("@/lib/db/client");
  try {
    const { cleanupInspirationConceptObjects } = await import("@/features/inspiration-concepts/cleanup");
    const { createConceptCleanupStore } = await import("@/features/inspiration-concepts/object-store");
    const store = createConceptCleanupStore({ region: env.ALIYUN_OSS_REGION, bucket: env.ALIYUN_OSS_BUCKET, endpoint: env.ALIYUN_OSS_ENDPOINT, cname: env.ALIYUN_OSS_CNAME });
    return { run: (dryRun) => cleanupInspirationConceptObjects({ now: new Date(), dryRun, store }), closeDatabase: database.closeDatabase };
  } catch { await database.closeDatabase(); throw Error(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runConceptCleanupCli(process.argv.slice(2), {
    loadEnv() { nextEnv.loadEnvConfig(process.cwd(), undefined, { info() {}, error() {} }); },
    validate, loadServices, write: (value) => console.log(value),
  }).then((code) => { process.exitCode = code; }).catch(() => { console.log('{"status":"failed"}'); process.exitCode = 1; });
}

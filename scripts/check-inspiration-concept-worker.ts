import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import type { getConceptWorkerStatus } from "@/features/inspiration-concepts/repository";

type Status = Awaited<ReturnType<typeof getConceptWorkerStatus>>;
type Services = { run(): Promise<Status>; closeDatabase(): Promise<void> };
type Dependencies = { loadEnv(): void; validate(): Promise<void>; loadServices(): Promise<Services>; write(value: string): void };
const count = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw Error(); return n; };
const age = (n: number | null) => n === null ? null : count(n);
export async function runConceptStatusCli(args: readonly string[], deps: Dependencies): Promise<number> {
  if (args.length) { deps.write(JSON.stringify({ status: "invalid_arguments" })); return 1; }
  let services: Services | undefined;
  let output: object = { status: "failed" }, code = 1;
  try {
    deps.loadEnv(); await deps.validate(); services = await deps.loadServices();
    const result = await services.run();
    if (!["healthy", "missing", "stale"].includes(result.status) || typeof result.healthy !== "boolean") throw Error();
    output = { healthy: result.healthy, status: result.status, heartbeatAgeMs: age(result.heartbeatAgeMs), counts: { queued: count(result.counts.queued), submitting: count(result.counts.submitting), submitted: count(result.counts.submitted), failed: count(result.counts.failed) }, oldestQueueAgeMs: age(result.oldestQueueAgeMs) };
    code = result.healthy ? 0 : 1;
  } catch { output = { status: "failed" }; }
  finally { try { await services?.closeDatabase(); } catch { code = 1; output = { status: "failed" }; } }
  deps.write(JSON.stringify(output)); return code;
}
async function validate() { const { getServerEnv } = await import("@/lib/env/server"); getServerEnv(); }
async function loadServices(): Promise<Services> {
  const { getServerEnv } = await import("@/lib/env/server"); const env = getServerEnv();
  const database = await import("@/lib/db/client");
  try {
    const { getConceptWorkerStatus } = await import("@/features/inspiration-concepts/repository");
    return { run: () => getConceptWorkerStatus({ now: new Date(), workerId: env.INSPIRATION_CONCEPT_WORKER_ID, staleAfterMs: 90_000 }), closeDatabase: database.closeDatabase };
  } catch { await database.closeDatabase(); throw Error(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runConceptStatusCli(process.argv.slice(2), {
    loadEnv() { nextEnv.loadEnvConfig(process.cwd(), undefined, { info() {}, error() {} }); },
    validate, loadServices, write: (value) => console.log(value),
  }).then((code) => { process.exitCode = code; }).catch(() => { console.log('{"status":"failed"}'); process.exitCode = 1; });
}

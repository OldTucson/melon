import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventEmitter } from "node:events";
import nextEnv from "@next/env";

type WorkerServices = {
  run(signal: AbortSignal): Promise<void>;
  closeDatabase(): Promise<void>;
};
type CliDependencies = {
  signals: Pick<EventEmitter, "on" | "removeListener">;
  loadEnv(): void;
  validate(): Promise<void>;
  loadServices(): Promise<WorkerServices>;
};

export async function runConceptWorkerCli(deps: CliDependencies) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  deps.signals.on("SIGTERM", stop);
  deps.signals.on("SIGINT", stop);
  let services: WorkerServices | undefined;
  try {
    try {
      deps.loadEnv();
      await deps.validate();
    } catch {
      throw new Error("Concept worker configuration invalid.");
    }
    if (controller.signal.aborted) return;
    try {
      services = await deps.loadServices();
      await services.run(controller.signal);
    } catch {
      throw new Error("Concept worker failed.");
    }
  } finally {
    try {
      await services?.closeDatabase();
    } catch {
      throw new Error("Concept worker shutdown failed.");
    } finally {
      deps.signals.removeListener("SIGTERM", stop);
      deps.signals.removeListener("SIGINT", stop);
    }
  }
}

async function validateConfiguration() {
  const { getServerEnv } = await import("@/lib/env/server");
  const env = getServerEnv();
  if (
    !env.INSPIRATION_ENABLED ||
    !env.INSPIRATION_CONCEPT_IMAGES_ENABLED ||
    !env.DASHSCOPE_API_KEY ||
    !env.DASHSCOPE_NATIVE_BASE_URL
  )
    throw Error();
}

async function loadServices(): Promise<WorkerServices> {
  const { getServerEnv } = await import("@/lib/env/server");
  const env = getServerEnv();
  // Configuration is validated before importing any module that opens PostgreSQL.
  const database = await import("@/lib/db/client");
  try {
    const [worker, provider, conceptStore, visualStore] = await Promise.all([
      import("@/features/inspiration-concepts/worker"),
      import("@/features/inspiration-concepts/qwen-image-provider"),
      import("@/features/inspiration-concepts/object-store"),
      import("@/features/inspiration-visuals/visual-object-store"),
    ]);
    const config = {
      region: env.ALIYUN_OSS_REGION,
      bucket: env.ALIYUN_OSS_BUCKET,
      endpoint: env.ALIYUN_OSS_ENDPOINT,
      cname: env.ALIYUN_OSS_CNAME,
    };
    const dependencies = {
      workerId: env.INSPIRATION_CONCEPT_WORKER_ID,
      provider: provider.getQwenImageProvider(),
      store: conceptStore.createConceptObjectStore(config),
      researchStore: visualStore.createVisualObjectStore(config),
    };
    return {
      run: (signal) =>
        worker.runConceptWorker({
          ...dependencies,
          signal,
          log: (event) => console.log(JSON.stringify(event)),
        }),
      closeDatabase: database.closeDatabase,
    };
  } catch {
    await database.closeDatabase();
    throw new Error("Concept worker failed.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runConceptWorkerCli({
    signals: process,
    loadEnv: () => {
      nextEnv.loadEnvConfig(process.cwd(), undefined, {
        info() {},
        error() {},
      });
    },
    validate: validateConfiguration,
    loadServices,
  }).catch(() => {
    console.error("Concept worker stopped with an error.");
    process.exitCode = 1;
  });
}

import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { inspirationAnalysisResultSchema, inspirationSourcesSchema } from "@/features/inspiration/contracts";
import {
  deleteInspirationAnalysis,
  inspirationBusy,
  parseInspirationInput,
  parseInspirationStored,
  requireOwnedInspiration,
} from "@/features/inspiration/analysis-service";
import { AppError } from "@/lib/http/app-error";
import { getServerEnv } from "@/lib/env/server";

import {
  inspirationVisualBoardDtoSchema,
  inspirationVisualJobDtoSchema,
  researchVisualMutationSchema,
  type VisualJobErrorCode,
  type VisualWarning,
} from "./contracts";
import { matchLibraryPatterns } from "./library-matcher";
import * as repository from "./visual-repository";
import { getWebAgentProvider, type WebEvidenceProvider } from "./web-agent-provider";
import { importWebEvidence, type WebEvidenceImportResult } from "./web-evidence-importer";
import { classifyWebEvidenceCandidates, planWebEvidenceIntents } from "./web-evidence-intents";
import { createVisualObjectStore, type VisualObjectStore } from "./visual-object-store";

const STALE_RESEARCH_JOB_MS = 3 * 60_000;

const visualIdentitySchema = z
  .object({
    ownerId: z.string().uuid(),
    analysisId: z.string().uuid(),
  })
  .strict();

const createResearchVisualsSchema = researchVisualMutationSchema
  .extend(visualIdentitySchema.shape)
  .strict();

type CreateResearchVisualsInput = z.input<
  typeof createResearchVisualsSchema
> & { signal?: AbortSignal };

type VisualServiceDependencies = {
  matchLibrary?: typeof matchLibraryPatterns;
  webProvider?: WebEvidenceProvider;
  importWeb?: typeof importWebEvidence;
  store?: VisualObjectStore;
  now?: () => Date;
  createId?: () => string;
};

const visualBusy = () =>
  new AppError(
    "INSPIRATION_VISUALS_BUSY",
    409,
    "Inspiration visuals are busy",
  );

const visualFailure = (
  code: Extract<
    VisualJobErrorCode,
    "INSPIRATION_VISUALS_EMPTY" | "INSPIRATION_VISUALS_UNAVAILABLE"
  >,
  jobId: string,
) => new AppError(code, 503, "Inspiration visuals failed", { jobId });

const operationReused = () =>
  new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );

const internalError = () =>
  new AppError("INTERNAL_ERROR", 500, "Inspiration visual operation failed");

function uniqueViolation(
  error: unknown,
): { constraint?: string } | undefined {
  let candidate = error;
  const seen = new Set<unknown>();
  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    if ("code" in candidate && candidate.code === "23505") {
      return {
        constraint:
          "constraint_name" in candidate &&
          typeof candidate.constraint_name === "string"
            ? candidate.constraint_name
            : undefined,
      };
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
}

const toJobDto = (row: repository.VisualJobRow) =>
  parseInspirationStored(inspirationVisualJobDtoSchema, {
    id: row.id,
    kind: row.kind,
    directionIndex: row.directionIndex,
    status: row.status,
    errorCode: row.errorCode,
    warnings: row.warnings,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });

const isLaterThan = (
  candidate: repository.VisualJobRow,
  baseline: repository.VisualJobRow,
) =>
  candidate.createdAt.getTime() > baseline.createdAt.getTime() ||
  (candidate.createdAt.getTime() === baseline.createdAt.getTime() &&
    candidate.id > baseline.id);

async function assembleBoard(ownerId: string, analysisId: string) {
  const [active, refreshCandidate] = await Promise.all([
    repository.findLatestCompletedResearchJob(ownerId, analysisId),
    repository.findLatestResearchRefreshJob(ownerId, analysisId),
  ]);
  const refresh =
    refreshCandidate && (!active || isLaterThan(refreshCandidate, active))
      ? refreshCandidate
      : undefined;
  const visible = active
    ? await repository.listVisibleAssets(ownerId, active.id)
    : [];

  return parseInspirationStored(inspirationVisualBoardDtoSchema, {
    refreshAvailable: getServerEnv().INSPIRATION_WEB_VISUALS_ENABLED || getServerEnv().IMAGE_SEARCH_ENABLED,
    activeJob: active ? toJobDto(active) : null,
    refreshJob: refresh ? toJobDto(refresh) : null,
    webEvidence: visible
      .filter((asset) => asset.kind === "web_evidence")
      .map((asset) => ({
        id: asset.id,
        kind: "web_evidence" as const,
        ordinal: asset.ordinal,
        title: asset.title,
        altText: asset.altText,
        imageUrl: `/api/inspiration-visual-assets/${asset.id}`,
        role: asset.documentRole,
        sourceIndexes: asset.sourceIndexes,
        brand: asset.brand,
        productName: asset.productName,
        priceText: asset.priceText,
        sourcePageUrl: asset.sourcePageUrl,
        sourceSiteName: asset.sourceSiteName,
        sourceQuery: asset.sourceQuery,
        width: asset.width,
        height: asset.height,
      })),
    libraryMatches: visible
      .filter(
        (asset) =>
          asset.kind === "library_match" &&
          asset.patternId !== null &&
          asset.imageAssetId !== null,
      )
      .map((asset) => ({
        id: asset.id,
        kind: "library_match" as const,
        ordinal: asset.ordinal,
        directionIndex: asset.directionIndex,
        title: asset.title,
        altText: asset.altText,
        imageUrl: `/api/assets/${asset.imageAssetId!}/view`,
        libraryHref: `/library?selected=${asset.patternId!}`,
        patternId: asset.patternId!,
        palette: asset.palette,
      })),
    conceptJobs: [],
    concepts: [],
  });
}

async function repairStaleJobs(
  ownerId: string,
  analysisId: string,
  now: Date,
) {
  await repository.failStaleResearchJobs(
    ownerId,
    analysisId,
    new Date(now.getTime() - STALE_RESEARCH_JOB_MS),
    now,
  );
}

function replayJob(
  row: repository.VisualJobRow,
  analysisId: string,
): Promise<ReturnType<typeof inspirationVisualBoardDtoSchema.parse>> {
  if (
    row.analysisId !== analysisId ||
    row.kind !== "research_visuals" ||
    row.directionIndex !== null
  ) {
    throw operationReused();
  }
  return assembleBoard(row.ownerId, row.analysisId);
}

async function failAttempt(
  ownerId: string,
  analysisId: string,
  jobId: string,
  code: Extract<
    VisualJobErrorCode,
    "INSPIRATION_VISUALS_EMPTY" | "INSPIRATION_VISUALS_UNAVAILABLE"
  >,
  warnings: readonly VisualWarning[],
  now: Date,
): Promise<never> {
  const failed = await repository.failPendingJob(
    ownerId,
    jobId,
    code,
    now,
    warnings,
  );
  if (!failed) {
    await requireOwnedInspiration(ownerId, analysisId);
    throw visualBusy();
  }
  throw visualFailure(code, jobId);
}

export async function getInspirationVisualBoard(input: {
  ownerId: string;
  analysisId: string;
}) {
  const parsed = parseInspirationInput(visualIdentitySchema, input);
  await requireOwnedInspiration(parsed.ownerId, parsed.analysisId);
  const now = new Date();
  await repairStaleJobs(parsed.ownerId, parsed.analysisId, now);
  return assembleBoard(parsed.ownerId, parsed.analysisId);
}

export async function createResearchVisuals(
  input: CreateResearchVisualsInput,
  dependencies: VisualServiceDependencies = {},
) {
  const parsed = parseInspirationInput(createResearchVisualsSchema, {
    ownerId: input.ownerId,
    analysisId: input.analysisId,
    operationId: input.operationId,
  });
  const now = dependencies.now ?? (() => new Date());
  const analysis = await requireOwnedInspiration(
    parsed.ownerId,
    parsed.analysisId,
  );
  if (analysis.status !== "completed") throw inspirationBusy();
  const result = parseInspirationStored(
    inspirationAnalysisResultSchema,
    analysis.result,
  );

  await repairStaleJobs(parsed.ownerId, parsed.analysisId, now());
  const existing = await repository.findJobByOperation(
    parsed.ownerId,
    parsed.operationId,
  );
  if (existing) return replayJob(existing, parsed.analysisId);

  let job: repository.VisualJobRow | undefined;
  try {
    job = await repository.createPendingResearchJob({
      id: (dependencies.createId ?? randomUUID)(),
      ownerId: parsed.ownerId,
      analysisId: parsed.analysisId,
      operationId: parsed.operationId,
      now: now(),
    });
  } catch (error) {
    const unique = uniqueViolation(error);
    if (unique) {
      const winner = await repository.findJobByOperation(
        parsed.ownerId,
        parsed.operationId,
      );
      if (winner) return replayJob(winner, parsed.analysisId);
      if (
        unique.constraint ===
        "inspiration_visual_jobs_target_pending_unique"
      ) {
        throw visualBusy();
      }
    }
    throw internalError();
  }
  if (!job) throw internalError();

  const signal = input.signal ?? new AbortController().signal;
  const env = getServerEnv();
  let store = dependencies.store;
  const objectStore = () => (store ??= createVisualObjectStore({
    region: env.ALIYUN_OSS_REGION,
    bucket: env.ALIYUN_OSS_BUCKET,
    endpoint: env.ALIYUN_OSS_ENDPOINT,
    cname: env.ALIYUN_OSS_CNAME,
  }));
  const deleteBestEffort = async (keys: readonly string[]) => {
    if (keys.length === 0) return;
    try { await objectStore().delete(keys); } catch { /* Never replace the job outcome with a cleanup error. */ }
  };

  // Snapshot prior committed keys before external work. Never collect keys after
  // commit: another refresh may already own the target by then.
  let supersededKeys: string[];
  try {
    supersededKeys = await repository.listObjectKeysForAnalysis(parsed.ownerId, parsed.analysisId);
  } catch {
    return failAttempt(parsed.ownerId, parsed.analysisId, job.id, "INSPIRATION_VISUALS_UNAVAILABLE", [], now());
  }

  const buildAndImportWebEvidence = async (): Promise<WebEvidenceImportResult> => {
    if (!env.INSPIRATION_WEB_VISUALS_ENABLED) {
      return { assets: [], writtenKeys: [], warnings: ["INSPIRATION_WEB_VISUALS_DISABLED"] };
    }
    if (signal.aborted) throw internalError();
    const sources = parseInspirationStored(inspirationSourcesSchema, analysis.sources);
    const intents = planWebEvidenceIntents({ prompt: analysis.prompt, result, sources });
    if (intents.length === 0) return { assets: [], writtenKeys: [], warnings: [] };
    let response;
    try {
      response = await (dependencies.webProvider ?? getWebAgentProvider()).search({
        requestId: job.id,
        prompt: analysis.prompt,
        headline: result.headline,
        summary: result.summary,
        intents,
        signal,
      });
    } catch (error) {
      if (!signal.aborted && error instanceof AppError && error.code === "INSPIRATION_VISUALS_EMPTY") {
        return { assets: [], writtenKeys: [], warnings: [] };
      }
      throw error;
    }
    const candidates = classifyWebEvidenceCandidates({ intents, sources, candidates: response.candidates });
    if (candidates.length === 0) return { assets: [], writtenKeys: [], warnings: [] };
    return (dependencies.importWeb ?? importWebEvidence)({
      ownerId: parsed.ownerId, analysisId: parsed.analysisId, jobId: job.id, candidates, signal,
    }, { store: objectStore() });
  };
  const matchLibrary = async () => {
    if (!env.IMAGE_SEARCH_ENABLED) {
      return { assets: [], warnings: ["INSPIRATION_LIBRARY_MATCH_DISABLED" as const] };
    }
    if (signal.aborted) throw internalError();
    return (dependencies.matchLibrary ?? matchLibraryPatterns)({ ownerId: parsed.ownerId, result, signal });
  };
  const [webResult, libraryResult] = await Promise.allSettled([
    buildAndImportWebEvidence(),
    matchLibrary(),
  ]);
  const web = webResult.status === "fulfilled"
    ? webResult.value
    : { assets: [], writtenKeys: [], warnings: ["INSPIRATION_WEB_VISUALS_UNAVAILABLE" as const] };
  const library = libraryResult.status === "fulfilled"
    ? libraryResult.value
    : { assets: [], warnings: ["INSPIRATION_LIBRARY_MATCH_UNAVAILABLE" as const] };
  const warnings = [...new Set<VisualWarning>([...web.warnings, ...library.warnings])];
  const unavailable = warnings.includes("INSPIRATION_WEB_VISUALS_UNAVAILABLE") ||
    warnings.includes("INSPIRATION_LIBRARY_MATCH_UNAVAILABLE");
  const assets: repository.NewVisualAsset[] = [
    ...web.assets.map((asset, ordinal) => ({ ...asset, ordinal })),
    ...library.assets.map((asset, ordinal) => ({ ...asset, ordinal, id: randomUUID() })),
  ];

  if (signal.aborted || assets.length === 0) {
    await deleteBestEffort(web.writtenKeys);
    return failAttempt(
      parsed.ownerId, parsed.analysisId, job.id,
      signal.aborted || unavailable ? "INSPIRATION_VISUALS_UNAVAILABLE" : "INSPIRATION_VISUALS_EMPTY",
      warnings, now(),
    );
  }

  let completion: Awaited<ReturnType<typeof repository.completeResearchJob>>;
  try {
    completion = await repository.completeResearchJob(parsed.ownerId, job.id, assets, warnings, now());
  } catch {
    await deleteBestEffort(web.writtenKeys);
    return failAttempt(parsed.ownerId, parsed.analysisId, job.id, "INSPIRATION_VISUALS_UNAVAILABLE", warnings, now());
  }
  if (!completion || completion.state === "empty") {
    await deleteBestEffort(web.writtenKeys);
    if (!completion) {
      await requireOwnedInspiration(parsed.ownerId, parsed.analysisId);
      throw visualBusy();
    }
    throw visualFailure(unavailable ? "INSPIRATION_VISUALS_UNAVAILABLE" : "INSPIRATION_VISUALS_EMPTY", completion.job.id);
  }

  await deleteBestEffort(supersededKeys);
  return assembleBoard(parsed.ownerId, parsed.analysisId);
}

/** Database deletion authorizes cleanup; captured keys alone never authorize it. */
export async function deleteInspirationWithVisualAssets(
  input: z.input<typeof visualIdentitySchema>,
  dependencies: Pick<VisualServiceDependencies, "store"> = {},
) {
  const parsed = parseInspirationInput(visualIdentitySchema, input);
  const keys = await repository.listObjectKeysForAnalysis(parsed.ownerId, parsed.analysisId);
  // A foreign, pending, or concurrently deleted analysis must never reach storage cleanup.
  const result = await deleteInspirationAnalysis(parsed);
  if (keys.length > 0) {
    try {
      let store = dependencies.store;
      if (!store) {
        const env = getServerEnv();
        store = createVisualObjectStore({
          region: env.ALIYUN_OSS_REGION,
          bucket: env.ALIYUN_OSS_BUCKET,
          endpoint: env.ALIYUN_OSS_ENDPOINT,
          cname: env.ALIYUN_OSS_CNAME,
        });
      }
      await store.delete(keys);
    } catch {
      // Storage/configuration failure cannot undo the committed database deletion.
    }
  }
  return result;
}

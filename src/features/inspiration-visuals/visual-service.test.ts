// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspirationResultFixture, inspirationSourceFixture } from "@/features/inspiration/test-fixtures";
import { AppError } from "@/lib/http/app-error";
import type { ServerEnv } from "@/lib/env/server";
import * as repository from "./visual-repository";
import type { ImportedWebEvidenceAsset } from "./web-evidence-importer";
import { matchLibraryPatterns } from "./library-matcher";
import { createResearchVisuals } from "./visual-service";

const setup = vi.hoisted(() => ({ owned: vi.fn(), env: vi.fn() }));
vi.mock("@/lib/env/server", () => ({ getServerEnv: setup.env }));
vi.mock("@/features/inspiration/analysis-service", () => ({
  requireOwnedInspiration: setup.owned,
  parseInspirationInput: (schema: { parse: (x: unknown) => unknown }, value: unknown) => schema.parse(value),
  parseInspirationStored: (schema: { parse: (x: unknown) => unknown }, value: unknown) => schema.parse(value),
  inspirationBusy: () => new Error("busy"),
}));
vi.mock("@/features/inspiration/analysis-repository", () => ({ deleteAnalysisWithObjectKeys: vi.fn() }));
vi.mock("@/features/inspiration-concepts/service", () => ({ listConceptSets: async () => [] }));
vi.mock("./library-matcher", () => ({ matchLibraryPatterns: vi.fn() }));
vi.mock("./visual-repository", () => ({
  failStaleResearchJobs: vi.fn(), findJobByOperation: vi.fn(), createPendingResearchJob: vi.fn(),
  failPendingJob: vi.fn(), completeResearchJob: vi.fn(), findLatestCompletedResearchJob: vi.fn(),
  findLatestResearchRefreshJob: vi.fn(), listVisibleAssets: vi.fn(),
  listObjectKeysForJob: vi.fn(), listObjectKeysForAnalysis: vi.fn(),
}));

const ownerId = randomUUID(), analysisId = randomUUID(), jobId = randomUUID();
const job = (status: "pending" | "completed" = "pending"): repository.VisualJobRow => ({
  id: jobId, ownerId, analysisId, operationId: randomUUID(), kind: "research_visuals", directionIndex: null,
  status, warnings: [], errorCode: null, providerTaskId: null, providerRequestId: null, createdAt: new Date(), updatedAt: new Date(),
  completedAt: status === "completed" ? new Date() : null,
});
const asset = (): ImportedWebEvidenceAsset => ({
  id: randomUUID(), kind: "web_evidence", ordinal: 4, directionIndex: null, title: "Product", altText: "Product",
  documentRole: "product", sourceIndexes: [1], productName: "Sourced product", brand: null, priceText: "$20",
  sourcePageUrl: inspirationSourceFixture.url, sourceSiteName: "Source", sourceQuery: "query",
  objectKey: "private-object-key", contentType: "image/jpeg", width: 2, height: 2,
});
function dependencies() {
  const imported = asset();
  return {
    imported,
    webProvider: { search: vi.fn(async () => ({ requestId: "request", candidates: [{ query: "query", title: "Product", imageUrl: "https://images.test/a.jpg", sourcePageUrl: inspirationSourceFixture.url }] })) },
    importWeb: vi.fn(async () => ({ assets: [imported], warnings: [], writtenKeys: [imported.objectKey] })),
    store: { put: vi.fn(), get: vi.fn(), delete: vi.fn(async () => {}) },
  };
}
const run = (deps: ReturnType<typeof dependencies>, signal?: AbortSignal) => createResearchVisuals({ ownerId, analysisId, operationId: randomUUID(), signal }, deps);

beforeEach(() => {
  vi.resetAllMocks();
  setup.env.mockReturnValue({ IMAGE_SEARCH_ENABLED: true, INSPIRATION_WEB_VISUALS_ENABLED: true } as ServerEnv);
  setup.owned.mockResolvedValue({ ownerId, id: analysisId, status: "completed", prompt: "Research", result: inspirationResultFixture, sources: [inspirationSourceFixture] });
  vi.mocked(repository.createPendingResearchJob).mockResolvedValue(job());
  vi.mocked(repository.failPendingJob).mockResolvedValue({ ...job(), status: "failed" });
  vi.mocked(repository.listObjectKeysForAnalysis).mockResolvedValue([]);
  vi.mocked(repository.listObjectKeysForJob).mockResolvedValue([]);
  vi.mocked(repository.listVisibleAssets).mockResolvedValue([]);
  vi.mocked(matchLibraryPatterns).mockResolvedValue({ assets: [], warnings: [] });
  vi.mocked(repository.completeResearchJob).mockImplementation(async (_owner, _id, assets, warnings) => {
    const completed = { ...job("completed"), warnings: [...warnings] };
    vi.mocked(repository.findLatestCompletedResearchJob).mockResolvedValue(completed);
    vi.mocked(repository.listVisibleAssets).mockResolvedValue(assets.map((a) => ({
      ...a, ownerId, analysisId, jobId, createdAt: new Date(), patternId: null, savedPatternId: null,
      saveOperationId: null, imageAssetId: null, palette: [],
    })) as repository.VisibleVisualAssetRow[]);
    return { state: "completed", job: completed, supersededKeys: [] };
  });
});

describe("visual orchestration compensation", () => {
  it("commits web-only results once, preserving IDs and exposing only browser metadata", async () => {
    const deps = dependencies();
    const board = await run(deps);
    expect(board.webEvidence).toEqual([{
      id: deps.imported.id, kind: "web_evidence", ordinal: 0, title: "Product", altText: "Product",
      imageUrl: `/api/inspiration-visual-assets/${deps.imported.id}`, role: "product", sourceIndexes: [1], productName: "Sourced product", brand: null, priceText: "$20",
      sourcePageUrl: inspirationSourceFixture.url, sourceSiteName: "Source", sourceQuery: "query", width: 2, height: 2,
    }]);
    expect(deps.webProvider.search).toHaveBeenCalledTimes(1);
    expect(repository.completeResearchJob).toHaveBeenCalledTimes(1);
    expect(deps.store.delete).not.toHaveBeenCalled();
  });

  it.each(["throws", "ownership lost", "empty"])("deletes imported keys when completion %s", async (state) => {
    const deps = dependencies();
    const completion = vi.mocked(repository.completeResearchJob);
    if (state === "throws") completion.mockRejectedValue(new Error("private database failure"));
    else completion.mockResolvedValue(state === "empty" ? { state: "empty", job: job() } : undefined);
    await expect(run(deps)).rejects.toMatchObject({ code: state === "ownership lost" ? "INSPIRATION_VISUALS_BUSY" : state === "empty" ? "INSPIRATION_VISUALS_EMPTY" : "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(deps.store.delete).toHaveBeenCalledWith([deps.imported.objectKey]);
  });

  it("does not query library matching when composing successful web results", async () => {
    const deps = dependencies();
    vi.mocked(matchLibraryPatterns).mockRejectedValue(new Error("matcher failed"));
    const board = await run(deps);
    expect(board.webEvidence).toHaveLength(1);
    expect(board.libraryMatches).toEqual([]);
    expect(board.activeJob!.warnings).toEqual([]);
    expect(matchLibraryPatterns).not.toHaveBeenCalled();
  });

  it.each(["INSPIRATION_VISUALS_EMPTY", "INSPIRATION_VISUALS_UNAVAILABLE"] as const)("classifies provider %s with empty library", async (code) => {
    const deps = dependencies();
    deps.webProvider.search.mockRejectedValue(new AppError(code, 503, "redacted"));
    await expect(run(deps)).rejects.toMatchObject({ code });
    expect(repository.completeResearchJob).not.toHaveBeenCalled();
  });

  it("reports only the disabled web branch", async () => {
    const deps = dependencies();
    setup.env.mockReturnValue({ IMAGE_SEARCH_ENABLED: false, INSPIRATION_WEB_VISUALS_ENABLED: false });
    await expect(run(deps)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_EMPTY" });
    expect(repository.failPendingJob).toHaveBeenCalledWith(ownerId, jobId, "INSPIRATION_VISUALS_EMPTY", expect.any(Date), ["INSPIRATION_WEB_VISUALS_DISABLED"]);
    expect(deps.webProvider.search).not.toHaveBeenCalled();
    expect(matchLibraryPatterns).not.toHaveBeenCalled();
  });

  it("shares one signal and compensates abort after import", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    deps.importWeb.mockImplementation(async () => { controller.abort(); return { assets: [deps.imported], warnings: [], writtenKeys: [deps.imported.objectKey] }; });
    await expect(run(deps, controller.signal)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(deps.webProvider.search).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(matchLibraryPatterns).not.toHaveBeenCalled();
    expect(deps.store.delete).toHaveBeenCalledWith([deps.imported.objectKey]);
    expect(repository.completeResearchJob).not.toHaveBeenCalled();
  });

  it("replays pending ownership without any external calls", async () => {
    const deps = dependencies();
    vi.mocked(repository.findJobByOperation).mockResolvedValue(job());
    await run(deps);
    expect(deps.webProvider.search).not.toHaveBeenCalled();
    expect(deps.importWeb).not.toHaveBeenCalled();
    expect(matchLibraryPatterns).not.toHaveBeenCalled();
  });

  it("cleans superseded keys after commit and ignores cleanup failures", async () => {
    const deps = dependencies();
    const complete = vi.mocked(repository.completeResearchJob).getMockImplementation()!;
    vi.mocked(repository.completeResearchJob).mockImplementation(async (...args) => ({ ...await complete(...args)!, state: "completed", job: job("completed"), supersededKeys: ["old-key"] }));
    deps.store.delete.mockImplementation(async () => { expect(repository.completeResearchJob).toHaveBeenCalledTimes(1); throw new Error("delete failed"); });
    const board = await run(deps);
    expect(board.activeJob!.status).toBe("completed");
    expect(deps.store.delete).toHaveBeenCalledWith(["old-key"]);
  });
});

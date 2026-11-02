import { describe, expect, it } from "vitest";
import { AppError, type AppErrorCode } from "@/lib/http/app-error";
import {
  conceptErrorCodeSchema, conceptOutputAssetDtoSchema, conceptOutputKindSchema,
  conceptRetryMutationSchema, conceptSetCreateMutationSchema, conceptSetDtoSchema,
  inspirationConceptBriefSchema, publicConceptSetDtoSchema,
} from "./contracts";
import { conceptAssetFixture, conceptBriefFixture, conceptSetFixture } from "./test-fixtures";

const id = "00000000-0000-4000-8000-000000000001";
const create = { operationId: id, directionIndex: 0, visualJobId: id, referenceAssetIds: [id] };
const shared = { id, directionIndex: 0, version: 1, outputs: [conceptAssetFixture], createdAt: conceptAssetFixture.createdAt };

describe("concept mutations", () => {
  it("accepts zero to three distinct references and normalizes UUIDs", () => {
    expect(conceptSetCreateMutationSchema.parse(create)).toEqual(create);
    for (const count of [0, 1, 2, 3]) {
      const referenceAssetIds = Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
      expect(conceptSetCreateMutationSchema.safeParse({ ...create, referenceAssetIds }).success).toBe(true);
    }
    expect(conceptSetCreateMutationSchema.parse({ ...create, visualJobId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }).visualJobId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  it.each([
    { extra: true }, { directionIndex: -1 }, { directionIndex: 5 }, { directionIndex: 0.5 },
    { visualJobId: null }, { referenceAssetIds: [id, id] },
    { referenceAssetIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] }, { referenceAssetIds: [id, id, id, id] },
    { operationId: "00000000-0000-5000-8000-000000000001" },
    { referenceAssetIds: ["invalid"] }, { visualJobId: undefined },
  ])("rejects invalid mutation %j", (patch) => {
    expect(conceptSetCreateMutationSchema.safeParse({ ...create, ...patch }).success).toBe(false);
  });
  it("allows an unreferenced direction with no visual job", () => {
    expect(conceptSetCreateMutationSchema.safeParse({ ...create, directionIndex: 4, visualJobId: null, referenceAssetIds: [] }).success).toBe(true);
  });
  it("accepts only an operation ID on retries", () => {
    expect(conceptRetryMutationSchema.parse({ operationId: id })).toEqual({ operationId: id });
    for (const value of [{}, { operationId: "bad" }, { operationId: id, kind: "flat" }]) {
      expect(conceptRetryMutationSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("immutable concept brief", () => {
  it("accepts the frozen version, model, dimensions and report direction", () => {
    expect(inspirationConceptBriefSchema.parse(conceptBriefFixture)).toEqual(conceptBriefFixture);
  });
  it.each([
    { schemaVersion: "v2" }, { promptTemplateVersion: "v2" }, { model: "other" },
    { sizes: { ...conceptBriefFixture.sizes, flat: "1536*2048" } },
    { directionIndex: 5 }, { direction: { ...conceptBriefFixture.direction, extra: true } },
    { referenceAssetIds: [id, id, id, id] }, { extra: true },
    ...["headline", "summary"].flatMap((field) => [
      { report: { ...conceptBriefFixture.report, [field]: " " } },
      { report: { ...conceptBriefFixture.report, [field]: "x".repeat(field === "headline" ? 121 : 2001) } },
    ]),
    { report: { ...conceptBriefFixture.report, marketSignals: Array(6).fill(conceptBriefFixture.report.marketSignals[0]) } },
    { report: { ...conceptBriefFixture.report, marketSignals: [{ name: "x".repeat(81), rationale: "ok", strength: "high" }] } },
    { report: { ...conceptBriefFixture.report, marketSignals: [{ name: "ok", rationale: "x".repeat(501), strength: "high" }] } },
    { report: { ...conceptBriefFixture.report, marketSignals: [{ name: "ok", rationale: "ok", strength: "unknown" }] } },
  ])("rejects an unbounded or changed brief %j", (patch) => {
    expect(inspirationConceptBriefSchema.safeParse({ ...conceptBriefFixture, ...patch }).success).toBe(false);
  });
});

describe("concept DTO boundaries", () => {
  it("accepts exactly sketch, effect and flat outputs", () => {
    expect(conceptOutputKindSchema.options).toEqual(["sketch", "effect", "flat"]);
    expect(conceptSetDtoSchema.parse(conceptSetFixture)).toEqual(conceptSetFixture);
  });
  it.each([
    { slots: conceptSetFixture.slots.slice(0, 2) },
    { slots: [...conceptSetFixture.slots, conceptSetFixture.slots[0]] },
    { slots: [...conceptSetFixture.slots].reverse() },
    { slots: [{ ...conceptSetFixture.slots[0], asset: { ...conceptAssetFixture, kind: "effect" } }, ...conceptSetFixture.slots.slice(1)] },
    { status: "queued" }, { status: "generating" }, { version: 0 }, { version: 2147483648 },
    { slots: [{ ...conceptSetFixture.slots[0], task: { status: "completed", errorCode: null } }, ...conceptSetFixture.slots.slice(1)] },
  ])("rejects invalid slot or set state %j", (patch) => {
    expect(conceptSetDtoSchema.safeParse({ ...conceptSetFixture, ...patch }).success).toBe(false);
  });
  it("requires active task state exactly when the set is active", () => {
    const slots = [{ kind: "sketch", asset: null, task: { status: "queued", errorCode: null } }, ...conceptSetFixture.slots.slice(1)];
    for (const status of ["queued", "generating"]) expect(conceptSetDtoSchema.safeParse({ ...conceptSetFixture, status, slots }).success).toBe(true);
    for (const status of ["partial", "completed", "failed"]) expect(conceptSetDtoSchema.safeParse({ ...conceptSetFixture, status, slots }).success).toBe(false);
  });
  it.each(["https://provider.test/image", "//provider.test/image", "/\\provider.test/image", "/image\n", "/image\u0000"])("rejects nonlocal image path %j", (imageUrl) => {
    expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, imageUrl }).success).toBe(false);
  });
  it("enforces exact portrait and landscape dimensions", () => {
    for (const kind of ["sketch", "effect"]) {
      expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, kind }).success).toBe(true);
      expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, kind, width: 2048, height: 1536 }).success).toBe(false);
    }
    expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, kind: "flat", width: 2048, height: 1536 }).success).toBe(true);
    expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, kind: "flat" }).success).toBe(false);
  });
  it("bounds public asset text, identifiers and dates", () => {
    for (const patch of [{ title: " " }, { title: "x".repeat(301) }, { altText: " " }, { altText: "x".repeat(501) }, { id: "bad" }, { createdAt: "bad" }, { imageUrl: "/" + "x".repeat(2048) }]) {
      expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, ...patch }).success).toBe(false);
    }
  });
  it("publishes only completed assets without tasks and errors", () => {
    expect(publicConceptSetDtoSchema.parse(shared)).toEqual(shared);
    for (const patch of [{ outputs: [] }, { outputs: [conceptAssetFixture, conceptAssetFixture] }, { outputs: Array(4).fill(conceptAssetFixture) }, { task: null }, { errorCode: null }, { status: "partial" }]) {
      expect(publicConceptSetDtoSchema.safeParse({ ...shared, ...patch }).success).toBe(false);
    }
  });
  it.each(["ownerId", "objectKey", "providerTaskId", "providerRequestId", "briefSnapshot", "prompt", "temporaryImageUrl"])("rejects leaked server field %s at every DTO boundary", (field) => {
    expect(JSON.stringify(conceptSetDtoSchema.parse(conceptSetFixture))).not.toContain(field);
    expect(JSON.stringify(publicConceptSetDtoSchema.parse(shared))).not.toContain(field);
    expect(conceptSetDtoSchema.safeParse({ ...conceptSetFixture, [field]: "secret" }).success).toBe(false);
    expect(conceptOutputAssetDtoSchema.safeParse({ ...conceptAssetFixture, [field]: "secret" }).success).toBe(false);
    expect(publicConceptSetDtoSchema.safeParse({ ...shared, [field]: "secret" }).success).toBe(false);
  });
  it("uses stable concept service errors and rejects provider errors", () => {
    const codes = [
      "INSPIRATION_CONCEPT_DISABLED", "INSPIRATION_CONCEPT_BUSY", "INSPIRATION_CONCEPT_LIMIT_REACHED",
      "INSPIRATION_CONCEPT_REFERENCES_STALE", "INSPIRATION_CONCEPT_REFERENCE_INVALID", "INSPIRATION_CONCEPT_REJECTED",
      "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN", "INSPIRATION_CONCEPT_TIMEOUT", "INSPIRATION_CONCEPT_IMPORT_FAILED", "INSPIRATION_CONCEPT_UNAVAILABLE",
    ] as const satisfies readonly AppErrorCode[];
    for (const code of codes) {
      expect(conceptErrorCodeSchema.parse(new AppError(code, 503, "failed").code)).toBe(code);
    }
    expect(conceptErrorCodeSchema.safeParse("ProviderInternalError").success).toBe(false);
  });
});

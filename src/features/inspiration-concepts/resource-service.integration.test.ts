import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as apiSession from "@/features/auth/api-session";
import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "@/features/inspiration/test-fixtures";
import { db, closeDatabase } from "@/lib/db/client";
import { users, inspirationAnalyses } from "@/lib/db/schema";
import {
  inspirationConceptSets as sets,
  inspirationConceptTasks as tasks,
  inspirationConceptOutputs as outputs,
} from "@/lib/db/schema/inspiration-concepts";
import { resetDatabase } from "@/test/database";
import { conceptBriefFixture } from "./test-fixtures";
import { conceptOutputObjectKey } from "./object-keys";
import * as objectStore from "./object-store";
import * as repository from "./repository";
import {
  authorizeOwnedConceptResource,
  conceptResourceResponse,
} from "./resource-service";
const denied = {
  code: "NOT_FOUND",
  status: 404,
  message: "Not found",
  details: undefined,
};
const bytes = Uint8Array.from([137, 80, 78, 71]);
describe("private owned concept resources", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let analysisId: string;
  let setId: string;
  let assetId: string;
  let objectKey: string;
  const get =
    vi.fn<
      (key: string) => Promise<{ bytes: Uint8Array; contentType: string }>
    >();
  const owned = (id = assetId, actor = ownerId) =>
    authorizeOwnedConceptResource(
      { ownerId: actor, assetId: id },
      { store: { get } },
    );
  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    analysisId = randomUUID();
    setId = randomUUID();
    assetId = randomUUID();
    const taskId = randomUUID();
    get.mockReset().mockResolvedValue({ bytes, contentType: "image/png" });
    await db
      .insert(users)
      .values(
        [ownerId, otherOwnerId].map((id) => ({
          id,
          email: `${id}@test.example`,
          displayName: "Designer",
          passwordHash: "hash",
          mustChangePassword: false,
        })),
      );
    await db
      .insert(inspirationAnalyses)
      .values({
        id: analysisId,
        ownerId,
        operationId: randomUUID(),
        prompt: "Private report",
        title: "Report",
        status: "completed",
        sources: [inspirationSourceFixture],
        result: inspirationResultFixture,
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
        completedAt: new Date(),
      });
    await db
      .insert(sets)
      .values({
        id: setId,
        ownerId,
        analysisId,
        operationId: randomUUID(),
        directionIndex: 0,
        version: 1,
        status: "partial",
        completedAt: new Date(),
        briefSnapshot: conceptBriefFixture,
        model: conceptBriefFixture.model,
        promptTemplateVersion: conceptBriefFixture.promptTemplateVersion,
      });
    await db
      .insert(tasks)
      .values({
        id: taskId,
        ownerId,
        setId,
        operationId: randomUUID(),
        outputKind: "sketch",
        attempt: 1,
        status: "completed",
        availableAt: new Date(),
        completedAt: new Date(),
        submitStartedAt: new Date(),
        providerTaskId: "private-provider-task",
      });
    objectKey = conceptOutputObjectKey({
      ownerId,
      analysisId,
      setId,
      outputId: assetId,
      outputKind: "sketch",
    });
    await db
      .insert(outputs)
      .values({
        id: assetId,
        ownerId,
        analysisId,
        setId,
        sourceTaskId: taskId,
        outputKind: "sketch",
        title: "Private concept",
        altText: "Concept",
        objectKey,
        contentType: "image/png",
        width: 1536,
        height: 2048,
      });
  });
  afterAll(closeDatabase);
  afterEach(() => vi.restoreAllMocks());

  async function download() {
    vi.spyOn(apiSession, "requireApiUser").mockResolvedValue({
      id: ownerId,
      email: "designer@example.test",
      displayName: "Designer",
      role: "user",
      mustChangePassword: false,
      themePreference: "system",
      sessionVersion: 1,
    });
    vi.spyOn(objectStore, "createConceptObjectStore").mockReturnValue({
      get,
      put: async () => {},
      delete: async () => {},
      listObjectKeys: async () => [],
    });
    const { GET } = await import(
      "@/app/api/inspiration-concept-assets/[assetId]/download/route"
    );
    return GET(
      new Request(
        `http://internal/api/inspiration-concept-assets/${assetId}/download`,
      ),
      {
        params: Promise.resolve({ assetId }),
      },
    );
  }

  it("downloads a boundary supplementary character without splitting its surrogate pair", async () => {
    const brief = structuredClone(conceptBriefFixture);
    brief.direction.title = `${"a".repeat(79)}😀after-boundary`;
    await db
      .update(sets)
      .set({ briefSnapshot: brief })
      .where(eq(sets.id, setId));

    const response = await download();

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition");
    expect(disposition).toMatch(
      /^attachment; filename="concept.png"; filename\*=UTF-8''/,
    );
    expect(decodeURIComponent(disposition!.split("UTF-8''")[1]!)).toBe(
      `${"a".repeat(79)}😀-方案01-设计草图.png`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["\uD800", "\uDC00"])(
    "sanitizes isolated surrogate metadata before encoding a download attachment",
    async (surrogate) => {
      // PostgreSQL JSON rejects isolated surrogates. Inject only the corrupt title at
      // the repository result boundary, preserving the real complete owned row.
      const stored = await repository.findOwnedConceptResource({
        ownerId,
        assetId,
      });
      vi.spyOn(repository, "findOwnedConceptResource").mockResolvedValue({
        ...stored!,
        directionTitle: `柔和${surrogate}通勤`,
      });

      const response = await download();

      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition")!;
      expect(disposition).toMatch(
        /^attachment; filename="concept.png"; filename\*=UTF-8''/,
      );
      const filename = decodeURIComponent(disposition.split("UTF-8''")[1]!);
      expect(filename).toBe("柔和�通勤-方案01-设计草图.png");
      expect(disposition).not.toContain(objectKey);
      expect(disposition).not.toContain(ownerId);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("location")).toBeNull();
    },
  );
  it("reads owned bytes only through the owned live set and returns no private identifiers", async () => {
    const resource = await owned(assetId.toUpperCase());
    expect(resource).toMatchObject({ bytes, contentType: "image/png" });
    expect(get).toHaveBeenCalledExactlyOnceWith(objectKey);
    expect(resource).not.toHaveProperty("objectKey");
    expect(resource).not.toHaveProperty("ownerId");
    const response = conceptResourceResponse(resource);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("denies foreign owners and missing outputs before reading storage", async () => {
    await expect(owned(assetId, otherOwnerId)).rejects.toMatchObject(denied);
    await expect(owned(randomUUID())).rejects.toMatchObject(denied);
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["bad", "", "../../private", "https://oss.test/private"])(
    "denies invalid identities %s",
    async (id) => {
      await expect(owned(id)).rejects.toMatchObject(denied);
      await expect(owned(assetId, id)).rejects.toMatchObject(denied);
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("revokes existing bytes immediately on soft deletion and after hard cleanup", async () => {
    await owned();
    get.mockClear();
    await db
      .update(sets)
      .set({ status: "deleting", deletedAt: new Date() })
      .where(eq(sets.id, setId));
    await expect(owned()).rejects.toMatchObject(denied);
    expect(get).not.toHaveBeenCalled();
    await db.delete(sets).where(eq(sets.id, setId));
    await expect(owned()).rejects.toMatchObject(denied);
  });
  it("revokes bytes when the analysis is removed", async () => {
    await db
      .delete(inspirationAnalyses)
      .where(eq(inspirationAnalyses.id, analysisId));
    await expect(owned()).rejects.toMatchObject(denied);
    expect(get).not.toHaveBeenCalled();
  });
  it("keeps completed outputs available during a derivative retry", async () => {
    await db
      .update(sets)
      .set({ status: "generating", completedAt: null })
      .where(eq(sets.id, setId));
    await expect(owned()).resolves.toMatchObject({ bytes });
  });
  it("denies mismatched object type and safely hides storage failures", async () => {
    get.mockResolvedValueOnce({ bytes, contentType: "text/html" });
    await expect(owned()).rejects.toMatchObject(denied);
    get.mockRejectedValueOnce(
      new Error(
        `${objectKey} https://oss.test?Signature=secret private-provider-task`,
      ),
    );
    const error = await owned().catch((error) => error);
    expect(error).toMatchObject(denied);
    expect(JSON.stringify(error)).not.toMatch(/Signature|provider|objectKey/);
    expect(error).not.toHaveProperty("cause");
  });
  it("denies object keys outside the authorized output scope before storage", async () => {
    await db
      .update(outputs)
      .set({
        objectKey: conceptOutputObjectKey({
          ownerId: otherOwnerId,
          analysisId,
          setId,
          outputId: assetId,
          outputKind: "sketch",
        }),
      })
      .where(eq(outputs.id, assetId));
    await expect(owned()).rejects.toMatchObject(denied);
    expect(get).not.toHaveBeenCalled();
  });
  it("uses bounded sanitized server filenames and RFC 5987 attachment encoding", async () => {
    const brief = structuredClone(conceptBriefFixture);
    brief.direction.title = '柔和/通勤\r\n"*';
    await db
      .update(sets)
      .set({ briefSnapshot: brief })
      .where(eq(sets.id, setId));
    const resource = await owned();
    expect(resource.filename).toMatch(/方案01-.*\.png$/);
    expect(resource.filename).not.toMatch(/[\r\n/\\"*]/);
    const response = conceptResourceResponse(resource, { download: true });
    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(resource.filename)}`,
    );
    expect(response.headers.get("location")).toBeNull();
  });
});

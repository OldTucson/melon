import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { inspirationResultFixture, inspirationSourceFixture } from "@/features/inspiration/test-fixtures";
import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, inspirationVisualAssets, inspirationVisualJobs, patterns, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import {
  authorizeOwnedVisualResource,
  authorizeSharedVisualResource,
  visualResourceResponse,
} from "./visual-resource-service";

const denied = { code: "NOT_FOUND", status: 404, message: "Not found", details: undefined };
const bytes = Uint8Array.from([137, 80, 78, 71]);

describe("private inspiration visual resources", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let analysisId: string;
  let shareId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    analysisId = randomUUID();
    shareId = randomUUID();
    await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({
      id, email: `${id}@example.test`, displayName: "Resource owner", passwordHash: "hash", mustChangePassword: false,
    })));
    await db.insert(inspirationAnalyses).values({
      id: analysisId, ownerId, operationId: randomUUID(), prompt: "分析都市轻通勤女装", title: "都市轻通勤",
      status: "completed", sources: [inspirationSourceFixture], result: inspirationResultFixture,
      searchModel: "qwen-plus", structureModel: "qwen3.8-flash", completedAt: new Date(), shareId,
    });
  });
  afterAll(closeDatabase);

  async function seed(input: {
    status?: "pending" | "completed" | "failed";
    createdAt?: Date;
    jobId?: string;
    kind?: "web_evidence" | "library_match";
  } = {}) {
    const status = input.status ?? "completed";
    const jobId = input.jobId ?? randomUUID();
    const assetId = randomUUID();
    const objectKey = `users/${ownerId}/inspiration/${analysisId}/research/${jobId}/${assetId}.png`;
    await db.insert(inspirationVisualJobs).values({
      id: jobId, ownerId, analysisId, operationId: randomUUID(), kind: "research_visuals", status,
      createdAt: input.createdAt ?? new Date("2026-10-30T00:00:00Z"),
      completedAt: status === "pending" ? null : new Date(),
      errorCode: status === "failed" ? "INSPIRATION_VISUALS_UNAVAILABLE" : null,
    });
    const common = { id: assetId, ownerId, analysisId, jobId, ordinal: 0, title: "Evidence", altText: "Evidence image" };
    if (input.kind === "library_match") {
      const patternId = randomUUID();
      await db.insert(patterns).values({
        id: patternId, ownerId, name: "Garden", originalFilename: "garden.png", extension: "png", sizeBytes: 4n,
        status: "ready", previewStatus: "ready",
      });
      await db.insert(inspirationVisualAssets).values({ ...common, kind: "library_match", patternId });
    } else {
      await db.insert(inspirationVisualAssets).values({
        ...common, kind: "web_evidence", documentRole: "hero", sourceIndexes: [0],
        sourcePageUrl: inspirationSourceFixture.url, sourceSiteName: "Source", sourceQuery: "fashion",
        objectKey, contentType: "image/png", width: 1, height: 1,
      });
    }
    return { assetId, jobId, objectKey };
  }

  const owned = (assetId: string, actor = ownerId) => authorizeOwnedVisualResource({ ownerId: actor, assetId });
  const shared = (assetId: string, token = shareId) => authorizeSharedVisualResource({ shareId: token, assetId });
  const denyBoth = async (assetId: string) => {
    await expect(owned(assetId)).rejects.toMatchObject(denied);
    await expect(shared(assetId)).rejects.toMatchObject(denied);
  };

  it("returns only the private key and MIME type for the current owner and live share", async () => {
    const { assetId, objectKey } = await seed();
    const resource = { objectKey, contentType: "image/png" };
    await expect(owned(assetId.toUpperCase())).resolves.toEqual(resource);
    await expect(shared(assetId, shareId.toUpperCase())).resolves.toEqual(resource);
    const response = await visualResourceResponse(resource, {
      store: { async get(key) {
        if (key !== objectKey) throw new Error("wrong private key");
        return { bytes, contentType: "image/png" };
      } },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/png", "content-length": "4", "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff", "cache-control": "private, no-store",
    });
  });

  it("denies another owner and an unrelated live share identically to an unknown asset", async () => {
    const { assetId } = await seed();
    const foreignShare = randomUUID();
    await db.insert(inspirationAnalyses).values({
      id: randomUUID(), ownerId: otherOwnerId, operationId: randomUUID(), prompt: "分析自然主义家居趋势", title: "自然主义",
      status: "completed", sources: [inspirationSourceFixture], result: inspirationResultFixture,
      searchModel: "qwen-plus", structureModel: "qwen3.8-flash", completedAt: new Date(), shareId: foreignShare,
    });
    await expect(owned(assetId, otherOwnerId)).rejects.toMatchObject(denied);
    await expect(shared(assetId, foreignShare)).rejects.toMatchObject(denied);
    await expect(shared(assetId, randomUUID())).rejects.toMatchObject(denied);
    await denyBoth(randomUUID());
  });

  it.each(["not-a-uuid", "", "../../private.png", "https://provider.test/image.png"])(
    "denies malformed identifiers %j without database errors", async (invalid) => {
      const { assetId } = await seed();
      await denyBoth(invalid);
      await expect(shared(assetId, invalid)).rejects.toMatchObject(denied);
      await expect(owned(assetId, invalid)).rejects.toMatchObject(denied);
    },
  );

  it("never grants this byte endpoint to a library match", async () => {
    await denyBoth((await seed({ kind: "library_match" })).assetId);
  });

  it.each(["pending", "failed"] as const)("denies objects attached to a %s job", async (status) => {
    await denyBoth((await seed({ status })).assetId);
  });

  it("denies superseded completed bytes even if the old object still exists", async () => {
    const old = await seed();
    const active = await seed({ createdAt: new Date("2026-10-30T00:01:00Z") });
    await denyBoth(old.assetId);
    await expect(shared(active.assetId)).resolves.toEqual({ objectKey: active.objectKey, contentType: "image/png" });
  });

  it("uses the board's job UUID tie-break when completion candidates have equal creation times", async () => {
    const active = await seed({ jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const old = await seed({ jobId: "00000000-0000-4000-8000-000000000001" });
    await denyBoth(old.assetId);
    await expect(owned(active.assetId)).resolves.toEqual({ objectKey: active.objectKey, contentType: "image/png" });
  });

  it.each(["pending", "failed"] as const)("keeps completed images accessible while the newer refresh is %s", async (status) => {
    const active = await seed();
    await seed({ status, createdAt: new Date("2026-10-30T00:01:00Z") });
    const resource = { objectKey: active.objectKey, contentType: "image/png" };
    await expect(owned(active.assetId)).resolves.toEqual(resource);
    await expect(shared(active.assetId)).resolves.toEqual(resource);
  });

  it("rechecks live share rotation and revocation after a successful byte request", async () => {
    const { assetId } = await seed();
    const store = { async get() { return { bytes, contentType: "image/png" }; } };
    expect((await visualResourceResponse(await shared(assetId), { store })).status).toBe(200);
    const rotated = randomUUID();
    await db.update(inspirationAnalyses).set({ shareId: rotated }).where(eq(inspirationAnalyses.id, analysisId));
    await expect(shared(assetId)).rejects.toMatchObject(denied);
    expect((await visualResourceResponse(await shared(assetId, rotated), { store })).status).toBe(200);
    await db.update(inspirationAnalyses).set({ shareId: null }).where(eq(inspirationAnalyses.id, analysisId));
    await expect(shared(assetId, rotated)).rejects.toMatchObject(denied);
    expect((await visualResourceResponse(await owned(assetId), { store })).status).toBe(200);
  });

  it("redacts missing-object and storage errors into the same denial with no cause or private details", async () => {
    const { assetId, objectKey } = await seed();
    const resource = await owned(assetId);
    const secret = `private-bucket ${objectKey} https://oss.test/private?Signature=secret ${ownerId}`;
    const error = await visualResourceResponse(resource, {
      store: { async get() { throw new Error(secret); } },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(denied);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).toBe("AppError: Not found");
    expect(JSON.stringify(error)).not.toContain(objectKey);
  });

  it("does not forward an untrusted object MIME header", async () => {
    const { assetId } = await seed();
    await expect(visualResourceResponse(await owned(assetId), {
      store: { async get() { return { bytes, contentType: "text/html" }; } },
    })).rejects.toMatchObject(denied);
  });
});

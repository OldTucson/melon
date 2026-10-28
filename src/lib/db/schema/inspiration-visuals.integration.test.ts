import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import {
  inspirationAnalyses,
  inspirationVisualAssets,
  inspirationVisualJobs,
  patterns,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

type DatabaseError = {
  code?: string;
  constraint_name?: string;
};

const findDatabaseError = (error: unknown): DatabaseError | undefined => {
  let candidate = error;
  const seen = new Set<unknown>();

  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    if ("code" in candidate && typeof candidate.code === "string") {
      return candidate as DatabaseError;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }

  return undefined;
};

const expectConstraint = async (
  operation: Promise<unknown>,
  code: string,
  constraintName: string,
) => {
  try {
    await operation;
  } catch (error) {
    expect(findDatabaseError(error)).toMatchObject({
      code,
      constraint_name: constraintName,
    });
    return;
  }

  throw new Error("Expected PostgreSQL to reject the operation");
};

describe("inspiration visual schema", () => {
  let ownerA: string;
  let ownerB: string;
  let analysisA: string;
  let analysisB: string;
  let patternA: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = randomUUID();
    ownerB = randomUUID();
    analysisA = randomUUID();
    analysisB = randomUUID();
    patternA = randomUUID();

    await db.insert(users).values(
      [ownerA, ownerB].map((id) => ({
        id,
        email: `${id}@example.test`,
        displayName: "Designer",
        passwordHash: "hash",
        mustChangePassword: false,
      })),
    );
    await db.insert(inspirationAnalyses).values([
      {
        id: analysisA,
        ownerId: ownerA,
        operationId: randomUUID(),
        prompt: "分析都市轻通勤女装",
        title: "都市轻通勤",
        status: "pending",
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
      },
      {
        id: analysisB,
        ownerId: ownerB,
        operationId: randomUUID(),
        prompt: "分析自然主义家居趋势",
        title: "自然主义家居",
        status: "pending",
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
      },
    ]);
    await db.insert(patterns).values({
      id: patternA,
      ownerId: ownerA,
      name: "雨后花园",
      originalFilename: "garden.png",
      extension: "png",
      sizeBytes: 1024n,
    });
  });

  afterAll(closeDatabase);

  const insertJob = (
    overrides: Partial<typeof inspirationVisualJobs.$inferInsert> = {},
  ) =>
    db
      .insert(inspirationVisualJobs)
      .values({
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        operationId: randomUUID(),
        kind: "research_visuals",
        directionIndex: null,
        status: "pending",
        ...overrides,
      })
      .returning();

  it("scopes operation replay to an owner", async () => {
    const operationId = randomUUID();
    await insertJob({ operationId });

    await expectConstraint(
      insertJob({ operationId }),
      "23505",
      "inspiration_visual_jobs_owner_operation_unique",
    );

    await expect(
      insertJob({
        ownerId: ownerB,
        analysisId: analysisB,
        operationId,
      }),
    ).resolves.toHaveLength(1);
  });

  it("allows only one pending job for each analysis, kind, and nullable direction", async () => {
    await insertJob();
    await expectConstraint(
      insertJob(),
      "23505",
      "inspiration_visual_jobs_target_pending_unique",
    );

    await expect(
      insertJob({
        status: "completed",
        completedAt: new Date(),
      }),
    ).resolves.toHaveLength(1);
    await expect(
      insertJob({ kind: "concept_image", directionIndex: 0 }),
    ).resolves.toHaveLength(1);
  });

  it.each([
    {
      name: "research job with a direction",
      values: { directionIndex: 0 },
      constraint: "inspiration_visual_jobs_target_check",
    },
    {
      name: "concept job without a direction",
      values: { kind: "concept_image", directionIndex: null },
      constraint: "inspiration_visual_jobs_target_check",
    },
    {
      name: "completed job without a completion time",
      values: { status: "completed" },
      constraint: "inspiration_visual_jobs_state_check",
    },
    {
      name: "failed job without a stable error",
      values: { status: "failed", completedAt: new Date() },
      constraint: "inspiration_visual_jobs_state_check",
    },
  ])("rejects $name", async ({ values, constraint }) => {
    await expectConstraint(
      insertJob(values as Partial<typeof inspirationVisualJobs.$inferInsert>),
      "23514",
      constraint,
    );
  });

  it("enforces fields for each asset kind and owner-scoped library references", async () => {
    const [job] = await insertJob({
      status: "completed",
      completedAt: new Date(),
    });

    await db.insert(inspirationVisualAssets).values([
      {
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        jobId: job!.id,
        kind: "web_evidence",
        ordinal: 0,
        title: "秀场证据",
        altText: "低饱和绿色造型",
        sourcePageUrl: "https://example.com/runway",
        sourceSiteName: "Example",
        sourceQuery: "2026 green tailoring",
        objectKey: "inspiration/web/evidence.webp",
        contentType: "image/webp",
        width: 1200,
        height: 900,
      },
      {
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        jobId: job!.id,
        kind: "library_match",
        ordinal: 1,
        title: "雨后花园",
        altText: "绿色植物图案",
        patternId: patternA,
      },
      {
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        jobId: job!.id,
        kind: "generated_concept",
        ordinal: 2,
        directionIndex: 0,
        title: "自然通勤概念",
        altText: "自然通勤女装概念图",
        objectKey: "inspiration/concepts/concept.webp",
        contentType: "image/webp",
        width: 1200,
        height: 900,
      },
    ]);

    await expectConstraint(
      db.insert(inspirationVisualAssets).values({
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        jobId: job!.id,
        kind: "web_evidence",
        ordinal: 3,
        title: "缺失来源",
        altText: "缺失来源字段的图片",
        objectKey: "inspiration/web/invalid.webp",
        contentType: "image/webp",
        width: 1200,
        height: 900,
      }),
      "23514",
      "inspiration_visual_assets_kind_check",
    );

    const foreignPattern = randomUUID();
    await db.insert(patterns).values({
      id: foreignPattern,
      ownerId: ownerB,
      name: "Other owner",
      originalFilename: "other.png",
      extension: "png",
      sizeBytes: 1024n,
    });
    await expectConstraint(
      db.insert(inspirationVisualAssets).values({
        id: randomUUID(),
        ownerId: ownerA,
        analysisId: analysisA,
        jobId: job!.id,
        kind: "library_match",
        ordinal: 4,
        title: "跨用户图案",
        altText: "不应允许引用",
        patternId: foreignPattern,
      }),
      "23503",
      "inspiration_visual_assets_owner_pattern_fk",
    );
  });

  it("keeps asset ordinals stable and unique inside a job", async () => {
    const [job] = await insertJob({
      status: "completed",
      completedAt: new Date(),
    });
    const values = [2, 0, 1].map((ordinal) => ({
      id: randomUUID(),
      ownerId: ownerA,
      analysisId: analysisA,
      jobId: job!.id,
      kind: "library_match" as const,
      ordinal,
      title: `图案 ${ordinal}`,
      altText: `图案 ${ordinal}`,
      patternId: patternA,
    }));
    await db.insert(inspirationVisualAssets).values(values);

    const ordered = await db
      .select({ ordinal: inspirationVisualAssets.ordinal })
      .from(inspirationVisualAssets)
      .where(eq(inspirationVisualAssets.jobId, job!.id))
      .orderBy(asc(inspirationVisualAssets.ordinal));
    expect(ordered.map(({ ordinal }) => ordinal)).toEqual([0, 1, 2]);

    await expectConstraint(
      db.insert(inspirationVisualAssets).values({
        ...values[0]!,
        id: randomUUID(),
      }),
      "23505",
      "inspiration_visual_assets_job_kind_ordinal_unique",
    );
  });

  it("cascades analysis and library-pattern deletion to dependent visual rows", async () => {
    const [job] = await insertJob({
      status: "completed",
      completedAt: new Date(),
    });
    await db.insert(inspirationVisualAssets).values({
      id: randomUUID(),
      ownerId: ownerA,
      analysisId: analysisA,
      jobId: job!.id,
      kind: "library_match",
      ordinal: 0,
      title: "雨后花园",
      altText: "绿色植物图案",
      patternId: patternA,
    });

    await db.delete(patterns).where(eq(patterns.id, patternA));
    expect(await db.select().from(inspirationVisualAssets)).toHaveLength(0);

    await db.delete(inspirationAnalyses).where(eq(inspirationAnalyses.id, analysisA));
    expect(await db.select().from(inspirationVisualJobs)).toHaveLength(0);
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { asc, eq, sql } from "drizzle-orm";
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
        documentRole: "evidence",
        sourceIndexes: [],
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

  it("keeps a generated concept tombstone after its saved pattern is deleted", async () => {
    const saveOperationId = randomUUID();
    const [job] = await insertJob({
      kind: "concept_image",
      directionIndex: 0,
      status: "completed",
      completedAt: new Date(),
    });
    await db.insert(inspirationVisualAssets).values({
      id: randomUUID(),
      ownerId: ownerA,
      analysisId: analysisA,
      jobId: job!.id,
      kind: "generated_concept",
      ordinal: 0,
      directionIndex: 0,
      title: "自然通勤概念",
      altText: "自然通勤女装概念图",
      savedPatternId: patternA,
      saveOperationId,
      objectKey: "inspiration/concepts/saved.webp",
      contentType: "image/webp",
      width: 1200,
      height: 900,
    });

    await expect(
      db.delete(patterns).where(eq(patterns.id, patternA)),
    ).resolves.toBeDefined();
    expect(await db.select().from(inspirationVisualAssets)).toEqual([
      expect.objectContaining({
        savedPatternId: null,
        saveOperationId,
      }),
    ]);
  });

  const webAsset = (jobId: string) => ({
    id: randomUUID(),
    ownerId: ownerA,
    analysisId: analysisA,
    jobId,
    kind: "web_evidence" as const,
    ordinal: 0,
    title: "秀场证据",
    altText: "绿色造型",
    sourcePageUrl: "https://example.test/runway",
    sourceSiteName: "Example",
    sourceQuery: "green tailoring",
    objectKey: "inspiration/web/evidence.webp",
    contentType: "image/webp",
    width: 1200,
    height: 900,
    documentRole: "evidence" as const,
    sourceIndexes: [3, 1],
  });

  it.each(["hero", "evidence", "product"] as const)(
    "stores the web role %s",
    async (documentRole) => {
      const [job] = await insertJob();
      const [asset] = await db
        .insert(inspirationVisualAssets)
        .values({
          ...webAsset(job!.id),
          documentRole,
          ...(documentRole === "product"
            ? { brand: "Melon", productName: "棉麻衬衫", priceText: "¥299" }
            : {}),
        })
        .returning();
      expect(asset).toMatchObject({ documentRole, sourceIndexes: [3, 1] });
    },
  );

  it.each([
    { documentRole: null },
    { sourceIndexes: null },
    { sourceIndexes: {} },
    { documentRole: "product", productName: null },
    { documentRole: "product", productName: "   " },
    { brand: "Melon" },
    { productName: "衬衫" },
    { priceText: "¥299" },
    { documentRole: "hero", brand: "Melon" },
  ])("rejects invalid web document fields %j", async (overrides) => {
    const [job] = await insertJob();
    await expectConstraint(
      db.insert(inspirationVisualAssets).values({
        ...webAsset(job!.id),
        ...overrides,
      } as typeof inspirationVisualAssets.$inferInsert),
      "23514",
      "productName" in overrides && overrides.productName === "   "
        ? "inspiration_visual_assets_product_length_check"
        : "inspiration_visual_assets_kind_check",
    );
  });

  it.each([
    ["brand", 120],
    ["productName", 300],
    ["priceText", 120],
  ] as const)("bounds stored product %s at %i", async (field, max) => {
    const [job] = await insertJob();
    const product = {
      ...webAsset(job!.id),
      documentRole: "product" as const,
      productName: "衬衫",
    };
    await db
      .insert(inspirationVisualAssets)
      .values({ ...product, [field]: "a".repeat(max) });
    await expectConstraint(
      db.insert(inspirationVisualAssets).values({
        ...product,
        id: randomUUID(),
        ordinal: 1,
        [field]: "a".repeat(max + 1),
      }),
      "23514",
      "inspiration_visual_assets_product_length_check",
    );
  });

  it.each(["library_match", "generated_concept"] as const)(
    "rejects document fields on %s",
    async (kind) => {
      const [job] = await insertJob();
      const asset =
        kind === "library_match"
          ? {
              id: randomUUID(),
              ownerId: ownerA,
              analysisId: analysisA,
              jobId: job!.id,
              kind,
              ordinal: 0,
              title: "图案",
              altText: "图案",
              patternId: patternA,
            }
          : {
              ...webAsset(job!.id),
              kind,
              directionIndex: 0,
              sourcePageUrl: null,
              sourceSiteName: null,
              sourceQuery: null,
            };
      await expectConstraint(
        db.insert(inspirationVisualAssets).values({
          ...asset,
          documentRole: "hero",
          sourceIndexes: [],
        }),
        "23514",
        "inspiration_visual_assets_kind_check",
      );
    },
  );

  it("backfills legacy web evidence without changing completed text analyses", async () => {
    const journal = JSON.parse(
      await readFile("drizzle/meta/_journal.json", "utf8"),
    ) as { entries: { tag: string }[] };
    const entry = journal.entries.find(({ tag }) =>
      tag.includes("editorial_inspiration_visuals"),
    );
    expect(entry, "editorial migration must be generated").toBeDefined();
    const migration = await readFile(`drizzle/${entry!.tag}.sql`, "utf8");
    const previous = await readFile(
      "drizzle/0009_melon_inspiration_visuals.sql",
      "utf8",
    );
    const legacyTable = previous.slice(
      previous.indexOf('CREATE TABLE "inspiration_visual_assets"'),
      previous.indexOf(
        "--> statement-breakpoint",
        previous.indexOf('CREATE TABLE "inspiration_visual_assets"'),
      ),
    );
    await db
      .update(inspirationAnalyses)
      .set({
        status: "completed",
        sources: [{ index: 1 }],
        result: { headline: "Original report" },
        completedAt: new Date(),
      })
      .where(eq(inspirationAnalyses.id, analysisA));
    const before = await db
      .select()
      .from(inspirationAnalyses)
      .where(eq(inspirationAnalyses.id, analysisA));
    const migrationSchema = `editorial_migration_${randomUUID().replaceAll("-", "")}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${migrationSchema}"`));
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO "${migrationSchema}", public`),
      );
      await tx.execute(sql.raw(legacyTable));
      await tx.execute(sql`INSERT INTO inspiration_visual_assets
        (id, owner_id, analysis_id, job_id, kind, ordinal, title, alt_text,
         source_page_url, source_site_name, source_query, object_key, content_type, width, height)
        VALUES (${randomUUID()}, ${ownerA}, ${analysisA}, ${randomUUID()}, 'web_evidence', 0,
          'Legacy evidence', 'Legacy image', 'https://example.test/source', 'Example', 'query', 'legacy.webp', 'image/webp', 100, 100)`);
      for (const statement of migration
        .replaceAll('"public".', `"${migrationSchema}".`)
        .split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      const rows = await tx.execute(
        sql`SELECT document_role, source_indexes, object_key FROM inspiration_visual_assets`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        document_role: "evidence",
        source_indexes: [],
        object_key: "legacy.webp",
      });
      await tx.execute(sql.raw(`DROP SCHEMA "${migrationSchema}" CASCADE`));
    });
    expect(
      await db
        .select()
        .from(inspirationAnalyses)
        .where(eq(inspirationAnalyses.id, analysisA)),
    ).toEqual(before);
  });
});

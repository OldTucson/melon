import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

type PostgresError = {
  code: string;
  constraint_name?: string;
  message?: string;
};

const INDEX_VERSION = "visual-search-v1";

const postgresError = (error: unknown): PostgresError | undefined => {
  let candidate = error;
  const seen = new Set<unknown>();

  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);

    if ("code" in candidate && typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint_name:
          "constraint_name" in candidate &&
          typeof candidate.constraint_name === "string"
            ? candidate.constraint_name
            : undefined,
        message:
          "message" in candidate && typeof candidate.message === "string"
            ? candidate.message
            : undefined,
      };
    }

    candidate = "cause" in candidate ? candidate.cause : undefined;
  }

  return undefined;
};

const expectDatabaseError = async (
  operation: Promise<unknown>,
  expected: {
    code: string;
    constraintName?: string;
    message?: RegExp;
  },
) => {
  try {
    await operation;
  } catch (error) {
    const actual = postgresError(error);

    expect(actual?.code).toBe(expected.code);
    if (expected.constraintName !== undefined) {
      expect(actual?.constraint_name).toBe(expected.constraintName);
    }
    if (expected.message !== undefined) {
      expect(actual?.message).toMatch(expected.message);
    }
    return;
  }

  throw new Error("Expected PostgreSQL to reject the operation");
};

const vectorLiteral = (dimensions: number) =>
  `[${Array.from({ length: dimensions }, () => "0").join(",")}]`;

const insertDocument = (input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  previewHash?: string;
  indexVersion?: string;
  status?: "pending" | "indexing" | "ready" | "failed" | "superseded";
  id?: string;
}) => {
  const id = input.id ?? randomUUID();

  return db
    .execute(sql`
      insert into visual_search_documents (
        id,
        owner_id,
        pattern_id,
        preview_asset_id,
        preview_hash,
        index_version,
        status
      ) values (
        ${id},
        ${input.ownerId},
        ${input.patternId},
        ${input.previewAssetId},
        ${input.previewHash ?? "a".repeat(64)},
        ${input.indexVersion ?? INDEX_VERSION},
        ${input.status ?? "pending"}
      )
    `)
    .then(() => id);
};

const insertEmbedding = (input: {
  documentId: string;
  ownerId: string;
  patternId: string;
  dimensions?: number;
  regionIndex?: number;
}) =>
  db.execute(sql`
    insert into visual_search_embeddings (
      document_id,
      owner_id,
      pattern_id,
      region_index,
      region_kind,
      x,
      y,
      width,
      height,
      embedding
    ) values (
      ${input.documentId},
      ${input.ownerId},
      ${input.patternId},
      ${input.regionIndex ?? 0},
      'global',
      0,
      0,
      1,
      1,
      ${vectorLiteral(input.dimensions ?? 384)}::vector
    )
  `);

const insertJob = (input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  previewHash?: string | null;
  indexVersion?: string;
  id?: string;
}) =>
  db.execute(sql`
    insert into visual_search_jobs (
      id,
      owner_id,
      pattern_id,
      preview_asset_id,
      preview_hash,
      index_version,
      status,
      available_at
    ) values (
      ${input.id ?? randomUUID()},
      ${input.ownerId},
      ${input.patternId},
      ${input.previewAssetId},
      ${input.previewHash ?? null},
      ${input.indexVersion ?? INDEX_VERSION},
      'pending',
      now()
    )
  `);

describe("visual search schema", () => {
  let ownerA: string;
  let ownerB: string;
  let patternA: string;
  let patternASibling: string;
  let patternB: string;
  let previewA: string;
  let previewASibling: string;
  let previewB: string;

  beforeEach(async () => {
    await resetDatabase();

    ownerA = randomUUID();
    ownerB = randomUUID();
    patternA = randomUUID();
    patternASibling = randomUUID();
    patternB = randomUUID();
    previewA = randomUUID();
    previewASibling = randomUUID();
    previewB = randomUUID();

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ownerA}, 'visual-search-owner-a@example.test', 'Owner A', 'test-password-hash'),
        (${ownerB}, 'visual-search-owner-b@example.test', 'Owner B', 'test-password-hash')
    `);
    await db.execute(sql`
      insert into patterns (
        id,
        owner_id,
        name,
        original_filename,
        extension,
        size_bytes,
        status,
        preview_status
      ) values
        (${patternA}, ${ownerA}, 'Garden A', 'garden-a.psd', 'psd', 1024, 'ready', 'ready'),
        (${patternASibling}, ${ownerA}, 'Garden A sibling', 'garden-a-sibling.psd', 'psd', 1024, 'ready', 'ready'),
        (${patternB}, ${ownerB}, 'Garden B', 'garden-b.psd', 'psd', 1024, 'ready', 'ready')
    `);
    await db.execute(sql`
      insert into assets (
        id,
        owner_id,
        pattern_id,
        role,
        object_key,
        original_filename,
        detected_mime_type,
        size_bytes,
        content_hash
      ) values
        (
          ${previewA},
          ${ownerA},
          ${patternA},
          'preview',
          ${`users/${ownerA}/patterns/${patternA}/preview.webp`},
          'garden-a.webp',
          'image/webp',
          512,
          ${"a".repeat(64)}
        ),
        (
          ${previewASibling},
          ${ownerA},
          ${patternASibling},
          'preview',
          ${`users/${ownerA}/patterns/${patternASibling}/preview.webp`},
          'garden-a-sibling.webp',
          'image/webp',
          512,
          ${"c".repeat(64)}
        ),
        (
          ${previewB},
          ${ownerB},
          ${patternB},
          'preview',
          ${`users/${ownerB}/patterns/${patternB}/preview.webp`},
          'garden-b.webp',
          'image/webp',
          512,
          ${"b".repeat(64)}
        )
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("keeps one ready document per pattern and index version", async () => {
    const firstDocumentId = await insertDocument({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
      status: "ready",
    });

    await expectDatabaseError(
      insertDocument({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewA,
        previewHash: "b".repeat(64),
        status: "ready",
      }),
      {
        code: "23505",
        constraintName: "visual_search_documents_ready_unique",
      },
    );

    await db.execute(sql`
      update visual_search_documents
      set status = 'superseded'
      where id = ${firstDocumentId}
    `);

    await expect(
      insertDocument({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewA,
        previewHash: "b".repeat(64),
        status: "ready",
      }),
    ).resolves.toBeDefined();

    const [result] = await db.execute<{ ready_count: number }>(sql`
      select count(*)::int as ready_count
      from visual_search_documents
      where owner_id = ${ownerA}
        and pattern_id = ${patternA}
        and index_version = ${INDEX_VERSION}
        and status = 'ready'
    `);
    expect(result?.ready_count).toBe(1);
  });

  it("rejects a duplicate document fingerprint", async () => {
    await insertDocument({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
    });

    await expectDatabaseError(
      insertDocument({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewA,
        status: "failed",
      }),
      {
        code: "23505",
        constraintName: "visual_search_documents_fingerprint_unique",
      },
    );
  });

  it("rejects a document whose owner does not own its pattern", async () => {
    await expect(
      insertDocument({
        ownerId: ownerB,
        patternId: patternB,
        previewAssetId: previewB,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertDocument({
        ownerId: ownerA,
        patternId: patternB,
        previewAssetId: previewB,
      }),
      {
        code: "23503",
        constraintName: "visual_search_documents_owner_pattern_fk",
      },
    );
  });

  it("rejects a document whose preview belongs to another pattern", async () => {
    await expect(
      insertDocument({
        ownerId: ownerA,
        patternId: patternASibling,
        previewAssetId: previewASibling,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertDocument({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewASibling,
      }),
      {
        code: "23503",
        constraintName: "visual_search_documents_preview_fk",
      },
    );
  });

  it("rejects an embedding whose owner differs from its document", async () => {
    const documentId = await insertDocument({
      ownerId: ownerB,
      patternId: patternB,
      previewAssetId: previewB,
    });
    await expect(
      insertEmbedding({
        documentId,
        ownerId: ownerB,
        patternId: patternB,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertEmbedding({
        documentId,
        ownerId: ownerA,
        patternId: patternB,
        regionIndex: 1,
      }),
      {
        code: "23503",
        constraintName: "visual_search_embeddings_document_owner_fk",
      },
    );
  });

  it("rejects an embedding whose pattern differs from its document", async () => {
    const documentId = await insertDocument({
      ownerId: ownerA,
      patternId: patternASibling,
      previewAssetId: previewASibling,
    });
    await expect(
      insertEmbedding({
        documentId,
        ownerId: ownerA,
        patternId: patternASibling,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertEmbedding({
        documentId,
        ownerId: ownerA,
        patternId: patternA,
        regionIndex: 1,
      }),
      {
        code: "23503",
        constraintName: "visual_search_embeddings_document_owner_fk",
      },
    );
  });

  it("rejects a job whose owner does not own its pattern", async () => {
    await expect(
      insertJob({
        ownerId: ownerB,
        patternId: patternB,
        previewAssetId: previewB,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertJob({
        ownerId: ownerA,
        patternId: patternB,
        previewAssetId: previewB,
      }),
      {
        code: "23503",
        constraintName: "visual_search_jobs_owner_pattern_fk",
      },
    );
  });

  it("rejects a job whose preview belongs to another pattern", async () => {
    await expect(
      insertJob({
        ownerId: ownerA,
        patternId: patternASibling,
        previewAssetId: previewASibling,
      }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertJob({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewASibling,
      }),
      {
        code: "23503",
        constraintName: "visual_search_jobs_preview_fk",
      },
    );
  });

  it("enforces exactly 384 embedding dimensions", async () => {
    const documentId = await insertDocument({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
    });

    await expect(
      insertEmbedding({ documentId, ownerId: ownerA, patternId: patternA }),
    ).resolves.toBeDefined();

    await expectDatabaseError(
      insertEmbedding({
        documentId,
        ownerId: ownerA,
        patternId: patternA,
        dimensions: 383,
        regionIndex: 1,
      }),
      { code: "22000", message: /expected 384 dimensions/i },
    );
  });

  it("cascades preview deletion into documents, embeddings, and jobs", async () => {
    const documentId = await insertDocument({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
    });
    await insertEmbedding({
      documentId,
      ownerId: ownerA,
      patternId: patternA,
    });
    await insertJob({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
    });

    await db.execute(sql`
      delete from assets
      where owner_id = ${ownerA} and id = ${previewA}
    `);

    const [counts] = await db.execute<{
      document_count: number;
      embedding_count: number;
      job_count: number;
    }>(sql`
      select
        (select count(*)::int from visual_search_documents) as document_count,
        (select count(*)::int from visual_search_embeddings) as embedding_count,
        (select count(*)::int from visual_search_jobs) as job_count
    `);
    expect(counts).toEqual({
      document_count: 0,
      embedding_count: 0,
      job_count: 0,
    });
  });

  it("keeps job identity idempotent while preview hash is unknown", async () => {
    await insertJob({
      ownerId: ownerA,
      patternId: patternA,
      previewAssetId: previewA,
      previewHash: null,
    });

    await expectDatabaseError(
      insertJob({
        ownerId: ownerA,
        patternId: patternA,
        previewAssetId: previewA,
        previewHash: null,
      }),
      {
        code: "23505",
        constraintName: "visual_search_jobs_identity_unique",
      },
    );
  });
});

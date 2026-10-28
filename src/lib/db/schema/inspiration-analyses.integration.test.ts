import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const completedAt = new Date("2026-10-28T00:00:00.000Z");
const completedState = {
  status: "completed" as const,
  sources: [],
  result: { headline: "都市轻通勤" },
  completedAt,
};

type AnalysisInsert = typeof inspirationAnalyses.$inferInsert;

const expectConstraint = (operation: PromiseLike<unknown>, name: string, code = "23514") =>
  expect(operation).rejects.toMatchObject({
    cause: expect.objectContaining({ code, constraint_name: name }),
  });

describe("inspiration analyses schema", () => {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();

  const insertAnalysis = (overrides: Partial<AnalysisInsert> = {}) =>
    db.insert(inspirationAnalyses).values({
      id: randomUUID(),
      ownerId,
      operationId: randomUUID(),
      prompt: "分析都市轻通勤女装",
      title: "分析都市轻通勤女装",
      status: "pending",
      searchModel: "qwen-plus",
      structureModel: "qwen3.8-flash",
      ...overrides,
    });

  beforeEach(async () => {
    await resetDatabase();
    await db.insert(users).values([
      {
        id: ownerId,
        email: "inspiration-schema@example.test",
        displayName: "Designer",
        passwordHash: "hash",
        mustChangePassword: false,
      },
      {
        id: otherOwnerId,
        email: "inspiration-other@example.test",
        displayName: "Other designer",
        passwordHash: "hash",
        mustChangePassword: false,
      },
    ]);
  });

  afterAll(closeDatabase);

  it("allows only one pending analysis per owner", async () => {
    await insertAnalysis();
    await expectConstraint(
      insertAnalysis(),
      "inspiration_analyses_owner_pending_unique",
      "23505",
    );
  });

  it("allows different owners to hold pending rows with the same operation ID", async () => {
    const operationId = randomUUID();
    await insertAnalysis({ operationId });
    const [other] = await insertAnalysis({ operationId, ownerId: otherOwnerId }).returning();
    expect(other).toMatchObject({ ownerId: otherOwnerId, operationId, status: "pending" });
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(2);
  });

  it("keeps operations unique for an owner even after completion", async () => {
    const operationId = randomUUID();
    await insertAnalysis({ ...completedState, operationId });
    await expectConstraint(
      insertAnalysis({ operationId }),
      "inspiration_analyses_owner_operation_unique",
      "23505",
    );
  });

  it("releases the pending slot when an analysis completes", async () => {
    const [pending] = await insertAnalysis().returning();
    assert(pending);
    await db
      .update(inspirationAnalyses)
      .set(completedState)
      .where(eq(inspirationAnalyses.id, pending.id));
    const [next] = await insertAnalysis().returning();
    expect(next?.status).toBe("pending");
  });

  it.each([
    { label: "a result", fields: { result: {} } },
    { label: "a completion timestamp", fields: { completedAt } },
    { label: "an error", fields: { errorCode: "INSPIRATION_INTERRUPTED" } },
  ])("rejects pending state with $label", async ({ fields }) => {
    await expectConstraint(insertAnalysis(fields), "inspiration_analyses_state_check");
  });

  it("allows pending state to retain source snapshots", async () => {
    const [row] = await insertAnalysis({ sources: [] }).returning();
    expect(row).toMatchObject({ status: "pending", sources: [], result: null, completedAt: null, errorCode: null });
  });

  it.each([
    { label: "sources", fields: { sources: null } },
    { label: "a result", fields: { result: null } },
    { label: "a completion timestamp", fields: { completedAt: null } },
    { label: "all required snapshots and timestamp", fields: { sources: null, result: null, completedAt: null } },
  ])("rejects completed state without $label", async ({ fields }) => {
    await expectConstraint(insertAnalysis({ ...completedState, ...fields }), "inspiration_analyses_state_check");
  });

  it("rejects completed state with an error", async () => {
    await expectConstraint(insertAnalysis({ ...completedState, errorCode: "INSPIRATION_INTERRUPTED" }), "inspiration_analyses_state_check");
  });

  it("persists completed JSON snapshots and private provider request IDs", async () => {
    const [row] = await insertAnalysis({
      ...completedState,
      searchRequestId: "search-private-id",
      structureRequestId: "structure-private-id",
    }).returning();
    expect(row).toMatchObject({
      ...completedState,
      errorCode: null,
      searchRequestId: "search-private-id",
      structureRequestId: "structure-private-id",
    });
  });

  it("rejects failed state without an error code", async () => {
    await expectConstraint(insertAnalysis({ status: "failed" }), "inspiration_analyses_state_check");
  });

  it("rejects failed state with a result", async () => {
    await expectConstraint(insertAnalysis({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED", result: {} }), "inspiration_analyses_state_check");
  });

  it.each([
    { label: "no snapshots", fields: {} },
    { label: "sources", fields: { sources: [] } },
    { label: "a completion timestamp", fields: { completedAt } },
    { label: "sources and a completion timestamp", fields: { sources: [], completedAt } },
  ])("allows failed state with $label", async ({ fields }) => {
    const [row] = await insertAnalysis({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED", ...fields }).returning();
    expect(row).toMatchObject({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED", result: null, ...fields });
  });

  it.each([
    { status: "pending" as const },
    { status: "failed" as const, errorCode: "INSPIRATION_INTERRUPTED" },
  ])("rejects sharing a $status analysis", async (state) => {
    await expectConstraint(insertAnalysis({ ...state, shareId: randomUUID() }), "inspiration_analyses_share_state_check");
  });

  it("allows completed sharing and enforces globally unique share IDs", async () => {
    const shareId = randomUUID();
    const [row] = await insertAnalysis({ ...completedState, shareId }).returning();
    expect(row?.shareId).toBe(shareId);
    await expectConstraint(
      insertAnalysis({ ...completedState, ownerId: otherOwnerId, shareId }),
      "inspiration_analyses_share_id_unique",
      "23505",
    );
  });

  it.each([
    { label: "four-character prompt", fields: { prompt: "😀😀😀😀" }, constraint: "inspiration_analyses_prompt_length_check" },
    { label: "1001-character prompt", fields: { prompt: "😀".repeat(1001) }, constraint: "inspiration_analyses_prompt_length_check" },
    { label: "empty title", fields: { title: "" }, constraint: "inspiration_analyses_title_length_check" },
    { label: "121-character title", fields: { title: "😀".repeat(121) }, constraint: "inspiration_analyses_title_length_check" },
  ])("rejects $label", async ({ fields, constraint }) => {
    await expectConstraint(insertAnalysis(fields), constraint);
  });

  it.each([
    { label: "minimum", prompt: "😀😀😀😀😀", title: "😀" },
    { label: "maximum", prompt: "😀".repeat(1000), title: "😀".repeat(120) },
  ])("accepts $label Unicode character lengths", async ({ prompt, title }) => {
    const [row] = await insertAnalysis({ prompt, title }).returning();
    expect(row).toMatchObject({ prompt, title });
  });

  it("applies snapshot version, optimistic version, and timestamp defaults", async () => {
    const [row] = await insertAnalysis().returning();
    expect(row).toMatchObject({ schemaVersion: "inspiration-analysis-v1", version: 0, shareId: null });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects analyses without an existing owner", async () => {
    await expectConstraint(insertAnalysis({ ownerId: randomUUID() }), "inspiration_analyses_owner_id_users_id_fk", "23503");
  });

  it("cascades owner deletion while preserving another owner's analyses", async () => {
    await insertAnalysis();
    const [other] = await insertAnalysis({ ownerId: otherOwnerId }).returning();
    await db.delete(users).where(eq(users.id, ownerId));
    expect(await db.select().from(inspirationAnalyses)).toEqual([other]);
  });
});

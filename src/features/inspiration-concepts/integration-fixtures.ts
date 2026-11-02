/** PostgreSQL fixtures shared by report lifecycle integration tests. */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { inspirationConceptSets as sets, inspirationConceptTasks as tasks, inspirationConceptOutputs as outputs } from "@/lib/db/schema/inspiration-concepts";
import { conceptBriefFixture } from "./test-fixtures";
import { conceptOutputObjectKey } from "./object-keys";
import type { ConceptOutputKind } from "./contracts";

export async function seedReportConcept(input: {
  ownerId: string; analysisId: string; directionIndex?: number; version?: number; deleted?: boolean;
  kinds?: ConceptOutputKind[];
}) {
  const { ownerId, analysisId, directionIndex = 0, version = 1, kinds = ["sketch", "effect"] } = input;
  const setId = randomUUID();
  const now = new Date();
  await db.insert(sets).values({
    id: setId, ownerId, analysisId, operationId: randomUUID(), directionIndex, version,
    status: input.deleted ? "deleting" : "partial", deletedAt: input.deleted ? now : null,
    completedAt: now, briefSnapshot: { ...conceptBriefFixture, directionIndex },
    model: conceptBriefFixture.model, promptTemplateVersion: conceptBriefFixture.promptTemplateVersion,
  });
  const assets = [];
  for (const outputKind of kinds) {
    const taskId = randomUUID(), id = randomUUID();
    await db.insert(tasks).values({ id: taskId, ownerId, setId, operationId: randomUUID(), outputKind,
      attempt: 1, status: "completed", availableAt: now, completedAt: now, submitStartedAt: now,
      providerTaskId: "secret-provider-task", providerRequestId: "secret-provider-request" });
    const objectKey = conceptOutputObjectKey({ ownerId, analysisId, setId, outputId: id, outputKind });
    await db.insert(outputs).values({ id, ownerId, analysisId, setId, sourceTaskId: taskId, outputKind,
      title: "Concept", altText: "Completed concept", objectKey, contentType: "image/png",
      width: outputKind === "flat" ? 2048 : 1536, height: outputKind === "flat" ? 1536 : 2048 });
    assets.push({ id, objectKey });
  }
  await db.insert(tasks).values({ id: randomUUID(), ownerId, setId, operationId: randomUUID(), outputKind: "flat",
    attempt: 2, status: "failed", availableAt: now, completedAt: now, errorCode: "INSPIRATION_CONCEPT_TIMEOUT" });
  return { setId, assets };
}

/** Observe real PostgreSQL blocking instead of relying on elapsed time alone. */
export async function waitForDatabaseBlocker(holderPid: number, event?: string) {
  const { sql } = await import("drizzle-orm");
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute(sql`select wait_event from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`);
    if (rows.some((row) => !event || row.wait_event === event)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

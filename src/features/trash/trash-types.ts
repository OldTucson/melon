import { z } from "zod";

const uuid = z.uuid();
const count = z.number().int().nonnegative();
const date = z.string().datetime();
const state = z.enum(["trashed", "deleting"]);
const batchFields = {
  trashBatchId: uuid,
  state,
  lastErrorCode: z.string().nullable(),
  purgeOperationId: uuid.nullable(),
  trashedAt: date,
  expiresAt: date,
};
export const trashPatternSchema = z
  .object({
    id: uuid,
    name: z.string(),
    originalFilename: z.string(),
    extension: z.string(),
    sizeBytes: z.string().regex(/^(0|[1-9]\d*)$/),
    folderId: uuid.nullable(),
    status: state,
    previewStatus: z.enum([
      "pending",
      "ready",
      "unsupported",
      "failed",
      "manual",
    ]),
    previewAssetId: uuid.nullable(),
    thumbnailAssetId: uuid.nullable(),
    version: count,
    lastErrorCode: z.string().nullable(),
    trashedAt: date,
  })
  .strict();
const folderBatchSchema = z
  .object({
    ...batchFields,
    rootFolderId: uuid,
    rootFolderName: z.string(),
    folderCount: z.number().int().positive(),
    patternCount: count,
  })
  .strict();
const patternBatchSchema = z
  .object({ ...batchFields, patterns: z.array(trashPatternSchema).min(1) })
  .strict();
export const trashListSchema = z
  .object({
    folderBatches: z.array(folderBatchSchema),
    patternBatches: z.array(patternBatchSchema),
  })
  .strict()
  .superRefine((data, ctx) => {
    const batches = [...data.folderBatches, ...data.patternBatches];
    const ids = batches.map((batch) => batch.trashBatchId);
    const patterns = data.patternBatches.flatMap((batch) => batch.patterns);
    if (
      new Set(ids).size !== ids.length ||
      new Set(patterns.map((p) => p.id)).size !== patterns.length
    )
      ctx.addIssue({ code: "custom", message: "重复的回收站项目" });
    for (const batch of batches) {
      if ((batch.state === "deleting") !== Boolean(batch.purgeOperationId))
        ctx.addIssue({ code: "custom", message: "删除操作状态无效" });
    }
    for (const batch of data.patternBatches)
      if (
        (batch.state === "deleting") !==
        batch.patterns.some((pattern) => pattern.status === "deleting")
      )
        ctx.addIssue({ code: "custom", message: "图案批次状态无效" });
  });
export const restoredPatternsSchema = z
  .object({
    state: z.literal("restored"),
    patterns: z
      .array(
        z
          .object({
            id: uuid,
            status: z.enum([
              "draft",
              "hashing",
              "uploading",
              "processing",
              "ready",
              "failed",
            ]),
            folderId: uuid.nullable(),
            version: count,
            changeSeq: z.string().regex(/^(0|[1-9]\d*)$/),
            updatedAt: date,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const restoredFolderSchema = z
  .object({
    state: z.literal("restored"),
    trashBatchId: uuid,
    rootFolderId: uuid,
    folderCount: z.number().int().positive(),
    patternCount: count,
  })
  .strict();
export const purgeResultSchema = z
  .object({
    state: z.literal("complete"),
    deletedPatternCount: count,
    deletedFolderCount: count,
  })
  .strict();
export type TrashList = z.infer<typeof trashListSchema>;
export type TrashFolderBatch = TrashList["folderBatches"][number];
export type TrashPatternBatch = TrashList["patternBatches"][number];

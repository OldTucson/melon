"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

export const folderDtoSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    parentId: z.uuid().nullable(),
    name: z.string().min(1).max(80),
    normalizedName: z.string(),
    status: z.enum(["active", "trashed", "deleting", "deleted"]),
    version: z.number().int().nonnegative(),
    trashBatchId: z.uuid().nullable(),
    trashedAt: z.string().datetime().nullable(),
    deletedAt: z.string().datetime().nullable(),
    changeSeq: z.string().regex(/^(0|[1-9]\d*)$/),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    directPatternCount: z.number().int().nonnegative(),
    recursivePatternCount: z.number().int().nonnegative(),
  })
  .strict();
export type FolderDto = z.infer<typeof folderDtoSchema>;
/** Local-only cache state; never accepted by the strict API DTO schema. */
export type FolderCacheItem = FolderDto & { optimisticCreate?: true };

/** WorkspaceShell owns fetching; every consumer observes this same cache. */
export function useFoldersQuery(load = false) {
  const ownerId = useQueryOwnerId();
  return useQuery<FolderCacheItem[]>({
    queryKey: queryKeys.folders(ownerId),
    enabled: load,
    queryFn: async () => {
      const data = z
        .array(folderDtoSchema)
        .parse(await readApiResponse(await fetch("/api/folders")));
      if (
        data.some(
          (folder) => folder.ownerId !== ownerId || folder.status !== "active",
        )
      )
        throw new Error("文件夹响应无效");
      return data;
    },
  });
}

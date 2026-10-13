"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";
import {
  type FolderDeleteImpact,
  folderDeleteImpactSchema,
  parseFolderName,
} from "./contracts";
import { folderDtoSchema, type FolderCacheItem } from "./folder-client";
import { folderSubtree } from "./folder-tree-model";

const retry = (count: number, error: Error) =>
  count < 1 &&
  (error instanceof TypeError ||
    (error instanceof ApiResponseError && error.status >= 500));
const trashSchema = z
  .object({
    state: z.literal("trashed"),
    trashBatchId: z.uuid(),
    rootFolderId: z.uuid(),
    folderCount: z.number().int().positive(),
    patternCount: z.number().int().nonnegative(),
  })
  .strict();
export type { FolderDeleteImpact } from "./contracts";
export async function loadDeleteImpact(id: string) {
  return folderDeleteImpactSchema.parse(
    await readApiResponse(
      await fetch(`/api/folders/${encodeURIComponent(id)}/delete-impact`),
    ),
  );
}
export function folderErrorMessage(error: unknown) {
  if (error instanceof ApiResponseError) {
    if (error.code === "FOLDER_NAME_CONFLICT")
      return "同名文件夹已存在，请修改名称";
    if (error.code === "TRASH_PURGE_IN_PROGRESS")
      return "正在永久删除相关内容，请稍后重试";
    if (
      [
        "FOLDER_STATE_CHANGED",
        "FOLDER_NOT_ACTIVE",
        "FOLDER_NOT_FOUND",
      ].includes(error.code)
    )
      return "文件夹状态已变化，请刷新后重试";
    if (error.code === "OPERATION_ID_REUSED")
      return "操作标识已使用，请重新提交";
  }
  return "文件夹操作未完成，请稍后重试";
}
async function request(url: string, method: string, body: unknown) {
  return readApiResponse(
    await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
function validateActive(value: unknown, ownerId: string, name: string) {
  const folder = folderDtoSchema.parse(value);
  const normalized = parseFolderName(name);
  if (
    folder.ownerId !== ownerId ||
    folder.status !== "active" ||
    folder.trashBatchId !== null ||
    folder.trashedAt !== null ||
    folder.deletedAt !== null ||
    folder.name !== normalized.name ||
    folder.normalizedName !== normalized.normalizedName ||
    folder.recursivePatternCount < folder.directPatternCount
  )
    throw new Error("文件夹响应无效");
  return folder;
}

export function useCreateFolderMutation() {
  const client = useQueryClient(),
    ownerId = useQueryOwnerId(),
    key = queryKeys.folders(ownerId);
  return useMutation({
    retry,
    mutationFn: async (variables: {
      operationId: string;
      input: { name: string; parentId: string | null };
    }) => {
      const dto = validateActive(
        await request("/api/folders", "POST", variables),
        ownerId,
        variables.input.name,
      );
      if (dto.parentId !== variables.input.parentId || dto.version !== 0)
        throw new Error("文件夹响应无效");
      return dto;
    },
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      const snapshot = client.getQueryData<FolderCacheItem[]>(key);
      const timestamp = new Date().toISOString();
      const optimistic: FolderCacheItem = {
        optimisticCreate: true,
        id: variables.operationId,
        ownerId,
        parentId: variables.input.parentId,
        ...parseFolderName(variables.input.name),
        status: "active",
        version: 0,
        trashBatchId: null,
        trashedAt: null,
        deletedAt: null,
        changeSeq: "0",
        createdAt: timestamp,
        updatedAt: timestamp,
        directPatternCount: 0,
        recursivePatternCount: 0,
      };
      client.setQueryData<FolderCacheItem[]>(key, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { snapshot, optimistic };
    },
    onError: (_error, _variables, context) => {
      if (context)
        client.setQueryData<FolderCacheItem[]>(key, (old) =>
          old?.filter(
            (folder) =>
              folder.id !== context.optimistic.id ||
              JSON.stringify(folder) !== JSON.stringify(context.optimistic),
          ),
        );
    },
    onSuccess: (dto, variables) => {
      client.setQueryData<FolderCacheItem[]>(key, (old) => {
        const items = (old ?? []).filter(
          (folder) => folder.id !== variables.operationId,
        );
        const existing = items.find((folder) => folder.id === dto.id);
        return existing
          ? items.map((folder) =>
              folder.id === dto.id && folder.version <= dto.version
                ? dto
                : folder,
            )
          : [...items, dto];
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
}

export function useRenameFolderMutation() {
  const client = useQueryClient(),
    ownerId = useQueryOwnerId(),
    key = queryKeys.folders(ownerId);
  return useMutation({
    retry,
    mutationFn: async ({
      id,
      operationId,
      patch,
    }: {
      id: string;
      operationId: string;
      patch: { name: string; version: number };
    }) => {
      const dto = validateActive(
        await request(`/api/folders/${encodeURIComponent(id)}`, "PATCH", {
          operationId,
          patch,
        }),
        ownerId,
        patch.name,
      );
      if (dto.id !== id || dto.version !== patch.version + 1)
        throw new Error("文件夹响应无效");
      return dto;
    },
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      const snapshot = client.getQueryData<FolderCacheItem[]>(key);
      const before = snapshot?.find((folder) => folder.id === variables.id);
      const optimistic = {
        ...parseFolderName(variables.patch.name),
        version: variables.patch.version + 1,
      };
      client.setQueryData<FolderCacheItem[]>(key, (old) =>
        old?.map((folder) =>
          folder.id === variables.id &&
          folder.version === variables.patch.version
            ? { ...folder, ...optimistic }
            : folder,
        ),
      );
      return { snapshot, before, optimistic };
    },
    onError: (_error, variables, context) => {
      if (!context?.before) return;
      const { before, optimistic } = context;
      client.setQueryData<FolderCacheItem[]>(key, (old) =>
        old?.map((folder) =>
          folder.id === variables.id &&
          folder.version === optimistic.version &&
          folder.name === optimistic.name &&
          folder.normalizedName === optimistic.normalizedName
            ? {
                ...folder,
                name: before.name,
                normalizedName: before.normalizedName,
                version: before.version,
              }
            : folder,
        ),
      );
    },
    onSuccess: (dto) =>
      client.setQueryData<FolderCacheItem[]>(key, (old) =>
        old?.map((folder) =>
          folder.id === dto.id && folder.version <= dto.version ? dto : folder,
        ),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
}

export function useTrashFolderMutation() {
  const client = useQueryClient(),
    ownerId = useQueryOwnerId(),
    key = queryKeys.folders(ownerId);
  return useMutation({
    retry,
    mutationFn: async ({
      id,
      operationId,
      version,
      expectedImpact,
    }: {
      id: string;
      operationId: string;
      version: number;
      expectedImpact: FolderDeleteImpact;
    }) => {
      const result = trashSchema.parse(
        await request(`/api/folders/${encodeURIComponent(id)}`, "DELETE", {
          operationId,
          version,
          expectedImpact,
        }),
      );
      if (result.rootFolderId !== id || result.trashBatchId !== operationId)
        throw new Error("文件夹响应无效");
      return result;
    },
    onSuccess: (_result, variables) =>
      client.setQueryData<FolderCacheItem[]>(key, (old) => {
        if (!old) return old;
        const removed = folderSubtree(old, variables.id);
        return old.filter((folder) => !removed.has(folder.id));
      }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key, exact: true }),
        client.invalidateQueries({ queryKey: ["owner", ownerId, "patterns"] }),
        client.invalidateQueries({ queryKey: ["owner", ownerId, "pattern"] }),
        client.invalidateQueries({ queryKey: queryKeys.trash(ownerId) }),
      ]),
  });
}

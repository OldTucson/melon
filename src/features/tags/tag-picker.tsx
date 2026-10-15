"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { PatternQuery } from "@/features/patterns/contracts";
import {
  tagColorTokens,
  type TagColorToken,
} from "@/features/tags/contracts";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type {
  PatternTagItem,
  PatternTagPage,
  TagItem,
} from "../library/library-types";

type RelationIntent = {
  checked: boolean;
  operationId: string;
  tagId: string;
};

type CreateTagIntent = {
  associateOperationId: string;
  colorToken: TagColorToken;
  createOperationId: string;
  createdTag?: TagItem;
  name: string;
};

class TagAssociationError extends Error {
  readonly associationCause: unknown;
  readonly createdTag: TagItem;

  constructor(createdTag: TagItem, cause: unknown) {
    super("Tag was created but could not be associated", { cause });
    this.name = "TagAssociationError";
    this.associationCause = cause;
    this.createdTag = createdTag;
  }
}

const now = () => new Date().toISOString();

const tagColorNames: Record<TagColorToken, string> = {
  gray: "灰色",
  blue: "蓝色",
  green: "绿色",
  yellow: "黄色",
  red: "红色",
  purple: "紫色",
};

async function loadTags() {
  return readApiResponse<TagItem[]>(await fetch("/api/tags"));
}

async function loadPatternTags(patternId: string) {
  return readApiResponse<PatternTagPage>(
    await fetch(`/api/patterns/${patternId}/tags`),
  );
}

function relationErrorMessage(error: unknown) {
  if (
    error instanceof ApiResponseError &&
    error.code === "TAG_LIMIT_EXCEEDED"
  ) {
    return "每个图案最多可添加 20 个标签";
  }
  if (
    error instanceof ApiResponseError &&
    error.code === "TAG_NAME_CONFLICT"
  ) {
    return "已有同名标签";
  }
  return "标签未能保存，请重试";
}

export function TagPicker({
  activeQuery,
  disabled = false,
  patternId,
}: {
  activeQuery: PatternQuery;
  disabled?: boolean;
  patternId: string;
}) {
  const queryClient = useQueryClient();
  const ownerId = useQueryOwnerId();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColorToken>("gray");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] =
    useState<CreateTagIntent | null>(null);
  const [pendingAssociation, setPendingAssociation] =
    useState<CreateTagIntent | null>(null);
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags(ownerId),
    queryFn: loadTags,
  });
  const relationsKey = queryKeys.patternTags(ownerId, patternId);
  const relationsQuery = useQuery({
    queryKey: relationsKey,
    queryFn: () => loadPatternTags(patternId),
  });
  const listKey = queryKeys.patterns(ownerId, activeQuery);
  const canWrite =
    !disabled && tagsQuery.isSuccess && relationsQuery.isSuccess;

  const relationMutation = useMutation({
    mutationFn: async (intent: RelationIntent) => {
      const response = await fetch(
        `/api/patterns/${patternId}/tags/${intent.tagId}`,
        {
          method: intent.checked ? "PUT" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: intent.operationId }),
        },
      );
      return readApiResponse<PatternTagItem>(response);
    },
    onMutate: async (intent: RelationIntent) => {
      setErrorMessage(null);
      await queryClient.cancelQueries({ queryKey: relationsKey, exact: true });
      const previous = queryClient.getQueryData<PatternTagPage>(relationsKey);
      queryClient.setQueryData<PatternTagPage>(relationsKey, (value) => {
        const existing = value ?? { items: [] };
        if (!intent.checked) {
          return {
            items: existing.items.filter((item) => item.tagId !== intent.tagId),
          };
        }
        if (existing.items.some((item) => item.tagId === intent.tagId)) {
          return existing;
        }
        const timestamp = now();
        return {
          items: [
            ...existing.items,
            {
              ownerId: "",
              patternId,
              tagId: intent.tagId,
              isActive: true,
              version: 0,
              changeSeq: "0",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        };
      });
      return { previous };
    },
    onError: (error, _intent, context) => {
      queryClient.setQueryData(relationsKey, context?.previous);
      setErrorMessage(relationErrorMessage(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: relationsKey, exact: true });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pattern(ownerId, patternId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    },
    retry: 0,
  });

  const createMutation = useMutation({
    mutationFn: async (intent: CreateTagIntent) => {
      const created =
        intent.createdTag ??
        (await readApiResponse<TagItem>(
          await fetch("/api/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId: intent.createOperationId,
              input: {
                name: intent.name,
                colorToken: intent.colorToken,
              },
            }),
          }),
        ));
      try {
        await readApiResponse<PatternTagItem>(
          await fetch(`/api/patterns/${patternId}/tags/${created.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operationId: intent.associateOperationId }),
          }),
        );
      } catch (error) {
        throw new TagAssociationError(created, error);
      }
      return created;
    },
    onMutate: () => setErrorMessage(null),
    onSuccess: (created) => {
      setPendingCreate(null);
      setPendingAssociation(null);
      queryClient.setQueryData<TagItem[]>(queryKeys.tags(ownerId), (value) =>
        value?.some((tag) => tag.id === created.id)
          ? value
          : [...(value ?? []), created],
      );
      const timestamp = now();
      queryClient.setQueryData<PatternTagPage>(relationsKey, (value) =>
        value?.items.some((item) => item.tagId === created.id)
          ? value
          : {
              items: [
                ...(value?.items ?? []),
                {
                  ownerId: created.ownerId,
                  patternId,
                  tagId: created.id,
                  isActive: true,
                  version: 0,
                  changeSeq: created.changeSeq,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
            },
      );
      setNewName("");
      setShowCreate(false);
    },
    onError: (error, intent) => {
      if (error instanceof TagAssociationError) {
        queryClient.setQueryData<TagItem[]>(queryKeys.tags(ownerId), (value) =>
          value?.some((tag) => tag.id === error.createdTag.id)
            ? value
            : [...(value ?? []), error.createdTag],
        );
        if (
          error.associationCause instanceof ApiResponseError &&
          error.associationCause.status >= 400 &&
          error.associationCause.status < 500
        ) {
          setPendingAssociation(null);
          setErrorMessage(relationErrorMessage(error.associationCause));
          return;
        }
        const retryIntent = { ...intent, createdTag: error.createdTag };
        setPendingAssociation(retryIntent);
        setErrorMessage("标签已创建，但尚未添加到图案");
        return;
      }
      if (
        !(error instanceof ApiResponseError) ||
        error.status >= 500
      ) {
        setPendingCreate(intent);
        setErrorMessage("标签创建结果未知，请重试");
        return;
      }
      setPendingCreate(null);
      setErrorMessage(relationErrorMessage(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tags(ownerId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: relationsKey, exact: true });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pattern(ownerId, patternId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    },
    retry: 0,
  });

  const activeIds = useMemo(
    () => new Set(relationsQuery.data?.items.map((item) => item.tagId) ?? []),
    [relationsQuery.data],
  );
  const visibleTags = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
    if (!normalizedSearch) return tagsQuery.data ?? [];
    return (tagsQuery.data ?? []).filter((tag) =>
      tag.name.toLocaleLowerCase("zh-CN").includes(normalizedSearch),
    );
  }, [search, tagsQuery.data]);

  const createTag = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) {
      setErrorMessage("标签数据无法载入，修改已禁用");
      return;
    }
    const name = newName.trim();
    if (!name) {
      setErrorMessage("请输入标签名称");
      return;
    }
    createMutation.mutate({
      associateOperationId: crypto.randomUUID(),
      colorToken: newColor,
      createOperationId: crypto.randomUUID(),
      name,
    });
  };

  return (
    <section className="tag-picker" aria-labelledby="pattern-tags-title">
      <div className="inspector-section-heading">
        <h3 id="pattern-tags-title">标签</h3>
        <button
          className="text-icon-button"
          type="button"
          aria-label={showCreate ? "取消创建标签" : "创建标签"}
          disabled={!canWrite}
          onClick={() => setShowCreate((value) => !value)}
        >
          {showCreate ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
          <span>{showCreate ? "取消" : "创建标签"}</span>
        </button>
      </div>

      {showCreate ? (
        <form className="tag-create-form" onSubmit={createTag}>
          <label className="tag-create-name">
            <span>标签名称</span>
            <input
              aria-label="标签名称"
              disabled={!canWrite}
              maxLength={32}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <fieldset className="tag-color-field">
            <legend>标签颜色</legend>
            <div className="tag-color-options" role="radiogroup" aria-label="标签颜色">
              {tagColorTokens.map((token) => (
                <label
                  className="tag-color-option"
                  data-selected={newColor === token ? "true" : "false"}
                  key={token}
                  title={tagColorNames[token]}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="tag-color"
                    value={token}
                    aria-label={tagColorNames[token]}
                    checked={newColor === token}
                    disabled={!canWrite}
                    onChange={() => setNewColor(token)}
                  />
                  <span
                    className="tag-swatch"
                    data-color-token={token}
                    aria-hidden="true"
                  />
                  <span className="sr-only">{tagColorNames[token]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className="secondary-button"
            type="submit"
            disabled={
              !canWrite ||
              createMutation.isPending ||
              pendingCreate !== null ||
              pendingAssociation !== null
            }
          >
            保存并添加标签
          </button>
        </form>
      ) : null}

      {pendingAssociation ? (
        <button
          className="secondary-button tag-association-retry"
          type="button"
          disabled={!canWrite || createMutation.isPending}
          onClick={() => createMutation.mutate(pendingAssociation)}
        >
          重试添加标签
        </button>
      ) : null}

      {pendingCreate ? (
        <button
          className="secondary-button tag-association-retry"
          type="button"
          disabled={createMutation.isPending || !canWrite}
          onClick={() => createMutation.mutate(pendingCreate)}
        >
          重试创建标签
        </button>
      ) : null}

      <label className="tag-search-field">
        <span className="sr-only">搜索标签</span>
        <input
          type="search"
          aria-label="搜索标签"
          placeholder="搜索标签"
          value={search}
          disabled={!canWrite}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      {tagsQuery.isPending || relationsQuery.isPending ? (
        <p className="muted-copy">正在读取标签...</p>
      ) : tagsQuery.isError || relationsQuery.isError ? (
        <div className="tag-load-error" role="alert">
          <p>标签数据无法载入，修改已禁用</p>
          <button
            className="secondary-button"
            type="button"
            disabled={tagsQuery.isFetching || relationsQuery.isFetching}
            onClick={() => {
              void Promise.all([tagsQuery.refetch(), relationsQuery.refetch()]);
            }}
          >
            重试读取标签
          </button>
        </div>
      ) : (
        <div className="tag-checkbox-list">
          {visibleTags.map((tag) => (
            <label className="tag-checkbox" key={tag.id}>
              <input
                type="checkbox"
                aria-label={tag.name}
                checked={activeIds.has(tag.id)}
                disabled={!canWrite || relationMutation.isPending}
                onChange={(event) =>
                  relationMutation.mutate({
                    checked: event.target.checked,
                    operationId: crypto.randomUUID(),
                    tagId: tag.id,
                  })
                }
              />
              <span
                className="tag-swatch"
                data-color-token={tag.colorToken}
                aria-hidden="true"
              />
              <span className="tag-name">{tag.name}</span>
            </label>
          ))}
          {visibleTags.length === 0 ? (
            <p className="muted-copy">没有匹配的标签</p>
          ) : null}
        </div>
      )}

      {errorMessage ? <p role="alert">{errorMessage}</p> : null}
    </section>
  );
}

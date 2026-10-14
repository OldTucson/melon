"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Grid2X2,
  Heart,
  List,
  PanelRightOpen,
  RotateCcw,
  Tags,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  commercialStates,
  patternFormats,
  patternSorts,
  type PatternQuery,
} from "@/features/patterns/contracts";
import {
  fetchAuthorizationFields,
  type AuthorizationFieldDto,
} from "@/features/authorizations/api";
import { authorizationKeys } from "@/features/authorizations/query-keys";
import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import { IconButton } from "./icon-button";
import type { TagItem } from "./library-types";

const sortLabels: Record<(typeof patternSorts)[number], string> = {
  updated_desc: "最近更新",
  created_desc: "最近创建",
  name_asc: "名称 A-Z",
  size_desc: "文件最大",
};

const commercialStateLabels: Record<
  (typeof commercialStates)[number],
  string
> = {
  unlicensed: "未授权",
  standard: "普通授权",
  field_exclusive: "领域独占",
  global_buyout: "全局买断",
};

export type LibraryViewMode = "grid" | "list";

async function loadTags() {
  return readApiResponse<TagItem[]>(await fetch("/api/tags"));
}

export function LibraryToolbar({
  inspectorHidden,
  onQueryChange,
  onShowInspector,
  onViewModeChange,
  query,
  resultCount,
  selectedCount,
  viewMode,
}: {
  inspectorHidden: boolean;
  onQueryChange: (query: PatternQuery) => void;
  onShowInspector: () => void;
  onViewModeChange: (mode: LibraryViewMode) => void;
  query: PatternQuery;
  resultCount: number;
  selectedCount: number;
  viewMode: LibraryViewMode;
}) {
  const ownerId = useQueryOwnerId();
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags(ownerId),
    queryFn: loadTags,
  });
  const fieldsQuery = useQuery<AuthorizationFieldDto[]>({
    queryKey: authorizationKeys.fields(ownerId, true),
    queryFn: () => fetchAuthorizationFields(true),
  });
  const [pendingQuery, setPendingQuery] = useState(query);
  const pendingQueryRef = useRef(query);

  const patchQuery = (
    patch:
      | Partial<PatternQuery>
      | ((current: PatternQuery) => Partial<PatternQuery>),
  ) => {
    const current = pendingQueryRef.current;
    const next = {
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
      cursor: undefined,
    };
    pendingQueryRef.current = next;
    setPendingQuery(next);
    onQueryChange(next);
  };
  const toggleTag = (tagId: string) => {
    const current = pendingQueryRef.current.tagIds;
    const tagIds = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    patchQuery({ tagIds });
  };

  return (
    <div className="library-toolbar" aria-label="图库工具栏">
      <div className="toolbar-filters">
        <label className="compact-field">
          <span>格式</span>
          <select
            aria-label="按格式筛选"
            value={pendingQuery.formats[0] ?? ""}
            onChange={(event) =>
              patchQuery({
                formats: event.target.value
                  ? [event.target.value as PatternQuery["formats"][number]]
                  : [],
              })
            }
          >
            <option value="">全部</option>
            {patternFormats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <button
          className="toolbar-toggle"
          type="button"
          aria-pressed={pendingQuery.favorite === true}
          onClick={() =>
            patchQuery((current) => ({
              favorite: current.favorite === true ? undefined : true,
            }))
          }
        >
          <Heart aria-hidden="true" />
          收藏
        </button>
        <label className="compact-field">
          <span>授权</span>
          <select
            aria-label="按商业状态筛选"
            value={pendingQuery.commercialState ?? ""}
            onChange={(event) =>
              patchQuery({
                commercialState: event.target.value
                  ? (event.target.value as PatternQuery["commercialState"])
                  : undefined,
              })
            }
          >
            <option value="">全部状态</option>
            {commercialStates.map((state) => (
              <option key={state} value={state}>
                {commercialStateLabels[state]}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-field">
          <span>领域</span>
          <select
            aria-label="按授权领域筛选"
            disabled={fieldsQuery.isPending || fieldsQuery.isError}
            value={pendingQuery.authorizationField ?? ""}
            onChange={(event) =>
              patchQuery({
                authorizationField: event.target.value || undefined,
              })
            }
          >
            <option value="">
              {fieldsQuery.isPending
                ? "读取领域中"
                : fieldsQuery.isError
                  ? "领域不可用"
                  : "全部领域"}
            </option>
            {fieldsQuery.data?.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
                {field.status === "archived" ? "（已归档）" : ""}
              </option>
            ))}
          </select>
        </label>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="toolbar-toggle"
              type="button"
              aria-label="筛选标签"
              aria-pressed={pendingQuery.tagIds.length > 0}
            >
              <Tags aria-hidden="true" />
              标签{pendingQuery.tagIds.length > 0 ? ` ${pendingQuery.tagIds.length}` : ""}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="filter-menu-content"
              sideOffset={6}
            >
              <DropdownMenu.Label className="filter-menu-label">
                按标签筛选
              </DropdownMenu.Label>
              {tagsQuery.isPending ? (
                <DropdownMenu.Item className="filter-menu-message" disabled>
                  正在读取标签...
                </DropdownMenu.Item>
              ) : tagsQuery.isError ? (
                <DropdownMenu.Item className="filter-menu-message" disabled>
                  标签暂时无法载入
                </DropdownMenu.Item>
              ) : tagsQuery.data.length === 0 ? (
                <DropdownMenu.Item className="filter-menu-message" disabled>
                  还没有标签
                </DropdownMenu.Item>
              ) : (
                tagsQuery.data.map((tag) => (
                  <DropdownMenu.CheckboxItem
                    checked={pendingQuery.tagIds.includes(tag.id)}
                    className="filter-menu-item"
                    key={tag.id}
                    onCheckedChange={() => toggleTag(tag.id)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="filter-menu-check" aria-hidden="true">
                      <DropdownMenu.ItemIndicator>
                        <Check />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    <span
                      className="tag-swatch"
                      data-color-token={tag.colorToken}
                      aria-hidden="true"
                    />
                    <span>{tag.name}</span>
                  </DropdownMenu.CheckboxItem>
                ))
              )}
              {pendingQuery.tagIds.length > 1 ? (
                <>
                  <DropdownMenu.Separator className="filter-menu-separator" />
                  <DropdownMenu.Label className="filter-menu-label">
                    多标签匹配
                  </DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={pendingQuery.tagMode}
                    onValueChange={(tagMode) =>
                      patchQuery({ tagMode: tagMode as PatternQuery["tagMode"] })
                    }
                  >
                    <DropdownMenu.RadioItem
                      className="filter-menu-item filter-menu-radio"
                      value="all"
                    >
                      <DropdownMenu.ItemIndicator>
                        <Check aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                      全部匹配
                    </DropdownMenu.RadioItem>
                    <DropdownMenu.RadioItem
                      className="filter-menu-item filter-menu-radio"
                      value="any"
                    >
                      <DropdownMenu.ItemIndicator>
                        <Check aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                      任一匹配
                    </DropdownMenu.RadioItem>
                  </DropdownMenu.RadioGroup>
                </>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <label className="compact-field">
          <span>排序</span>
          <select
            aria-label="排序图案"
            value={pendingQuery.sort}
            onChange={(event) =>
              patchQuery({ sort: event.target.value as PatternQuery["sort"] })
            }
          >
            {patternSorts.map((sort) => (
              <option key={sort} value={sort}>
                {sortLabels[sort]}
              </option>
            ))}
          </select>
        </label>
        {(pendingQuery.formats.length > 0 ||
          pendingQuery.tagIds.length > 0 ||
          pendingQuery.favorite !== undefined ||
          pendingQuery.commercialState !== undefined ||
          pendingQuery.authorizationField !== undefined) && (
          <IconButton
            label="清除筛选"
            onClick={() => {
              patchQuery({
                formats: [],
                tagIds: [],
                favorite: undefined,
                commercialState: undefined,
                authorizationField: undefined,
              });
            }}
          >
            <RotateCcw aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <div className="toolbar-summary" aria-live="polite">
        {selectedCount > 0
          ? `已选择 ${selectedCount} 项`
          : `已载入 ${resultCount} 项`}
      </div>
      <div className="toolbar-view-controls">
        <span className="inspector-toggle-slot">
        {inspectorHidden && selectedCount > 0 ? (
          <IconButton label="显示检查器" onClick={onShowInspector}>
            <PanelRightOpen aria-hidden="true" />
          </IconButton>
        ) : null}
        </span>
        <div className="segmented-icons" aria-label="显示方式">
          <IconButton
            label="网格视图"
            pressed={viewMode === "grid"}
            onClick={() => onViewModeChange("grid")}
          >
            <Grid2X2 aria-hidden="true" />
          </IconButton>
          <IconButton
            label="列表视图"
            pressed={viewMode === "list"}
            onClick={() => onViewModeChange("list")}
          >
            <List aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

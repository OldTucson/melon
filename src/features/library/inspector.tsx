"use client";

import * as Tabs from "@radix-ui/react-tabs";
import {
  X,
  FolderInput,
  Heart,
  HeartOff,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResponsivePanel } from "@/components/responsive-panel";

import type { PatternQuery } from "@/features/patterns/contracts";
import { TagPicker } from "@/features/tags/tag-picker";
import { AuthorizationTab } from "@/features/authorizations/authorization-tab";

import { IconButton } from "./icon-button";
import type { PatternItem } from "./library-types";
import { usePatternPatchMutation } from "./pattern-mutations";
import { selectionAvailability } from "./selection-availability";
import {
  usePatternBatchMutation,
  type PatternBatchInput,
} from "./pattern-batch-mutations";
import { useFoldersQuery } from "@/features/folders/folder-client";
import { FolderPicker } from "@/features/folders/folder-picker";
import { TrashPatternsDialog } from "./trash-patterns-dialog";

export function Inspector({
  activeQuery,
  onCollapse,
  pattern,
}: {
  activeQuery: PatternQuery;
  onCollapse: () => void;
  pattern: PatternItem;
}) {
  const mutation = usePatternPatchMutation(activeQuery);
  const [name, setName] = useState(pattern.name);
  const [saveError, setSaveError] = useState<"empty" | "save" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPattern = useRef(pattern);
  const latestName = useRef(pattern.name);
  const latestDraft = useRef(pattern.name);
  const pendingName = useRef<string | null>(null);
  const pendingSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const saveNameRef = useRef<(candidate: string) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    const draftWasClean =
      pendingName.current === null &&
      latestDraft.current === latestName.current;
    const committedNameChanged = pattern.name !== latestName.current;
    latestPattern.current = pattern;
    if (pendingName.current !== null) return;
    latestName.current = pattern.name;
    if (draftWasClean) {
      latestDraft.current = pattern.name;
      setName(pattern.name);
      if (committedNameChanged) setSaveError(null);
    }
  }, [pattern]);

  const saveName = async (candidate: string): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const nextName = candidate.trim();
    if (!nextName) {
      if (pendingSave.current) await pendingSave.current;
      latestDraft.current = latestName.current;
      if (mounted.current) {
        setName(latestName.current);
        setSaveError("empty");
      }
      return;
    }
    if (nextName === latestName.current || nextName === pendingName.current) {
      return pendingSave.current ?? Promise.resolve();
    }
    if (pendingSave.current) {
      await pendingSave.current;
      return saveName(candidate);
    }
    const previousName = latestName.current;
    pendingName.current = nextName;
    if (mounted.current) setSaveError(null);
    const request = (async () => {
      try {
        const updated = await mutation.mutatePatternAsync({
          patternId: latestPattern.current.id,
          patch: {
            version: latestPattern.current.version,
            name: nextName,
          },
        });
        latestPattern.current = updated;
        latestName.current = updated.name;
        if (latestDraft.current.trim() === nextName) {
          latestDraft.current = updated.name;
          if (mounted.current) setName(updated.name);
        }
      } catch {
        latestName.current = previousName;
        if (latestDraft.current.trim() === nextName) {
          latestDraft.current = previousName;
          if (mounted.current) setName(previousName);
        }
        if (mounted.current) setSaveError("save");
      } finally {
        if (pendingName.current === nextName) pendingName.current = null;
      }
    })();
    pendingSave.current = request;
    await request;
    if (pendingSave.current === request) pendingSave.current = null;
  };

  useEffect(() => {
    saveNameRef.current = saveName;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (latestDraft.current.trim()) {
        void saveNameRef.current(latestDraft.current);
      }
    };
  }, []);

  const scheduleNameSave = (nextName: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveName(nextName), 400);
  };

  return (
    <InspectorPanel onCollapse={onCollapse}>
      <header className="inspector-header">
        <div>
          <span>图案检查器</span>
          <strong title={pattern.name}>{pattern.name}</strong>
        </div>
        <IconButton label="收起检查器" onClick={onCollapse}>
          <X aria-hidden="true" />
        </IconButton>
      </header>
      <div className="inspector-scroll">
        <Tabs.Root className="inspector-tabs" defaultValue="details">
          <Tabs.List className="inspector-tab-list" aria-label="图案信息视图">
            <Tabs.Trigger value="details">基本信息</Tabs.Trigger>
            <Tabs.Trigger value="authorizations">商业授权</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="details" className="inspector-tab-content">
            <SelectionActions
              activeQuery={activeQuery}
              patterns={[pattern]}
              compact
            />
            <section className="inspector-section">
              <label className="inspector-field">
                <span>图案名称</span>
                <input
                  aria-label="图案名称"
                  maxLength={160}
                  value={name}
                  onBlur={() => void saveName(name)}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    latestDraft.current = nextName;
                    setName(nextName);
                    setSaveError(null);
                    scheduleNameSave(nextName);
                  }}
                />
              </label>
              {saveError ? (
                <p role="alert">
                  {saveError === "empty"
                    ? "名称不能为空"
                    : "名称未能保存，已恢复原值"}
                </p>
              ) : null}
              <button
                className="inspector-favorite"
                type="button"
                aria-pressed={pattern.isFavorite}
                onClick={() =>
                  mutation.mutatePattern({
                    patternId: pattern.id,
                    patch: {
                      version: pattern.version,
                      isFavorite: !pattern.isFavorite,
                    },
                  })
                }
              >
                <Heart
                  aria-hidden="true"
                  fill={pattern.isFavorite ? "currentColor" : "none"}
                />
                {pattern.isFavorite ? "已收藏" : "添加收藏"}
              </button>
              <dl className="pattern-facts">
                <div>
                  <dt>格式</dt>
                  <dd>{pattern.extension.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>原始文件</dt>
                  <dd title={pattern.originalFilename}>
                    {pattern.originalFilename}
                  </dd>
                </div>
                <div>
                  <dt>预览</dt>
                  <dd>{previewLabel(pattern.previewStatus)}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>
                    {new Intl.DateTimeFormat("zh-CN").format(
                      new Date(pattern.updatedAt),
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <TagPicker activeQuery={activeQuery} patternId={pattern.id} />
          </Tabs.Content>
          <Tabs.Content
            value="authorizations"
            className="inspector-tab-content"
          >
            <AuthorizationTab
              disabled={pattern.status !== "ready"}
              patternId={pattern.id}
            />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </InspectorPanel>
  );
}

export function MultiSelectionInspector({
  patterns,
  activeQuery,
  onCollapse,
}: {
  patterns: PatternItem[];
  activeQuery: PatternQuery;
  onCollapse: () => void;
}) {
  return (
    <InspectorPanel onCollapse={onCollapse}>
      <header className="inspector-header">
        <div>
          <span>多项选择</span>
          <strong>已选择 {patterns.length} 个图案</strong>
        </div>
        <IconButton label="收起检查器" onClick={onCollapse}>
          <X aria-hidden="true" />
        </IconButton>
      </header>
      <div className="inspector-scroll">
        <SelectionActions
          key={patterns
            .map((pattern) => pattern.id)
            .sort()
            .join("|")}
          activeQuery={activeQuery}
          patterns={patterns}
        />
      </div>
    </InspectorPanel>
  );
}

function InspectorPanel({ children, onCollapse }: { children: React.ReactNode; onCollapse: () => void }) {
  return <ResponsivePanel
    as="aside"
    className="library-inspector"
    label="图案检查器"
    open
    onClose={onCollapse}
    returnFocus={() => document.querySelector<HTMLButtonElement>('[aria-label="显示检查器"]')}
  >{children}</ResponsivePanel>;
}

function SelectionActions({
  activeQuery,
  patterns,
  compact = false,
}: {
  activeQuery: PatternQuery;
  patterns: PatternItem[];
  compact?: boolean;
}) {
  const folders = useFoldersQuery();
  const mutation = usePatternBatchMutation(activeQuery);
  const [destination, setDestination] = useState<string | null>(
    patterns[0]?.folderId ?? null,
  );
  const [moveOpen, setMoveOpen] = useState(!compact);
  const [trashOpen, setTrashOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const availability = selectionAvailability(
    patterns.map((pattern) => pattern.id),
    patterns,
  );
  const disabled =
    mutation.isPending || availability !== "editable" || patterns.length > 100;
  const run = async (input: PatternBatchInput) => {
    if (disabled) return;
    setMessage(null);
    try {
      await mutation.mutateBatchAsync(input);
      setTrashOpen(false);
    } catch {
      setMessage("选择已变化，请刷新后重新选择");
    }
  };
  const currentFolder = folders.data?.find(
    (folder) => folder.id === patterns[0]?.folderId,
  );
  return (
    <section className="inspector-section inspector-location">
      {compact ? (
        <>
          <p title={currentFolder?.name}>
            当前位置：
            {patterns[0]?.folderId
              ? (currentFolder?.name ?? "位置暂不可用")
              : "未分类"}
          </p>
          <button
            type="button"
            className="bulk-action-button"
            disabled={disabled}
            onClick={() => setMoveOpen(!moveOpen)}
          >
            <FolderInput aria-hidden="true" />
            移动
          </button>
        </>
      ) : null}
      {availability === "transient" ? (
        <p role="status">图案正在完成上传</p>
      ) : availability === "missing" ? (
        <p role="alert">选择内容已变化，请重新选择</p>
      ) : null}
      {patterns.length > 100 ? (
        <p role="alert">每次最多处理 100 个图案</p>
      ) : null}
      {moveOpen ? (
        <>
          <FolderPicker
            folders={folders.data ?? []}
            value={destination}
            onChange={setDestination}
            disabled={disabled}
          />
          {folders.isPending ? (
            <p>正在载入文件夹...</p>
          ) : folders.isError ? (
            <p role="alert">文件夹载入失败，请刷新</p>
          ) : null}
          <button
            className="bulk-action-button"
            type="button"
            disabled={disabled}
            onClick={() =>
              void run({ action: "move", folderId: destination, patterns })
            }
          >
            <FolderInput aria-hidden="true" />
            移动到此处
          </button>
        </>
      ) : null}
      {!compact ? (
        <div className="inspector-batch-actions">
          <button
            className="bulk-action-button"
            type="button"
            disabled={disabled}
            onClick={() =>
              void run({ action: "favorite", isFavorite: true, patterns })
            }
          >
            <Heart aria-hidden="true" />
            添加收藏
          </button>
          <button
            className="bulk-action-button"
            type="button"
            disabled={disabled}
            onClick={() =>
              void run({ action: "favorite", isFavorite: false, patterns })
            }
          >
            <HeartOff aria-hidden="true" />
            取消收藏
          </button>
          <button
            className="bulk-action-button"
            type="button"
            disabled={disabled}
            onClick={() => setTrashOpen(true)}
          >
            <Trash2 aria-hidden="true" />
            移入回收站
          </button>
        </div>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      <TrashPatternsDialog
        patterns={patterns}
        open={trashOpen}
        isPending={mutation.isPending}
        onOpenChange={setTrashOpen}
        onConfirm={() => void run({ action: "trash", patterns })}
      />
    </section>
  );
}

function previewLabel(status: PatternItem["previewStatus"]) {
  return {
    pending: "处理中",
    ready: "可用",
    unsupported: "格式暂不支持",
    failed: "生成失败",
    manual: "手动预览",
  }[status];
}

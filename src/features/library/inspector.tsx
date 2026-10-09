"use client";

import { ChevronRight, Heart, Layers3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PatternQuery } from "@/features/patterns/contracts";
import { TagPicker } from "@/features/tags/tag-picker";

import { IconButton } from "./icon-button";
import type { PatternItem } from "./library-types";
import { usePatternPatchMutation } from "./pattern-mutations";

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
    if (
      nextName === latestName.current ||
      nextName === pendingName.current
    ) {
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
    <aside className="library-inspector" aria-label="图案检查器">
      <header className="inspector-header">
        <div>
          <span>基本信息</span>
          <strong title={pattern.name}>{pattern.name}</strong>
        </div>
        <IconButton label="收起检查器" onClick={onCollapse}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </header>
      <div className="inspector-scroll">
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
              <dd title={pattern.originalFilename}>{pattern.originalFilename}</dd>
            </div>
            <div>
              <dt>预览</dt>
              <dd>{previewLabel(pattern.previewStatus)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{new Intl.DateTimeFormat("zh-CN").format(new Date(pattern.updatedAt))}</dd>
            </div>
          </dl>
        </section>
        <TagPicker activeQuery={activeQuery} patternId={pattern.id} />
        <section className="inspector-section inspector-coming-soon">
          <div className="inspector-section-heading">
            <h3>商业授权</h3>
            <Layers3 aria-hidden="true" />
          </div>
          <p>商业授权记录将在下一阶段接入。</p>
        </section>
      </div>
    </aside>
  );
}

export function MultiSelectionInspector({
  count,
  onCollapse,
}: {
  count: number;
  onCollapse: () => void;
}) {
  return (
    <aside className="library-inspector" aria-label="图案检查器">
      <header className="inspector-header">
        <div>
          <span>多项选择</span>
          <strong>已选择 {count} 个图案</strong>
        </div>
        <IconButton label="收起检查器" onClick={onCollapse}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </header>
      <div className="inspector-empty-state">
        <p>批量操作将在对应服务接入后开放。</p>
      </div>
    </aside>
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

"use client";

import * as Checkbox from "@radix-ui/react-checkbox";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Check,
  CheckCheck,
  FolderInput,
  Heart,
  HeartOff,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { PatternQuery } from "@/features/patterns/contracts";
import { useFoldersQuery } from "@/features/folders/folder-client";

import type { PatternItem } from "./library-types";
import { usePatternBatchMutation } from "./pattern-batch-mutations";
import { selectionAvailability } from "./selection-availability";
import { useSelectionStore } from "./selection-store";
import { TrashPatternsDialog } from "./trash-patterns-dialog";

type UndoNotice = { patternIds: string[] };

function ActionButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <button
      aria-label={label}
      className="bulk-action-button"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  );
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function BulkActionBar({
  activeQuery,
  loadedPatterns,
}: {
  activeQuery: PatternQuery;
  loadedPatterns: PatternItem[];
}) {
  const selectedIds = useSelectionStore((state) => state.selectedIds);
  const clearSelected = useSelectionStore((state) => state.clearSelected);
  const selectAll = useSelectionStore((state) => state.selectAll);
  const [moveOpen, setMoveOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [notice, setNotice] = useState<UndoNotice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutation = usePatternBatchMutation(activeQuery);
  const selected = useMemo(() => {
    const ids = new Set(selectedIds);
    return loadedPatterns.filter((pattern) => ids.has(pattern.id));
  }, [loadedPatterns, selectedIds]);
  const folders = useFoldersQuery();
  const count = selected.length;
  const allLoadedSelected =
    loadedPatterns.length > 0 && count === loadedPatterns.length;
  const tooMany = count > 100;
  const availability = selectionAvailability(selectedIds, selected);
  const disabled =
    mutation.isPending || tooMany || availability !== "editable";

  const run = async (
    input:
      | { action: "move"; folderId: string | null }
      | { action: "favorite"; isFavorite: boolean },
  ) => {
    if (disabled) return;
    setMessage(null);
    try {
      await mutation.mutateBatchAsync({ ...input, patterns: selected });
    } catch {
      setMessage("批量操作未完成，请刷新后重新选择");
    }
  };

  const confirmTrash = async () => {
    if (disabled) return;
    setMessage(null);
    try {
      const result = await mutation.mutateBatchAsync({
        action: "trash",
        patterns: selected,
      });
      const patternIds = result.patterns.map((pattern) => pattern.id);
      setTrashOpen(false);
      setNotice({ patternIds });
    } catch {
      setMessage("图案未能移入回收站，请刷新后重试");
    }
  };

  const undoTrash = async () => {
    if (!notice) return;
    setMessage(null);
    try {
      await mutation.restorePatternsAsync(notice.patternIds);
      setNotice(null);
    } catch {
      setMessage("撤销失败，请前往回收站恢复");
    }
  };

  return (
    <>
      {count > 0 ? (
        <div className="bulk-action-bar" aria-label="批量操作">
          <label className="bulk-selection-count">
            <Checkbox.Root
              aria-label="选择所有已加载图案"
              checked={allLoadedSelected ? true : "indeterminate"}
              onCheckedChange={(checked) => {
                if (checked === true) {
                  selectAll(loadedPatterns.map((pattern) => pattern.id));
                } else {
                  clearSelected();
                }
              }}
            >
              <Checkbox.Indicator>
                {allLoadedSelected ? (
                  <Check aria-hidden="true" />
                ) : (
                  <CheckCheck aria-hidden="true" />
                )}
              </Checkbox.Indicator>
            </Checkbox.Root>
            <span>已选择 {count} 项</span>
          </label>

          <DropdownMenu.Root open={moveOpen} onOpenChange={setMoveOpen}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <DropdownMenu.Trigger asChild>
                  <button
                    aria-label="移动"
                    className="bulk-action-button"
                    disabled={disabled}
                    type="button"
                  >
                    <FolderInput aria-hidden="true" />
                    <span>移动</span>
                  </button>
                </DropdownMenu.Trigger>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={6}>
                  移动
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="filter-menu-content"
                sideOffset={6}
              >
                <DropdownMenu.Label className="filter-menu-label">
                  移动到
                </DropdownMenu.Label>
                <DropdownMenu.Item
                  className="bulk-folder-item"
                  onSelect={() => void run({ action: "move", folderId: null })}
                >
                  未分类
                </DropdownMenu.Item>
                {folders.isPending ? (
                  <DropdownMenu.Item className="filter-menu-message" disabled>
                    正在载入文件夹...
                  </DropdownMenu.Item>
                ) : folders.isError ? (
                  <DropdownMenu.Item className="filter-menu-message" disabled>
                    文件夹载入失败
                  </DropdownMenu.Item>
                ) : (
                  folders.data?.filter((folder) => !folder.optimisticCreate).map((folder) => (
                    <DropdownMenu.Item
                      className="bulk-folder-item"
                      key={folder.id}
                      onSelect={() =>
                        void run({ action: "move", folderId: folder.id })
                      }
                    >
                      {folder.name}
                    </DropdownMenu.Item>
                  ))
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <ActionButton
            disabled={disabled}
            label="收藏所选"
            onClick={() => void run({ action: "favorite", isFavorite: true })}
          >
            <Heart aria-hidden="true" />
          </ActionButton>
          <ActionButton
            disabled={disabled}
            label="取消收藏所选"
            onClick={() => void run({ action: "favorite", isFavorite: false })}
          >
            <HeartOff aria-hidden="true" />
          </ActionButton>
          <ActionButton
            disabled={disabled}
            label="移入回收站"
            onClick={() => setTrashOpen(true)}
          >
            <Trash2 aria-hidden="true" />
          </ActionButton>
          <ActionButton label="清除选择" onClick={clearSelected}>
            <X aria-hidden="true" />
          </ActionButton>
          {tooMany ? (
            <span className="bulk-inline-error" role="alert">
              每次最多处理 100 个图案
            </span>
          ) : null}
          {availability === "missing" ? (
            <span className="bulk-inline-error" role="alert">
              选择内容已变化，请重新选择
            </span>
          ) : availability === "transient" ? (
            <span className="bulk-inline-status" role="status">
              图案正在完成上传
            </span>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div className="bulk-notice" role="status">
          <span>已将 {notice.patternIds.length} 个图案移入回收站</span>
          <button
            disabled={mutation.isPending}
            type="button"
            onClick={() => void undoTrash()}
          >
            <RotateCcw aria-hidden="true" />
            撤销
          </button>
        </div>
      ) : null}
      {message ? (
        <div className="bulk-error" role="alert">
          {message}
        </div>
      ) : null}

      <TrashPatternsDialog
        patterns={selected}
        isPending={mutation.isPending}
        open={trashOpen}
        onConfirm={() => void confirmTrash()}
        onOpenChange={setTrashOpen}
      />
    </>
  );
}

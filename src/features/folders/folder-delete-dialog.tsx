"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Trash2 } from "lucide-react";
import type { FolderDeleteImpact } from "./folder-mutations";

export function FolderDeleteDialog({
  name,
  impact,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  impact: FolderDeleteImpact;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <header className="confirm-dialog-header">
            <div>
              <Dialog.Title>将“{name}”移入回收站</Dialog.Title>
              <Dialog.Description>
                将影响 {impact.folderCount} 个文件夹和 {impact.patternCount}{" "}
                个图案，可以在回收站恢复。
              </Dialog.Description>
            </div>
          </header>
          <div className="folder-delete-details">
            {(impact.alreadyTrashedFolderCount > 0 ||
              impact.alreadyTrashedPatternCount > 0) && (
              <p>
                {impact.alreadyTrashedFolderCount} 个文件夹、
                {impact.alreadyTrashedPatternCount}{" "}
                个图案已在回收站，不会重复移入。
              </p>
            )}
            {impact.hasDeletingEntities && (
              <p>部分内容正在永久删除，请等待完成后重新打开此对话框。</p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
          <footer className="confirm-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={pending || impact.hasDeletingEntities}
              onClick={onConfirm}
            >
              <Trash2 aria-hidden="true" />
              {pending ? "正在处理" : "确认移入回收站"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

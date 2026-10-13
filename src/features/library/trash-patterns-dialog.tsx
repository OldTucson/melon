"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Trash2, X } from "lucide-react";

import { IconButton } from "./icon-button";

export function TrashPatternsDialog({
  count,
  isPending,
  onConfirm,
  onOpenChange,
  open,
}: {
  count: number;
  isPending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="confirm-dialog">
          <header className="confirm-dialog-header">
            <div>
              <Dialog.Title>移入回收站</Dialog.Title>
              <Dialog.Description>
                确定将 {count} 个图案移入回收站吗？之后可以撤销或在回收站恢复。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton disabled={isPending} label="关闭">
                <X aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </header>
          <footer className="confirm-dialog-actions">
            <Dialog.Close asChild>
              <button className="secondary-button" disabled={isPending} type="button">
                取消
              </button>
            </Dialog.Close>
            <button
              className="danger-button"
              disabled={isPending}
              type="button"
              onClick={onConfirm}
            >
              <Trash2 aria-hidden="true" />
              {isPending ? "正在处理" : "确认移入回收站"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

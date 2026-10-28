"use client";

import type { Ref } from "react";
import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";

import type { InspirationCreateMutation } from "./contracts";
import { InspirationPromptForm } from "./inspiration-prompt-form";
import styles from "./inspiration.module.css";

export function InspirationNewDialog({
  open,
  pending,
  blocked,
  onOpenChange,
  onSubmit,
  triggerRef,
}: {
  open: boolean;
  pending: boolean;
  blocked: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: InspirationCreateMutation) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const input = useRef<HTMLTextAreaElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button
          ref={triggerRef}
          className={styles.primaryButton}
          type="button"
          disabled={pending || blocked}
        >
          <Plus aria-hidden="true" />
          新建调研
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={`${styles.dialog} ${styles.newDialog}`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <div className={styles.dialogHeader}>
            <Dialog.Title>新建灵感调研</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className={styles.iconButton}
                type="button"
                aria-label="关闭新建调研"
                disabled={pending}
              >
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className={styles.visuallyHidden}>
            创建一份新的灵感调研
          </Dialog.Description>
          <InspirationPromptForm
            inputRef={input}
            pending={pending}
            blocked={blocked}
            onSubmit={onSubmit}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

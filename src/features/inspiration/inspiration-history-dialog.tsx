"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { History, X } from "lucide-react";

import { InspirationHistory } from "./inspiration-history";
import styles from "./inspiration.module.css";

type InspirationHistoryDialogProps = ComponentProps<typeof InspirationHistory>;

export function InspirationHistoryDialog({
  onSelect,
  ...historyProps
}: InspirationHistoryDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={styles.button} type="button">
          <History aria-hidden="true" />
          历史
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={`${styles.dialog} ${styles.historyDialog}`}>
          <div className={styles.dialogHeader}>
            <Dialog.Title>研究历史</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className={styles.iconButton}
                type="button"
                aria-label="关闭研究历史"
              >
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className={styles.visuallyHidden}>
            选择已保存的灵感调研
          </Dialog.Description>
          <InspirationHistory
            {...historyProps}
            onSelect={(id) => {
              onSelect(id);
              setOpen(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

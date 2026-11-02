"use client";

import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Sparkles, X } from "lucide-react";
import type { ConceptSetCreateMutation } from "@/features/inspiration-concepts/contracts";
import { selectDefaultConceptReferences } from "@/features/inspiration-concepts/reference-selector";
import type { WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";
import type { InspirationPrompt } from "./contracts";
import { EvidenceImage } from "./inspiration-evidence-dialog";
import styles from "./inspiration.module.css";

type Props = {
  direction: InspirationPrompt;
  directionIndex: number;
  activeVisualJobId: string | null;
  assets: WebEvidenceAssetDto[];
  available: boolean;
  pending?: boolean;
  disabledReason?: string;
  error?: string | null;
  onGenerate: (input: ConceptSetCreateMutation) => void | Promise<void>;
};

// Mounted once per open session/job. Ordinary query rerenders never undo a deselection.
function ReferenceSelection({
  onSubmitted,
  ...props
}: Props & { onSubmitted: () => void }) {
  const [references] = useState(() =>
    props.activeVisualJobId
      ? selectDefaultConceptReferences({
          direction: props.direction,
          assets: props.assets,
        })
      : [],
  );
  const [selectedIds, setSelectedIds] = useState(() =>
    references.map(({ id }) => id),
  );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (props.pending || props.disabledReason) return;
        try {
          await props.onGenerate({
            operationId: crypto.randomUUID(),
            directionIndex: props.directionIndex,
            visualJobId: selectedIds.length ? props.activeVisualJobId : null,
            referenceAssetIds: selectedIds,
          });
          onSubmitted();
        } catch {
          /* The controller supplies a safe, local error. Keep the selection for retry. */
        }
      }}
    >
      <div className={styles.conceptDirectionSummary}>
        <strong>{props.direction.title}</strong>
        <p>{props.direction.direction}</p>
        <dl className={styles.directionDetails}>
          <div>
            <dt>廓形</dt>
            <dd>{props.direction.silhouette}</dd>
          </div>
          <div>
            <dt>配色</dt>
            <dd>{props.direction.palette.join("、")}</dd>
          </div>
          <div>
            <dt>材质</dt>
            <dd>{props.direction.materials.join("、") || "未指定"}</dd>
          </div>
          <div>
            <dt>细节</dt>
            <dd>{props.direction.details.join("、") || "未指定"}</dd>
          </div>
        </dl>
      </div>
      <div className={styles.conceptReferenceHeading}>
        <strong>参考图片</strong>
        <span>已选 {selectedIds.length} / 3</span>
      </div>
      {references.length ? (
        <div className={styles.conceptReferences}>
          {references.map((asset) => (
            <label className={styles.conceptReference} key={asset.id}>
              <EvidenceImage asset={asset} />
              <span>
                <Checkbox.Root
                  className={styles.conceptCheckbox}
                  checked={selectedIds.includes(asset.id)}
                  aria-label={`参考：${asset.title}`}
                  disabled={
                    props.pending ||
                    (!selectedIds.includes(asset.id) && selectedIds.length >= 3)
                  }
                  onCheckedChange={(checked) =>
                    setSelectedIds((ids) =>
                      checked
                        ? references
                            .filter(
                              ({ id }) => id === asset.id || ids.includes(id),
                            )
                            .slice(0, 3)
                            .map(({ id }) => id)
                        : ids.filter((id) => id !== asset.id),
                    )
                  }
                >
                  <Checkbox.Indicator>
                    <Check aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                {asset.title}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className={styles.muted}>暂无可用参考图片，可直接生成</p>
      )}
      <footer className={styles.conceptDrawerFooter}>
        <p className={styles.muted}>
          将生成 3 张 AI 图片，预计费用以百炼账单为准
        </p>
        {props.error && <p role="alert">{props.error}</p>}
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={props.pending || !!props.disabledReason}
        >
          <Sparkles aria-hidden="true" />
          {props.pending ? "正在提交…" : "生成整套成图"}
        </button>
      </footer>
    </form>
  );
}

export function InspirationConceptDrawer(props: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!props.available) return null;
  return (
    <div className={styles.conceptCreate}>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            ref={trigger}
            type="button"
            className={styles.button}
            disabled={props.pending || !!props.disabledReason}
          >
            <Sparkles aria-hidden="true" />
            生成整套成图
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={`${styles.dialog} ${styles.conceptDrawer}`}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (trigger.current && !trigger.current.disabled)
                trigger.current.focus();
              else {
                const results = trigger.current
                  ?.closest("section")
                  ?.querySelector<HTMLElement>("[data-concept-results]");
                const selectedTab = !props.pending
                  ? results?.querySelector<HTMLElement>(
                      '[role="tab"][aria-selected="true"]',
                    )
                  : null;
                (selectedTab ?? results)?.focus();
              }
            }}
          >
            <div className={styles.dialogHeader}>
              <Dialog.Title>生成整套成图</Dialog.Title>
              <Dialog.Close
                className={styles.iconButton}
                aria-label="关闭生成面板"
              >
                <X aria-hidden="true" />
              </Dialog.Close>
            </div>
            <Dialog.Description className={styles.muted}>
              方向 {String(props.directionIndex + 1).padStart(2, "0")} ·{" "}
              {props.direction.title}
            </Dialog.Description>
            <ReferenceSelection
              key={`${props.directionIndex}:${props.activeVisualJobId ?? "none"}`}
              {...props}
              onSubmitted={() => setOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {props.disabledReason && (
        <p className={styles.muted}>{props.disabledReason}</p>
      )}
    </div>
  );
}

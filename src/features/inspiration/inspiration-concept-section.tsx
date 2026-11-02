"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type {
  ConceptOutputKind,
  ConceptSetDto,
  PublicConceptSetDto,
} from "@/features/inspiration-concepts/contracts";
import { EvidenceImage } from "./inspiration-evidence-dialog";
import { InspirationConceptOutputDialog } from "./inspiration-concept-output-dialog";
import styles from "./inspiration.module.css";

const labels = { sketch: "设计草图", effect: "服装效果图", flat: "服装款式图" };
export function hasActiveConceptTask(
  sets: readonly ConceptSetDto[] | undefined,
) {
  return (
    sets?.some((set) =>
      set.slots.some(
        ({ task }) =>
          task?.status === "queued" || task?.status === "generating",
      ),
    ) ?? false
  );
}
export function conceptCreationDisabledReason(sets: readonly ConceptSetDto[]) {
  if (hasActiveConceptTask(sets)) return "当前方向已有方案正在生成";
  if (sets.length >= 3) return "已保留 3 个方案，请先删除一个";
  return undefined;
}
type PrivateProps = {
  mode?: "private";
  sets: ConceptSetDto[];
  available?: boolean;
  pending?: boolean;
  onRetry?: (setId: string, kind: "effect" | "flat") => void;
  onRegenerate?: (setId: string) => void;
  onDelete?: (setId: string) => void;
};
type Props = PrivateProps | { mode: "public"; sets: PublicConceptSetDto[] };

function ConceptSetActions({
  set,
  resultsRef,
  ...props
}: PrivateProps & {
  set: ConceptSetDto;
  resultsRef: RefObject<HTMLElement | null>;
}) {
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const blocked =
    !props.available ||
    props.pending ||
    !!conceptCreationDisabledReason(props.sets);
  // Dismiss the old confirmation, including if availability is later restored.
  if (confirm && !props.available) setConfirm(false);
  if (!props.onDelete && !props.onRegenerate) return null;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={trigger}
            className={styles.iconButton}
            aria-label="方案操作"
            title="方案操作"
            disabled={props.pending}
          >
            <MoreHorizontal aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className={styles.conceptMenu}
            align="end"
            sideOffset={6}
          >
            {props.available && props.onRegenerate && (
              <DropdownMenu.Item
                className={styles.conceptMenuItem}
                disabled={blocked}
                onSelect={() => setConfirm(true)}
              >
                <RefreshCw aria-hidden="true" />
                重新生成草图（新方案）
              </DropdownMenu.Item>
            )}
            {props.onDelete && (
              <DropdownMenu.Item
                className={styles.conceptMenuItem}
                onSelect={() => props.onDelete?.(set.id)}
              >
                <Trash2 aria-hidden="true" />
                删除方案
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root
        open={confirm && !!props.available}
        onOpenChange={setConfirm}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.dialog}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (submitted.current) {
                const results = resultsRef.current;
                const selectedTab = results?.querySelector<HTMLElement>(
                  '[role="tab"][aria-selected="true"]',
                );
                // Immediate responses can already have replaced the active panel.
                (selectedTab && selectedTab.dataset.conceptSet !== set.id
                  ? selectedTab
                  : results
                )?.focus();
                submitted.current = false;
              } else if (
                trigger.current?.isConnected &&
                !trigger.current.disabled
              )
                trigger.current.focus();
              else {
                const results = resultsRef.current;
                const selectedTab = !props.pending
                  ? results?.querySelector<HTMLElement>(
                      '[role="tab"][aria-selected="true"]',
                    )
                  : null;
                (selectedTab ?? results)?.focus();
              }
            }}
          >
            <Dialog.Title>重新生成草图？</Dialog.Title>
            <Dialog.Description>
              将创建新方案，并重新生成草图、服装效果图和服装款式图。当前方案将保留。
            </Dialog.Description>
            <p className={styles.muted}>
              将生成 3 张 AI 图片，预计费用以百炼账单为准
            </p>
            <footer className={styles.actions}>
              <Dialog.Close className={styles.button}>取消</Dialog.Close>
              <button
                className={styles.primaryButton}
                disabled={blocked}
                onClick={() => {
                  if (!props.available || blocked) return;
                  submitted.current = true;
                  props.onRegenerate?.(set.id);
                  setConfirm(false);
                }}
              >
                <Sparkles aria-hidden="true" />
                确认生成新方案
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function InspirationConceptSection(props: Props) {
  const ordered = [...props.sets].sort((a, b) => b.version - a.version);
  const resultsRef = useRef<HTMLElement>(null);
  const newest = ordered[0]?.id ?? "";
  const previousNewest = useRef(newest);
  const pending = props.mode !== "public" && !!props.pending;
  const [selection, setSelection] = useState<{
    id: string;
    newest: string;
  } | null>(null);
  useEffect(() => {
    if (pending) return;
    const results = resultsRef.current;
    // A closed pending dialog leaves focus here (or on the previous tab).
    // Transfer it only within this results region, without stealing outside focus.
    if (
      newest !== previousNewest.current &&
      results?.contains(document.activeElement)
    ) {
      results
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    }
    previousNewest.current = newest;
  }, [newest, pending]);
  const selectedId =
    selection?.newest === newest &&
    ordered.some(({ id }) => id === selection.id)
      ? selection.id
      : newest;
  return (
    <section
      ref={resultsRef}
      aria-label="成图结果"
      tabIndex={-1}
      data-concept-results=""
    >
      {ordered.length > 0 && (
        <Tabs.Root
          className={styles.conceptSection}
          value={selectedId}
          onValueChange={(id) => setSelection({ id, newest })}
        >
          <Tabs.List className={styles.conceptTabs} aria-label="成图方案" loop>
            {ordered.map((set) => (
              <Tabs.Trigger
                key={set.id}
                className={styles.conceptTab}
                value={set.id}
                data-concept-set={set.id}
              >
                方案 {String(set.version).padStart(2, "0")}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {ordered.map((set) => (
            <Tabs.Content
              key={set.id}
              value={set.id}
              className={styles.conceptPanel}
            >
              {props.mode !== "public" && (
                <div className={styles.conceptSetActions}>
                  <ConceptSetActions
                    {...props}
                    set={set as ConceptSetDto}
                    resultsRef={resultsRef}
                  />
                </div>
              )}
              <div className={styles.conceptSlots}>
                {(props.mode === "public"
                  ? (set as PublicConceptSetDto).outputs.map((asset) => ({
                      kind: asset.kind,
                      asset,
                      task: null,
                    }))
                  : (set as ConceptSetDto).slots
                ).map(({ kind, asset, task }) => {
                  const active =
                    task?.status === "queued" || task?.status === "generating";
                  const status =
                    active && asset
                      ? "正在重新生成"
                      : task?.status === "queued"
                        ? "排队中"
                        : task?.status === "generating"
                          ? "生成中"
                          : task?.status === "failed"
                            ? asset
                              ? "重新生成失败，已保留当前图片"
                              : "生成失败"
                            : asset
                              ? ""
                              : "等待草图完成";
                  const retryKind: "effect" | "flat" | null =
                    kind === "sketch" ? null : kind;
                  const privateSet =
                    props.mode !== "public" ? (set as ConceptSetDto) : null;
                  const hasSketch = !!privateSet?.slots[0].asset;
                  return (
                    <figure
                      key={kind}
                      className={styles.conceptFigure}
                      aria-label={labels[kind as ConceptOutputKind]}
                    >
                      <div
                        className={styles.conceptMedia}
                        data-concept-media=""
                        style={{
                          aspectRatio: kind === "flat" ? "4 / 3" : "3 / 4",
                        }}
                      >
                        {asset ? (
                          <InspirationConceptOutputDialog
                            asset={asset}
                            mode={props.mode}
                          >
                            <EvidenceImage asset={asset} />
                          </InspirationConceptOutputDialog>
                        ) : (
                          <span
                            className={styles.conceptPlaceholder}
                            role={active ? "status" : undefined}
                          >
                            {status}
                          </span>
                        )}
                      </div>
                      <figcaption className={styles.conceptCaption}>
                        <div>
                          <strong>{labels[kind]}</strong>
                          {asset && <span>AI 生成</span>}
                        </div>
                        <div className={styles.conceptSlotStatus}>
                          {asset && status && (
                            <span role="status">{status}</span>
                          )}
                          {props.mode !== "public" &&
                            props.available &&
                            props.onRetry &&
                            retryKind &&
                            hasSketch && (
                              <button
                                className={styles.iconButton}
                                aria-label={`${asset ? "重新生成" : "重试"}${labels[kind]}`}
                                title={`${asset ? "重新生成" : "重试"}${labels[kind]}`}
                                disabled={props.pending || active}
                                onClick={() =>
                                  props.onRetry?.(set.id, retryKind)
                                }
                              >
                                <RefreshCw aria-hidden="true" />
                              </button>
                            )}
                        </div>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </section>
  );
}

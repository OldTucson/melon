"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { Pencil, RefreshCw, Share2, Trash2 } from "lucide-react";
import { z } from "zod";
import { inspirationVisualApi } from "@/features/inspiration-visuals/inspiration-visual-api";
import { inspirationVisualKeys } from "@/features/inspiration-visuals/query-keys";
import { ApiResponseError } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";
import {
  inspirationPatchMutationSchema,
  type InspirationDetailDto,
  type InspirationListDto,
} from "./contracts";
import { inspirationApi } from "./inspiration-api";
import { InspirationHistoryDialog } from "./inspiration-history-dialog";
import { InspirationNewDialog } from "./inspiration-new-dialog";
import { InspirationPromptForm } from "./inspiration-prompt-form";
import { InspirationResult } from "./inspiration-result";
import { InspirationShareDialog } from "./inspiration-share-dialog";
import { InspirationVisualBoard } from "./inspiration-visual-board";
import { InspirationWorkspaceHeader } from "./inspiration-workspace-header";
import { inspirationKeys } from "./query-keys";
import styles from "./inspiration.module.css";

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          className={styles.iconButton}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// Only this validated identifier may leave an error's untrusted details object.
function savedFailureId(error: unknown) {
  if (
    !(error instanceof ApiResponseError) ||
    typeof error.details !== "object" ||
    error.details === null ||
    !("analysisId" in error.details)
  )
    return null;
  const id = z.string().uuid().safeParse(error.details.analysisId);
  return id.success ? id.data : null;
}
function errorMessage(error: unknown) {
  return error instanceof ApiResponseError && error.status === 409
    ? "记录已更新，请重试"
    : "分析暂时失败，请稍后重试";
}

function removeHistoryRecord(client: QueryClient, ownerId: string, id: string) {
  return client.setQueryData<
    InfiniteData<InspirationListDto, string | undefined>
  >(inspirationKeys.list(ownerId), (current) =>
    current
      ? {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== id),
          })),
        }
      : current,
  );
}

type DialogKind = "rename" | "delete" | "share";
type InspirationDialog = {
  kind: DialogKind;
  target: Pick<InspirationDetailDto, "id" | "title" | "version">;
};

export function InspirationView() {
  const ownerId = useQueryOwnerId();
  const client = useQueryClient();
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const newResearchTrigger = useRef<HTMLButtonElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const focusAfterRecovery = useRef(false);
  const [selection, setSelection] = useState<string | null>(
    () =>
      client
        .getQueryData<InfiniteData<InspirationListDto, string | undefined>>(
          inspirationKeys.list(ownerId),
        )
        ?.pages.flatMap((page) => page.items)[0]?.id ?? null,
  );
  const [dialog, setDialog] = useState<InspirationDialog | null>(null);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: inspirationKeys.list(ownerId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await inspirationApi.list(pageParam, signal);
      setSelection((current) => current ?? page.items[0]?.id ?? null);
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) => item.status === "pending"),
      )
        ? 5000
        : false,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedId = selection;
  const detail = useQuery({
    queryKey: inspirationKeys.detail(ownerId, selectedId ?? ""),
    queryFn: ({ signal }) => inspirationApi.detail(selectedId!, signal),
    enabled: selectedId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 5000 : false,
  });
  const analysis = detail.data;
  const selected =
    analysis && selectedId === analysis.id ? analysis : undefined;
  const visualKey = inspirationVisualKeys.detail(ownerId, selectedId ?? "");
  const visuals = useQuery({
    queryKey: visualKey,
    queryFn: ({ signal }) => inspirationVisualApi.get(selectedId!, signal),
    enabled: selected?.status === "completed",
    refetchInterval: (query) =>
      query.state.data?.refreshJob?.status === "pending" ? 5000 : false,
  });
  const invalidate = () =>
    client.invalidateQueries({ queryKey: inspirationKeys.all(ownerId) });
  const saveDetail = async (data: InspirationDetailDto) => {
    if (data.id !== selectedId) dialogTrigger.current = null;
    setDialog(null);
    client.setQueryData(inspirationKeys.detail(ownerId, data.id), data);
    setSelection(data.id);
    setNotice("已自动保存");
    await invalidate();
  };
  const onFailure = async (failure: unknown) => {
    setError(errorMessage(failure));
    const id = savedFailureId(failure);
    if (id) {
      if (id !== selectedId) dialogTrigger.current = null;
      setDialog(null);
      setSelection(id);
    }
    await invalidate();
  };
  const refreshVisuals = useMutation({
    mutationFn: ({
      analysisId,
      operationId,
    }: {
      analysisId: string;
      operationId: string;
    }) => inspirationVisualApi.create(analysisId, { operationId }),
    onSuccess: (board, variables) => {
      client.setQueryData(
        inspirationVisualKeys.detail(ownerId, variables.analysisId),
        board,
      );
    },
    onError: (_failure, variables) => {
      void client.invalidateQueries({
        queryKey: inspirationVisualKeys.detail(ownerId, variables.analysisId),
      });
    },
  });
  const create = useMutation({
    mutationFn: inspirationApi.create,
    onSuccess: async (data) => {
      setNewDialogOpen(false);
      await saveDetail(data);
      if (data.status === "completed") {
        refreshVisuals.mutate({
          analysisId: data.id,
          operationId: crypto.randomUUID(),
        });
      }
    },
    onError: onFailure,
  });
  const retry = useMutation({
    mutationFn: inspirationApi.retry,
    onSuccess: saveDetail,
    onError: onFailure,
  });
  const rename = useMutation({
    mutationFn: ({
      id,
      title,
      version,
    }: {
      id: string;
      title: string;
      version: number;
    }) => inspirationApi.rename(id, { title, version }),
    onSuccess: async (data) => {
      setDialog(null);
      await saveDetail(data);
    },
    onError: onFailure,
  });
  const remove = useMutation({
    mutationFn: inspirationApi.delete,
    onSuccess: async ({ id }) => {
      const remaining = removeHistoryRecord(client, ownerId, id);
      setSelection(
        remaining?.pages.flatMap((page) => page.items)[0]?.id ?? null,
      );
      focusAfterRecovery.current = true;
      dialogTrigger.current = null;
      setDialog(null);
      setNotice(null);
      client.removeQueries({
        queryKey: inspirationKeys.detail(ownerId, id),
      });
      await invalidate();
    },
    onError: onFailure,
  });
  const pending = create.isPending || retry.isPending;
  const editing = rename.isPending || remove.isPending;
  const blocked =
    items.some((item) => item.status === "pending") ||
    analysis?.status === "pending";
  const selectedInHistory = items.some((item) => item.id === selectedId);
  const refetchSelected = detail.refetch;
  useEffect(() => {
    if (!selectedId) return;
    // Observe the current owned query so automatic and manual refetches recover alike.
    const cache = client.getQueryCache();
    const currentQuery = cache.find({
      queryKey: inspirationKeys.detail(ownerId, selectedId),
      exact: true,
    });
    const historyQuery = cache.find({
      queryKey: inspirationKeys.list(ownerId),
      exact: true,
    });
    let recovered = false;
    return cache.subscribe((event) => {
      if (
        recovered ||
        event.type !== "updated" ||
        (event.query !== currentQuery && event.query !== historyQuery) ||
        currentQuery?.state.fetchStatus !== "idle" ||
        !(currentQuery.state.error instanceof ApiResponseError) ||
        currentQuery.state.error.status !== 404
      )
        return;
      const currentHistory = client.getQueryData<
        InfiniteData<InspirationListDto, string | undefined>
      >(inspirationKeys.list(ownerId));
      // Absence from loaded pages alone is never deletion; require the owned 404.
      if (
        client.getQueryState(inspirationKeys.list(ownerId))?.status !==
          "success" ||
        currentHistory?.pages.some((page) =>
          page.items.some((item) => item.id === selectedId),
        )
      )
        return;
      recovered = true;
      const remaining = removeHistoryRecord(client, ownerId, selectedId);
      dialogTrigger.current = null;
      setDialog(null);
      setError(null);
      setNotice(null);
      setSelection(
        remaining?.pages.flatMap((page) => page.items)[0]?.id ?? null,
      );
      focusAfterRecovery.current = true;
      client.removeQueries({
        queryKey: inspirationKeys.detail(ownerId, selectedId),
      });
    });
  }, [client, ownerId, selectedId]);
  useEffect(() => {
    if (!history.isSuccess) return;
    if (focusAfterRecovery.current) {
      focusAfterRecovery.current = false;
      if (selectedId) newResearchTrigger.current?.focus();
      else promptInput.current?.focus();
      return;
    }
    if (!selectedId) promptInput.current?.focus();
  }, [history.isSuccess, selectedId]);
  useEffect(() => {
    if (
      !selectedId ||
      !history.isSuccess ||
      history.isFetching ||
      selectedInHistory
    )
      return;
    void refetchSelected();
  }, [
    client,
    ownerId,
    selectedId,
    selectedInHistory,
    history.isSuccess,
    history.isFetching,
    history.dataUpdatedAt,
    refetchSelected,
  ]);
  const unavailable =
    !selectedInHistory &&
    history.isSuccess &&
    detail.error instanceof ApiResponseError &&
    detail.error.status === 404;
  const activeDialog = dialog?.target.id === selectedId ? dialog : null;
  function restoreDialogFocus(event: Event) {
    event.preventDefault();
    const trigger = dialogTrigger.current;
    if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    else if (promptInput.current) promptInput.current.focus();
    else newResearchTrigger.current?.focus();
  }
  function openDialog(kind: DialogKind, trigger: HTMLButtonElement) {
    if (!selected) return;
    dialogTrigger.current = trigger;
    setError(null);
    setNotice(null);
    setTitle(selected.title);
    setDialog({
      kind,
      target: {
        id: selected.id,
        title: selected.title,
        version: selected.version,
      },
    });
  }
  function submitAnalysis(input: Parameters<typeof inspirationApi.create>[0]) {
    setError(null);
    setNotice(null);
    setNewDialogOpen(false);
    create.mutate(input);
  }
  function selectAnalysis(id: string) {
    setSelection(id);
    setDialog(null);
    setError(null);
    setNotice(null);
  }
  function refreshSelectedVisuals() {
    if (!selected || selected.status !== "completed") return;
    refreshVisuals.mutate({
      analysisId: selected.id,
      operationId: crypto.randomUUID(),
    });
  }
  const selectedVisualMutation =
    refreshVisuals.variables?.analysisId === selected?.id;

  return (
    <main
      aria-labelledby="inspiration-title"
      className={styles.workspace}
    >
      <InspirationWorkspaceHeader>
        <InspirationHistoryDialog
          items={items}
          selectedId={selectedId}
          loading={history.isPending}
          error={history.isError}
          hasMore={history.hasNextPage}
          fetchingMore={history.isFetchingNextPage}
          onSelect={selectAnalysis}
          onMore={() => {
            void history.fetchNextPage();
          }}
          onRefresh={() => {
            void history.refetch();
          }}
        />
        <InspirationNewDialog
          triggerRef={newResearchTrigger}
          open={newDialogOpen}
          pending={create.isPending}
          blocked={blocked}
          onOpenChange={setNewDialogOpen}
          onSubmit={submitAnalysis}
        />
      </InspirationWorkspaceHeader>
      {pending && (
        <p className={`${styles.muted} ${styles.workspaceStatus}`} role="status">
          正在分析…
        </p>
      )}
      <div className={styles.report} aria-label="研究详情">
          {error && <p role="alert">{error}</p>}
          {notice && (
            <p className={styles.muted} role="status">
              {notice}
            </p>
          )}
          {selectedId && detail.isPending && <p role="status">正在加载研究…</p>}
          {unavailable && <p role="status">正在同步研究…</p>}
          {detail.isError && !unavailable && (
            <div>
              <p role="alert">研究详情加载失败</p>
              <button
                className={styles.button}
                onClick={() => {
                  void detail.refetch();
                }}
              >
                重新加载详情
              </button>
            </div>
          )}
          {!selectedId && (
            <section className={styles.emptyResearch}>
              <div>
                <p className={styles.sectionKicker}>NEW RESEARCH</p>
                <h2>开始一份灵感调研</h2>
                <p className={styles.empty}>暂无研究记录</p>
              </div>
              <InspirationPromptForm
                inputRef={promptInput}
                pending={pending}
                blocked={blocked}
                onSubmit={submitAnalysis}
              />
            </section>
          )}
          {selected && !unavailable && (
            <>
              <header className={styles.detailHeader}>
                <div>
                  <p className={styles.sectionKicker}>RESEARCH REPORT</p>
                  <h2 className={styles.recordTitle}>{selected.title}</h2>
                </div>
                {selected.status !== "pending" && (
                  <div className={styles.actions}>
                    <IconButton
                      label="重命名"
                      disabled={editing}
                      onClick={(event) =>
                        openDialog("rename", event.currentTarget)
                      }
                    >
                      <Pencil aria-hidden="true" />
                    </IconButton>
                    {selected.status === "completed" && (
                      <IconButton
                        label="分享研究"
                        disabled={editing}
                        onClick={(event) =>
                          openDialog("share", event.currentTarget)
                        }
                      >
                        <Share2 aria-hidden="true" />
                      </IconButton>
                    )}
                    <IconButton
                      label="删除研究"
                      disabled={editing || pending}
                      onClick={(event) =>
                        openDialog("delete", event.currentTarget)
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </IconButton>
                  </div>
                )}
              </header>
              <p className={styles.originalPrompt}>{selected.prompt}</p>
              {selected.status === "pending" && (
                <p role="status">正在分析这份研究…</p>
              )}
              {selected.status === "failed" && (
                <div className={styles.failed}>
                  <p>这份研究分析失败，已保存研究需求。</p>
                  <button
                    className={styles.button}
                    disabled={pending || blocked}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      retry.mutate(selected.id);
                    }}
                  >
                    <RefreshCw aria-hidden="true" />
                    {retry.isPending ? "重试中…" : "重试分析"}
                  </button>
                </div>
              )}
              {selected.status === "completed" && selected.result && (
                <InspirationResult
                  result={selected.result}
                  sources={selected.sources ?? []}
                  visualSummary={
                    <InspirationVisualBoard
                      placement="summary"
                      board={visuals.data}
                      loading={visuals.isPending}
                      error={
                        visuals.isError ||
                        (selectedVisualMutation &&
                          refreshVisuals.isError &&
                          visuals.data === undefined)
                      }
                      refreshing={
                        selectedVisualMutation && refreshVisuals.isPending
                      }
                      onRefresh={refreshSelectedVisuals}
                    />
                  }
                  libraryMatches={
                    <InspirationVisualBoard
                      placement="library"
                      board={visuals.data}
                    />
                  }
                />
              )}
              {activeDialog?.kind === "share" && (
                <InspirationShareDialog
                  key={activeDialog.target.id}
                  analysis={selected}
                  onClose={() => setDialog(null)}
                  onCloseAutoFocus={restoreDialogFocus}
                />
              )}
              {(activeDialog?.kind === "rename" ||
                activeDialog?.kind === "delete") && (
                <Dialog.Root
                  open
                  onOpenChange={(open) => {
                    if (!open && !editing) setDialog(null);
                  }}
                >
                  <Dialog.Portal>
                    <Dialog.Overlay className={styles.overlay} />
                    <Dialog.Content
                      className={styles.dialog}
                      onCloseAutoFocus={restoreDialogFocus}
                      onEscapeKeyDown={(event) => {
                        if (editing) event.preventDefault();
                      }}
                      onInteractOutside={(event) => {
                        if (editing) event.preventDefault();
                      }}
                    >
                      <Dialog.Title>
                        {activeDialog?.kind === "rename"
                          ? "重命名研究"
                          : "删除研究？"}
                      </Dialog.Title>
                      <Dialog.Description>
                        {activeDialog?.kind === "delete"
                          ? `“${activeDialog.target.title}”将被永久删除，分享链接也会失效。`
                          : activeDialog.target.title}
                      </Dialog.Description>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (
                            editing ||
                            !activeDialog ||
                            activeDialog.target.id !== selectedId
                          )
                            return;
                          if (activeDialog.kind === "delete")
                            remove.mutate(activeDialog.target.id);
                          else {
                            const input =
                              inspirationPatchMutationSchema.safeParse({
                                title,
                                version: activeDialog.target.version,
                              });
                            if (input.success)
                              rename.mutate({
                                id: activeDialog.target.id,
                                ...input.data,
                              });
                          }
                        }}
                      >
                        {activeDialog?.kind === "rename" && (
                          <label className={styles.titleField}>
                            研究标题
                            <input
                              value={title}
                              maxLength={120}
                              onChange={(event) => setTitle(event.target.value)}
                            />
                          </label>
                        )}
                        {error && <p role="alert">{error}</p>}
                        <footer className={styles.actions}>
                          <button
                            className={styles.button}
                            type="button"
                            disabled={editing}
                            onClick={() => setDialog(null)}
                          >
                            取消
                          </button>
                          <button
                            className={
                              activeDialog?.kind === "delete"
                                ? styles.dangerButton
                                : styles.primaryButton
                            }
                            disabled={
                              editing ||
                              (activeDialog?.kind === "rename" &&
                                !inspirationPatchMutationSchema.safeParse({
                                  title,
                                  version: activeDialog.target.version,
                                }).success)
                            }
                            type="submit"
                          >
                            {editing
                              ? "正在保存…"
                              : activeDialog?.kind === "delete"
                                ? "确认删除"
                                : "保存标题"}
                          </button>
                        </footer>
                      </form>
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>
              )}
            </>
          )}
      </div>
    </main>
  );
}

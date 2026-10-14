"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Ban, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { IconButton } from "@/features/library/icon-button";
import { currentDateInTimeZone } from "@/features/authorizations/dates";
import { ApiResponseError } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import {
  createAuthorization,
  createAuthorizationField,
  editAuthorization,
  fetchAuthorizationFields,
  fetchAuthorizationHistory,
  formatFenForDisplay,
  setAuthorizationStatus,
  type AuthorizationDto,
  type AuthorizationFieldDto,
  type AuthorizationMutationInput,
} from "./api";
import { AuthorizationForm } from "./authorization-form";
import { AuthorizationRow } from "./authorization-row";
import { authorizationKeys } from "./query-keys";

const stateLabels = {
  unlicensed: "未授权",
  standard: "普通授权",
  field_exclusive: "领域独占",
  global_buyout: "已买断",
} as const;

type StatusIntent = {
  action: "void" | "restore";
  authorization: AuthorizationDto;
};

export function AuthorizationTab({
  disabled = false,
  patternId,
}: {
  disabled?: boolean;
  patternId: string;
}) {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const [includeVoid, setIncludeVoid] = useState(false);
  const [editor, setEditor] = useState<"create" | AuthorizationDto | null>(null);
  const [statusIntent, setStatusIntent] = useState<StatusIntent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const today = currentDateInTimeZone();

  const fieldsKey = authorizationKeys.fields(ownerId, true);
  const fieldsQuery = useQuery({
    queryKey: fieldsKey,
    queryFn: () => fetchAuthorizationFields(true),
  });
  const historyKey = authorizationKeys.history(
    ownerId,
    patternId,
    includeVoid,
  );
  const historyQuery = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam }) =>
      fetchAuthorizationHistory({
        patternId,
        includeVoid,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const firstPage = historyQuery.data?.pages[0];
  const records =
    historyQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const commercialVersion = firstPage?.commercialVersion ?? 0;

  const invalidateCommercialData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.pattern(ownerId, patternId),
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: ["owner", ownerId, "patterns"],
      }),
      queryClient.invalidateQueries({
        queryKey: authorizationKeys.historyRoot(ownerId, patternId),
      }),
      queryClient.invalidateQueries({
        queryKey: authorizationKeys.dashboard(ownerId),
      }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async (input: AuthorizationMutationInput) => {
      if (editor && editor !== "create") {
        if (input.version === undefined) throw new Error("VERSION_REQUIRED");
        return editAuthorization(editor.id, {
          ...input,
          version: input.version,
        });
      }
      return createAuthorization(patternId, input);
    },
    onSuccess: async () => {
      await invalidateCommercialData();
    },
  });

  const statusMutation = useMutation({
    mutationFn: (intent: StatusIntent) =>
      setAuthorizationStatus({
        action: intent.action,
        authorizationId: intent.authorization.id,
        commercialVersion,
        operationId: crypto.randomUUID(),
        version: intent.authorization.version,
      }),
    onSuccess: async (_result, intent) => {
      await invalidateCommercialData();
      setStatusIntent(null);
      setMessage(intent.action === "void" ? "授权记录已作废" : "授权记录已恢复");
    },
    onError: async (error) => {
      setStatusIntent(null);
      if (
        error instanceof ApiResponseError &&
        error.code === "AUTHORIZATION_STATE_CHANGED"
      ) {
        setMessage("授权状态已更新，请重新操作");
        await invalidateCommercialData();
        return;
      }
      if (
        error instanceof ApiResponseError &&
        error.code === "AUTHORIZATION_RESTORE_CONFLICT"
      ) {
        setMessage("当前授权状态冲突，无法恢复这条记录");
        return;
      }
      setMessage("授权记录未能更新，请重试");
    },
  });

  const createField = async (input: {
    name: string;
    operationId: string;
  }) => {
    const created = await createAuthorizationField(input);
    queryClient.setQueriesData<AuthorizationFieldDto[]>(
      { queryKey: authorizationKeys.fieldsRoot(ownerId) },
      (current) => [...(current ?? []), created],
    );
    return created;
  };

  if (historyQuery.isPending || fieldsQuery.isPending) {
    return <div className="authorization-tab-state">正在载入授权记录...</div>;
  }
  if (historyQuery.isError || fieldsQuery.isError || !firstPage) {
    return (
      <div className="authorization-tab-state" role="alert">
        授权记录暂时无法载入
      </div>
    );
  }

  return (
    <section className="authorization-tab" aria-label="商业授权">
      <div className="authorization-summary" aria-label="授权汇总">
        <div>
          <span>当前状态</span>
          <strong data-state={firstPage.summary.state}>
            {stateLabels[firstPage.summary.state]}
          </strong>
        </div>
        <div>
          <span>累计有效收入</span>
          <strong>{formatFenForDisplay(firstPage.summary.revenueFen)}</strong>
        </div>
        <div>
          <span>有效授权</span>
          <strong>{firstPage.summary.activeCount} 条</strong>
        </div>
      </div>

      <div className="authorization-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeVoid}
            onChange={(event) => setIncludeVoid(event.target.checked)}
          />
          显示作废记录
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={disabled || firstPage.summary.state === "global_buyout"}
          onClick={() => {
            setMessage(null);
            setEditor("create");
          }}
        >
          <Plus aria-hidden="true" />
          新增授权
        </button>
      </div>

      {disabled ? (
        <p className="authorization-notice">当前图案尚未就绪，暂不能新增授权。</p>
      ) : null}
      {message ? <p className="authorization-notice" role="status">{message}</p> : null}

      {editor ? (
        <div className="authorization-editor">
          <div className="authorization-editor-heading">
            <strong>{editor === "create" ? "新增授权" : "编辑授权"}</strong>
            <IconButton label="关闭授权表单" onClick={() => setEditor(null)}>
              <X aria-hidden="true" />
            </IconButton>
          </div>
          <AuthorizationForm
            key={editor === "create" ? "create" : editor.id}
            commercialVersion={commercialVersion}
            fields={fieldsQuery.data}
            initial={editor === "create" ? undefined : editor}
            today={today}
            onCancel={() => setEditor(null)}
            onCreateField={createField}
            onSaved={() => {
              setEditor(null);
              setMessage("授权记录已保存");
            }}
            onStale={async () => {
              setEditor(null);
              setMessage("授权状态已更新，请重新操作");
              await invalidateCommercialData();
            }}
            onSubmit={async (input) => {
              await saveMutation.mutateAsync(input);
            }}
          />
        </div>
      ) : null}

      <div className="authorization-history" aria-label="授权历史">
        {records.length === 0 ? (
          <div className="authorization-empty-state">
            <strong>还没有授权记录</strong>
            <p>新增记录后，收入与授权状态会在这里汇总。</p>
          </div>
        ) : (
          records.map((authorization) => (
            <AuthorizationRow
              key={authorization.id}
              authorization={authorization}
              onEdit={() => {
                setMessage(null);
                setEditor(authorization);
              }}
              onVoid={() =>
                setStatusIntent({ action: "void", authorization })
              }
              onRestore={() =>
                setStatusIntent({ action: "restore", authorization })
              }
            />
          ))
        )}
      </div>
      {historyQuery.hasNextPage ? (
        <button
          className="secondary-button authorization-load-more"
          type="button"
          disabled={historyQuery.isFetchingNextPage}
          onClick={() => void historyQuery.fetchNextPage()}
        >
          {historyQuery.isFetchingNextPage ? "正在载入..." : "载入更多"}
        </button>
      ) : null}

      <Dialog.Root
        open={Boolean(statusIntent)}
        onOpenChange={(open) => {
          if (!open && !statusMutation.isPending) setStatusIntent(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog"
            aria-describedby="authorization-status-description"
          >
            <div className="confirm-dialog-header">
              <div>
                <Dialog.Title>
                  {statusIntent?.action === "void"
                    ? "确认作废授权"
                    : "确认恢复授权"}
                </Dialog.Title>
                <Dialog.Description id="authorization-status-description">
                  {statusIntent?.action === "void"
                    ? "作废后该笔收入不再计入有效收入，记录仍会保留。"
                    : "恢复时会重新检查买断与领域独占冲突。"}
                </Dialog.Description>
              </div>
            </div>
            <div className="confirm-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={statusMutation.isPending}
                onClick={() => setStatusIntent(null)}
              >
                取消
              </button>
              <button
                className={
                  statusIntent?.action === "void"
                    ? "danger-button"
                    : "primary-button"
                }
                type="button"
                disabled={statusMutation.isPending}
                onClick={() => {
                  if (statusIntent) statusMutation.mutate(statusIntent);
                }}
              >
                {statusIntent?.action === "void" ? (
                  <Ban aria-hidden="true" />
                ) : (
                  <RotateCcw aria-hidden="true" />
                )}
                {statusIntent?.action === "void" ? "确认作废" : "确认恢复"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

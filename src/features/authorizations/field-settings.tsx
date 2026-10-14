"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Lock, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { IconButton } from "@/features/library/icon-button";
import { ApiResponseError } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";

import {
  archiveAuthorizationField,
  createAuthorizationField,
  fetchAuthorizationFields,
  type AuthorizationFieldDto,
} from "./api";
import { authorizationKeys } from "./query-keys";

function fieldError(error: unknown) {
  if (
    error instanceof ApiResponseError &&
    error.code === "AUTHORIZATION_FIELD_EXISTS"
  ) {
    return "已有同名授权领域";
  }
  if (
    error instanceof ApiResponseError &&
    error.code === "AUTHORIZATION_FIELD_NAME_INVALID"
  ) {
    return "领域名称应为 1 至 32 个字符";
  }
  return "授权领域未能保存，请重试";
}

export function AuthorizationFieldSettings() {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const key = authorizationKeys.fields(ownerId, true);
  const fields = useQuery({
    queryKey: key,
    queryFn: () => fetchAuthorizationFields(true),
  });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] =
    useState<AuthorizationFieldDto | null>(null);
  const createIntent = useRef<{ name: string; operationId: string } | null>(
    null,
  );

  const createMutation = useMutation({
    mutationFn: createAuthorizationField,
    onSuccess: (created) => {
      queryClient.setQueriesData<AuthorizationFieldDto[]>(
        { queryKey: authorizationKeys.fieldsRoot(ownerId) },
        (current) => [...(current ?? []), created],
      );
      setName("");
      createIntent.current = null;
      setError(null);
    },
    onError: (cause) => setError(fieldError(cause)),
  });
  const archiveMutation = useMutation({
    mutationFn: archiveAuthorizationField,
    onSuccess: (archived) => {
      queryClient.setQueriesData<AuthorizationFieldDto[]>(
        { queryKey: authorizationKeys.fieldsRoot(ownerId) },
        (current) =>
          current?.map((field) =>
            field.id === archived.id ? archived : field,
          ),
      );
      setArchiveTarget(null);
      setError(null);
    },
    onError: (cause) => setError(fieldError(cause)),
  });

  const normalizedPreview = name.trim().normalize("NFKC");
  const active = fields.data?.filter((field) => field.status === "active") ?? [];
  const archived =
    fields.data?.filter((field) => field.status === "archived") ?? [];

  return (
    <div className="authorization-field-settings">
      <form
        className="authorization-field-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (!normalizedPreview) {
            setError("请输入授权领域名称");
            return;
          }
          if ([...normalizedPreview].length > 32) {
            setError("领域名称最多 32 个字符");
            return;
          }
          const intent =
            createIntent.current?.name === normalizedPreview
              ? createIntent.current
              : {
                  operationId: crypto.randomUUID(),
                  name: normalizedPreview,
                };
          createIntent.current = intent;
          createMutation.mutate(intent);
        }}
      >
        <label>
          <span>新领域名称</span>
          <input
            aria-label="新领域名称"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              createIntent.current = null;
              setError(null);
            }}
          />
        </label>
        <button
          className="primary-button"
          type="submit"
          disabled={createMutation.isPending}
        >
          <Plus aria-hidden="true" />
          添加领域
        </button>
        {normalizedPreview && normalizedPreview !== name ? (
          <p className="field-name-preview">将创建：{normalizedPreview}</p>
        ) : null}
      </form>

      {error ? <p role="alert">{error}</p> : null}
      {fields.isPending ? (
        <p className="muted-copy">正在载入授权领域...</p>
      ) : fields.isError ? (
        <p role="alert">授权领域暂时无法载入</p>
      ) : (
        <div className="authorization-field-list" aria-label="授权领域列表">
          {active.map((field) => (
            <div className="authorization-field-row" key={field.id}>
              <span className="authorization-field-scope">
                {field.scope === "system" ? (
                  <Lock aria-label="系统领域" />
                ) : (
                  <span aria-label="自定义领域" className="field-custom-mark" />
                )}
              </span>
              <span>{field.name}</span>
              {field.scope === "custom" ? (
                <IconButton
                  label={`归档 ${field.name}`}
                  onClick={() => setArchiveTarget(field)}
                >
                  <Archive aria-hidden="true" />
                </IconButton>
              ) : (
                <span className="field-system-label">系统</span>
              )}
            </div>
          ))}
          {archived.length > 0 ? (
            <details className="archived-field-list">
              <summary>已归档（{archived.length}）</summary>
              {archived.map((field) => (
                <div className="authorization-field-row" key={field.id}>
                  <Archive aria-hidden="true" />
                  <span>{field.name}</span>
                  <span className="field-system-label">已归档</span>
                </div>
              ))}
            </details>
          ) : null}
        </div>
      )}

      <Dialog.Root
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open && !archiveMutation.isPending) setArchiveTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog"
            aria-describedby="archive-field-description"
          >
            <div className="confirm-dialog-header">
              <div>
                <Dialog.Title>归档授权领域</Dialog.Title>
                <Dialog.Description id="archive-field-description">
                  “{archiveTarget?.name}”将不再出现在新授权表单中，历史授权记录会保留。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <IconButton label="取消归档">
                  <X aria-hidden="true" />
                </IconButton>
              </Dialog.Close>
            </div>
            <div className="confirm-dialog-actions">
              <Dialog.Close asChild>
                <button className="secondary-button" type="button">
                  取消
                </button>
              </Dialog.Close>
              <button
                className="danger-button"
                type="button"
                disabled={archiveMutation.isPending}
                onClick={() => {
                  if (!archiveTarget) return;
                  archiveMutation.mutate({
                    fieldId: archiveTarget.id,
                    operationId: crypto.randomUUID(),
                  });
                }}
              >
                <Archive aria-hidden="true" />
                确认归档
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

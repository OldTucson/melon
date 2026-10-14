"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { ApiResponseError } from "@/lib/query/client";

import type {
  AuthorizationDto,
  AuthorizationFieldDto,
  AuthorizationKind,
  AuthorizationMutationInput,
} from "./api";
import { AuthorizationFieldCombobox } from "./authorization-field-combobox";
import {
  HistoryConfirmation,
  type AuthorizationHistoryConfirmation,
} from "./history-confirmation";
import { MoneyInput } from "./money-input";

type FormValues = {
  kind: AuthorizationKind;
  fieldId: string | null;
  licenseeName: string;
  priceYuan: string;
  authorizedOn: string;
  note: string;
};

const pricePattern = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

function createFormSchema(today: string, activeFieldIds: ReadonlySet<string>) {
  return z
    .object({
      kind: z.enum(["standard", "field_exclusive", "global_buyout"]),
      fieldId: z.string().uuid().nullable(),
      licenseeName: z
        .string()
        .refine((value) => value.trim().length > 0, "请输入授权客户")
        .refine((value) => [...value.trim()].length <= 100, "授权客户最多 100 个字符"),
      priceYuan: z
        .string()
        .refine((value) => pricePattern.test(value.trim()), "金额最多保留两位小数"),
      authorizedOn: z
        .string()
        .refine((value) => z.iso.date().safeParse(value).success, "请输入有效日期")
        .refine((value) => value <= today, "授权日期不能晚于今天"),
      note: z.string().max(1000, "备注最多 1000 个字符"),
    })
    .superRefine((value, context) => {
      if (value.kind === "global_buyout" && value.fieldId !== null) {
        context.addIssue({
          code: "custom",
          path: ["fieldId"],
          message: "买断不选择领域",
        });
      }
      if (value.kind !== "global_buyout" && value.fieldId === null) {
        context.addIssue({
          code: "custom",
          path: ["fieldId"],
          message: "请选择授权领域",
        });
      }
      if (
        value.kind !== "global_buyout" &&
        value.fieldId !== null &&
        !activeFieldIds.has(value.fieldId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["fieldId"],
          message: "该领域已归档，请选择其他领域",
        });
      }
    });
}

function historyDetails(value: unknown): AuthorizationHistoryConfirmation {
  if (typeof value !== "object" || value === null) {
    return { activeCount: 0, recent: [] };
  }
  const candidate = value as {
    activeCount?: unknown;
    recent?: unknown;
  };
  const recent = Array.isArray(candidate.recent)
    ? candidate.recent.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const row = item as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          typeof row.licenseeName !== "string" ||
          typeof row.authorizedOn !== "string" ||
          typeof row.priceFen !== "string"
        ) {
          return [];
        }
        return [
          {
            id: row.id,
            licenseeName: row.licenseeName,
            authorizedOn: row.authorizedOn,
            priceFen: row.priceFen,
            fieldNameSnapshot:
              typeof row.fieldNameSnapshot === "string"
                ? row.fieldNameSnapshot
                : null,
          },
        ];
      })
    : [];
  return {
    activeCount:
      typeof candidate.activeCount === "number" ? candidate.activeCount : 0,
    recent,
  };
}

function defaultValues(today: string, initial?: AuthorizationDto): FormValues {
  return {
    kind: initial?.kind ?? "standard",
    fieldId: initial?.fieldId ?? null,
    licenseeName: initial?.licenseeName ?? "",
    priceYuan: initial?.priceYuan ?? "",
    authorizedOn: initial?.authorizedOn ?? today,
    note: initial?.note ?? "",
  };
}

export function AuthorizationForm({
  commercialVersion,
  fields,
  initial,
  onCancel,
  onCreateField,
  onSaved,
  onStale,
  onSubmit,
  today,
}: {
  commercialVersion: number;
  fields: AuthorizationFieldDto[];
  initial?: AuthorizationDto;
  onCancel?: () => void;
  onCreateField?: (input: {
    name: string;
    operationId: string;
  }) => Promise<AuthorizationFieldDto>;
  onSaved?: () => void;
  onStale?: () => void;
  onSubmit: (input: AuthorizationMutationInput) => Promise<void>;
  today: string;
}) {
  const [localCreatedFields, setLocalCreatedFields] = useState<
    AuthorizationFieldDto[]
  >([]);
  const availableFields = useMemo(() => {
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const field of localCreatedFields) byId.set(field.id, field);
    return [...byId.values()];
  }, [fields, localCreatedFields]);
  const activeFields = useMemo(
    () => availableFields.filter((field) => field.status === "active"),
    [availableFields],
  );
  const activeFieldIds = useMemo(
    () => new Set(activeFields.map((field) => field.id)),
    [activeFields],
  );
  const schema = useMemo(
    () => createFormSchema(today, activeFieldIds),
    [activeFieldIds, today],
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues(today, initial),
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    details: AuthorizationHistoryConfirmation;
    intent: AuthorizationMutationInput;
  } | null>(null);
  const [creatingField, setCreatingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [fieldCreatePending, setFieldCreatePending] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const pendingIntent = useRef<AuthorizationMutationInput | null>(null);
  const fieldCreateIntent = useRef<{
    name: string;
    operationId: string;
  } | null>(null);
  const fieldCreateInFlight = useRef(false);
  const kind = useWatch({ control: form.control, name: "kind" });
  const selectedFieldId = useWatch({ control: form.control, name: "fieldId" });
  const note = useWatch({ control: form.control, name: "note" });
  const fieldInputRef = useRef<HTMLInputElement>(null);
  const currentArchivedField =
    initial?.fieldId === null
      ? undefined
      : availableFields.find(
          (field) =>
            field.id === initial?.fieldId && field.status === "archived",
        );
  const selectableFields = currentArchivedField
    ? [...activeFields, currentArchivedField]
    : activeFields;
  form.register("fieldId");
  useEffect(() => {
    if (kind !== "global_buyout") return;
    form.setValue("fieldId", null, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
  }, [form, kind]);

  const finish = () => {
    pendingIntent.current = null;
    setConfirmation(null);
    setSubmitError(null);
    onSaved?.();
  };

  const handleFailure = (
    error: unknown,
    intent: AuthorizationMutationInput,
  ) => {
    if (
      error instanceof ApiResponseError &&
      error.code === "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED"
    ) {
      setConfirmation({ details: historyDetails(error.details), intent });
      return;
    }
    if (
      error instanceof ApiResponseError &&
      error.code === "AUTHORIZATION_STATE_CHANGED"
    ) {
      pendingIntent.current = null;
      setConfirmation(null);
      setSubmitError("授权状态已更新，请重新操作");
      onStale?.();
      return;
    }
    setSubmitError("授权记录未能保存，请重试");
  };

  const attempt = async (intent: AuthorizationMutationInput) => {
    setSubmitError(null);
    setSubmitPending(true);
    try {
      await onSubmit(intent);
      finish();
    } catch (error) {
      handleFailure(error, intent);
    } finally {
      setSubmitPending(false);
    }
  };

  const submitValues = async (values: FormValues) => {
    const operationId =
      pendingIntent.current?.operationId ?? crypto.randomUUID();
    const intent: AuthorizationMutationInput = {
      operationId,
      commercialVersion,
      ...(initial ? { version: initial.version } : {}),
      kind: values.kind,
      fieldId: values.kind === "global_buyout" ? null : values.fieldId,
      licenseeName: values.licenseeName.trim().normalize("NFKC"),
      priceYuan: values.priceYuan.trim(),
      authorizedOn: values.authorizedOn,
      note: values.note.trim() || null,
      historyConfirmed: false,
    };
    pendingIntent.current = intent;
    await attempt(intent);
  };

  return (
    <>
      <form
        className="authorization-form"
        noValidate
        onChangeCapture={() => {
          if (!confirmation) pendingIntent.current = null;
          setSubmitError(null);
        }}
        onSubmit={(event) =>
          form.handleSubmit(submitValues, (errors) => {
            if (errors.fieldId) fieldInputRef.current?.focus();
          })(event)
        }
      >
        <fieldset className="authorization-kind-control">
          <legend>授权方式</legend>
          <div>
            {[
              ["standard", "普通授权"],
              ["field_exclusive", "领域独占"],
              ["global_buyout", "买断"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  value={value}
                  {...form.register("kind")}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind !== "global_buyout" ? (
          <div className="authorization-field-control">
            <AuthorizationFieldCombobox
              ref={fieldInputRef}
              ariaDescribedBy={
                form.formState.errors.fieldId
                  ? "authorization-field-error"
                  : undefined
              }
              ariaInvalid={Boolean(form.formState.errors.fieldId)}
              fields={selectableFields}
              value={selectedFieldId}
              onChange={(fieldId) =>
                form.setValue("fieldId", fieldId, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: true,
                })
              }
            />
            {form.formState.errors.fieldId ? (
              <span id="authorization-field-error" role="alert">
                {form.formState.errors.fieldId.message}
              </span>
            ) : null}
            {onCreateField ? (
              <button
                className="text-icon-button"
                type="button"
                disabled={fieldCreatePending}
                onClick={() =>
                  setCreatingField((value) => {
                    if (value) {
                      fieldCreateIntent.current = null;
                      setNewFieldName("");
                      setFieldError(null);
                    }
                    return !value;
                  })
                }
              >
                <Plus aria-hidden="true" />
                新建授权领域
              </button>
            ) : null}
            {creatingField && onCreateField ? (
              <div className="authorization-inline-field-create">
                <input
                  aria-label="自定义授权领域名称"
                  disabled={fieldCreatePending}
                  value={newFieldName}
                  onChange={(event) => {
                    setNewFieldName(event.target.value);
                    fieldCreateIntent.current = null;
                    setFieldError(null);
                  }}
                />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={fieldCreatePending}
                  onClick={async () => {
                    if (fieldCreateInFlight.current) return;
                    const name = newFieldName.trim().normalize("NFKC");
                    if (!name) {
                      setFieldError("请输入领域名称");
                      return;
                    }
                    if ([...name].length > 32) {
                      setFieldError("领域名称最多 32 个字符");
                      return;
                    }
                    const intent =
                      fieldCreateIntent.current?.name === name
                        ? fieldCreateIntent.current
                        : { name, operationId: crypto.randomUUID() };
                    fieldCreateIntent.current = intent;
                    fieldCreateInFlight.current = true;
                    setFieldCreatePending(true);
                    try {
                      const created = await onCreateField(intent);
                      setLocalCreatedFields((current) =>
                        current.some((field) => field.id === created.id)
                          ? current
                          : [...current, created],
                      );
                      form.setValue("fieldId", created.id, {
                        shouldDirty: true,
                        shouldTouch: true,
                      });
                      form.clearErrors("fieldId");
                      setNewFieldName("");
                      setCreatingField(false);
                      fieldCreateIntent.current = null;
                    } catch {
                      setFieldError("领域未能创建，请重试");
                    } finally {
                      fieldCreateInFlight.current = false;
                      setFieldCreatePending(false);
                    }
                  }}
                >
                  创建
                </button>
              </div>
            ) : null}
            {fieldError ? <span role="alert">{fieldError}</span> : null}
          </div>
        ) : null}

        <label className="authorization-form-field">
          <span>授权客户</span>
          <input
            aria-label="授权客户"
            autoComplete="organization"
            {...form.register("licenseeName")}
          />
          {form.formState.errors.licenseeName ? (
            <span role="alert">
              {form.formState.errors.licenseeName.message}
            </span>
          ) : null}
        </label>

        <label className="authorization-form-field">
          <span>授权价格</span>
          <MoneyInput
            aria-label="授权价格"
            placeholder="0.00"
            {...form.register("priceYuan")}
          />
          {form.formState.errors.priceYuan ? (
            <span role="alert">{form.formState.errors.priceYuan.message}</span>
          ) : null}
        </label>

        <label className="authorization-form-field">
          <span>授权日期</span>
          <input
            aria-label="授权日期"
            type="date"
            max={today}
            {...form.register("authorizedOn")}
          />
          {form.formState.errors.authorizedOn ? (
            <span role="alert">
              {form.formState.errors.authorizedOn.message}
            </span>
          ) : null}
        </label>

        <label className="authorization-form-field">
          <span>备注</span>
          <textarea aria-label="备注" rows={3} {...form.register("note")} />
          <small>{note.length}/1000</small>
          {form.formState.errors.note ? (
            <span role="alert">{form.formState.errors.note.message}</span>
          ) : null}
        </label>

        {submitError ? <p role="alert">{submitError}</p> : null}
        <div className="authorization-form-actions">
          {onCancel ? (
            <button className="secondary-button" type="button" onClick={onCancel}>
              取消
            </button>
          ) : null}
          <button
            className="primary-button"
            type="submit"
            disabled={form.formState.isSubmitting || submitPending}
          >
            保存授权
          </button>
        </div>
      </form>

      {confirmation ? (
        <HistoryConfirmation
          details={confirmation.details}
          isPending={submitPending}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const confirmed = {
              ...confirmation.intent,
              historyConfirmed: true,
            };
            pendingIntent.current = confirmed;
            void attempt(confirmed);
          }}
        />
      ) : null}
    </>
  );
}

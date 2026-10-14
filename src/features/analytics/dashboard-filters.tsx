"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  fetchAuthorizationFields,
  type AuthorizationFieldDto,
} from "@/features/authorizations/api";
import { authorizationKeys } from "@/features/authorizations/query-keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type { DashboardQuery, DashboardDto } from "./contracts";

const rangeLabels: Record<DashboardQuery["range"], string> = {
  current_year: "本年度",
  last_12_months: "近 12 个月",
  all_time: "全部时间",
  custom: "自定义",
};

const kindLabels = {
  standard: "普通授权",
  field_exclusive: "领域独占",
  global_buyout: "全局买断",
} as const;

export function DashboardFilters({
  query,
  resolvedRange,
  onChange,
  today,
}: {
  query: DashboardQuery;
  resolvedRange: DashboardDto["range"];
  onChange: (query: DashboardQuery) => void;
  today: string;
}) {
  const ownerId = useQueryOwnerId();
  const fieldsQuery = useQuery<AuthorizationFieldDto[]>({
    queryKey: authorizationKeys.fields(ownerId, true),
    queryFn: () => fetchAuthorizationFields(true),
  });
  const [pending, setPending] = useState(query);
  const pendingRef = useRef(query);

  const customRangeIsValid = (candidate: DashboardQuery) =>
    candidate.range !== "custom" ||
    Boolean(
      candidate.start &&
        candidate.end &&
        candidate.start <= candidate.end &&
        candidate.end <= today,
    );
  const updatePending = (next: DashboardQuery) => {
    pendingRef.current = next;
    setPending(next);
    if (customRangeIsValid(next)) onChange(next);
  };
  const patch = (change: Partial<DashboardQuery>) => {
    updatePending({ ...pendingRef.current, ...change });
  };
  const startInvalid =
    pending.range === "custom" &&
    (!pending.start ||
      Boolean(pending.end && pending.start > pending.end) ||
      pending.start > today);
  const endInvalid =
    pending.range === "custom" &&
    (!pending.end ||
      Boolean(pending.start && pending.end < pending.start) ||
      pending.end > today);

  return (
    <div className="dashboard-filters" aria-label="看板筛选">
      <label>
        <span>时间</span>
        <select
          aria-label="统计时间"
          value={pending.range}
          onChange={(event) => {
            const range = event.target.value as DashboardQuery["range"];
            const current = pendingRef.current;
            if (range === "custom") {
              const fallbackStart =
                resolvedRange.start ?? `${resolvedRange.end.slice(0, 4)}-01-01`;
              updatePending({
                ...current,
                range,
                start: current.start ?? fallbackStart,
                end: current.end ?? resolvedRange.end,
              });
              return;
            }
            updatePending({
              range,
              fieldId: current.fieldId,
              kind: current.kind,
            });
          }}
        >
          {Object.entries(rangeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {pending.range === "custom" ? (
        <div className="dashboard-date-range">
          <label>
            <span>开始</span>
            <input
              aria-label="开始日期"
              aria-invalid={startInvalid || undefined}
              max={
                pending.end && pending.end < today ? pending.end : today
              }
              required
              type="date"
              value={pending.start ?? ""}
              onChange={(event) => patch({ start: event.target.value })}
            />
          </label>
          <span aria-hidden="true">至</span>
          <label>
            <span>结束</span>
            <input
              aria-label="结束日期"
              aria-invalid={endInvalid || undefined}
              max={today}
              min={pending.start}
              required
              type="date"
              value={pending.end ?? ""}
              onChange={(event) => patch({ end: event.target.value })}
            />
          </label>
        </div>
      ) : null}
      {pending.range === "custom" && (startInvalid || endInvalid) ? (
        <p className="dashboard-filter-message" role="status">
          请选择不晚于今日的完整日期范围
        </p>
      ) : null}
      <label>
        <span>类型</span>
        <select
          aria-label="授权类型"
          value={pending.kind ?? ""}
          onChange={(event) =>
            patch({
              kind: event.target.value
                ? (event.target.value as DashboardQuery["kind"])
                : undefined,
            })
          }
        >
          <option value="">全部类型</option>
          {Object.entries(kindLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>领域</span>
        <select
          aria-label="授权领域"
          disabled={fieldsQuery.isPending || fieldsQuery.isError}
          value={pending.fieldId ?? ""}
          onChange={(event) => patch({ fieldId: event.target.value || undefined })}
        >
          <option value="">
            {fieldsQuery.isPending
              ? "读取领域中"
              : fieldsQuery.isError
                ? "领域不可用"
                : "全部领域"}
          </option>
          {fieldsQuery.data?.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
              {field.status === "archived" ? "（已归档）" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

"use client";

/* eslint-disable @next/next/no-img-element */

import * as Checkbox from "@radix-ui/react-checkbox";
import {
  Check,
  CircleDollarSign,
  Download,
  Eye,
  FileImage,
  Heart,
} from "lucide-react";
import { useState } from "react";

import type { PatternItem } from "./library-types";
import { IconButton } from "./icon-button";
import type { LibraryViewMode } from "./library-toolbar";
import type { SelectionModifiers } from "./selection-store";
import { formatFenForDisplay } from "@/features/authorizations/api";
import { isPatternEditable } from "./selection-availability";

const commercialStateLabels = {
  unlicensed: "未授权",
  standard: "普通授权",
  field_exclusive: "领域独占",
  global_buyout: "全局买断",
} as const;

export function FormatPlaceholder({
  extension,
  previewStatus,
}: Pick<PatternItem, "extension" | "previewStatus">) {
  const status =
    previewStatus === "unsupported"
      ? "暂不支持预览"
      : previewStatus === "failed"
        ? "预览生成失败"
        : previewStatus === "pending"
          ? "正在准备预览"
          : "格式预览";
  return (
    <div className="format-placeholder" data-format={extension.toLowerCase()}>
      <FileImage aria-hidden="true" />
      <strong>{extension.toUpperCase()}</strong>
      <span>{status}</span>
    </div>
  );
}

export function PatternCard({
  item,
  mode,
  onFavorite,
  onInspect,
  onOpenPreview,
  onSelect,
  selected,
}: {
  item: PatternItem;
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onInspect: (id: string) => void;
  onOpenPreview: (id: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  selected: boolean;
}) {
  const imageAssetId = item.thumbnailAssetId ?? item.previewAssetId;
  const [failedImageAssetId, setFailedImageAssetId] = useState<string | null>(
    null,
  );
  const imageFailed = imageAssetId === failedImageAssetId;
  const commercialSummary = item.commercialSummary ?? {
    state: "unlicensed" as const,
    activeCount: 0,
    revenueFen: "0",
  };
  return (
    <div
      className="pattern-card"
      data-mode={mode}
      data-selected={selected ? "true" : undefined}
      role="listitem"
      aria-label={`${item.name}, ${item.extension.toUpperCase()}${selected ? ", 已选择" : ""}`}
    >
      <Checkbox.Root
        aria-label={`选择 ${item.name}`}
        title={`选择 ${item.name}`}
        checked={selected}
        className="pattern-select-checkbox"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCheckedChange={() => onSelect(item.id, { metaKey: true })}
      >
        <Checkbox.Indicator>
          <Check aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <button
        aria-label={`打开 ${item.name} 检查器`}
        className="pattern-media"
        type="button"
        onClick={() => onInspect(item.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onOpenPreview(item.id);
        }}
      >
        {imageAssetId && !imageFailed ? (
          <img
            alt={`${item.name} 缩略图`}
            loading="lazy"
            src={`/api/assets/${imageAssetId}/view`}
            onError={() => setFailedImageAssetId(imageAssetId)}
          />
        ) : (
          <FormatPlaceholder
            extension={item.extension}
            previewStatus={item.previewStatus}
          />
        )}
      </button>
      <div className="pattern-card-copy">
        <strong title={item.name}>{item.name}</strong>
        <span>
          {item.extension.toUpperCase()} · {formatBytes(item.sizeBytes)}
        </span>
      </div>
      <div
        className="pattern-commercial-summary"
        data-state={commercialSummary.state}
        aria-label="商业授权摘要"
      >
        <span className="pattern-commercial-state">
          <CircleDollarSign aria-hidden="true" />
          {commercialStateLabels[commercialSummary.state]}
        </span>
        <span>
          {commercialSummary.activeCount} 笔 ·{" "}
          {formatFenForDisplay(commercialSummary.revenueFen)}
        </span>
      </div>
      <div className="pattern-card-actions">
        <IconButton
          disabled={!isPatternEditable(item.status)}
          label={item.isFavorite ? "取消收藏" : "收藏"}
          pressed={item.isFavorite}
          onClick={(event) => {
            event.stopPropagation();
            if (!isPatternEditable(item.status)) return;
            onFavorite(item);
          }}
        >
          <Heart aria-hidden="true" fill={item.isFavorite ? "currentColor" : "none"} />
        </IconButton>
        <IconButton
          label="预览"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPreview(item.id);
          }}
        >
          <Eye aria-hidden="true" />
        </IconButton>
        {item.sourceAssetId ? (
          <a
            className="icon-button"
            aria-label={`下载 ${item.name}`}
            href={`/api/assets/${item.sourceAssetId}/download`}
            title="下载原文件"
            onClick={(event) => event.stopPropagation()}
          >
            <Download aria-hidden="true" />
          </a>
        ) : (
          <IconButton disabled label="原文件尚未就绪">
            <Download aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function formatBytes(rawBytes: string) {
  const bytes = Number(rawBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

"use client";

/* eslint-disable @next/next/no-img-element */

import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Download, Eye, FileImage, Heart } from "lucide-react";
import { useState } from "react";

import type { PatternItem } from "./library-types";
import { IconButton } from "./icon-button";
import type { LibraryViewMode } from "./library-toolbar";
import type { SelectionModifiers } from "./selection-store";

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
  onOpenPreview,
  onSelect,
  selected,
}: {
  item: PatternItem;
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onOpenPreview: (id: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  selected: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageAssetId = item.thumbnailAssetId ?? item.previewAssetId;
  return (
    <div
      className="pattern-card"
      data-mode={mode}
      data-selected={selected ? "true" : undefined}
      role="listitem"
      aria-label={`${item.name}, ${item.extension.toUpperCase()}${selected ? ", 已选择" : ""}`}
      tabIndex={0}
      onClick={(event) =>
        onSelect(item.id, {
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        })
      }
      onDoubleClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, select, textarea")
        ) {
          return;
        }
        onOpenPreview(item.id);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          onSelect(item.id, {});
        }
      }}
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
      <div className="pattern-media">
        {imageAssetId && !imageFailed ? (
          <img
            alt={`${item.name} 缩略图`}
            loading="lazy"
            src={`/api/assets/${imageAssetId}/view`}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <FormatPlaceholder
            extension={item.extension}
            previewStatus={item.previewStatus}
          />
        )}
      </div>
      <div className="pattern-card-copy">
        <strong title={item.name}>{item.name}</strong>
        <span>
          {item.extension.toUpperCase()} · {formatBytes(item.sizeBytes)}
        </span>
      </div>
      <div className="pattern-card-actions">
        <IconButton
          label={item.isFavorite ? "取消收藏" : "收藏"}
          pressed={item.isFavorite}
          onClick={(event) => {
            event.stopPropagation();
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

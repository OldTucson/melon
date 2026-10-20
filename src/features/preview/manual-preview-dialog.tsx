"use client";

/* eslint-disable @next/next/no-img-element */

import * as Dialog from "@radix-ui/react-dialog";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiResponseError } from "@/lib/query/client";
import { IconButton } from "@/features/library/icon-button";

import { replaceManualPreview } from "./manual-preview-client";

type ManualPreviewPattern = {
  id: string;
  name: string;
  extension: string;
  version: number;
};

function errorMessage(error: unknown) {
  if (error instanceof ApiResponseError) {
    if (error.code === "PATTERN_STATE_CHANGED") return "图案已更新，请关闭后重新选择";
    if (error.code === "MANUAL_PREVIEW_INVALID") return "生成的预览文件未通过校验";
  }
  if (error instanceof Error && error.message === "PREVIEW_PIXEL_LIMIT") {
    return "图片像素过大，请选择尺寸较小的图片";
  }
  if (error instanceof Error && error.message === "MANUAL_PREVIEW_FILE_UNSUPPORTED") {
    return "请选择 JPG 或 PNG 图片";
  }
  return "预览更新失败，请检查网络后重试";
}

export function ManualPreviewDialog({
  open,
  pattern,
  onComplete,
  onOpenChange,
}: {
  open: boolean;
  pattern: ManualPreviewPattern;
  onComplete: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const close = (nextOpen: boolean) => {
    if (pending && !nextOpen) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setFile(null);
      setPreviewUrl(null);
      setError(null);
      setProgress(0);
    }
  };

  const submit = async () => {
    if (!file || pending) return;
    setPending(true);
    setError(null);
    setProgress(0);
    try {
      await replaceManualPreview({
        patternId: pattern.id,
        version: pattern.version,
        file,
        onProgress: setProgress,
      });
      onComplete();
      setFile(null);
      setPreviewUrl(null);
      setProgress(0);
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog manual-preview-dialog"
          onEscapeKeyDown={(event) => pending && event.preventDefault()}
          onInteractOutside={(event) => pending && event.preventDefault()}
        >
          <header className="confirm-dialog-header">
            <div>
              <Dialog.Title>更新“{pattern.name}”的预览</Dialog.Title>
              <Dialog.Description>
                仅替换图库预览，不会替换 {pattern.extension.toUpperCase()} 原文件。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton disabled={pending} label="关闭">
                <X aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="manual-preview-body">
            <label className="manual-preview-picker">
              <input
                aria-label="选择 JPG 或 PNG 预览"
                type="file"
                accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                disabled={pending}
                onChange={(event) => {
                  const selected = event.currentTarget.files?.[0] ?? null;
                  setFile(selected);
                  setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
                  setError(null);
                }}
              />
              {previewUrl ? (
                <img src={previewUrl} alt="待上传的预览" />
              ) : (
                <span>
                  <ImagePlus aria-hidden="true" />
                  选择 JPG 或 PNG
                </span>
              )}
            </label>
            {file ? <p className="manual-preview-filename">{file.name}</p> : null}
            {pending ? (
              <div className="manual-preview-progress" role="status">
                <span style={{ width: `${progress}%` }} />
                <small>正在更新 {progress}%</small>
              </div>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <footer className="confirm-dialog-actions">
            <Dialog.Close asChild>
              <button className="secondary-button" disabled={pending} type="button">
                取消
              </button>
            </Dialog.Close>
            <button
              className="primary-button"
              disabled={!file || pending}
              type="button"
              onClick={() => void submit()}
            >
              <ImagePlus aria-hidden="true" />
              {pending ? "正在更新" : "更新预览"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

"use client";

/* eslint-disable @next/next/no-img-element */

import * as Dialog from "@radix-ui/react-dialog";
import { Crop, ImagePlus, ScanSearch, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactCrop, {
  type Crop as CropValue,
  type PixelCrop,
} from "react-image-crop";

import { IconButton } from "@/features/library/icon-button";

import {
  ImageSearchFileError,
  validateImageSearchFile,
} from "./image-search-client";

export type ImageSearchDialogPhase = "analyzing" | "idle" | "processing";

export type ImageSearchDialogSubmit = {
  file: File;
  crop?: PixelCrop & { displayHeight: number; displayWidth: number };
};

export type ImageSearchDialogProps = {
  error: string | null;
  onCancel: () => void;
  onOpenChange: (open: boolean) => void;
  onSearch: (input: ImageSearchDialogSubmit) => void;
  open: boolean;
  phase: ImageSearchDialogPhase;
};

const initialCrop: CropValue = {
  unit: "%",
  x: 10,
  y: 10,
  width: 80,
  height: 80,
};

function fileErrorMessage(error: unknown) {
  if (error instanceof ImageSearchFileError && error.code === "too_large") {
    return "图片不能超过 20 MB";
  }
  return "请选择 JPG、PNG、WebP、HEIC 或 HEIF 图片";
}

const isHeif = (file: File) => /\.(?:heic|heif)$/i.test(file.name);

export function ImageSearchDialog({
  error,
  onCancel,
  onOpenChange,
  onSearch,
  open,
  phase,
}: ImageSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [cropEnabled, setCropEnabled] = useState(false);
  const [crop, setCrop] = useState<CropValue>(initialCrop);
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const busy = phase !== "idle";

  const revokePreview = () => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  };

  const clearFile = () => {
    revokePreview();
    setFile(null);
    setPreviewUrl(null);
    setPreviewFailed(false);
    setLocalError(null);
    setCropEnabled(false);
    setCrop(initialCrop);
    setCompletedCrop(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  useEffect(() => () => revokePreview(), []);

  const acceptFile = (nextFile: File | undefined) => {
    if (!nextFile || busy) return;
    try {
      validateImageSearchFile(nextFile);
    } catch (cause) {
      clearFile();
      setLocalError(fileErrorMessage(cause));
      return;
    }
    revokePreview();
    const nextUrl = URL.createObjectURL(nextFile);
    objectUrlRef.current = nextUrl;
    setFile(nextFile);
    setPreviewUrl(nextUrl);
    setPreviewFailed(false);
    setLocalError(null);
    setCropEnabled(false);
    setCrop(initialCrop);
    setCompletedCrop(null);
  };

  const close = () => {
    if (busy) {
      onCancel();
      return;
    }
    clearFile();
    onOpenChange(false);
  };

  const submit = () => {
    if (!file || busy || (previewFailed && !isHeif(file))) return;
    const image = imageRef.current;
    if (
      cropEnabled &&
      completedCrop &&
      image &&
      image.clientWidth > 0 &&
      image.clientHeight > 0
    ) {
      onSearch({
        file,
        crop: {
          ...completedCrop,
          displayHeight: image.clientHeight,
          displayWidth: image.clientWidth,
        },
      });
      return;
    }
    onSearch({ file });
  };

  const preview = previewUrl ? (
    <img
      ref={imageRef}
      alt="搜索图片预览"
      src={previewUrl}
      onError={() => {
        setPreviewFailed(true);
        setCropEnabled(false);
        setCompletedCrop(null);
        if (!file || !isHeif(file)) setLocalError("浏览器无法读取这张图片");
      }}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (
          Math.min(image.naturalWidth, image.naturalHeight) < 96 ||
          image.naturalWidth * image.naturalHeight > 40_000_000
        ) {
          setLocalError("图片尺寸不符合搜索要求");
        }
      }}
    />
  ) : null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="image-search-dialog"
          aria-describedby="image-search-description"
          onDragEnter={(event) => event.stopPropagation()}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            acceptFile(event.dataTransfer.files[0]);
          }}
          onEscapeKeyDown={(event) => {
            if (busy) {
              event.preventDefault();
              onCancel();
            }
          }}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files).find((entry) =>
              entry.type.startsWith("image/"),
            );
            if (!pasted) return;
            event.preventDefault();
            acceptFile(pasted);
          }}
        >
          <header className="image-search-dialog-header">
            <div>
              <Dialog.Title>以图搜图</Dialog.Title>
              <Dialog.Description id="image-search-description">
                选择完整图片或裁剪局部，在当前筛选范围内查找。
              </Dialog.Description>
            </div>
            <IconButton disabled={busy} label="关闭" onClick={close}>
              <X aria-hidden="true" />
            </IconButton>
          </header>

          <div className="image-search-dialog-body">
            <input
              ref={inputRef}
              className="sr-only"
              aria-label="选择搜索图片"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
              disabled={busy}
              type="file"
              onChange={(event) => acceptFile(event.currentTarget.files?.[0])}
            />

            {file ? (
              <div className="image-search-selection">
                <div className="image-search-preview">
                  {!previewFailed && preview ? (
                    cropEnabled ? (
                      <ReactCrop
                        crop={crop}
                        minHeight={24}
                        minWidth={24}
                        onChange={(pixelCrop, percentCrop) => {
                          setCrop(percentCrop);
                          setCompletedCrop(pixelCrop);
                        }}
                        onComplete={setCompletedCrop}
                      >
                        {preview}
                      </ReactCrop>
                    ) : (
                      preview
                    )
                  ) : (
                    <div className="image-search-preview-fallback">
                      <ImagePlus aria-hidden="true" />
                      <strong>{file.name}</strong>
                      {isHeif(file) ? (
                        <p>此浏览器无法裁剪 HEIC，将搜索整张图片</p>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="image-search-file-row">
                  <span title={file.name}>{file.name}</span>
                  <IconButton
                    disabled={busy}
                    label="移除搜索图片"
                    onClick={clearFile}
                  >
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </div>
                {!previewFailed ? (
                  <label className="image-search-crop-toggle">
                    <input
                      checked={cropEnabled}
                      disabled={busy}
                      type="checkbox"
                      onChange={(event) => {
                        setCropEnabled(event.target.checked);
                        if (!event.target.checked) setCompletedCrop(null);
                      }}
                    />
                    <Crop aria-hidden="true" />
                    裁剪搜索区域
                  </label>
                ) : null}
              </div>
            ) : (
              <button
                className="image-search-dropzone"
                aria-label="拖放、粘贴或选择搜索图片"
                disabled={busy}
                type="button"
                onClick={() => inputRef.current?.click()}
              >
                <ImagePlus aria-hidden="true" />
                <strong>选择或拖入图片</strong>
                <span>也可以直接粘贴剪贴板中的图片</span>
                <small>JPG、PNG、WebP、HEIC、HEIF · 最大 20 MB</small>
              </button>
            )}

            {busy ? (
              <ol className="image-search-phases" role="status">
                <li data-active={phase === "analyzing"}>分析图片</li>
                <li data-active={phase === "processing"}>查找候选</li>
                <li data-active={phase === "processing"}>精确比对</li>
              </ol>
            ) : null}
            {localError || error ? (
              <p className="image-search-error" role="alert">
                {localError ?? error}
              </p>
            ) : null}
          </div>

          <footer className="image-search-dialog-actions">
            <button className="secondary-button" type="button" onClick={close}>
              {busy ? "取消搜索" : "取消"}
            </button>
            <button
              className="primary-button"
              disabled={!file || busy || Boolean(localError)}
              type="button"
              onClick={submit}
            >
              <ScanSearch aria-hidden="true" />
              开始搜索
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

"use client";

import { UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

export const UPLOAD_ACCEPT = ".psd,.ai,.pdf,.jpg,.jpeg,.png,.procreate";

export function UploadDropzone({
  compact = false,
  onFiles,
}: {
  compact?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const choose = () => inputRef.current?.click();
  const accept = (files: FileList | null) => {
    const selected = files ? Array.from(files) : [];
    if (selected.length > 0) onFiles(selected);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      className="upload-dropzone"
      data-compact={compact ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-label="选择或拖入图案文件"
      onClick={choose}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        accept(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        className="sr-only"
        aria-label="选择图案文件"
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        onChange={(event) => accept(event.currentTarget.files)}
        onClick={(event) => event.stopPropagation()}
      />
      <UploadCloud aria-hidden="true" />
      <span>{compact ? "添加文件" : "选择文件或拖放到这里"}</span>
      {!compact ? <small>PSD、AI、PDF、JPG、PNG、Procreate，单个不超过 200 MB</small> : null}
    </div>
  );
}

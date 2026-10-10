"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

import {
  UploadManagerProvider,
  useUploadManager,
} from "@/features/uploads/upload-manager";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function WorkspaceShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { displayName: string; email: string };
}) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <UploadManagerProvider>
        <WorkspaceContent user={user}>{children}</WorkspaceContent>
      </UploadManagerProvider>
    </Tooltip.Provider>
  );
}

function WorkspaceContent({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { displayName: string; email: string };
}) {
  const upload = useUploadManager();
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className="workspace"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        upload.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <Topbar user={user} />
      <Sidebar />
      <div className="workspace-main">{children}</div>
      {dragging ? (
        <div className="upload-drag-overlay" role="status">
          <UploadCloud aria-hidden="true" />
          <strong>拖到这里上传</strong>
          <span>松开即可加入队列</span>
        </div>
      ) : null}
    </div>
  );
}

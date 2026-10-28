"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  UploadManagerProvider,
  useUploadManager,
} from "@/features/uploads/upload-manager";

import { Sidebar } from "./sidebar";
import {
  defaultSidebarMode,
  parseSidebarMode,
  SIDEBAR_STORAGE_KEY,
  type SidebarMode,
} from "./sidebar-preference";
import { Topbar } from "./topbar";
import { useFoldersQuery } from "@/features/folders/folder-client";

const mobileNavigationQuery = "(max-width: 720px)";
const subscribeToMobileNavigation = (onChange: () => void) => {
  const media = window.matchMedia?.(mobileNavigationQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
};
const getMobileNavigationSnapshot = () =>
  window.matchMedia?.(mobileNavigationQuery).matches ?? false;
const getMobileNavigationServerSnapshot = () => false;

export function WorkspaceShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { displayName: string; email: string };
}) {
  useFoldersQuery(true);
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
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const [sidebarMode, setSidebarMode] =
    useState<SidebarMode>("expanded");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mobileNavigation = useSyncExternalStore(
    subscribeToMobileNavigation,
    getMobileNavigationSnapshot,
    getMobileNavigationServerSnapshot,
  );

  useEffect(() => {
    try {
      const stored = parseSidebarMode(
        window.localStorage.getItem(SIDEBAR_STORAGE_KEY),
      );
      setSidebarMode(stored ?? defaultSidebarMode(window.innerWidth));
    } catch {
      setSidebarMode(defaultSidebarMode(window.innerWidth));
    }
  }, []);

  const toggleNavigation = () => {
    if (mobileNavigation) {
      setMobileNavigationOpen((open) => !open);
      return;
    }

    setSidebarMode((current) => {
      const next = current === "expanded" ? "collapsed" : "expanded";
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next);
      } catch {
        // A blocked storage API must not prevent navigation.
      }
      return next;
    });
  };

  const navigationExpanded = mobileNavigation
    ? mobileNavigationOpen
    : sidebarMode === "expanded";

  return (
    <div
      className="workspace"
      aria-label="图案工作区"
      data-mobile-navigation={mobileNavigationOpen ? "open" : "closed"}
      data-sidebar={sidebarMode}
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
      <Topbar
        mobileNavigation={mobileNavigation}
        navigationExpanded={navigationExpanded}
        navigationTriggerRef={navigationTriggerRef}
        onToggleNavigation={toggleNavigation}
        user={user}
      />
      {mobileNavigation ? (
        <Dialog.Root
          open={mobileNavigationOpen}
          onOpenChange={setMobileNavigationOpen}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="mobile-navigation-overlay" />
            <Dialog.Content
              aria-describedby={undefined}
              className="mobile-navigation-dialog"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                navigationTriggerRef.current?.focus();
              }}
            >
              <Dialog.Title className="sr-only">主导航</Dialog.Title>
              <div className="mobile-navigation-header">
                <strong>melon</strong>
                <button
                  aria-label="关闭主导航"
                  className="icon-button"
                  onClick={() => setMobileNavigationOpen(false)}
                  title="关闭主导航"
                  type="button"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <Sidebar
                collapsed={false}
                onNavigate={() => setMobileNavigationOpen(false)}
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <Sidebar collapsed={sidebarMode === "collapsed"} />
      )}
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

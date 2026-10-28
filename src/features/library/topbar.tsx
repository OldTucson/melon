"use client";

import {
  Cloud,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Search,
  Upload,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useUploadManager } from "@/features/uploads/upload-manager";
import { useImageSearchStore } from "@/features/image-search/image-search-store";

import { IconButton } from "./icon-button";

export function Topbar({
  mobileNavigation,
  navigationExpanded,
  navigationTriggerRef,
  onToggleNavigation,
  user,
}: {
  mobileNavigation: boolean;
  navigationExpanded: boolean;
  navigationTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggleNavigation: () => void;
  user: { displayName: string; email: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const upload = useUploadManager();
  const requestImageSearch = useImageSearchStore((state) => state.requestOpen);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const params =
      pathname === "/library"
        ? new URLSearchParams(searchParams.toString())
        : new URLSearchParams();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const value = String(form.get("q") ?? "").trim();
    if (value) params.set("q", value);
    else params.delete("q");
    params.delete("cursor");
    const suffix = params.toString();
    router.replace(`/library${suffix ? `?${suffix}` : ""}`);
  };

  return (
    <header className="workspace-topbar">
      <button
        aria-expanded={navigationExpanded}
        aria-label={
          mobileNavigation
            ? navigationExpanded
              ? "关闭主导航"
              : "打开主导航"
            : navigationExpanded
              ? "折叠主导航"
              : "展开主导航"
        }
        className="icon-button workspace-navigation-toggle"
        onClick={onToggleNavigation}
        ref={navigationTriggerRef}
        title={
          mobileNavigation
            ? navigationExpanded
              ? "关闭主导航"
              : "打开主导航"
            : navigationExpanded
              ? "折叠主导航"
              : "展开主导航"
        }
        type="button"
      >
        {mobileNavigation ? (
          <Menu aria-hidden="true" />
        ) : navigationExpanded ? (
          <PanelLeftClose aria-hidden="true" />
        ) : (
          <PanelLeftOpen aria-hidden="true" />
        )}
      </button>
      <Link className="workspace-brand" href="/library" aria-label="melon 图案库">
        <span className="workspace-brand-full">melon</span>
        <span aria-hidden="true" className="workspace-brand-mark">m</span>
      </Link>
      <form className="global-search" role="search" onSubmit={submitSearch}>
        <Search aria-hidden="true" />
        <input
          key={`${pathname}:${searchParams.get("q") ?? ""}`}
          aria-label="搜索图案"
          defaultValue={
            pathname === "/library" ? (searchParams.get("q") ?? "") : ""
          }
          name="q"
          placeholder="搜索名称或文件名"
        />
        {pathname === "/library" ? (
          <IconButton
            className="image-search-trigger"
            label="以图搜图"
            onClick={requestImageSearch}
          >
            <ScanSearch aria-hidden="true" />
          </IconButton>
        ) : null}
      </form>
      <div className="topbar-actions">
        <span className="online-status" title="服务器连接正常">
          <Cloud aria-hidden="true" />
          <span>在线</span>
        </span>
        <button
          className="topbar-upload-button"
          type="button"
          onClick={upload.openFilePicker}
          title="上传图案"
          aria-label="上传图案"
        >
          <Upload aria-hidden="true" />
          <span>上传</span>
        </button>
        <Link
          className="account-link"
          href="/settings"
          aria-label="打开账户设置"
          title="打开账户设置"
        >
          <UserRound aria-hidden="true" />
          <span className="account-copy">
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </span>
        </Link>
      </div>
    </header>
  );
}

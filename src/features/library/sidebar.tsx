"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Clock3,
  Heart,
  ImageIcon,
  Settings,
  Tag,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type { TagItem } from "./library-types";
import { FolderTree } from "@/features/folders/folder-tree";

const primaryItems = [
  { id: "all", href: "/library", icon: ImageIcon, label: "全部图案" },
  {
    id: "recent",
    href: "/library?sort=updated_desc",
    icon: Clock3,
    label: "最近使用",
  },
  {
    id: "untagged",
    href: "/library?untagged=true",
    icon: Tag,
    label: "未打标签",
  },
  {
    id: "favorite",
    href: "/library?favorite=true",
    icon: Heart,
    label: "收藏",
  },
] as const;

async function loadTags() {
  return readApiResponse<TagItem[]>(await fetch("/api/tags"));
}

export function Sidebar({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ownerId = useQueryOwnerId();
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags(ownerId),
    queryFn: loadTags,
  });
  const activeView = getActiveView(pathname, searchParams);

  return (
    <nav
      className="workspace-sidebar"
      aria-label="主导航"
      data-collapsed={collapsed ? "true" : "false"}
      onClickCapture={(event) => {
        if ((event.target as Element).closest("a")) onNavigate?.();
      }}
    >
      <div className="sidebar-section">
        {primaryItems.map(({ id, href, icon: Icon, label }) => {
          const active = activeView === id;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className="sidebar-link"
              data-active={active ? "true" : undefined}
              href={href}
              key={href}
              title={label}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>

      <FolderTree />

      <div className="sidebar-section sidebar-tags" aria-label="标签">
        <p className="sidebar-section-label">标签</p>
        {tagsQuery.isPending ? (
          <p className="sidebar-section-message">正在载入...</p>
        ) : tagsQuery.isError ? (
          <p className="sidebar-section-message">标签暂时无法载入</p>
        ) : tagsQuery.data.length === 0 ? (
          <p className="sidebar-section-message">还没有标签</p>
        ) : (
          tagsQuery.data.map((tag) => {
            const active = activeView === `tag:${tag.id}`;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className="sidebar-link sidebar-tag-link"
                data-active={active ? "true" : undefined}
                href={`/library?tag=${tag.id}`}
                key={tag.id}
                title={tag.name}
              >
                <span
                  aria-hidden="true"
                  className="tag-swatch"
                  data-color-token={tag.colorToken}
                  data-testid="tag-swatch"
                />
                <span>{tag.name}</span>
              </Link>
            );
          })
        )}
      </div>

      <div className="sidebar-section sidebar-secondary">
        <Link
          aria-current={activeView === "dashboard" ? "page" : undefined}
          className="sidebar-link"
          data-active={activeView === "dashboard" ? "true" : undefined}
          href="/dashboard"
          title="数据看板"
        >
          <BarChart3 aria-hidden="true" />
          <span>数据看板</span>
        </Link>
        <Link
          className="sidebar-link"
          href="/trash"
          aria-current={activeView === "trash" ? "page" : undefined}
          data-active={activeView === "trash" ? "true" : undefined}
          title="回收站"
        >
          <Trash2 aria-hidden="true" />
          <span>回收站</span>
        </Link>
        <Link
          aria-current={activeView === "settings" ? "page" : undefined}
          className="sidebar-link"
          data-active={activeView === "settings" ? "true" : undefined}
          href="/settings"
          title="设置"
        >
          <Settings aria-hidden="true" />
          <span>设置</span>
        </Link>
      </div>
    </nav>
  );
}

function getActiveView(pathname: string, searchParams: URLSearchParams) {
  if (pathname === "/dashboard") return "dashboard";
  if (pathname === "/trash") return "trash";
  if (pathname === "/settings") return "settings";
  if (pathname !== "/library") return null;
  if (searchParams.has("folderId") || searchParams.get("unfiled") === "true")
    return null;
  if (searchParams.get("untagged") === "true") return "untagged";
  if (searchParams.get("favorite") === "true") return "favorite";

  const tagIds = [
    ...searchParams.getAll("tag"),
    ...searchParams.getAll("tagIds"),
  ];
  if (tagIds.length === 1) return `tag:${tagIds[0]}`;
  if (searchParams.has("sort") && searchParams.get("sort") === "updated_desc") {
    return "recent";
  }
  return "all";
}

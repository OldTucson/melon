"use client";

import {
  BarChart3,
  Clock3,
  Heart,
  ImageIcon,
  Settings,
  Tags,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const primaryItems = [
  { href: "/library", icon: ImageIcon, label: "全部图案" },
  { href: "/library?sort=updated_desc", icon: Clock3, label: "最近使用" },
  { href: "/library?favorite=true", icon: Heart, label: "收藏" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="workspace-sidebar" aria-label="主导航">
      <div className="sidebar-section">
        {primaryItems.map(({ href, icon: Icon, label }, index) => (
          <Link
            className="sidebar-link"
            data-active={pathname === "/library" && index === 0 ? "true" : undefined}
            href={href}
            key={href}
            title={label}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
      </div>

      <div className="sidebar-section sidebar-secondary">
        <span
          className="sidebar-link sidebar-link-disabled"
          aria-disabled="true"
          title="数据看板将在商业授权阶段开放"
        >
          <BarChart3 aria-hidden="true" />
          <span>数据看板</span>
        </span>
        <span
          className="sidebar-link sidebar-link-disabled"
          aria-disabled="true"
          title="回收站将在删除流程接入后开放"
        >
          <Trash2 aria-hidden="true" />
          <span>回收站</span>
        </span>
        <span
          className="sidebar-link sidebar-link-disabled"
          aria-disabled="true"
          title="标签可在图案检查器中管理"
        >
          <Tags aria-hidden="true" />
          <span>标签</span>
        </span>
        <Link
          className="sidebar-link"
          data-active={pathname === "/settings" ? "true" : undefined}
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

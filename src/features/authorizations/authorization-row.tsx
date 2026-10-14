"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Pencil, RotateCcw, Ban } from "lucide-react";

import {
  formatFenForDisplay,
  type AuthorizationDto,
} from "./api";

const kindLabels = {
  standard: "普通",
  field_exclusive: "独占",
  global_buyout: "买断",
} as const;

export function AuthorizationRow({
  authorization,
  onEdit,
  onRestore,
  onVoid,
}: {
  authorization: AuthorizationDto;
  onEdit: () => void;
  onRestore: () => void;
  onVoid: () => void;
}) {
  const isVoid = authorization.status === "void";
  return (
    <article
      className="authorization-row"
      data-status={authorization.status}
      aria-label={`${authorization.licenseeName}授权记录`}
    >
      <div className="authorization-row-heading">
        <div>
          <strong>{authorization.licenseeName}</strong>
          <span>
            {kindLabels[authorization.kind]}
            {authorization.fieldNameSnapshot
              ? ` · ${authorization.fieldNameSnapshot}`
              : " · 全领域"}
          </span>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="icon-button authorization-row-menu"
              type="button"
              aria-label={`更多操作 ${authorization.licenseeName}`}
              title="更多操作"
            >
              <Ellipsis aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="filter-menu-content authorization-menu-content"
              sideOffset={5}
              align="end"
            >
              {isVoid ? (
                <DropdownMenu.Item
                  className="filter-menu-item"
                  onSelect={onRestore}
                >
                  <RotateCcw aria-hidden="true" />
                  <span />
                  <span>恢复记录</span>
                </DropdownMenu.Item>
              ) : (
                <>
                  <DropdownMenu.Item
                    className="filter-menu-item"
                    onSelect={onEdit}
                  >
                    <Pencil aria-hidden="true" />
                    <span />
                    <span>编辑记录</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="filter-menu-item"
                    onSelect={onVoid}
                  >
                    <Ban aria-hidden="true" />
                    <span />
                    <span>作废记录</span>
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="authorization-row-meta">
        <time dateTime={authorization.authorizedOn}>
          {authorization.authorizedOn}
        </time>
        <strong>{formatFenForDisplay(authorization.priceFen)}</strong>
      </div>
      {isVoid ? <span className="authorization-void-label">已作废</span> : null}
      {authorization.note ? (
        <p title={authorization.note}>{authorization.note}</p>
      ) : null}
    </article>
  );
}

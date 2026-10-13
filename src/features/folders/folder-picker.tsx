"use client";

import { useId } from "react";
import { buildFolderTree, type FolderNode } from "./folder-tree-model";
import type { FolderCacheItem } from "./folder-client";

type Destination = Pick<
  FolderCacheItem,
  "id" | "name" | "parentId" | "status" | "optimisticCreate"
>;

export function FolderPicker({
  folders,
  value,
  onChange,
  disabled = false,
}: {
  folders: readonly Destination[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const tree = buildFolderTree(
    folders.filter(
      (folder) => folder.status === "active" && !folder.optimisticCreate,
    ),
  );
  const option = (
    id: string | null,
    label: string,
    path: string,
    depth: number,
  ) => (
    <label
      className="folder-picker-option"
      key={id ?? "unfiled"}
      style={{ paddingInlineStart: 8 + depth * 16 }}
    >
      <input
        type="radio"
        name={name}
        aria-label={path}
        checked={value === id}
        disabled={disabled}
        onChange={() => onChange(id)}
      />
      <span title={path}>{label}</span>
    </label>
  );
  const nodes = (
    items: FolderNode<Destination>[],
    parent = "",
    depth = 0,
  ): React.ReactNode =>
    items.map(({ folder, children }) => {
      const path = parent ? `${parent} / ${folder.name}` : folder.name;
      return (
        <div key={folder.id}>
          {option(folder.id, folder.name, path, depth)}
          {nodes(children, path, depth + 1)}
        </div>
      );
    });
  return (
    <fieldset className="folder-picker" disabled={disabled}>
      <legend>目标位置</legend>
      {option(null, "未分类", "未分类", 0)}
      {nodes(tree.roots)}
    </fieldset>
  );
}

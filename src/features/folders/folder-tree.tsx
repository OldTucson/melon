"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState } from "react";
import { ResponsivePanel } from "@/components/responsive-panel";
import { useSelectionStore } from "@/features/library/selection-store";
import { ApiResponseError } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";
import {
  type FolderDto,
  type FolderCacheItem,
  useFoldersQuery,
} from "./folder-client";
import { FolderDeleteDialog } from "./folder-delete-dialog";
import { folderDeleteImpactSchema } from "./contracts";
import {
  type FolderDeleteImpact,
  folderErrorMessage,
  loadDeleteImpact,
  useCreateFolderMutation,
  useRenameFolderMutation,
  useTrashFolderMutation,
} from "./folder-mutations";
import {
  buildFolderTree,
  folderHref,
  folderSubtree,
  type FolderNode,
} from "./folder-tree-model";

type Draft =
  | { kind: "create"; parentId: string | null; name: string }
  | { kind: "rename"; folder: FolderDto; name: string };
const deleteImpactMatches = (
  left: FolderDeleteImpact,
  right: FolderDeleteImpact,
) =>
  left.folderCount === right.folderCount &&
  left.patternCount === right.patternCount &&
  left.alreadyTrashedFolderCount === right.alreadyTrashedFolderCount &&
  left.alreadyTrashedPatternCount === right.alreadyTrashedPatternCount &&
  left.hasDeletingEntities === right.hasDeletingEntities &&
  left.scopeFingerprint === right.scopeFingerprint;

export function FolderTree() {
  const folders = useFoldersQuery(),
    create = useCreateFolderMutation(),
    rename = useRenameFolderMutation(),
    trash = useTrashFolderMutation();
  const client = useQueryClient(),
    ownerId = useQueryOwnerId(),
    router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const selection = search.get("folderId");
  const [expansion, setExpansion] = useState<{
    selection: string | null;
    overrides: Map<string, boolean>;
  }>(() => ({ selection, overrides: new Map() }));
  if (expansion.selection !== selection)
    setExpansion({ selection, overrides: new Map() });
  const ancestors = new Set<string>();
  let parent = folders.data?.find(
    (folder) => folder.id === selection,
  )?.parentId;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = folders.data?.find((folder) => folder.id === parent)?.parentId;
  }
  const [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{
    folder: FolderDto;
    impact: FolderDeleteImpact;
  } | null>(null);
  const [impactPending, setImpactPending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const submitting = useRef(false);
  const focusEditor = useRef(false);
  const editorInput = useRef<HTMLInputElement>(null);
  const tree = buildFolderTree(folders.data ?? []);
  const draftRowId =
    draft?.kind === "rename" ? draft.folder.id : draft?.parentId;
  const showRootEditor =
    draft &&
    (!draftRowId || !folders.data?.some((folder) => folder.id === draftRowId));
  const pending = create.isPending || rename.isPending;
  const clearContext = () => {
    useSelectionStore.getState().clear();
    setRailOpen(false);
  };
  const startDraft = (next: Draft) => {
    if (pending) return;
    setError(null);
    setDraft(next);
  };
  const setOpen = (id: string, open: boolean) =>
    setExpansion((old) => ({
      ...old,
      overrides: new Map(old.overrides).set(id, open),
    }));
  const expand = (id: string) => setOpen(id, true);
  const submit = async () => {
    if (!draft || submitting.current || !draft.name.trim()) return;
    submitting.current = true;
    setError(null);
    const operationId = crypto.randomUUID();
    try {
      if (draft.kind === "create")
        await create.mutateAsync({
          operationId,
          input: { name: draft.name, parentId: draft.parentId },
        });
      else
        await rename.mutateAsync({
          id: draft.folder.id,
          operationId,
          patch: { name: draft.name, version: draft.folder.version },
        });
      setDraft(null);
    } catch (cause) {
      setError(folderErrorMessage(cause));
    } finally {
      submitting.current = false;
    }
  };
  const previewDelete = async (folder: FolderDto) => {
    if (impactPending) return;
    setError(null);
    setImpactPending(true);
    try {
      setDeletion({ folder, impact: await loadDeleteImpact(folder.id) });
    } catch (cause) {
      setError(folderErrorMessage(cause));
    } finally {
      setImpactPending(false);
    }
  };
  const confirmDelete = async () => {
    if (
      !deletion ||
      deletion.impact.hasDeletingEntities ||
      impactPending ||
      submitting.current
    )
      return;
    submitting.current = true;
    setError(null);
    setImpactPending(true);
    const snapshot =
      client.getQueryData<FolderCacheItem[]>(queryKeys.folders(ownerId)) ?? [];
    const removed = folderSubtree(snapshot, deletion.folder.id);
    try {
      const currentImpact = await loadDeleteImpact(deletion.folder.id);
      if (!deleteImpactMatches(deletion.impact, currentImpact)) {
        setDeletion({ folder: deletion.folder, impact: currentImpact });
        setError("删除范围已变化，请核对后再次确认");
        return;
      }
      await trash.mutateAsync({
        id: deletion.folder.id,
        version: deletion.folder.version,
        operationId: crypto.randomUUID(),
        expectedImpact: currentImpact,
      });
      if (search.get("folderId") && removed.has(search.get("folderId")!)) {
        const active =
          client.getQueryData<FolderCacheItem[]>(queryKeys.folders(ownerId)) ??
          [];
        const seen = new Set<string>();
        let ancestor = deletion.folder.parentId;
        while (ancestor && !seen.has(ancestor)) {
          seen.add(ancestor);
          if (
            !removed.has(ancestor) &&
            active.some(
              (folder) => folder.id === ancestor && folder.status === "active",
            )
          )
            break;
          ancestor =
            snapshot.find((folder) => folder.id === ancestor)?.parentId ?? null;
        }
        if (
          ancestor &&
          (removed.has(ancestor) ||
            !active.some(
              (folder) => folder.id === ancestor && folder.status === "active",
            ))
        )
          ancestor = null;
        clearContext();
        router.replace(
          folderHref(new URLSearchParams(search.toString()), ancestor),
        );
      }
      setDeletion(null);
    } catch (cause) {
      if (
        cause instanceof ApiResponseError &&
        cause.code === "FOLDER_DELETE_SCOPE_CHANGED"
      ) {
        const latestImpact = folderDeleteImpactSchema.safeParse(cause.details);
        if (latestImpact.success) {
          setDeletion({ folder: deletion.folder, impact: latestImpact.data });
          setError("删除范围已变化，请核对后再次确认");
        } else {
          setError(folderErrorMessage(cause));
        }
      } else {
        setError(folderErrorMessage(cause));
      }
    } finally {
      setImpactPending(false);
      submitting.current = false;
    }
  };
  const editor = () =>
    draft && (
      <form
        className="folder-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={editorInput}
          aria-label="文件夹名称"
          autoFocus
          disabled={pending}
          maxLength={80}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.preventDefault();
              setDraft(null);
              setError(null);
            }
          }}
        />
        <button
          className="folder-icon-button"
          type="submit"
          title="保存文件夹"
          aria-label="保存文件夹"
          disabled={pending || !draft.name.trim()}
        >
          <Check aria-hidden="true" />
        </button>
      </form>
    );
  const renderNode = (
    node: FolderNode<FolderCacheItem>,
    depth: number,
  ): React.ReactNode => {
    const { folder, children } = node,
      open = expansion.overrides.get(folder.id) ?? ancestors.has(folder.id);
    const active =
      pathname === "/library" &&
      search.get("unfiled") !== "true" &&
      search.get("folderId") === folder.id;
    return (
      <li key={folder.id}>
        <div
          className="folder-row"
          data-active={active || undefined}
          style={{ paddingLeft: Math.min(depth, 6) * 12 }}
        >
          {children.length > 0 ? (
            <button
              className="folder-icon-button"
              type="button"
              aria-label={`${open ? "收起" : "展开"}${folder.name}`}
              title={`${open ? "收起" : "展开"}${folder.name}`}
              aria-expanded={open}
              onClick={() => setOpen(folder.id, !open)}
            >
              <ChevronRight
                aria-hidden="true"
                className={open ? "folder-chevron-open" : undefined}
              />
            </button>
          ) : (
            <span className="folder-spacer" />
          )}
          {folder.optimisticCreate ? (
            <div
              className="folder-link"
              role="status"
              aria-label={`正在创建${folder.name}`}
              aria-busy="true"
              title={folder.name}
            >
              <Folder aria-hidden="true" />
              <span>{folder.name}</span>
              <span className="folder-count">创建中</span>
            </div>
          ) : draft?.kind === "rename" && draft.folder.id === folder.id ? (
            editor()
          ) : (
            <Link
              className="folder-link"
              aria-label={folder.name}
              title={folder.name}
              aria-current={active ? "page" : undefined}
              href={folderHref(
                new URLSearchParams(search.toString()),
                folder.id,
              )}
              onClick={clearContext}
            >
              {open ? (
                <FolderOpen aria-hidden="true" />
              ) : (
                <Folder aria-hidden="true" />
              )}
              <span>{folder.name}</span>
              <span className="folder-count" aria-hidden="true">
                {folder.recursivePatternCount}
              </span>
            </Link>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="folder-icon-button"
                aria-label={`${folder.name}的操作`}
                title={`${folder.name}的操作`}
                disabled={
                  Boolean(folder.optimisticCreate) || pending || impactPending
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="filter-menu-content"
                sideOffset={4}
                onCloseAutoFocus={(event) => {
                  if (focusEditor.current) {
                    event.preventDefault();
                    focusEditor.current = false;
                    editorInput.current?.focus();
                  }
                }}
              >
                <DropdownMenu.Item
                  className="folder-menu-item"
                  onSelect={() => {
                    focusEditor.current = true;
                    expand(folder.id);
                    startDraft({
                      kind: "create",
                      parentId: folder.id,
                      name: "",
                    });
                  }}
                >
                  <Plus aria-hidden="true" />
                  新建子文件夹
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="folder-menu-item"
                  onSelect={() => {
                    focusEditor.current = true;
                    startDraft({ kind: "rename", folder, name: folder.name });
                  }}
                >
                  <Pencil aria-hidden="true" />
                  重命名
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="folder-menu-item"
                  onSelect={() => void previewDelete(folder)}
                >
                  <Trash2 aria-hidden="true" />
                  移入回收站
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {open && (
          <ul className="folder-children">
            {children.map((child) => renderNode(child, depth + 1))}
            {draft?.kind === "create" && draft.parentId === folder.id && (
              <li style={{ paddingLeft: Math.min(depth + 1, 6) * 12 }}>
                {editor()}
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };
  return (
    <section
      className="sidebar-section sidebar-folders"
      aria-label="文件夹"
      data-rail-open={railOpen}
      onKeyDown={(event) => {
        if (event.key === "Escape" && railOpen && !draft && !deletion) {
          setRailOpen(false);
          railTrigger.current?.focus();
        }
      }}
    >
      <button
        className="folder-icon-button folder-rail-toggle"
        ref={railTrigger}
        type="button"
        title="浏览文件夹"
        aria-label="浏览文件夹"
        aria-controls={panelId}
        aria-expanded={railOpen}
        onClick={() => setRailOpen((open) => !open)}
      >
        <Folder aria-hidden="true" />
      </button>
      <ResponsivePanel
        className="folder-tree-content"
        id={panelId}
        label="文件夹"
        open={railOpen}
        onClose={() => setRailOpen(false)}
        returnFocus={() => railTrigger.current}
      >
        <div className="folder-section-heading">
          <p className="sidebar-section-label">文件夹</p>
          <button
            className="folder-icon-button folder-panel-close"
            type="button"
            aria-label="关闭文件夹"
            title="关闭文件夹"
            onClick={() => setRailOpen(false)}
          >
            <X aria-hidden="true" />
          </button>
          <button
            className="folder-icon-button"
            type="button"
            aria-label="新建文件夹"
            title="新建文件夹"
            disabled={pending}
            onClick={() =>
              startDraft({ kind: "create", parentId: null, name: "" })
            }
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        <Link
          className="folder-link folder-unfiled"
          aria-current={
            pathname === "/library" && search.get("unfiled") === "true"
              ? "page"
              : undefined
          }
          href={folderHref(new URLSearchParams(search.toString()), "unfiled")}
          onClick={clearContext}
        >
          <Folder aria-hidden="true" />
          <span>未分类</span>
        </Link>
        {showRootEditor && editor()}
        <ul className="folder-children" aria-label="文件夹树">
          {tree.roots.map((node) => renderNode(node, 0))}
        </ul>
        {process.env.NODE_ENV !== "production" && tree.ungrouped.length > 0 && (
          <>
            <p className="sidebar-section-message">未分组（层级异常）</p>
            <ul className="folder-children">
              {tree.ungrouped.map((node) => renderNode(node, 0))}
            </ul>
          </>
        )}
        {folders.isLoading && (
          <p className="sidebar-section-message">正在载入文件夹...</p>
        )}
        {folders.isError && <p role="alert">文件夹暂时无法载入</p>}
        {impactPending && <p role="status">正在计算删除影响...</p>}
        {error && !deletion && (
          <p className="folder-error" role="alert">
            {error}
          </p>
        )}
        {deletion && (
          <FolderDeleteDialog
            name={deletion.folder.name}
            impact={deletion.impact}
            pending={impactPending || trash.isPending}
            error={error}
            onCancel={() => {
              setDeletion(null);
              setError(null);
            }}
            onConfirm={() => void confirmDelete()}
          />
        )}
      </ResponsivePanel>
    </section>
  );
}

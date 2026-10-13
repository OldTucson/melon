import {
  parseLibrarySearchParams,
  serializeLibrarySearchParams,
} from "@/features/library/query-state";

type FolderRef = { id: string; parentId: string | null; name: string };
export type FolderNode<T extends FolderRef> = {
  folder: T;
  children: FolderNode<T>[];
};

/** Invalid parent chains are isolated, so even corrupt API input is safe to render. */
export function buildFolderTree<T extends FolderRef>(folders: readonly T[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const valid = new Map<string, boolean>();
  for (const folder of folders) {
    const path = new Set<string>();
    let current: T | undefined = folder;
    let ok = true;
    while (current) {
      if (valid.has(current.id)) {
        ok = valid.get(current.id)!;
        break;
      }
      if (path.has(current.id)) {
        ok = false;
        break;
      }
      path.add(current.id);
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
      if (!current) ok = false;
    }
    for (const id of path) valid.set(id, ok);
  }
  const nodes = new Map(
    folders.map((folder) => [
      folder.id,
      { folder, children: [] } as FolderNode<T>,
    ]),
  );
  const roots: FolderNode<T>[] = [],
    ungrouped: FolderNode<T>[] = [];
  const sorted = [...folders].sort(
    (a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id),
  );
  for (const folder of sorted) {
    const node = nodes.get(folder.id)!;
    if (!valid.get(folder.id)) ungrouped.push(node);
    else if (folder.parentId === null) roots.push(node);
    else nodes.get(folder.parentId)!.children.push(node);
  }
  return { roots, ungrouped };
}

export function folderSubtree(
  folders: readonly Pick<FolderRef, "id" | "parentId">[],
  id: string,
) {
  const result = new Set([id]);
  const children = new Map<string, string[]>();
  for (const folder of folders)
    if (folder.parentId)
      children.set(folder.parentId, [
        ...(children.get(folder.parentId) ?? []),
        folder.id,
      ]);
  const pending = [id];
  while (pending.length)
    for (const child of children.get(pending.pop()!) ?? [])
      if (!result.has(child)) {
        result.add(child);
        pending.push(child);
      }
  return result;
}

export function folderHref(
  search: URLSearchParams,
  target: string | null,
  includeDescendants?: boolean,
) {
  const state = parseLibrarySearchParams(
    new URLSearchParams(search.toString()),
  );
  state.formats = [...new Set(state.formats)];
  state.tagIds = [...new Set(state.tagIds)];
  state.cursor = undefined;
  state.scope = "library";
  state.folderId = target && target !== "unfiled" ? target : undefined;
  state.unfiled = target === "unfiled" ? true : undefined;
  state.includeDescendants = state.folderId
    ? (includeDescendants ?? state.includeDescendants)
    : true;
  const query = serializeLibrarySearchParams(state).toString();
  return `/library${query ? `?${query}` : ""}`;
}

import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  folderHref,
  folderSubtree,
} from "./folder-tree-model";

describe("folder tree model", () => {
  it("handles child before parent, sorts ties by id, and never mutates input", () => {
    const input = [
      { id: "c", parentId: "a", name: "孩子" },
      { id: "b", parentId: null, name: "同名" },
      { id: "a", parentId: null, name: "同名" },
    ];
    const before = structuredClone(input);
    const tree = buildFolderTree(input);
    expect(tree.roots.map((n) => n.folder.id)).toEqual(["a", "b"]);
    expect(tree.roots[0]!.children[0]!.folder.id).toBe("c");
    expect(input).toEqual(before);
  });
  it("terminates with orphan, self-cycle and multi-node cycles in diagnostics", () => {
    const input = [
      { id: "o", parentId: "missing", name: "孤立" },
      { id: "s", parentId: "s", name: "自身" },
      { id: "a", parentId: "b", name: "甲" },
      { id: "b", parentId: "a", name: "乙" },
      { id: "c", parentId: "a", name: "子" },
    ];
    const tree = buildFolderTree(input);
    expect(tree.roots).toEqual([]);
    expect(new Set(tree.ungrouped.map((n) => n.folder.id))).toEqual(
      new Set(input.map((n) => n.id)),
    );
    expect(folderSubtree(input, "a")).toEqual(new Set(["a", "b", "c"]));
  });
  it("canonicalizes aliases, preserves filters, and clears paging/unfiled", () => {
    const source = new URLSearchParams(
      "q=花&formats=png&format=jpg&format=png&tagIds=b&tag=a&tagMode=any&favorite=true&untagged=false&previewStatus=ready&sort=name_asc&limit=20&scope=trash&cursor=old&unfiled=true&includeDescendants=false&unknown=x",
    );
    const url = new URL(folderHref(source, "a/b"), "https://test");
    expect(url.searchParams.get("folderId")).toBe("a/b");
    expect(url.searchParams.getAll("format")).toEqual(["jpg", "png"]);
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(url.searchParams.get("includeDescendants")).toBe("false");
    for (const key of ["cursor", "unfiled", "unknown", "formats", "tagIds"])
      expect(url.searchParams.has(key)).toBe(false);
    expect(url.searchParams.get("q")).toBe("花");
    expect(url.searchParams.has("scope")).toBe(false);
    const unfiled = new URL(folderHref(source, "unfiled"), "https://test");
    expect(unfiled.searchParams.get("unfiled")).toBe("true");
    expect(unfiled.searchParams.has("scope")).toBe(false);
    for (const key of ["folderId", "includeDescendants", "cursor"])
      expect(unfiled.searchParams.has(key)).toBe(false);
    expect(folderHref(new URLSearchParams(), null)).toBe("/library");
  });
});

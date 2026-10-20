import { beforeEach, describe, expect, it } from "vitest";

import { createSelectionStore, type SelectionStore } from "./selection-store";

const orderedIds = ["a", "b", "c", "d", "e"];

describe("library selection store", () => {
  let store: SelectionStore;

  beforeEach(() => {
    store = createSelectionStore();
  });

  it("uses a plain click for one selected pattern", () => {
    store.getState().select("c", orderedIds, {});

    expect(store.getState()).toMatchObject({
      selectedIds: ["c"],
      anchorId: "c",
    });
  });

  it("uses Command to toggle discrete patterns and keeps the clicked anchor", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().select("d", orderedIds, { metaKey: true });
    store.getState().select("b", orderedIds, { metaKey: true });

    expect(store.getState().selectedIds).toEqual(["d"]);
    expect(store.getState().anchorId).toBe("b");
  });

  it("uses Control to toggle discrete patterns on Windows and Linux", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().select("d", orderedIds, { ctrlKey: true });
    store.getState().select("b", orderedIds, { ctrlKey: true });

    expect(store.getState().selectedIds).toEqual(["d"]);
    expect(store.getState().anchorId).toBe("b");
  });

  it("uses Shift for a contiguous range without moving the anchor", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().select("e", orderedIds, { shiftKey: true });

    expect(store.getState().selectedIds).toEqual(["b", "c", "d", "e"]);
    expect(store.getState().anchorId).toBe("b");
  });

  it("clears selection, inspector, and preview on Escape", () => {
    store.getState().select("c", orderedIds, {});
    store.getState().openInspector(["c"]);
    store.getState().openPreview("c");
    store.getState().clear();

    expect(store.getState()).toMatchObject({
      selectedIds: [],
      anchorId: null,
      inspectorIds: [],
      previewId: null,
    });
  });

  it("tracks inspector targets independently from checkbox selection", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().openInspector(["d"]);

    expect(store.getState()).toMatchObject({
      selectedIds: ["b"],
      inspectorIds: ["d"],
    });

    store.getState().closeInspector();

    expect(store.getState()).toMatchObject({
      selectedIds: ["b"],
      inspectorIds: [],
    });
  });

  it("clears only checkbox selection without closing inspector or preview", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().openInspector(["d"]);
    store.getState().openPreview("c");

    store.getState().clearSelected();

    expect(store.getState()).toMatchObject({
      anchorId: null,
      selectedIds: [],
      inspectorIds: ["d"],
      previewId: "c",
    });
  });

  it("toggles quick preview for the current selection", () => {
    store.getState().select("c", orderedIds, {});
    store.getState().togglePreview();
    expect(store.getState().previewId).toBe("c");

    store.getState().togglePreview();
    expect(store.getState().previewId).toBeNull();
  });

  it("removes selections and previews that disappear from the result set", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().select("d", orderedIds, { metaKey: true });
    store.getState().openInspector(["b"]);
    store.getState().openPreview("b");

    store.getState().reconcile(["a", "d", "e"]);

    expect(store.getState()).toMatchObject({
      selectedIds: ["d"],
      anchorId: "d",
      inspectorIds: [],
      previewId: null,
    });
  });

  it("selects every loaded pattern and anchors the last loaded pattern", () => {
    store.getState().selectAll(["a", "b", "c"]);

    expect(store.getState()).toMatchObject({
      selectedIds: ["a", "b", "c"],
      anchorId: "c",
    });
  });

  it("removes only explicit selections and repairs anchor and preview", () => {
    store.getState().selectAll(["a", "b", "c", "d"]);
    store.getState().openPreview("d");

    store.getState().removeSelected(["b", "d"]);

    expect(store.getState()).toMatchObject({
      selectedIds: ["a", "c"],
      anchorId: "a",
      previewId: null,
    });
  });
});

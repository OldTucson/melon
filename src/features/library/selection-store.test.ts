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

  it("uses Shift for a contiguous range without moving the anchor", () => {
    store.getState().select("b", orderedIds, {});
    store.getState().select("e", orderedIds, { shiftKey: true });

    expect(store.getState().selectedIds).toEqual(["b", "c", "d", "e"]);
    expect(store.getState().anchorId).toBe("b");
  });

  it("clears selection and preview on Escape", () => {
    store.getState().select("c", orderedIds, {});
    store.getState().openPreview("c");
    store.getState().clear();

    expect(store.getState()).toMatchObject({
      selectedIds: [],
      anchorId: null,
      previewId: null,
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
    store.getState().openPreview("b");

    store.getState().reconcile(["a", "d", "e"]);

    expect(store.getState()).toMatchObject({
      selectedIds: ["d"],
      anchorId: "d",
      previewId: null,
    });
  });
});

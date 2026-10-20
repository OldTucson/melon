import { create } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export type SelectionModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export type SelectionState = {
  anchorId: string | null;
  inspectorIds: string[];
  previewId: string | null;
  selectedIds: string[];
  clear: () => void;
  clearSelected: () => void;
  closeInspector: () => void;
  closePreview: () => void;
  openInspector: (ids: readonly string[]) => void;
  openPreview: (id: string) => void;
  reconcile: (orderedIds: readonly string[]) => void;
  removeSelected: (ids: readonly string[]) => void;
  select: (
    id: string,
    orderedIds: readonly string[],
    modifiers: SelectionModifiers,
  ) => void;
  selectAll: (orderedIds: readonly string[]) => void;
  togglePreview: () => void;
};

const selectionState = (
  set: StoreApi<SelectionState>["setState"],
  get: StoreApi<SelectionState>["getState"],
): SelectionState => ({
  anchorId: null,
  inspectorIds: [],
  previewId: null,
  selectedIds: [],
  clear: () =>
    set({ anchorId: null, inspectorIds: [], previewId: null, selectedIds: [] }),
  clearSelected: () => set({ anchorId: null, selectedIds: [] }),
  closeInspector: () => set({ inspectorIds: [] }),
  closePreview: () => set({ previewId: null }),
  openInspector: (ids) => set({ inspectorIds: [...new Set(ids)] }),
  openPreview: (id) => set({ previewId: id }),
  reconcile: (orderedIds) =>
    set((current) => {
      const available = new Set(orderedIds);
      const selectedIds = current.selectedIds.filter((id) => available.has(id));
      const inspectorIds = current.inspectorIds.filter((id) => available.has(id));
      const anchorId =
        current.anchorId && available.has(current.anchorId)
          ? current.anchorId
          : (selectedIds[0] ?? null);
      const previewId =
        current.previewId && available.has(current.previewId)
          ? current.previewId
          : null;
      if (
        selectedIds.length === current.selectedIds.length &&
        inspectorIds.length === current.inspectorIds.length &&
        anchorId === current.anchorId &&
        previewId === current.previewId
      ) {
        return current;
      }
      return { selectedIds, inspectorIds, anchorId, previewId };
    }),
  removeSelected: (ids) =>
    set((current) => {
      const removed = new Set(ids);
      const selectedIds = current.selectedIds.filter((id) => !removed.has(id));
      const inspectorIds = current.inspectorIds.filter((id) => !removed.has(id));
      return {
        selectedIds,
        inspectorIds,
        anchorId:
          current.anchorId && removed.has(current.anchorId)
            ? (selectedIds[0] ?? null)
            : current.anchorId,
        previewId:
          current.previewId && removed.has(current.previewId)
            ? null
            : current.previewId,
      };
    }),
  select: (id, orderedIds, modifiers) => {
    const current = get();
    if (modifiers.shiftKey && current.anchorId) {
      const anchorIndex = orderedIds.indexOf(current.anchorId);
      const targetIndex = orderedIds.indexOf(id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        set({ selectedIds: orderedIds.slice(start, end + 1) });
        return;
      }
    }

    if (modifiers.metaKey || modifiers.ctrlKey) {
      const selected = current.selectedIds.includes(id)
        ? current.selectedIds.filter((selectedId) => selectedId !== id)
        : [...current.selectedIds, id];
      set({ anchorId: id, selectedIds: selected });
      return;
    }

    set({ anchorId: id, selectedIds: [id] });
  },
  selectAll: (orderedIds) =>
    set({
      anchorId: orderedIds.at(-1) ?? null,
      selectedIds: [...orderedIds],
    }),
  togglePreview: () => {
    const current = get();
    const selected = current.selectedIds[0];
    if (!selected) {
      set({ previewId: null });
      return;
    }
    set({ previewId: current.previewId === selected ? null : selected });
  },
});

export type SelectionStore = StoreApi<SelectionState>;

export const createSelectionStore = (): SelectionStore =>
  createStore<SelectionState>(selectionState);

export const useSelectionStore = create<SelectionState>(selectionState);

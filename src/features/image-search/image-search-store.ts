"use client";

import { create } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

export type ImageSearchStoreState = {
  dialogOpen: boolean;
  openRequest: number;
  requestOpen: () => void;
  resetForOwner: (ownerId: string) => void;
  setDialogOpen: (open: boolean) => void;
};

const imageSearchState = (): StateCreator<ImageSearchStoreState> => {
  let activeOwnerId: string | undefined;
  return (set) => ({
    dialogOpen: false,
    openRequest: 0,
    requestOpen: () =>
      set((current) => ({
        dialogOpen: true,
        openRequest: current.openRequest + 1,
      })),
    resetForOwner: (ownerId) => {
      if (activeOwnerId === undefined) {
        activeOwnerId = ownerId;
        return;
      }
      if (activeOwnerId === ownerId) return;
      activeOwnerId = ownerId;
      set({ dialogOpen: false, openRequest: 0 });
    },
    setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  });
};

export type ImageSearchStore = StoreApi<ImageSearchStoreState>;

export const createImageSearchStore = (): ImageSearchStore =>
  createStore<ImageSearchStoreState>(imageSearchState());

export const useImageSearchStore = create<ImageSearchStoreState>(
  imageSearchState(),
);

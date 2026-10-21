import { describe, expect, it } from "vitest";

import { createImageSearchStore } from "./image-search-store";

describe("image search transient store", () => {
  it("stores only dialog coordination state and increments every open request", () => {
    const store = createImageSearchStore();

    expect(store.getState()).toMatchObject({
      dialogOpen: false,
      openRequest: 0,
    });

    store.getState().requestOpen();
    store.getState().requestOpen();

    expect(store.getState()).toMatchObject({
      dialogOpen: true,
      openRequest: 2,
    });
    expect(Object.keys(store.getState())).not.toEqual(
      expect.arrayContaining([
        "file",
        "blob",
        "previewUrl",
        "pixels",
        "response",
        "results",
        "selection",
        "persist",
      ]),
    );
  });

  it("resets only when the authenticated owner changes", () => {
    const store = createImageSearchStore();

    store.getState().resetForOwner("owner-a");
    store.getState().requestOpen();
    store.getState().resetForOwner("owner-a");
    expect(store.getState()).toMatchObject({ dialogOpen: true, openRequest: 1 });

    store.getState().resetForOwner("owner-b");
    expect(store.getState()).toMatchObject({ dialogOpen: false, openRequest: 0 });
  });
});

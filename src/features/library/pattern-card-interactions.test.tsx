import * as Tooltip from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PatternItem } from "./library-types";
import { PatternCard } from "./pattern-card";

const item: PatternItem = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000000",
  name: "Leaf",
  originalFilename: "leaf.png",
  extension: "png",
  detectedMimeType: "image/png",
  sizeBytes: "123",
  contentHash: null,
  status: "ready",
  folderId: null,
  trashBatchId: null,
  preTrashStatus: null,
  previewStatus: "ready",
  previewAssetId: "00000000-0000-4000-8000-000000000002",
  thumbnailAssetId: "00000000-0000-4000-8000-000000000003",
  sourceAssetId: "00000000-0000-4000-8000-000000000004",
  isFavorite: false,
  version: 0,
  commercialVersion: 0,
  paletteStatus: "pending",
  palette: [],
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "1",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

function renderCard(overrides: Partial<ComponentProps<typeof PatternCard>> = {}) {
  const props: ComponentProps<typeof PatternCard> = {
    item,
    mode: "grid",
    onFavorite: vi.fn(),
    onInspect: vi.fn(),
    onOpenPreview: vi.fn(),
    onSelect: vi.fn(),
    selected: false,
    ...overrides,
  };
  render(
    <Tooltip.Provider>
      <PatternCard {...props} />
    </Tooltip.Provider>,
  );
  return props;
}

function waitPastInspectDelay() {
  return new Promise((resolve) => setTimeout(resolve, 450));
}

describe("pattern card interactions", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens preview on a real double click without opening a closed inspector", async () => {
    const user = userEvent.setup();
    const props = renderCard();

    await user.dblClick(
      screen.getByRole("button", { name: "打开 Leaf 检查器" }),
    );
    await waitPastInspectDelay();

    expect(props.onOpenPreview).toHaveBeenCalledOnce();
    expect(props.onOpenPreview).toHaveBeenCalledWith(item.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("keeps another item inspected when this card is double clicked", async () => {
    const user = userEvent.setup();
    const onOpenPreview = vi.fn();

    function Harness() {
      const [inspectedId, setInspectedId] = useState("another-pattern");
      return (
        <Tooltip.Provider>
          <output aria-label="当前检查器">{inspectedId}</output>
          <PatternCard
            item={item}
            mode="grid"
            onFavorite={vi.fn()}
            onInspect={setInspectedId}
            onOpenPreview={onOpenPreview}
            onSelect={vi.fn()}
            selected={false}
          />
        </Tooltip.Provider>
      );
    }

    render(<Harness />);
    await user.dblClick(
      screen.getByRole("button", { name: "打开 Leaf 检查器" }),
    );
    await waitPastInspectDelay();

    expect(screen.getByLabelText("当前检查器")).toHaveTextContent(
      "another-pattern",
    );
    expect(onOpenPreview).toHaveBeenCalledOnce();
    expect(onOpenPreview).toHaveBeenCalledWith(item.id);
  });

  it("cancels inspection when a valid second click arrives after 300 ms", async () => {
    vi.useFakeTimers();
    const props = renderCard();
    const media = screen.getByRole("button", { name: "打开 Leaf 检查器" });

    fireEvent.click(media, { detail: 1 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(props.onInspect).not.toHaveBeenCalled();

    fireEvent.click(media, { detail: 2 });
    fireEvent.doubleClick(media, { detail: 2 });
    await act(() => vi.runAllTimersAsync());

    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onOpenPreview).toHaveBeenCalledOnce();
    expect(props.onOpenPreview).toHaveBeenCalledWith(item.id);
  });

  it("recognizes an in-window second pointer click independently of browser detail", async () => {
    vi.useFakeTimers();
    const props = renderCard();
    const media = screen.getByRole("button", { name: "打开 Leaf 检查器" });

    fireEvent.click(media, { detail: 1 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    fireEvent.click(media, { detail: 1 });
    await act(() => vi.runAllTimersAsync());

    expect(props.onInspect).not.toHaveBeenCalled();
    expect(props.onOpenPreview).toHaveBeenCalledOnce();
    expect(props.onOpenPreview).toHaveBeenCalledWith(item.id);
  });

  it("does not reinterpret a second click after the app gesture window", async () => {
    vi.useFakeTimers();
    const props = renderCard();
    const media = screen.getByRole("button", { name: "打开 Leaf 检查器" });

    fireEvent.click(media, { detail: 1 });
    await act(() => vi.advanceTimersByTimeAsync(401));
    expect(props.onInspect).toHaveBeenCalledOnce();

    fireEvent.click(media, { detail: 2 });
    fireEvent.doubleClick(media, { detail: 2 });
    await act(() => vi.runAllTimersAsync());

    expect(props.onInspect).toHaveBeenCalledOnce();
    expect(props.onOpenPreview).not.toHaveBeenCalled();
  });

  it("opens the explicit preview action immediately and cancels pending inspection", async () => {
    vi.useFakeTimers();
    const props = renderCard();
    const media = screen.getByRole("button", { name: "打开 Leaf 检查器" });

    fireEvent.click(media, { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));

    expect(props.onOpenPreview).toHaveBeenCalledOnce();
    expect(props.onOpenPreview).toHaveBeenCalledWith(item.id);
    expect(props.onInspect).not.toHaveBeenCalled();
    await act(() => vi.runAllTimersAsync());
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("opens the inspector only after the pointer single-click delay", async () => {
    const user = userEvent.setup();
    const props = renderCard();

    await user.click(screen.getByRole("button", { name: "打开 Leaf 检查器" }));
    expect(props.onInspect).not.toHaveBeenCalled();

    await waitFor(() => expect(props.onInspect).toHaveBeenCalledOnce(), {
      timeout: 700,
    });
    expect(props.onInspect).toHaveBeenCalledWith(item.id);
    expect(props.onOpenPreview).not.toHaveBeenCalled();
  });

  it("replaces selection from an unmodified pointer checkbox click", () => {
    const props = renderCard();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Leaf" }), {
      detail: 1,
    });

    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(props.onSelect).toHaveBeenCalledWith(item.id, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it.each([
    ["Command", { metaKey: true }],
    ["Control", { ctrlKey: true }],
  ])("forwards %s from a pointer checkbox click", (_label, modifier) => {
    const props = renderCard();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Leaf" }), {
      detail: 1,
      ...modifier,
    });

    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(props.onSelect).toHaveBeenCalledWith(item.id, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...modifier,
    });
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("forwards Shift from a pointer checkbox click", () => {
    const props = renderCard();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Leaf" }), {
      detail: 1,
      shiftKey: true,
    });

    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(props.onSelect).toHaveBeenCalledWith(item.id, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    });
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("uses plain replacement semantics for keyboard checkbox activation", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    const checkbox = screen.getByRole("checkbox", { name: "选择 Leaf" });
    checkbox.focus();

    await user.keyboard(" ");

    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(props.onSelect).toHaveBeenCalledWith(item.id, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("opens the inspector immediately from keyboard activation", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    const media = screen.getByRole("button", { name: "打开 Leaf 检查器" });
    media.focus();

    await user.keyboard("{Enter}");

    expect(props.onInspect).toHaveBeenCalledOnce();
    expect(props.onInspect).toHaveBeenCalledWith(item.id);
    expect(props.onOpenPreview).not.toHaveBeenCalled();
  });
});

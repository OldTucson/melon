import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CLIENT_IMAGE_SEARCH_BYTES } from "./image-search-client";
import {
  ImageSearchDialog,
  type ImageSearchDialogProps,
} from "./image-search-dialog";

const createObjectURL = vi.fn(() => "blob:image-search-preview");
const revokeObjectURL = vi.fn();

function renderDialog(overrides: Partial<ImageSearchDialogProps> = {}) {
  const props: ImageSearchDialogProps = {
    error: null,
    onCancel: vi.fn(),
    onOpenChange: vi.fn(),
    onSearch: vi.fn(),
    open: true,
    phase: "idle",
    ...overrides,
  };
  return {
    props,
    ...render(
      <Tooltip.Provider>
        <ImageSearchDialog {...props} />
      </Tooltip.Provider>,
    ),
  };
}

describe("image search dialog", () => {
  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects, previews, optionally crops, and submits a supported image", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const file = new File(["jpeg"], "query.jpg", { type: "image/jpeg" });

    await user.upload(screen.getByLabelText("选择搜索图片"), file);
    const preview = screen.getByRole("img", { name: "搜索图片预览" });
    expect(preview).toBeVisible();
    Object.defineProperties(preview, {
      naturalHeight: { configurable: true, value: 800 },
      naturalWidth: { configurable: true, value: 1200 },
    });
    fireEvent.load(preview);
    await user.click(screen.getByRole("checkbox", { name: "裁剪搜索区域" }));
    expect(document.querySelector(".ReactCrop")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始搜索" }));

    expect(props.onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ file }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it("accepts a drop or clipboard image without invoking the upload workflow", () => {
    const { props } = renderDialog();
    const dropFile = new File(["png"], "drop.png", { type: "image/png" });
    const pasteFile = new File(["webp"], "paste.webp", { type: "image/webp" });
    const dropzone = screen.getByRole("button", { name: "拖放、粘贴或选择搜索图片" });

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [dropFile], types: ["Files"] },
    });
    expect(screen.getByText("drop.png")).toBeVisible();
    fireEvent.paste(screen.getByRole("dialog"), {
      clipboardData: { files: [pasteFile] },
    });
    expect(screen.getByText("paste.webp")).toBeVisible();
    expect(props.onSearch).not.toHaveBeenCalled();
  });

  it("rejects wrong types and files over 20 MiB", () => {
    renderDialog();
    const input = screen.getByLabelText("选择搜索图片");

    fireEvent.change(input, {
      target: {
        files: [new File(["svg"], "query.svg", { type: "image/svg+xml" })],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("JPG、PNG、WebP、HEIC 或 HEIF");

    const oversized = new File(["jpeg"], "large.jpg", { type: "image/jpeg" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: MAX_CLIENT_IMAGE_SEARCH_BYTES + 1,
    });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(screen.getByRole("alert")).toHaveTextContent("20 MB");
  });

  it("removes the selected image and revokes every preview URL", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const first = new File(["jpeg"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["png"], "second.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("选择搜索图片"), first);
    await user.upload(screen.getByLabelText("选择搜索图片"), second);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-search-preview");
    await user.click(screen.getByRole("button", { name: "移除搜索图片" }));
    expect(screen.queryByRole("img", { name: "搜索图片预览" })).not.toBeInTheDocument();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps an undecodable HEIC searchable without crop controls", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const file = new File(["heic"], "phone.heic", { type: "image/heic" });

    await user.upload(screen.getByLabelText("选择搜索图片"), file);
    fireEvent.error(screen.getByRole("img", { name: "搜索图片预览" }));

    expect(screen.getAllByText("phone.heic")[0]).toBeVisible();
    expect(screen.getByText("此浏览器无法裁剪 HEIC，将搜索整张图片")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "裁剪搜索区域" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始搜索" }));
    expect(props.onSearch).toHaveBeenCalledWith({ file });
  });

  it("shows truthful phases, cancels active work, and handles Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onOpenChange = vi.fn();
    const view = renderDialog({ onCancel, onOpenChange, phase: "processing" });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("分析图片");
    expect(status).toHaveTextContent("查找候选");
    expect(status).toHaveTextContent("精确比对");
    expect(status.querySelectorAll('[data-active="true"]')).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "取消搜索" }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(
      <Tooltip.Provider>
        <ImageSearchDialog
          error={null}
          onCancel={onCancel}
          onOpenChange={onOpenChange}
          onSearch={vi.fn()}
          open
          phase="idle"
        />
      </Tooltip.Provider>,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

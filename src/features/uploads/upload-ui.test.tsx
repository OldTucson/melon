import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadDropzone } from "./upload-dropzone";
import { UploadTray } from "./upload-tray";

afterEach(cleanup);

describe("upload UI", () => {
  it("collapses the upload queue without discarding tasks and expands it again", async () => {
    const user = userEvent.setup();
    const onAbandon = vi.fn();
    const onPause = vi.fn();
    render(
      <UploadTray
        tasks={[
          {
            localTaskId: "one",
            filename: "leaf.png",
            status: "uploading",
            progress: 42,
          },
        ]}
        onAbandon={onAbandon}
        onPause={onPause}
        onRetry={vi.fn()}
        onReselect={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "收起上传队列" }));
    expect(screen.queryByText("leaf.png")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开上传队列" })).toHaveAttribute("aria-expanded", "false");
    expect(onAbandon).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "展开上传队列" }));
    expect(screen.getByText("42%")).toBeVisible();
    expect(screen.getByRole("button", { name: "收起上传队列" })).toHaveAttribute("aria-expanded", "true");
  });

  it("accepts supported files from an accessible dropzone", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    const dropzone = screen.getByRole("button", { name: "选择或拖入图案文件" });

    dropzone.focus();
    await user.keyboard("{Enter}");
    const input = screen.getByLabelText("选择图案文件");
    const file = new File(["png"], "leaf.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("shows stable progress and task controls in the tray", () => {
    render(
      <Tooltip.Provider>
        <UploadTray
          tasks={[
            {
              localTaskId: "local-1",
              filename: "leaf.png",
              status: "uploading",
              progress: 42,
            },
            {
              localTaskId: "local-2",
              filename: "bad.ai",
              status: "failed",
              progress: 12,
              error: "网络连接中断",
            },
          ]}
          onAbandon={vi.fn()}
          onPause={vi.fn()}
          onReselect={vi.fn()}
          onRetry={vi.fn()}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("42%")).toBeVisible();
    expect(screen.getByRole("button", { name: "暂停 leaf.png" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重试 bad.ai" })).toBeEnabled();
    expect(screen.getByText("网络连接中断")).toBeVisible();
  });
});

import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UploadDropzone } from "./upload-dropzone";
import { UploadTray } from "./upload-tray";

describe("upload UI", () => {
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

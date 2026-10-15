import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadDropzone } from "./upload-dropzone";
import { UploadTray } from "./upload-tray";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

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
        onRecover={vi.fn()}
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
          onRecover={vi.fn()}
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

  it("offers completion recovery only after a recoverable task is stalled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:01:00.000Z"));
    const onRecover = vi.fn();
    render(
      <UploadTray
        tasks={[
          {
            localTaskId: "stalled",
            filename: "stalled.png",
            status: "processing",
            progress: 99,
            canRecoverCompletion: true,
            completionStartedAt: Date.now() - 31_000,
          },
          {
            localTaskId: "recent",
            filename: "recent.png",
            status: "processing",
            progress: 99,
            canRecoverCompletion: true,
            completionStartedAt: Date.now() - 29_000,
          },
          {
            localTaskId: "legacy",
            filename: "legacy.png",
            status: "paused",
            progress: 99,
          },
        ]}
        onAbandon={vi.fn()}
        onPause={vi.fn()}
        onRecover={onRecover}
        onReselect={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "恢复上传 stalled.png" }),
    );
    expect(onRecover).toHaveBeenCalledWith("stalled");
    expect(
      screen.queryByRole("button", { name: "恢复上传 recent.png" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "恢复上传 legacy.png" }),
    ).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(
      screen.getByRole("button", { name: "恢复上传 recent.png" }),
    ).toBeEnabled();
  });

  it("disables recovery while the replay is pending", () => {
    vi.useFakeTimers();
    render(
      <UploadTray
        tasks={[
          {
            localTaskId: "recovering",
            filename: "leaf.png",
            status: "processing",
            progress: 99,
            canRecoverCompletion: true,
            completionStartedAt: Date.now() - 31_000,
            recoveryPending: true,
          },
        ]}
        onAbandon={vi.fn()}
        onPause={vi.fn()}
        onRecover={vi.fn()}
        onReselect={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "恢复上传 leaf.png" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "放弃 leaf.png" }),
    ).toBeDisabled();
    expect(screen.getByText("正在恢复")).toBeVisible();
  });

  it("starts the recovery threshold from a task added to an old tray", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    const props = {
      onAbandon: vi.fn(),
      onPause: vi.fn(),
      onRecover: vi.fn(),
      onReselect: vi.fn(),
      onRetry: vi.fn(),
    };
    const view = render(
      <UploadTray
        {...props}
        tasks={[
          {
            localTaskId: "done",
            filename: "done.png",
            status: "ready",
            progress: 100,
          },
        ]}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    const completionStartedAt = Date.now() - 29_000;
    view.rerender(
      <UploadTray
        {...props}
        tasks={[
          {
            localTaskId: "recent",
            filename: "recent.png",
            status: "processing",
            progress: 99,
            canRecoverCompletion: true,
            completionStartedAt,
          },
        ]}
      />,
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(
      screen.getByRole("button", { name: "恢复上传 recent.png" }),
    ).toBeEnabled();
  });
});

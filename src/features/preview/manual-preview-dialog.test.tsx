import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualPreviewDialog } from "./manual-preview-dialog";

const replaceManualPreview = vi.fn();

vi.mock("./manual-preview-client", () => ({
  replaceManualPreview: (...args: unknown[]) => replaceManualPreview(...args),
}));

describe("manual preview dialog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    replaceManualPreview.mockReset();
    replaceManualPreview.mockResolvedValue({
      pattern: { id: "pattern-1", version: 3, previewStatus: "manual" },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts a JPG cover and closes after replacement", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onComplete = vi.fn();
    const createObjectURL = vi.fn(() => "blob:manual-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tooltip.Provider>
          <ManualPreviewDialog
            open
            pattern={{ id: "pattern-1", name: "花叶", extension: "psd", version: 2 }}
            onComplete={onComplete}
            onOpenChange={onOpenChange}
          />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const file = new File(["jpeg"], "cover.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText("选择 JPG 或 PNG 预览"), file);
    await user.click(screen.getByRole("button", { name: "更新预览" }));

    expect(replaceManualPreview).toHaveBeenCalledWith(
      expect.objectContaining({ patternId: "pattern-1", version: 2, file }),
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });
});

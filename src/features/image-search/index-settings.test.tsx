import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryOwnerProvider } from "@/lib/query/provider";

import {
  ImageSearchIndexSettings,
  imageSearchIndexRefetchInterval,
  type ImageSearchIndexStatus,
} from "./index-settings";

const ownerId = "10000000-0000-4000-8000-000000000001";
const activeStatus: ImageSearchIndexStatus = {
  indexVersion: "visual-search-v1",
  eligible: 4,
  ready: 2,
  pending: 1,
  indexing: 0,
  failed: 1,
  worker: "online",
};

function renderSettings(status = activeStatus) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/retry")) {
      return Response.json({ enqueued: 1 });
    }
    if (url.endsWith("/rebuild")) {
      return Response.json({ enqueued: 3, alreadyExisting: 1 });
    }
    return Response.json(status);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <ImageSearchIndexSettings />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
  return { client, fetchMock };
}

describe("image search index settings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows quiet owner-scoped index health and actions", async () => {
    renderSettings();

    expect(await screen.findByText("visual-search-v1")).toBeInTheDocument();
    expect(screen.getByText("可索引 4")).toBeInTheDocument();
    expect(screen.getByText("已就绪 2")).toBeInTheDocument();
    expect(screen.getByText("等待中 1")).toBeInTheDocument();
    expect(screen.getByText("处理中 0")).toBeInTheDocument();
    expect(screen.getByText("失败 1")).toBeInTheDocument();
    expect(screen.getByText("Worker 在线")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重试失败项" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "重建索引" })).toBeEnabled();
  });

  it("retries failed items and confirms a background rebuild without deleting current results", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderSettings();
    await screen.findByText("visual-search-v1");

    await user.click(screen.getByRole("button", { name: "重试失败项" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/image-search/retry",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "重建索引" }));
    const dialog = screen.getByRole("dialog", { name: "重建图像搜索索引" });
    expect(dialog).toHaveTextContent("重建会在后台运行");
    expect(dialog).toHaveTextContent("不会删除当前结果");
    await user.click(screen.getByRole("button", { name: "确认重建" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/image-search/rebuild",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("polls only while work is active and the page is visible", () => {
    expect(imageSearchIndexRefetchInterval(activeStatus, "visible")).toBe(
      15_000,
    );
    expect(imageSearchIndexRefetchInterval(activeStatus, "hidden")).toBe(
      false,
    );
    expect(
      imageSearchIndexRefetchInterval(
        { ...activeStatus, pending: 0, indexing: 0 },
        "visible",
      ),
    ).toBe(false);
  });
});

import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryOwnerProvider } from "@/lib/query/provider";

import { AuthorizationFieldSettings } from "./field-settings";

const ownerId = "10000000-0000-4000-8000-000000000001";
const systemField = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: null,
  scope: "system" as const,
  name: "家居服",
  normalizedName: "家居服",
  status: "active" as const,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  archivedAt: null,
};
const customField = {
  ...systemField,
  id: "00000000-0000-4000-8000-000000000002",
  ownerId,
  scope: "custom" as const,
  name: "童装",
  normalizedName: "童装",
};

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <AuthorizationFieldSettings />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

describe("AuthorizationFieldSettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("fetch", vi.fn(() => json([systemField, customField])));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("distinguishes immutable system fields and archives custom fields with history notice", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText("家居服")).toBeInTheDocument();
    expect(screen.getByLabelText("系统领域")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "归档 家居服" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "归档 童装" }));
    const dialog = screen.getByRole("dialog", { name: "归档授权领域" });
    expect(dialog).toHaveTextContent("历史授权记录会保留");

    vi.mocked(fetch).mockImplementationOnce(() =>
      json({ ...customField, status: "archived", archivedAt: "2026-10-14T00:00:00.000Z" }),
    );
    await user.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/authorization-fields/${customField.id}`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("previews the trimmed custom name and creates it", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText("家居服");

    await user.type(screen.getByRole("textbox", { name: "新领域名称" }), "  童鞋  ");
    expect(screen.getByText("将创建：童鞋")).toBeInTheDocument();

    const created = {
      ...customField,
      id: "00000000-0000-4000-8000-000000000003",
      name: "童鞋",
      normalizedName: "童鞋",
    };
    vi.mocked(fetch).mockImplementationOnce(() => json(created, 201));
    await user.click(screen.getByRole("button", { name: "添加领域" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/authorization-fields",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"name":"童鞋"'),
        }),
      ),
    );
  });
});

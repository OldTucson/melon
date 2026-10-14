import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryOwnerProvider } from "@/lib/query/provider";
import { queryKeys } from "@/lib/query/keys";

import { AuthorizationTab } from "./authorization-tab";
import { authorizationKeys } from "./query-keys";

const ownerId = "10000000-0000-4000-8000-000000000001";
const patternId = "20000000-0000-4000-8000-000000000002";
const active = {
  id: "30000000-0000-4000-8000-000000000003",
  ownerId,
  patternId,
  operationId: "40000000-0000-4000-8000-000000000004",
  kind: "standard" as const,
  fieldId: "00000000-0000-4000-8000-000000000001",
  fieldNameSnapshot: "家居服",
  licenseeName: "有效客户",
  priceFen: "128000",
  priceYuan: "1280.00",
  authorizedOn: "2026-10-08",
  note: null,
  status: "active" as const,
  version: 0,
  voidedAt: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
};
const voided = {
  ...active,
  id: "30000000-0000-4000-8000-000000000005",
  licenseeName: "已作废客户",
  status: "void" as const,
  voidedAt: "2026-10-10T00:00:00.000Z",
};
const field = {
  id: active.fieldId,
  ownerId: null,
  scope: "system" as const,
  name: "家居服",
  normalizedName: "家居服",
  status: "active" as const,
  createdAt: active.createdAt,
  updatedAt: active.updatedAt,
  archivedAt: null,
};

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function history(items: Array<typeof active | typeof voided>) {
  return {
    items,
    nextCursor: null,
    commercialVersion: 2,
    summary: { state: "standard", activeCount: 1, revenueFen: "128000" },
  };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <AuthorizationTab patternId={patternId} />
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

describe("AuthorizationTab", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/authorization-fields?includeArchived=true") {
          return json([field]);
        }
        if (url.includes("includeVoid=true")) return json(history([active, voided]));
        return json(history([active]));
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders textual commercial state and hides void records until requested", async () => {
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByText("有效客户")).toBeInTheDocument();
    const summary = within(screen.getByLabelText("授权汇总"));
    expect(summary.getByText("普通授权")).toBeInTheDocument();
    expect(summary.getByText("累计有效收入")).toBeInTheDocument();
    expect(summary.getByText("¥1,280.00")).toBeInTheDocument();
    expect(screen.queryByText("已作废客户")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "显示作废记录" }));
    expect(await screen.findByText("已作废客户")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("includeVoid=true"),
      ),
    );
  });

  it("keeps server state unchanged while voiding and invalidates every commercial query", async () => {
    const user = userEvent.setup();
    let resolveVoid: ((response: Response) => void) | undefined;
    const voidResponse = new Promise<Response>((resolve) => {
      resolveVoid = resolve;
    });
    vi.mocked(fetch).mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/authorization-fields?includeArchived=true") {
          return json([field]);
        }
        if (init?.method === "POST" && url.endsWith(`/${active.id}/void`)) {
          return voidResponse;
        }
        return json(history([active]));
      },
    );
    const { client } = renderTab();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    expect(await screen.findByText("有效客户")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "更多操作 有效客户" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "作废记录" }));
    await user.click(screen.getByRole("button", { name: "确认作废" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/authorizations/${active.id}/void`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.getByText("有效客户")).toBeInTheDocument();
    expect(within(screen.getByLabelText("授权汇总")).getByText("1 条"))
      .toBeInTheDocument();

    resolveVoid?.(
      new Response(
        JSON.stringify({
          ...active,
          status: "void",
          version: 1,
          voidedAt: "2026-10-14T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await screen.findByText("授权记录已作废")).toBeInTheDocument();

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.pattern(ownerId, patternId),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["owner", ownerId, "patterns"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: authorizationKeys.historyRoot(ownerId, patternId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: authorizationKeys.dashboard(ownerId),
    });
  });
});

import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationFieldDto } from "@/features/authorizations/api";
import { authorizationKeys } from "@/features/authorizations/query-keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import {
  dashboardQuerySchema,
  type DashboardDto,
  type DashboardQuery,
} from "./contracts";
import { DashboardView } from "./dashboard-view";
import { dashboardKeys } from "./query-keys";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const fieldId = "00000000-0000-4000-8000-000000000003";
const patternId = "20000000-0000-4000-8000-000000000001";
const trashPatternId = "20000000-0000-4000-8000-000000000002";
const field: AuthorizationFieldDto = {
  id: fieldId,
  ownerId: null,
  scope: "system",
  name: "口水巾",
  normalizedName: "口水巾",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
};

const dashboard: DashboardDto = {
  range: {
    start: "2026-01-01",
    end: "2026-10-08",
    comparison: { start: "2025-01-01", end: "2025-10-08" },
  },
  metrics: {
    revenueFen: "128000",
    count: 2,
    patternCount: 1,
    averageFen: "64000",
    comparisonPercent: "25.00",
  },
  trend: [{ bucket: "2026-01-01", revenueFen: "128000", count: 2 }],
  currentStates: [
    { state: "unlicensed", patternCount: 4 },
    { state: "standard", patternCount: 2 },
    { state: "field_exclusive", patternCount: 1 },
    { state: "global_buyout", patternCount: 1 },
  ],
  fields: [
    { fieldId, fieldName: "口水巾", count: 2, revenueFen: "128000" },
  ],
  topPatterns: [
    {
      patternId,
      patternName: "春日花叶",
      lifecycle: "library",
      count: 1,
      revenueFen: "80000",
    },
    {
      patternId: trashPatternId,
      patternName: "旧版星点",
      lifecycle: "trash",
      count: 1,
      revenueFen: "48000",
    },
  ],
};

function json(data: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderDashboard(query: DashboardQuery, data: DashboardDto) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(dashboardKeys.data(ownerId, query), data);
  client.setQueryData(authorizationKeys.fields(ownerId, true), [field]);
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <DashboardView initialQuery={query} today="2026-10-08" />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

describe("dashboard view", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/dashboard/authorizations")) {
          return json(dashboard);
        }
        if (url === "/api/authorization-fields?includeArchived=true") {
          return json([field]);
        }
        return json([]);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders current-year KPIs, semantic charts, and ranking drill-downs", () => {
    renderDashboard(
      dashboardQuerySchema.parse({ range: "current_year" }),
      dashboard,
    );

    expect(screen.getByRole("heading", { name: "数据看板" })).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "商业授权关键指标" }),
      ).getByText("¥1,280.00"),
    ).toBeInTheDocument();
    expect(screen.getByText("较上期 +25.00%")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "收入趋势数据" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "当前商业状态数据" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /口水巾/ })).toHaveAttribute(
      "href",
      `/library?authorizationField=${fieldId}`,
    );
    expect(screen.getByRole("link", { name: /春日花叶/ })).toHaveAttribute(
      "href",
      `/library?selected=${patternId}`,
    );
    const trashLink = screen.getByRole("link", { name: /旧版星点/ });
    expect(trashLink).toHaveAttribute(
      "href",
      `/trash?selected=${trashPatternId}`,
    );
    expect(trashLink).toHaveTextContent("回收站");
  });

  it("omits comparison for all time and shows an honest zero-data state", () => {
    const empty: DashboardDto = {
      ...dashboard,
      range: { start: null, end: "2026-10-08", comparison: null },
      metrics: {
        revenueFen: "0",
        count: 0,
        patternCount: 0,
        averageFen: "0",
        comparisonPercent: null,
      },
      trend: [],
      fields: [],
      topPatterns: [],
    };
    renderDashboard(dashboardQuerySchema.parse({ range: "all_time" }), empty);

    expect(screen.getAllByText("¥0.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/较上期/)).not.toBeInTheDocument();
    expect(screen.getByText("所选期间暂无授权收入")).toBeInTheDocument();
    expect(screen.getByText("暂无领域授权数据")).toBeInTheDocument();
    expect(screen.getByText("暂无图案授权数据")).toBeInTheDocument();
  });

  it("restores inclusive custom dates and persists kind and field filters in the URL", async () => {
    const user = userEvent.setup();
    const query = dashboardQuerySchema.parse({
      range: "custom",
      start: "2026-09-01",
      end: "2026-10-08",
    });
    renderDashboard(query, {
      ...dashboard,
      range: {
        start: "2026-09-01",
        end: "2026-10-08",
        comparison: { start: "2026-07-25", end: "2026-08-31" },
      },
    });

    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("结束日期")).toHaveValue("2026-10-08");
    expect(screen.getByText("2026-09-01 至 2026-10-08（含首尾）")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "授权类型" }),
      "standard",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "授权领域" }),
      fieldId,
    );

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        `/dashboard?range=custom&start=2026-09-01&end=2026-10-08&field=${fieldId}&kind=standard`,
        { scroll: false },
      ),
    );
  });

  it("keeps incomplete custom dates as local drafts instead of navigating", async () => {
    const user = userEvent.setup();
    const query = dashboardQuerySchema.parse({
      range: "custom",
      start: "2026-09-01",
      end: "2026-10-08",
    });
    renderDashboard(query, dashboard);
    navigation.replace.mockClear();

    await user.clear(screen.getByLabelText("开始日期"));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "授权类型" }),
      "standard",
    );

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("开始日期")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("does not navigate to a future custom end date", () => {
    const query = dashboardQuerySchema.parse({
      range: "custom",
      start: "2026-09-01",
      end: "2026-10-08",
    });
    renderDashboard(query, dashboard);
    navigation.replace.mockClear();

    fireEvent.change(screen.getByLabelText("结束日期"), {
      target: { value: "2026-10-09" },
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("结束日期")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

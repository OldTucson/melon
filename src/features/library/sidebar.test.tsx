import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TagItem } from "@/features/library/library-types";
import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import { Sidebar } from "./sidebar";

const navigation = vi.hoisted(() => ({
  pathname: "/library",
  searchParams: new URLSearchParams(),
}));

const ownerId = "10000000-0000-4000-8000-000000000001";

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => ({ replace: vi.fn() }),
}));

const tags: TagItem[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "10000000-0000-4000-8000-000000000001",
    name: "花卉",
    normalizedName: "花卉",
    colorToken: "green",
    changeSeq: "1",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    ownerId: "10000000-0000-4000-8000-000000000001",
    name: "几何",
    normalizedName: "几何",
    colorToken: "blue",
    changeSeq: "2",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
];

function renderSidebar(search = "") {
  navigation.pathname = "/library";
  navigation.searchParams = new URLSearchParams(search);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.tags(ownerId), tags);
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Sidebar />
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("workspace sidebar", () => {
  it("shows folder navigation and does not mark all active in a folder context", () => {
    renderSidebar("unfiled=true");
    expect(screen.getByRole("link", { name: "未分类" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "全部图案" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen.getByRole("button", { name: "新建文件夹" }),
    ).toBeInTheDocument();
  });
  it("shows the untagged view and the real tag list with fixed swatches", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "未打标签" })).toHaveAttribute(
      "href",
      "/library?untagged=true",
    );
    for (const tag of tags) {
      const link = screen.getByRole("link", { name: tag.name });
      expect(link).toHaveAttribute("href", `/library?tag=${tag.id}`);
      expect(within(link).getByTestId("tag-swatch")).toHaveAttribute(
        "data-color-token",
        tag.colorToken,
      );
    }
  });

  it.each([
    ["", "全部图案"],
    ["format=png", "全部图案"],
    ["sort=updated_desc", "最近使用"],
    ["favorite=true", "收藏"],
    ["untagged=true", "未打标签"],
    [`tag=${tags[0]!.id}`, tags[0]!.name],
  ])("marks only the URL-backed %s view active", (search, activeLabel) => {
    renderSidebar(search);

    const links = screen
      .getAllByRole("link")
      .filter((link) =>
        ["全部图案", "最近使用", "收藏", "未打标签", "花卉", "几何"].includes(
          link.textContent ?? "",
        ),
      );
    for (const link of links) {
      if (link.textContent === activeLabel) {
        expect(link).toHaveAttribute("data-active", "true");
        expect(link).toHaveAttribute("aria-current", "page");
      } else {
        expect(link).not.toHaveAttribute("data-active", "true");
        expect(link).not.toHaveAttribute("aria-current", "page");
      }
    }
  });
});

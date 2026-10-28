import { readFileSync } from "node:fs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FolderDto } from "@/features/folders/folder-client";
import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";
import { LibraryView } from "./library-view";
import type { PatternItem } from "./library-types";
import { parseLibrarySearchParams, toPatternQuery } from "./query-state";
import { useSelectionStore } from "./selection-store";
import { WorkspaceShell } from "./workspace-shell";

const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
  useSearchParams: () => navigation.search,
  useRouter: () => ({ replace: vi.fn() }),
}));
const ownerId = "10000000-0000-4000-8000-000000000000";
const longName = "春日花卉与植物纹样 — BotanicalCollectionWithoutSpaces".repeat(3);
const folder: FolderDto = {
  id: "20000000-0000-4000-8000-000000000001", ownerId, parentId: null,
  name: longName, normalizedName: longName, status: "active", version: 0,
  trashBatchId: null, trashedAt: null, deletedAt: null, changeSeq: "1",
  createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
  directPatternCount: 2, recursivePatternCount: 2,
};
const pattern: PatternItem = {
  id: "00000000-0000-4000-8000-000000000001", ownerId, name: longName,
  originalFilename: "botanical.png", extension: "png", detectedMimeType: "image/png",
  sizeBytes: "2048", contentHash: null, status: "ready", folderId: folder.id,
  trashBatchId: null, preTrashStatus: null, previewStatus: "ready", isFavorite: false,
  version: 0, commercialVersion: 0, lastErrorCode: null, trashedAt: null,
  paletteStatus: "pending", palette: [],
  deletedAt: null, changeSeq: "1", createdAt: folder.createdAt, updatedAt: folder.updatedAt,
};

function renderWorkspace(compact = true, phone = false) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: phone ? 390 : compact ? 1024 : 1512,
  });
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches:
      (compact && media === "(max-width: 1100px)") ||
      (phone && media === "(max-width: 720px)"),
    media,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  navigation.search = new URLSearchParams({ folderId: folder.id });
  const query = toPatternQuery(parseLibrarySearchParams(navigation.search));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.folders(ownerId), [folder]);
  client.setQueryData(queryKeys.tags(ownerId), []);
  client.setQueryData(queryKeys.patternTags(ownerId, pattern.id), { items: [] });
  client.setQueryData(queryKeys.pattern(ownerId, pattern.id), pattern);
  client.setQueryData(queryKeys.patterns(ownerId, query), { pages: [{ items: [pattern], nextCursor: null }], pageParams: [null] });
  return render(<QueryClientProvider client={client}><QueryOwnerProvider ownerId={ownerId}>
    <WorkspaceShell user={{ displayName: "Lin", email: "lin@example.test" }}>
      <LibraryView initialQuery={query} />
    </WorkspaceShell>
  </QueryOwnerProvider></QueryClientProvider>);
}

function renderDeepLinkedPattern() {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(max-width: 1100px)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.folders(ownerId), [folder]);
  client.setQueryData(queryKeys.tags(ownerId), []);
  client.setQueryData(queryKeys.patternTags(ownerId, pattern.id), { items: [] });
  client.setQueryData(queryKeys.pattern(ownerId, pattern.id), pattern);
  client.setQueryData(queryKeys.patterns(ownerId, query), {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [null],
  });
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <LibraryView initialQuery={query} initialSelectedId={pattern.id} />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSelectionStore.getState().clear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("responsive workspace panels", () => {
  it("persists an explicit desktop sidebar mode", async () => {
    const user = userEvent.setup();
    renderWorkspace(false);

    const workspace = screen.getByLabelText("图案工作区");
    const toggle = screen.getByRole("button", { name: "折叠主导航" });
    expect(workspace).toHaveAttribute("data-sidebar", "expanded");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);

    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(localStorage.getItem("melon:sidebar-mode")).toBe("collapsed");
    expect(
      screen.getByRole("button", { name: "展开主导航" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("restores a saved desktop sidebar mode", async () => {
    localStorage.setItem("melon:sidebar-mode", "collapsed");
    renderWorkspace(false);

    await waitFor(() =>
      expect(screen.getByLabelText("图案工作区")).toHaveAttribute(
        "data-sidebar",
        "collapsed",
      ),
    );
  });

  it("opens mobile navigation as a dialog and restores trigger focus", async () => {
    const user = userEvent.setup();
    renderWorkspace(true, true);

    const trigger = screen.getByRole("button", { name: "打开主导航" });
    await user.click(trigger);

    expect(
      screen.getByRole("dialog", { name: "主导航" }),
    ).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "主导航" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("opens a deep-linked pattern even when it is not in the loaded page", async () => {
    renderDeepLinkedPattern();

    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "图案检查器" }),
      ).toBeInTheDocument(),
    );
    expect(useSelectionStore.getState().selectedIds).toEqual([]);
    expect(
      screen.getByRole("complementary", { name: "图案检查器" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "图案名称" })).toHaveValue(
      pattern.name,
    );
  });

  it("opens a named folder dialog, traps focus and restores its trigger on Escape and close", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const trigger = screen.getByRole("button", { name: "浏览文件夹" });
    expect(screen.queryByRole("link", { name: longName })).not.toBeInTheDocument();
    await user.click(trigger);
    const panel = screen.getByRole("dialog", { name: "文件夹" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    const close = within(panel).getByRole("button", { name: "关闭文件夹" });
    close.focus();
    await user.tab({ shift: true });
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "关闭文件夹" }));
    expect(trigger).toHaveFocus();
  });

  it("dismisses the compact inspector without changing selection and can switch to folders", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const card = within(screen.getByRole("list", { name: "图案列表" })).getByRole("listitem");
    const image = within(card).getByRole("button", {
      name: `打开 ${pattern.name} 检查器`,
    });
    await user.click(image);
    const inspector = await screen.findByRole("dialog", {
      name: "图案检查器",
    });
    expect(inspector).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useSelectionStore.getState().selectedIds).toEqual([]);
    expect(image).toHaveFocus();
    const show = screen.getByRole("button", { name: "显示检查器" });
    await user.click(show);
    await user.click(screen.getByRole("button", { name: "收起检查器" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "显示检查器" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "浏览文件夹" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "文件夹" })).toBeInTheDocument();
  });

  it("keeps desktop folders and inspector nonmodal, names icon actions and exposes unabridged names", () => {
    const { container } = renderWorkspace(false);
    const card = within(screen.getByRole("list", { name: "图案列表" })).getByRole("listitem");
    fireEvent.click(
      within(card).getByRole("button", {
        name: `打开 ${pattern.name} 检查器`,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "图案检查器" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: longName })).toHaveAttribute("title", longName);
    expect(screen.getByRole("heading", { name: longName })).toHaveAttribute("title", longName);
    expect(within(card).getByText(longName)).toHaveAttribute("title", longName);
    expect(container.querySelector(".pattern-card .pattern-card")).toBeNull();
    for (const button of container.querySelectorAll(".icon-button, .folder-icon-button, .topbar-upload-button")) {
      expect(button).toHaveAccessibleName();
      expect(button).toHaveAttribute("title");
    }
  });

  it("defines stable compact controls, bounded tracks and truncation using restrained theme tokens", () => {
    const tokens = readFileSync("src/app/styles/tokens.css", "utf8");
    const controls = readFileSync("src/app/styles/controls.css", "utf8");
    const legacy = readFileSync("src/app/globals.css", "utf8");

    expect(tokens).toContain("--surface-app: #f4f4f1");
    expect(tokens).toContain("--surface-app: #11120f");
    expect(tokens).toContain("--accent: #d9ef52");
    expect(tokens).toContain("--topbar-height: 56px");
    expect(tokens).toContain("--control-radius: 6px");
    expect(legacy).toMatch(/\.workspace\s*\{[^}]*grid-template-columns:\s*220px minmax\(0,\s*1fr\);/s);
    expect(legacy).toMatch(/\.library-layout\[data-inspector="open"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 292px/s);
    expect(controls).toMatch(/\.icon-button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/s);
    expect(legacy).toMatch(/\.pattern-card-copy strong,[^}]*text-overflow:\s*ellipsis/s);
    expect(legacy).toMatch(/\.folder-link > span:first-of-type\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});

# Melon UI System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an interview-ready, full-product visual redesign for Melon that feels minimal, elegant, image-first, and efficient for designers, with a five-column MacBook 14-inch library as the primary showcase.

**Architecture:** Keep all existing routes, Server Component boundaries, React Query/Zustand state, APIs, virtualization, and business workflows. Add an ordered design-system CSS layer imported from the root layout, a small shared page-chrome layer, and one local-only workspace navigation preference. Refactor markup only where it improves hierarchy, responsiveness, or accessibility; do not duplicate business state or migrate UI frameworks.

**Tech Stack:** Next.js 16.4 App Router, React 19, TypeScript 6, CSS, Radix UI, Lucide, TanStack Query, TanStack Virtual, Zustand, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-melon-ui-system-redesign-design.md`

## Global Constraints

- Preserve API contracts, URLs, permissions, query parameters, upload behavior, image search, palette search, authorization logic, and deletion behavior.
- Keep Server Components as Server Components. Add `"use client"` only for browser APIs, local state, or event handlers; sidebar persistence belongs inside the existing client workspace shell.
- Import all new global styles from `src/app/layout.tsx` in a deliberate order and verify `next build`, because Next.js production CSS order may differ from development.
- Do not add a UI framework, remote font, gradient background, decorative orb, nested card layout, or large-radius visual language.
- Use `#d9ef52` only as a controlled brand accent. Keep success, warning, danger, and authorization colors semantic.
- Maintain accessible names, roles, focus behavior, keyboard workflows, virtual scrolling, and single-page scrolling boundaries.
- Optimize first for `1512x982`, then `1280x800`, tablet, and phone. At `1512x982`, the default expanded workspace must show five library columns when the inspector is closed.
- Keep every task independently runnable and commit only files belonging to that task.

---

### Task 1: Establish the design-system foundation and shared page chrome

**Files:**
- Create: `src/app/styles/tokens.css`
- Create: `src/app/styles/foundation.css`
- Create: `src/app/styles/controls.css`
- Create: `src/components/ui/page-header.tsx`
- Create: `src/components/ui/page-header.test.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/features/library/mobile-panels.test.tsx`

- [ ] **Step 1: Write the failing shared-header test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("exposes a stable title, context and action region", () => {
    render(
      <PageHeader
        id="library-title"
        eyebrow="私人图案库"
        title="全部图案"
        description="128 个素材"
        actions={<button type="button">上传</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "全部图案" })).toHaveAttribute(
      "id",
      "library-title",
    );
    expect(screen.getByText("私人图案库")).toBeInTheDocument();
    expect(screen.getByText("128 个素材")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传" })).toBeInTheDocument();
  });
});
```

Use `id="library-title"` in the fixture so the component API is explicit rather than hard-coded.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- src/components/ui/page-header.test.tsx`

Expected: FAIL because `page-header.tsx` does not exist.

- [ ] **Step 3: Implement the server-safe shared page header**

```tsx
import clsx from "clsx";

export function PageHeader({
  actions,
  className,
  description,
  eyebrow,
  id,
  title,
}: {
  actions?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  id?: string;
  title: React.ReactNode;
}) {
  return (
    <header className={clsx("page-header", className)}>
      <div className="page-header-copy">
        {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
        <h1 id={id}>{title}</h1>
        {description ? <div className="page-description">{description}</div> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
```

- [ ] **Step 4: Add semantic tokens and ordered CSS entries**

Define light and dark values in `tokens.css`, including:

```css
:root {
  color-scheme: light;
  --surface-app: #f4f4f1;
  --surface-panel: #ffffff;
  --surface-raised: #ffffff;
  --surface-hover: #eeeeea;
  --surface-selected: #f1f6ce;
  --border-subtle: #deded8;
  --border-strong: #b9bab3;
  --text-primary: #171815;
  --text-secondary: #686a63;
  --text-tertiary: #8a8c84;
  --accent: #d9ef52;
  --accent-strong: #bfd52e;
  --on-accent: #171815;
  --danger: #c43c3c;
  --focus-ring: #9eb51b;
  --font-sans: Inter, "PingFang SC", system-ui, sans-serif;
  --font-display: Georgia, "Songti SC", serif;
  --control-radius: 6px;
  --panel-radius: 8px;
  --topbar-height: 56px;
  --sidebar-expanded: 216px;
  --sidebar-collapsed: 64px;
  --canvas: var(--surface-app);
  --surface: var(--surface-panel);
  --text: var(--text-primary);
  --text-muted: var(--text-secondary);
  --border: var(--border-subtle);
  --primary: var(--accent);
  --primary-hover: var(--accent-strong);
  --on-primary: var(--on-accent);
  --status-standard: #2f7150;
  --status-exclusive: #7a6217;
  --status-buyout: var(--danger);
}

[data-theme="dark"] {
  color-scheme: dark;
  --surface-app: #11120f;
  --surface-panel: #181916;
  --surface-raised: #20211d;
  --surface-hover: #252720;
  --surface-selected: #30371b;
  --border-subtle: #30322c;
  --border-strong: #50534a;
  --text-primary: #f1f2ec;
  --text-secondary: #a9aba2;
  --text-tertiary: #7f8179;
  --accent: #d9ef52;
  --accent-strong: #e3f46f;
  --on-accent: #151611;
  --focus-ring: #d9ef52;
}
```

Move only the replaced token/reset/control rules out of `globals.css`; keep untouched feature rules in place. Import in this exact order from `src/app/layout.tsx`:

```tsx
import "./globals.css";
import "./styles/tokens.css";
import "./styles/foundation.css";
import "./styles/controls.css";
```

In `foundation.css`, define the system typography, display-heading style, focus ring, selection color, stable scrollbars, and the shared `.page-header` structure. In `controls.css`, normalize primary/secondary/danger/icon buttons, inputs, selects, Radix menus, dialogs, disabled states, and loading states without changing component behavior.

- [ ] **Step 5: Update CSS contract assertions**

Change the existing `mobile-panels.test.tsx` CSS check to read the new files and assert the new tokens instead of stale blue-accent values:

```ts
const tokens = readFileSync("src/app/styles/tokens.css", "utf8");
expect(tokens).toContain("--accent: #d9ef52");
expect(tokens).toContain("--topbar-height: 56px");
expect(tokens).toContain('[data-theme="dark"]');
```

- [ ] **Step 6: Run foundation verification**

Run: `npm test -- src/components/ui/page-header.test.tsx src/features/library/mobile-panels.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS with no new client/server boundary errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/layout.tsx src/app/globals.css src/app/styles/tokens.css src/app/styles/foundation.css src/app/styles/controls.css src/components/ui/page-header.tsx src/components/ui/page-header.test.tsx src/features/library/mobile-panels.test.tsx
git commit -m "feat: establish gallery design system"
```

---

### Task 2: Rebuild the workspace shell, collapsible sidebar, and topbar

**Files:**
- Create: `src/app/styles/workspace.css`
- Create: `src/features/library/sidebar-preference.ts`
- Create: `src/features/library/sidebar-preference.test.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/features/library/workspace-shell.tsx`
- Modify: `src/features/library/topbar.tsx`
- Modify: `src/features/library/sidebar.tsx`
- Modify: `src/features/library/sidebar.test.tsx`
- Modify: `src/features/library/mobile-panels.test.tsx`

- [ ] **Step 1: Write failing tests for local-only sidebar preference**

```ts
import { describe, expect, it } from "vitest";

import {
  defaultSidebarMode,
  parseSidebarMode,
  SIDEBAR_STORAGE_KEY,
} from "./sidebar-preference";

describe("sidebar preference", () => {
  it("uses expanded mode for the primary MacBook viewport", () => {
    expect(defaultSidebarMode(1512)).toBe("expanded");
    expect(defaultSidebarMode(1279)).toBe("collapsed");
  });

  it("ignores malformed persisted values", () => {
    expect(parseSidebarMode("collapsed")).toBe("collapsed");
    expect(parseSidebarMode("expanded")).toBe("expanded");
    expect(parseSidebarMode("broken")).toBeNull();
    expect(SIDEBAR_STORAGE_KEY).toBe("melon:sidebar-mode");
  });
});
```

- [ ] **Step 2: Run the preference test and confirm it fails**

Run: `npm test -- src/features/library/sidebar-preference.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the pure preference helper**

```ts
export type SidebarMode = "expanded" | "collapsed";

export const SIDEBAR_STORAGE_KEY = "melon:sidebar-mode";

export function parseSidebarMode(value: string | null): SidebarMode | null {
  return value === "expanded" || value === "collapsed" ? value : null;
}

export function defaultSidebarMode(viewportWidth: number): SidebarMode {
  return viewportWidth < 1280 ? "collapsed" : "expanded";
}
```

- [ ] **Step 4: Add shell interaction tests before changing markup**

Extend `mobile-panels.test.tsx` to assert:

- desktop toggle exposes `aria-expanded`, changes the workspace `data-sidebar` value, and writes `melon:sidebar-mode`;
- a stored `collapsed` value is restored after mount;
- at phone width the same topbar control opens an accessible `dialog` named `主导航`;
- Escape and navigation close the mobile drawer and restore focus to the trigger;
- collapsed navigation links keep visible tooltips/titles and accessible names.

Run: `npm test -- src/features/library/mobile-panels.test.tsx src/features/library/sidebar.test.tsx`

Expected: FAIL on missing toggle, storage behavior, and dialog semantics.

- [ ] **Step 5: Implement workspace state at the existing client boundary**

In `WorkspaceContent`, add only UI state:

```tsx
const [sidebarMode, setSidebarMode] = useState<SidebarMode>("expanded");
const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

useEffect(() => {
  const stored = parseSidebarMode(localStorage.getItem(SIDEBAR_STORAGE_KEY));
  setSidebarMode(stored ?? defaultSidebarMode(window.innerWidth));
}, []);
```

Persist only explicit desktop changes. Do not add a database field or reuse URL state. Render `data-sidebar={sidebarMode}` and `data-mobile-navigation={mobileNavigationOpen ? "open" : "closed"}` on `.workspace`.

- [ ] **Step 6: Refactor topbar and sidebar presentation**

- Add a Lucide `PanelLeftClose`/`PanelLeftOpen` icon button at the left edge of `Topbar` with a clear tooltip and `aria-expanded`.
- Keep the brand first-viewport visible in both modes; collapse it to a compact `m` mark only when necessary.
- Keep search centered, preserve the image-search button, make upload the Acid Lime primary command, and collapse account copy at narrower widths.
- Pass `collapsed` and `onNavigate` to `Sidebar`; retain all links, tags, folder navigation, active URL semantics, and query behavior.
- On phone widths, present the same sidebar as an overlay drawer with a backdrop, focus containment, Escape close, and full-height scrolling. Do not keep the current bottom navigation implementation.
- Import `workspace.css` after `controls.css` from `src/app/layout.tsx`.

- [ ] **Step 7: Verify workspace behavior**

Run: `npm test -- src/features/library/sidebar-preference.test.ts src/features/library/sidebar.test.tsx src/features/library/mobile-panels.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/layout.tsx src/app/styles/workspace.css src/features/library/sidebar-preference.ts src/features/library/sidebar-preference.test.ts src/features/library/workspace-shell.tsx src/features/library/topbar.tsx src/features/library/sidebar.tsx src/features/library/sidebar.test.tsx src/features/library/mobile-panels.test.tsx
git commit -m "feat: redesign adaptive workspace shell"
```

---

### Task 3: Make the library the interview-ready showcase

**Files:**
- Create: `src/app/styles/library.css`
- Create: `src/features/library/pattern-grid-layout.test.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/features/library/pattern-grid.tsx`
- Modify: `src/features/library/pattern-card.tsx`
- Modify: `src/features/library/library-toolbar.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/features/library/pattern-card-assets.test.tsx`
- Modify: `src/features/library/pattern-card-interactions.test.tsx`

- [ ] **Step 1: Write a failing deterministic grid-density test**

```ts
import { describe, expect, it } from "vitest";

import { resolvePatternGridColumns } from "./pattern-grid";

describe("resolvePatternGridColumns", () => {
  it.each([
    [1264, "grid", 5],
    [1024, "grid", 4],
    [760, "grid", 3],
    [358, "grid", 1],
    [1264, "list", 1],
  ] as const)("maps %ipx %s mode to %i columns", (width, mode, expected) => {
    expect(resolvePatternGridColumns(width, mode)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the grid test and confirm it fails**

Run: `npm test -- src/features/library/pattern-grid-layout.test.ts`

Expected: FAIL because `resolvePatternGridColumns` is not exported.

- [ ] **Step 3: Extract and use the grid resolver**

```ts
export function resolvePatternGridColumns(
  width: number,
  mode: LibraryViewMode,
) {
  if (mode === "list") return 1;
  if (width < 520) return 1;
  if (width < 860) return 3;
  return Math.max(4, Math.min(6, Math.floor((width + 16) / 238)));
}
```

Use the helper in `PatternGrid` and recalculate row height from the actual square track plus fixed palette/metadata rows. Keep TanStack Virtual, overscan, scroll restoration, and load-more thresholds unchanged.

- [ ] **Step 4: Add failing presentation-semantic assertions**

Update existing library/card tests to require:

- cards expose `data-state="selected"` when selected and retain checkbox semantics;
- a ready palette shows 3–5 interactive swatches before metadata;
- the page header retains `aria-labelledby="library-title"` through `PageHeader`;
- hover-only actions remain keyboard reachable and are always present in the DOM;
- list mode still exposes the same name, palette, commercial summary, preview, favorite, and download actions.

Run: `npm test -- src/features/library/library-view.test.tsx src/features/library/pattern-card-assets.test.tsx src/features/library/pattern-card-interactions.test.tsx`

Expected: FAIL only on the new presentation contract, not existing business behavior.

- [ ] **Step 5: Refactor the library markup without changing data flow**

- Replace the bespoke heading wrapper with `PageHeader`, keeping `id="library-title"`, active-folder naming, and descendant toggle behavior.
- Reorder the toolbar into a compact filter group, result summary, and right-aligned view/inspector controls. Preserve every select, menu, URL patch, and accessible label.
- Keep image as the dominant square region. Place palette directly beneath it, then name/file metadata, then commercial state.
- Keep actions in the DOM; reveal visually on hover/focus/selection for pointer devices and always show them on touch layouts.
- Change only presentation data attributes (`data-state`, `data-mode`, `data-palette`) and keep all event handlers intact.

- [ ] **Step 6: Implement the Gallery White library styling**

In `library.css`:

- use a flat white/canvas composition with 16px grid gaps and no decorative card shadows;
- give media a stable `aspect-ratio: 1`, subtle border, and at most 6px radius;
- style selection with a crisp outline, checkbox, and small Acid Lime marker without tinting the artwork;
- give palette swatches stable height and visible borders in both themes;
- use ellipsis/title for names and tabular numerals for size/revenue;
- keep the toolbar on one line at `1512x982`, allow controlled wrapping at `1280x800`, and move filters into the existing compact flow on small screens;
- keep `.pattern-results` as the only scrolling library region.

Import `library.css` after `workspace.css` from the root layout.

- [ ] **Step 7: Run the complete library unit suite**

Run: `npm test -- src/features/library src/features/palette-search/palette-swatches.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the first visible milestone**

```bash
git add src/app/layout.tsx src/app/styles/library.css src/features/library/pattern-grid.tsx src/features/library/pattern-grid-layout.test.ts src/features/library/pattern-card.tsx src/features/library/library-toolbar.tsx src/features/library/library-view.tsx src/features/library/library-view.test.tsx src/features/library/pattern-card-assets.test.tsx src/features/library/pattern-card-interactions.test.tsx
git commit -m "feat: deliver gallery-first library redesign"
```

---

### Task 4: Unify inspector, image search, palette search, upload, and overlays

**Files:**
- Create: `src/app/styles/workflows.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/features/library/inspector.tsx`
- Modify: `src/features/library/bulk-action-bar.tsx`
- Modify: `src/features/image-search/image-search-dialog.tsx`
- Modify: `src/features/image-search/image-search-results.tsx`
- Modify: `src/features/palette-search/palette-query-bar.tsx`
- Modify: `src/features/palette-search/palette-swatches.tsx`
- Modify: `src/features/uploads/upload-dropzone.tsx`
- Modify: `src/features/uploads/upload-tray.tsx`
- Modify: `src/features/image-search/image-search-dialog.test.tsx`
- Modify: `src/features/image-search/image-search-results.test.tsx`
- Modify: `src/features/palette-search/palette-query-bar.test.tsx`
- Modify: `src/features/uploads/upload-ui.test.tsx`

- [ ] **Step 1: Add failing workflow presentation tests**

Add focused assertions that:

- image search has one labelled dialog, one clear drop/crop stage, and a primary search command;
- palette search exposes each selected color as a removable control and keeps the result count live region;
- inspector groups preview, palette, metadata, organization, and authorization under named sections;
- upload tray toggle exposes `aria-expanded`, every task has a named progress bar, and failure actions remain keyboard reachable;
- bulk actions report selection count before commands.

Run:

```bash
npm test -- src/features/image-search/image-search-dialog.test.tsx src/features/image-search/image-search-results.test.tsx src/features/palette-search/palette-query-bar.test.tsx src/features/uploads/upload-ui.test.tsx src/features/library/bulk-action-bar.test.tsx
```

Expected: FAIL on the new hierarchy hooks while existing workflow assertions continue to pass.

- [ ] **Step 2: Refine markup only where hierarchy is missing**

- Add semantic section headings and stable class hooks to `Inspector`; do not move mutations or query ownership.
- Keep the Radix image-search dialog and crop behavior, but clarify header, stage, inline status, and footer action regions.
- Keep palette selection order and multi-color limit logic; render selected colors as compact swatch controls rather than text chips.
- Keep upload store and manager untouched; reorganize tray header, progress, filename, status, and retry/cancel controls.
- Keep all existing Radix portals, focus management, Escape handling, and accessible labels.

- [ ] **Step 3: Apply shared overlay and workflow styling**

In `workflows.css`:

- use the same 6–8px radius, 1px borders, and restrained shadow for dialogs, menus, crop stage, inspector, and upload tray;
- size the desktop inspector as a real work panel and convert it to a bottom sheet/full-screen surface at compact widths;
- make image-search stage large enough to inspect the source image without embedding cards inside cards;
- give upload progress and drag overlay stable dimensions and clear success/error colors;
- keep mobile actions visible without hover;
- validate dark theme borders for transparent images and color swatches.

Import `workflows.css` after `library.css`.

- [ ] **Step 4: Run workflow regression tests**

Run:

```bash
npm test -- src/features/image-search src/features/palette-search src/features/uploads src/features/library/bulk-action-bar.test.tsx src/features/library/mobile-panels.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.tsx src/app/styles/workflows.css src/features/library/inspector.tsx src/features/library/bulk-action-bar.tsx src/features/library/bulk-action-bar.test.tsx src/features/image-search/image-search-dialog.tsx src/features/image-search/image-search-dialog.test.tsx src/features/image-search/image-search-results.tsx src/features/image-search/image-search-results.test.tsx src/features/palette-search/palette-query-bar.tsx src/features/palette-search/palette-query-bar.test.tsx src/features/palette-search/palette-swatches.tsx src/features/uploads/upload-dropzone.tsx src/features/uploads/upload-tray.tsx src/features/uploads/upload-ui.test.tsx
git commit -m "feat: refine visual search and upload workflows"
```

Before committing, inspect `git diff --staged --name-only` and unstage unrelated image-search/upload service files; only UI and test files belong in this commit.

---

### Task 5: Redesign the dashboard as a quiet analytical workspace

**Files:**
- Create: `src/app/styles/dashboard.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/features/analytics/dashboard-view.tsx`
- Modify: `src/features/analytics/dashboard-filters.tsx`
- Modify: `src/features/analytics/kpi-strip.tsx`
- Modify: `src/features/analytics/revenue-trend.tsx`
- Modify: `src/features/analytics/current-state-chart.tsx`
- Modify: `src/features/analytics/ranking-table.tsx`
- Modify: `src/features/analytics/dashboard-view.test.tsx`
- Modify: `src/features/analytics/revenue-trend.test.tsx`

- [ ] **Step 1: Add failing dashboard hierarchy tests**

Extend `dashboard-view.test.tsx` to require one `PageHeader`, a named KPI strip, named chart regions, and two named ranking tables. Assert that date controls remain labelled and that loading/error output still uses `main`.

Run: `npm test -- src/features/analytics/dashboard-view.test.tsx src/features/analytics/revenue-trend.test.tsx`

Expected: FAIL on the new region names/structure only.

- [ ] **Step 2: Refactor dashboard presentation**

- Use `PageHeader` for title/range and keep filters in the actions slot.
- Keep all dashboard query serialization, React Query keys, chart calculations, and navigation unchanged.
- Render KPI values as a compact horizontal metric strip separated by rules, not individual floating cards.
- Keep trend/status/rankings as full-width sections with concise headings and predictable min-heights.
- Use neutral chart colors with Acid Lime only for the primary series/current emphasis; retain semantic authorization colors.

- [ ] **Step 3: Add dashboard responsive styling**

At `1512x982`, title and filters share the header line, KPI values remain one strip, overview uses a balanced two-column grid, and rankings scan without nested cards. At `1280x800`, allow filters to wrap below the title. On phones, use one column and horizontal-safe chart/table regions.

Import `dashboard.css` after `workflows.css`.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- src/features/analytics`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```bash
git add src/app/layout.tsx src/app/styles/dashboard.css src/features/analytics/dashboard-view.tsx src/features/analytics/dashboard-filters.tsx src/features/analytics/kpi-strip.tsx src/features/analytics/revenue-trend.tsx src/features/analytics/current-state-chart.tsx src/features/analytics/ranking-table.tsx src/features/analytics/dashboard-view.test.tsx src/features/analytics/revenue-trend.test.tsx
git commit -m "feat: redesign analytical dashboard"
```

---

### Task 6: Bring settings, trash, authentication, and legal pages into the same system

**Files:**
- Create: `src/app/styles/pages.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/(workspace)/settings/page.tsx`
- Modify: `src/features/theme/theme-control.tsx`
- Modify: `src/features/authorizations/field-settings.tsx`
- Modify: `src/features/image-search/index-settings.tsx`
- Modify: `src/features/trash/trash-view.tsx`
- Modify: `src/app/(auth)/login/page.tsx`
- Modify: `src/app/(auth)/login/login-form.tsx`
- Modify: `src/app/(auth)/change-password/page.tsx`
- Modify: `src/app/(auth)/change-password/change-password-form.tsx`
- Modify: `src/app/(legal)/layout.tsx`
- Modify: `src/app/(legal)/privacy/page.tsx`
- Modify: `src/app/(legal)/terms/page.tsx`
- Modify: `src/app/(workspace)/settings/page.test.tsx`
- Modify: `src/features/trash/trash-view.test.tsx`
- Modify: `src/app/(auth)/login/page.test.tsx`
- Modify: `src/app/(legal)/privacy/page.test.tsx`
- Modify: `src/app/(legal)/terms/page.test.tsx`

- [ ] **Step 1: Add failing cross-page consistency assertions**

Require:

- Settings uses `PageHeader` and four labelled, un-nested sections in the existing order.
- Theme choice remains a radio/segmented control with `system`, `light`, and `dark` values.
- Trash rows expose name, count, expiry, commercial impact, restore, and destructive action without a card-in-card structure.
- Login and change-password retain one heading, labelled inputs, inline errors, submit action, and legal links.
- Legal pages retain readable heading hierarchy, operator/contact/filing content, and back navigation.

Run:

```bash
npm test -- 'src/app/(workspace)/settings/page.test.tsx' src/features/trash/trash-view.test.tsx 'src/app/(auth)/login/page.test.tsx' 'src/app/(legal)/privacy/page.test.tsx' 'src/app/(legal)/terms/page.test.tsx'
```

Expected: FAIL only where new shared page chrome/section hooks are absent.

- [ ] **Step 2: Refactor settings and trash presentation**

- Use `PageHeader` and dividers/spacing for settings; preserve section order and all server-derived legal configuration.
- Present theme as a quiet three-option segmented control while keeping native radio inputs.
- Reuse shared button/input/dialog classes in authorization fields and image-index controls; do not change their service calls.
- Convert trash into scanning rows with aligned metadata and a visually separated danger action; keep online checks, deep links, selection, mutations, and confirmation payloads unchanged.

- [ ] **Step 3: Refactor auth and legal presentation**

- Keep auth pages focused and narrow, with the brand as the first signal, no marketing hero, and no decorative split layout.
- Use a simple form surface with clear field rhythm and Acid Lime only on the submit action/focus state.
- Use a restrained reading column for legal content with serif page title and sans-serif body/navigation.
- Preserve server actions, validation, error messages, redirects, legal configuration, and route paths.

- [ ] **Step 4: Implement page styles and verify dark mode**

In `pages.css`, define settings sections, trash rows/dialogs, auth shell/forms, and legal typography for both themes. Use full-width sections rather than page-section cards; only confirmation dialogs and the focused auth form may have a framed surface.

Import `pages.css` last from the root layout.

- [ ] **Step 5: Run page tests and commit**

Run:

```bash
npm test -- 'src/app/(workspace)/settings/page.test.tsx' src/features/theme src/features/authorizations/field-settings.test.tsx src/features/image-search/index-settings.test.tsx src/features/trash/trash-view.test.tsx 'src/app/(auth)' 'src/app/(legal)'
```

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

```bash
git add src/app/layout.tsx src/app/styles/pages.css 'src/app/(workspace)/settings/page.tsx' 'src/app/(workspace)/settings/page.test.tsx' src/features/theme/theme-control.tsx src/features/authorizations/field-settings.tsx src/features/image-search/index-settings.tsx src/features/trash/trash-view.tsx src/features/trash/trash-view.test.tsx 'src/app/(auth)/login/page.tsx' 'src/app/(auth)/login/page.test.tsx' 'src/app/(auth)/login/login-form.tsx' 'src/app/(auth)/change-password/page.tsx' 'src/app/(auth)/change-password/change-password-form.tsx' 'src/app/(legal)/layout.tsx' 'src/app/(legal)/privacy/page.tsx' 'src/app/(legal)/privacy/page.test.tsx' 'src/app/(legal)/terms/page.tsx' 'src/app/(legal)/terms/page.test.tsx'
git commit -m "feat: unify supporting product pages"
```

---

### Task 7: Perform responsive, dark-mode, accessibility, and regression hardening

**Files:**
- Create: `tests/e2e/ui-shell.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `src/app/styles/foundation.css`
- Modify: `src/app/styles/controls.css`
- Modify: `src/app/styles/workspace.css`
- Modify: `src/app/styles/library.css`
- Modify: `src/app/styles/workflows.css`
- Modify: `src/app/styles/dashboard.css`
- Modify: `src/app/styles/pages.css`

- [ ] **Step 1: Add shell-level Playwright assertions**

Create a deterministic smoke spec using the existing `loginAs` fixture. Assert the shell at multiple viewports without coupling to colors:

```ts
test("workspace adapts without page overflow", async ({ page }) => {
  await loginAs(page, E2E_USERS.designer);

  for (const viewport of [
    { width: 1512, height: 982 },
    { width: 1280, height: 800 },
    { width: 834, height: 1112 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/library");
    await expect(page.getByRole("main")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});
```

Add assertions for desktop collapse persistence, mobile drawer Escape behavior, theme switching, and focus visibility. Keep screenshot capture as artifacts, not brittle pixel snapshots in the default suite.

- [ ] **Step 2: Run the focused E2E smoke test**

Run: `npx playwright test tests/e2e/ui-shell.spec.ts --project=chromium-desktop`

Expected: PASS after fixing any real overflow, focus, or drawer defects.

- [ ] **Step 3: Run automated regression gates**

Run in this order:

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

Expected: every command exits 0. The build step is mandatory because Next.js may merge CSS differently in production.

- [ ] **Step 4: Run core workflow E2E suites**

```bash
npm run test:e2e -- tests/e2e/core-library.spec.ts tests/e2e/folders-trash.spec.ts
E2E_IMAGE_SEARCH=1 npm run test:e2e -- tests/e2e/image-search.spec.ts tests/e2e/palette-search.spec.ts
npm run test:e2e:commercial -- tests/e2e/dashboard.spec.ts tests/e2e/commercial-authorizations.spec.ts
```

Expected: PASS. If required local services are unavailable, record the exact missing prerequisite and still run all unaffected suites; do not claim the blocked suite passed.

- [ ] **Step 5: Perform visual QA in a real browser**

Start the dev server on the first available port and inspect light and dark themes at `1512x982`, `1280x800`, `834x1112`, and `390x844`. Capture at least:

- library default, selected, list, collapsed-sidebar, inspector, image-search, palette-search, and upload states;
- dashboard, settings, trash, login, destructive confirmation, and legal content;
- transparent/very light artwork in dark mode and very dark artwork in light mode.

Check every capture for five columns at the primary viewport, text clipping, overlaps, double scrollbars, blank regions, focus loss, hover-only mobile actions, weak contrast, and layout shift. Fix defects in the smallest owning stylesheet/component and rerun its focused tests.

- [ ] **Step 6: Remove superseded rules and scan for forbidden visual patterns**

Delete only legacy rules demonstrably replaced by the new ordered styles. Then run:

```bash
rg -n "linear-gradient|radial-gradient|border-radius:\s*(1[6-9]|[2-9][0-9])px|#[0-9a-fA-F]{6}" src/app/styles src/app/globals.css
```

Expected: no gradients/orbs; large radii only where explicitly justified by a circular control; hard-coded colors limited to semantic tokens, artwork swatches, and chart definitions.

- [ ] **Step 7: Final verification and commit**

Re-run:

```bash
npm run typecheck && npm run lint && npm test && npm run build
git status --short
```

Expected: all checks pass; status contains only intentional final QA changes.

```bash
git add tests/e2e/ui-shell.spec.ts playwright.config.ts src/app/styles/foundation.css src/app/styles/controls.css src/app/styles/workspace.css src/app/styles/library.css src/app/styles/workflows.css src/app/styles/dashboard.css src/app/styles/pages.css
git commit -m "test: harden redesigned interface across viewports"
```

Use `git diff --staged --name-only` before committing so generated screenshots, `.superpowers/`, local environment files, and unrelated user changes are never included.

---

## Final Acceptance Checklist

- [ ] `1512x982` opens with expanded navigation and five library columns.
- [ ] `1280x800` stays readable with controlled wrapping and no horizontal page overflow.
- [ ] Sidebar collapse persists locally; mobile navigation is a real drawer with focus/Escape behavior.
- [ ] Palette cards, multi-color palette search, image search, upload, inspector, preview, and bulk actions remain functional.
- [ ] Dashboard, settings, trash, auth, password change, and legal pages share the same design language.
- [ ] Light, dark, and system themes have deliberate surfaces, borders, disabled states, and focus contrast.
- [ ] Existing routes, query strings, permissions, API contracts, and business logic remain unchanged.
- [ ] Unit, integration, relevant E2E, typecheck, lint, and production build results are recorded accurately.
- [ ] Final browser captures show no overlap, clipping, nested cards, unnecessary shadows, decorative gradients, or blank content.

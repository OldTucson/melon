# Melon Prelaunch Compliance Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish accurate privacy, private-service, contact, and filing information without inventing values that are not yet available.

**Architecture:** Optional public legal metadata is parsed with the existing server environment schema and passed into small server components. Public legal routes render the current product behavior; the login and authenticated settings surfaces reuse one filing/link component.

**Tech Stack:** Next.js App Router server components, Zod, React Testing Library, Vitest, existing CSS design tokens.

---

## File Map

- `src/lib/env/server.ts`, `src/lib/env/server.test.ts`: parse legal metadata and filing pairs.
- `.env.example`: document production-provided public values.
- `src/features/legal/legal-config.ts`: map parsed environment to a public-only DTO.
- `src/features/legal/legal-links.tsx`, `legal-links.test.tsx`: shared links and conditional filing display.
- `src/features/legal/legal-page.tsx`: shared legal document shell.
- `src/app/(legal)/layout.tsx`: public legal layout.
- `src/app/(legal)/privacy/page.tsx`, `page.test.tsx`: privacy policy.
- `src/app/(legal)/terms/page.tsx`, `page.test.tsx`: private-service terms.
- `src/app/(auth)/login/page.tsx`, `page.test.tsx`: public legal access from login.
- `src/app/(workspace)/settings/page.tsx`, `page.test.tsx`: authenticated legal/contact section.
- `src/app/globals.css`: restrained legal-page, footer, and settings styles.

## Task 1: Parse public legal metadata safely

**Files:**
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `.env.example`
- Create: `src/features/legal/legal-config.ts`
- Create: `src/features/legal/legal-config.test.ts`

- [ ] **Step 1: Write failing environment tests**

Extend `server.test.ts` with these cases:

```ts
it("parses optional public legal metadata", () => {
  const parsed = parseServerEnv({
    ...validEnv,
    SITE_OPERATOR_NAME: "Melon Studio",
    SITE_CONTACT_EMAIL: "privacy@example.test",
    SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
    ICP_FILING_NUMBER: "浙ICP备00000000号-1",
  });
  expect(parsed.SITE_CONTACT_EMAIL).toBe("privacy@example.test");
});

it("requires the public-security number and URL together", () => {
  expect(() => parseServerEnv({
    ...validEnv,
    PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
  })).toThrow(/together/i);
});
```

Also reject blank operator names, invalid email, non-ISO effective dates, non-HTTPS public-security URLs, and a URL without a public-security number.

- [ ] **Step 2: Run tests and verify the new fields are absent**

Run:

```bash
npm test -- src/lib/env/server.test.ts
```

Expected: FAIL because the new fields are not parsed or paired.

- [ ] **Step 3: Extend the server schema**

Add optional trimmed schemas:

```ts
SITE_OPERATOR_NAME: optionalNonBlankString,
SITE_CONTACT_EMAIL: z.preprocess(blankToUndefined, z.string().email().optional()),
SITE_LEGAL_EFFECTIVE_DATE: z.preprocess(
  blankToUndefined,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
),
ICP_FILING_NUMBER: optionalNonBlankString,
PUBLIC_SECURITY_FILING_NUMBER: optionalNonBlankString,
PUBLIC_SECURITY_FILING_URL: z.preprocess(
  blankToUndefined,
  z.string().url().startsWith("https://").optional(),
),
```

In `superRefine`, require the two public-security fields together. Refactor the existing blank preprocessor into a named `blankToUndefined` helper so all optional public values share identical blank handling.

- [ ] **Step 4: Add `.env.example` entries**

```dotenv
SITE_OPERATOR_NAME=
SITE_CONTACT_EMAIL=
SITE_LEGAL_EFFECTIVE_DATE=2026-10-23
ICP_FILING_NUMBER=
PUBLIC_SECURITY_FILING_NUMBER=
PUBLIC_SECURITY_FILING_URL=
```

- [ ] **Step 5: Write and run the public DTO test**

Test `toPublicLegalConfig(env)` returns only the six public fields and does not include `AUTH_SECRET`, database, OSS, or image-search configuration. Then implement:

```ts
export type PublicLegalConfig = {
  operatorName?: string;
  contactEmail?: string;
  effectiveDate?: string;
  icpFilingNumber?: string;
  publicSecurityFiling?: { number: string; url: string };
};

export const toPublicLegalConfig = (env: ServerEnv): PublicLegalConfig => ({
  operatorName: env.SITE_OPERATOR_NAME,
  contactEmail: env.SITE_CONTACT_EMAIL,
  effectiveDate: env.SITE_LEGAL_EFFECTIVE_DATE,
  icpFilingNumber: env.ICP_FILING_NUMBER,
  publicSecurityFiling:
    env.PUBLIC_SECURITY_FILING_NUMBER && env.PUBLIC_SECURITY_FILING_URL
      ? { number: env.PUBLIC_SECURITY_FILING_NUMBER, url: env.PUBLIC_SECURITY_FILING_URL }
      : undefined,
});
```

- [ ] **Step 6: Run focused tests and commit**

```bash
npm test -- src/lib/env/server.test.ts src/features/legal/legal-config.test.ts
git add .env.example src/lib/env/server.ts src/lib/env/server.test.ts src/features/legal/legal-config.ts src/features/legal/legal-config.test.ts
git commit -m "feat: configure public legal metadata"
```

## Task 2: Build reusable legal navigation

**Files:**
- Create: `src/features/legal/legal-links.tsx`
- Create: `src/features/legal/legal-links.test.tsx`
- Create: `src/features/legal/legal-page.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing component tests**

Test that privacy and terms links always render, an ICP number links exactly to `https://beian.miit.gov.cn/`, a public-security number uses its configured HTTPS URL, missing filing values render no blank anchors, and operator/contact metadata appears only when supplied.

```tsx
render(<LegalLinks config={{ operatorName: "Melon Studio", contactEmail: "privacy@example.test" }} />);
expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/privacy");
expect(screen.getByRole("link", { name: "服务协议" })).toHaveAttribute("href", "/terms");
expect(screen.queryByText(/ICP备/)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run and verify the missing-component failure**

```bash
npm test -- src/features/legal/legal-links.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement `LegalLinks` and `LegalPage`**

`LegalLinks` accepts a `PublicLegalConfig` prop, uses ordinary text links, sets `rel="noreferrer"` on external filing links, and never renders placeholders. `LegalPage` renders a compact header with the `melon` wordmark, a constrained `<main>` with title/effective date/content, and `LegalLinks` at the bottom.

- [ ] **Step 4: Add restrained responsive styles**

Add `.legal-links`, `.legal-page`, `.legal-page-header`, `.legal-content`, and `.legal-section` using existing color and spacing tokens. Do not use nested cards, decorative gradients, floating sections, negative letter spacing, or viewport-scaled type. Keep the content width at `min(720px, 100%)` and links wrapping on 390 px screens.

- [ ] **Step 5: Run component tests and commit**

```bash
npm test -- src/features/legal/legal-links.test.tsx
git add src/features/legal src/app/globals.css
git commit -m "feat: add legal navigation components"
```

## Task 3: Publish the privacy policy

**Files:**
- Create: `src/app/(legal)/layout.tsx`
- Create: `src/app/(legal)/privacy/page.tsx`
- Create: `src/app/(legal)/privacy/page.test.tsx`

- [ ] **Step 1: Write the failing privacy-page test**

Mock `getServerEnv()` with public values, render the async page, and require headings or text for operator/contact, account data, uploaded works, authorization data, query-image non-persistence, OSS/infrastructure, 30-day trash retention, security logs, user rights, and contact procedure. Assert it does not contain secrets or claim that filing is complete.

- [ ] **Step 2: Run and verify the missing-page failure**

```bash
npm test -- 'src/app/(legal)/privacy/page.test.tsx'
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the route and metadata**

Use a server page that obtains `toPublicLegalConfig(getServerEnv())` and renders these sections through `LegalPage`: 信息处理者、处理的信息、处理目的、存储与安全、保存期限、用户权利、政策更新、联系我们. State accurately that search query images are processed for the current request and are not added as library assets or persisted search history.

- [ ] **Step 4: Run privacy tests and commit**

```bash
npm test -- 'src/app/(legal)/privacy/page.test.tsx'
git add 'src/app/(legal)'
git commit -m "feat: publish privacy policy"
```

## Task 4: Publish private-service terms

**Files:**
- Create: `src/app/(legal)/terms/page.tsx`
- Create: `src/app/(legal)/terms/page.test.tsx`

- [ ] **Step 1: Write the failing terms-page test**

Require sections for private invitation, account protection, authorized content ownership, prohibited content, service availability, deletion/retention, suspension, changes, and contact. Assert there is no public-registration promise, payment promise, marketplace language, or invented company/filing identifier.

- [ ] **Step 2: Run and verify the missing-page failure**

```bash
npm test -- 'src/app/(legal)/terms/page.test.tsx'
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the terms route**

Render through `LegalPage` with concise Chinese text matching the private invited-account model. Make clear that users retain ownership of uploaded content while granting only the processing permission necessary to operate previews, storage, search, download, and deletion.

- [ ] **Step 4: Run terms tests and commit**

```bash
npm test -- 'src/app/(legal)/terms/page.test.tsx'
git add 'src/app/(legal)/terms'
git commit -m "feat: publish private service terms"
```

## Task 5: Expose legal links from login and settings

**Files:**
- Modify: `src/app/(auth)/login/page.tsx`
- Create/Modify: `src/app/(auth)/login/page.test.tsx`
- Modify: `src/app/(workspace)/settings/page.tsx`
- Modify: `src/app/(workspace)/settings/page.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing login-page coverage**

Mock auth as signed out and public config with no filing numbers. Assert the page renders privacy, terms, operator, and email after the login form, and renders no empty filing element. Add a second case with both filing values and assert both external links.

- [ ] **Step 2: Run and verify links are missing**

```bash
npm test -- 'src/app/(auth)/login/page.test.tsx'
```

Expected: FAIL because login does not render `LegalLinks`.

- [ ] **Step 3: Add the login legal footer**

Load the public config on the server and render `<LegalLinks className="auth-legal" />` outside the login panel but inside `auth-shell`. Update the auth shell to use a stable two-row layout so the footer never overlaps the form at short or narrow viewports.

- [ ] **Step 4: Write failing settings coverage**

Extend the existing settings test to expect a `法律与备案` heading, privacy and terms links, operator/contact text, and conditional filing values.

- [ ] **Step 5: Add the settings section**

After the current index section, render an unframed `.settings-section` with a compact label and `LegalLinks`. Do not introduce another card inside the settings section.

- [ ] **Step 6: Run focused page tests**

```bash
npm test -- 'src/app/(auth)/login/page.test.tsx' 'src/app/(workspace)/settings/page.test.tsx' src/features/legal/legal-links.test.tsx
```

Expected: PASS at default jsdom width with no missing accessible names.

- [ ] **Step 7: Commit entry points**

```bash
git add 'src/app/(auth)/login' 'src/app/(workspace)/settings' src/app/globals.css
git commit -m "feat: expose legal and filing links"
```

## Task 6: Verify the compliance phase

- [ ] **Step 1: Run fresh focused and global checks**

```bash
npm test -- src/features/legal src/lib/env/server.test.ts 'src/app/(legal)' 'src/app/(auth)/login/page.test.tsx' 'src/app/(workspace)/settings/page.test.tsx'
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0; build lists `/privacy` and `/terms` as public routes.

- [ ] **Step 2: Browser smoke at desktop and mobile widths**

Open `/login`, `/privacy`, `/terms`, and `/settings` at 1440×900 and 390×844. Verify no horizontal overflow, no footer/form overlap, readable policy text, keyboard-visible links, and no empty filing placeholders.


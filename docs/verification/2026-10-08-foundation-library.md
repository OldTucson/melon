# Foundation Library Verification

- Verified: 2026-10-12T10:58:50+08:00
- Target runtime: Node.js 24
- Runtime used: Node.js 24.21.0, npm 11.11.0
- Database: PostgreSQL 17.10
- Cloud target: operator-provided private Alibaba Cloud OSS Bucket

## Quality gate

All commands completed with exit code `0` under Node.js 24.21.0.

| Command | Evidence |
| --- | --- |
| `npm test` | 44 files passed; 359 tests passed |
| `npm run test:integration` | 10 files passed and 1 opt-in file skipped; 84 tests passed and 1 skipped |
| `RUN_REAL_OSS_TESTS=1 npm run test:integration -- src/features/storage/oss-adapter.real.integration.test.ts` | 1 file passed; 1 test passed |
| `npm run typecheck` | TypeScript completed without diagnostics |
| `npm run lint` | ESLint completed without warnings or errors |
| `npm run build` | Next.js 16.4.0 production build completed; all routes generated |
| `npm run test:e2e` | 4 tests passed and 2 intentional cross-browser duplicates skipped |

## Browser coverage

The core journey passed in all configured projects:

| Project | Viewport | Result |
| --- | --- | --- |
| `chromium-desktop` | 1440 x 900 | Core journey passed; tenant isolation passed |
| `webkit-desktop` | 1440 x 900 | Core journey passed; duplicate tenant test skipped |
| `webkit-1024` | 1024 x 1366 | Core journey passed; no page-level horizontal overflow |

The core journey covered login, real browser-to-OSS upload, progress completion, JPG/PNG-derived thumbnail and preview display, rename, tag creation and assignment, tag filtering, favorite filtering, original filename download, and byte-for-byte SHA-256 verification.

The tenant journey proved that another authenticated user cannot list or read the pattern, edit it, view or download its asset, refresh its upload credentials, or complete its upload session.

## Real OSS smoke test

The opt-in cloud test used a random owner, pattern, and asset UUID prefix. It:

1. obtained scoped upload credentials through STS;
2. uploaded the first 1 MiB part manually;
3. resumed the remaining multipart upload from an SDK checkpoint;
4. verified metadata and a byte range through the server adapter;
5. downloaded through a 300-second V4 signed URL and matched the SHA-256 digest;
6. deleted the object and confirmed it was no longer readable.

E2E-created OSS objects and database rows were also cleaned by global teardown.

## Security checks

`rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!.env*' -g '!package-lock.json' 'LTAI[A-Za-z0-9]+' .` returned no matches. No `.env.local` values, temporary STS credentials, session tokens, or signed URLs are included in tracked files.

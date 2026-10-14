import { deflateSync } from "node:zlib";

import { expect, test as base, type Page } from "@playwright/test";
import postgres from "postgres";

import {
  E2E_BASE_URL,
  E2E_DATABASE_URL,
  E2E_PASSWORD,
  E2E_USERS,
} from "./environment";

export const E2E_PATTERN_SEEDS = {
  folderWorkflow: [
    {
      id: "33333333-3333-4333-8333-333333333331",
      name: "蜜瓜纹样",
      originalFilename: "melon-pattern.png",
    },
    {
      id: "33333333-3333-4333-8333-333333333332",
      name: "柠檬纹样",
      originalFilename: "lemon-pattern.png",
    },
  ],
  isolationActor: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "隔离校验纹样",
    originalFilename: "isolation-actor.png",
  },
} as const;

export type BrowserResponse<T> = { body: T; status: number };

export async function browserRequest<T>(
  page: Page,
  url: string,
  input: { body?: unknown; method?: string } = {},
) {
  return page.evaluate(
    async ({ body, method, url }): Promise<BrowserResponse<T>> => {
      const response = await fetch(url, {
        method: method ?? "GET",
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      });
      return {
        body: (await response.json()) as T,
        status: response.status,
      };
    },
    { body: input.body, method: input.method, url },
  );
}

export async function browserStatusRequest(
  page: Page,
  url: string,
  redirect: RequestRedirect = "manual",
) {
  return page.evaluate(
    async ({ redirect, url }) => {
      const response = await fetch(url, { redirect });
      return {
        ok: response.ok,
        status: response.status,
      };
    },
    { redirect, url },
  );
}

type FolderSnapshot = {
  changeSeq: string;
  deletedAt: Date | null;
  id: string;
  parentId: string | null;
  name: string;
  status: string;
  trashedAt: Date | null;
  version: number;
  trashBatchId: string | null;
};

type PatternSnapshot = {
  changeSeq: string;
  deletedAt: Date | null;
  id: string;
  folderId: string | null;
  name: string;
  preTrashStatus: string | null;
  status: string;
  trashedAt: Date | null;
  version: number;
  trashBatchId: string | null;
};

type AssetSnapshot = {
  id: string;
  patternId: string;
  role: string;
  objectKey: string;
  sizeBytes: string;
  contentHash: string | null;
};

export type TenantSnapshot = {
  assets: AssetSnapshot[];
  folders: FolderSnapshot[];
  patterns: PatternSnapshot[];
};

export type ChangeLogSnapshot = {
  entityId: string;
  entityType: string;
  operation: string;
  operationId: string;
  payload: Record<string, unknown>;
  seq: string;
};

export type OperationSnapshot = {
  kind: string;
  result: Record<string, unknown>;
};

export async function readTenantSnapshot(
  ownerId: string,
): Promise<TenantSnapshot> {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    const folders = await client<FolderSnapshot[]>`
      select
        id,
        parent_id as "parentId",
        name,
        status::text,
        version,
        trash_batch_id as "trashBatchId",
        trashed_at as "trashedAt",
        deleted_at as "deletedAt",
        change_seq::text as "changeSeq"
      from folders
      where owner_id = ${ownerId}
      order by id
    `;
    const patterns = await client<PatternSnapshot[]>`
      select
        id,
        folder_id as "folderId",
        name,
        status::text,
        version,
        trash_batch_id as "trashBatchId",
        pre_trash_status::text as "preTrashStatus",
        trashed_at as "trashedAt",
        deleted_at as "deletedAt",
        change_seq::text as "changeSeq"
      from patterns
      where owner_id = ${ownerId}
      order by id
    `;
    const assets = await client<AssetSnapshot[]>`
      select
        id,
        pattern_id as "patternId",
        role::text,
        object_key as "objectKey",
        size_bytes::text as "sizeBytes",
        content_hash as "contentHash"
      from assets
      where owner_id = ${ownerId}
      order by id
    `;
    return { assets, folders, patterns };
  } finally {
    await client.end();
  }
}

export async function readChangeLog(
  ownerId: string,
): Promise<ChangeLogSnapshot[]> {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    return await client<ChangeLogSnapshot[]>`
      select
        seq::text,
        operation_id as "operationId",
        entity_type as "entityType",
        entity_id as "entityId",
        operation,
        payload
      from change_log
      where owner_id = ${ownerId}
      order by seq
    `;
  } finally {
    await client.end();
  }
}

export async function readOperationSnapshot(
  ownerId: string,
  operationId: string,
): Promise<OperationSnapshot | undefined> {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    const [operation] = await client<OperationSnapshot[]>`
      select kind, result
      from operations
      where owner_id = ${ownerId} and operation_id = ${operationId}
      limit 1
    `;
    return operation;
  } finally {
    await client.end();
  }
}

export async function expireUploadSafetyWindowForE2E(
  ownerId: string,
  patternId: string,
) {
  const allowedOwnerIds = new Set<string>(
    Object.values(E2E_USERS).map((user) => user.id),
  );
  if (!allowedOwnerIds.has(ownerId)) {
    throw new Error("E2E_OWNER_ID_UNSAFE");
  }
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await client<{ id: string }[]>`
      update upload_sessions
      set
        credential_issue_fence_at = '2000-01-01T00:00:00.000Z',
        credentials_expire_at = '2000-01-01T00:00:00.000Z'
      where owner_id = ${ownerId} and pattern_id = ${patternId}
      returning id
    `;
    if (rows.length === 0) throw new Error("E2E_UPLOAD_SESSION_MISSING");
  } finally {
    await client.end();
  }
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Buffer) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createTransparentPng() {
  const width = 16;
  const height = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    scanlines[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 4;
      scanlines.set([219, 63, 120, (x + y) % 3 === 0 ? 96 : 255], pixel);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const TRANSPARENT_PNG = createTransparentPng();

export async function loginAs(
  page: Page,
  user: (typeof E2E_USERS)[keyof typeof E2E_USERS],
) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(user.email);
  await page.getByLabel("密码").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/library(?:\?|$)/);
}

export const test = base.extend({
  page: async ({ page }, providePage) => {
    const errors: string[] = [];
    const appOrigin = new URL(E2E_BASE_URL).origin;
    page.on("console", (message) => {
      if (message.type() === "error") {
        const rawLocation = message.location().url;
        let location = "unknown";
        let pathname = "";
        let origin = "";
        if (rawLocation) {
          try {
            const parsed = new URL(rawLocation);
            pathname = parsed.pathname;
            origin = parsed.origin;
            location =
              parsed.origin === appOrigin
                ? `${parsed.origin}${parsed.pathname}`
                : parsed.origin;
          } catch {
            location = "invalid-url";
          }
        }
        const expectedApiRejection =
          origin === appOrigin &&
          pathname.startsWith("/api/") &&
          /Failed to load resource.*\b(?:404|409)\b/i.test(message.text());
        if (!expectedApiRejection) {
          errors.push(`console error at ${location}`);
        }
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`pageerror: ${error.name || "Error"}`);
    });

    await providePage(page);

    expect(errors, "browser console and page errors").toEqual([]);
  },
});
export { expect };

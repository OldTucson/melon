import { parseObjectKey } from "../../src/features/storage/object-keys";
import { E2E_USERS } from "./environment";

const allowedOwnerIds = new Set<string>(
  Object.values(E2E_USERS).map((user) => user.id),
);
const allowedOwnerPrefixes = Object.values(E2E_USERS).map(
  (user) => `users/${user.id}/patterns/`,
);
const allowedOwnerPrefixSet = new Set(allowedOwnerPrefixes);

export type E2eAssetRow = {
  assetId: string;
  objectKey: string;
  ownerId: string;
  patternId: string;
  role: string;
};

type E2eOssListQuery = {
  "continuation-token"?: string;
  "max-keys": number;
  prefix: string;
};

type E2eOssListPage = {
  isTruncated: boolean;
  nextContinuationToken?: string;
  objects?: Array<{ name: string }>;
};

type E2eOssLister = {
  listV2(query: E2eOssListQuery): Promise<E2eOssListPage>;
};

function unsafe(): never {
  throw new Error("E2E_OSS_OBJECT_KEY_UNSAFE");
}

function parseAllowedObjectKey(objectKey: string) {
  try {
    const parsed = parseObjectKey(objectKey);
    if (!allowedOwnerIds.has(parsed.ownerId)) unsafe();
    return parsed;
  } catch {
    return unsafe();
  }
}

export function assertE2eObjectKeys(objectKeys: readonly string[]) {
  for (const objectKey of objectKeys) {
    parseAllowedObjectKey(objectKey);
  }
}

export function assertE2eAssetRows(rows: readonly E2eAssetRow[]) {
  for (const row of rows) {
    const parsed = parseAllowedObjectKey(row.objectKey);
    const expectedKind =
      row.role === "source"
        ? "source"
        : row.role === "preview" || row.role === "thumbnail"
          ? "derived"
          : unsafe();
    if (
      parsed.ownerId !== row.ownerId ||
      parsed.patternId !== row.patternId ||
      parsed.assetId !== row.assetId ||
      parsed.kind !== expectedKind
    ) {
      unsafe();
    }
  }
}

export function e2eOwnerObjectPrefixes() {
  return [...allowedOwnerPrefixes];
}

export function assertE2eListedObjectKeys(
  prefix: string,
  objectKeys: readonly string[],
) {
  if (!allowedOwnerPrefixSet.has(prefix)) unsafe();
  for (const objectKey of objectKeys) {
    if (typeof objectKey !== "string" || !objectKey.startsWith(prefix)) {
      unsafe();
    }
  }
}

export async function listE2eOssObjectKeys(client: E2eOssLister) {
  const keys: string[] = [];
  for (const prefix of e2eOwnerObjectPrefixes()) {
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const result = await client.listV2({
        prefix,
        "max-keys": 1000,
        ...(continuationToken === undefined
          ? {}
          : { "continuation-token": continuationToken }),
      });
      const pageKeys = (result.objects ?? []).map((object) => object.name);
      assertE2eListedObjectKeys(prefix, pageKeys);
      keys.push(...pageKeys);

      if (!result.isTruncated) break;
      const nextToken = result.nextContinuationToken;
      if (
        typeof nextToken !== "string" ||
        nextToken.length === 0 ||
        seenTokens.has(nextToken)
      ) {
        throw new Error("E2E_OSS_LIST_PAGINATION_INVALID");
      }
      seenTokens.add(nextToken);
      continuationToken = nextToken;
    } while (true);
  }
  return [...new Set(keys)];
}

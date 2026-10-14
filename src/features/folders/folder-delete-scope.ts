import "server-only";

import { createHash } from "node:crypto";

import type { FolderDeleteImpact } from "./contracts";

export type FolderDeleteScope = Pick<
  FolderDeleteImpact,
  | "folderCount"
  | "patternCount"
  | "alreadyTrashedFolderCount"
  | "alreadyTrashedPatternCount"
  | "hasDeletingEntities"
  | "scopeFingerprint"
>;

type ScopeEntity = { id: string; status: string };

const canonicalScope = (entities: readonly ScopeEntity[]) =>
  entities
    .map((entity) => `${entity.id}:${entity.status}`)
    .sort()
    .join(",");

export function folderDeleteScopeFingerprintFromParts(
  folderScope: string,
  patternScope: string,
) {
  return createHash("sha256")
    .update(`folders=${folderScope}\npatterns=${patternScope}`)
    .digest("hex");
}

export function buildFolderDeleteImpact(
  folders: readonly ScopeEntity[],
  patterns: readonly ScopeEntity[],
): FolderDeleteScope {
  return {
    folderCount: folders.length,
    patternCount: patterns.length,
    alreadyTrashedFolderCount: folders.filter(
      (folder) => folder.status === "trashed",
    ).length,
    alreadyTrashedPatternCount: patterns.filter(
      (pattern) => pattern.status === "trashed",
    ).length,
    hasDeletingEntities:
      folders.some((folder) => folder.status === "deleting") ||
      patterns.some((pattern) => pattern.status === "deleting"),
    scopeFingerprint: folderDeleteScopeFingerprintFromParts(
      canonicalScope(folders),
      canonicalScope(patterns),
    ),
  };
}

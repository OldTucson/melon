import type { PatternQuery } from "@/features/patterns/contracts";
import type { TagColorToken } from "@/features/tags/contracts";
import type { patterns } from "@/lib/db/schema";

type PatternStatus = (typeof patterns.$inferSelect)["status"];

export type PatternItem = {
  id: string;
  ownerId: string;
  name: string;
  originalFilename: string;
  extension: string;
  detectedMimeType: string | null;
  sizeBytes: string;
  contentHash: string | null;
  status: PatternStatus;
  folderId: string | null;
  trashBatchId: string | null;
  preTrashStatus: PatternStatus | null;
  previewStatus: "pending" | "ready" | "unsupported" | "failed" | "manual";
  previewAssetId?: string | null;
  thumbnailAssetId?: string | null;
  sourceAssetId?: string | null;
  isFavorite: boolean;
  version: number;
  commercialVersion: number;
  lastErrorCode: string | null;
  trashedAt: string | null;
  deletedAt: string | null;
  changeSeq: string;
  createdAt: string;
  updatedAt: string;
};

export type PatternPage = {
  items: PatternItem[];
  nextCursor: string | null;
};

export type TagItem = {
  id: string;
  ownerId: string;
  name: string;
  normalizedName: string;
  colorToken: TagColorToken;
  changeSeq: string;
  createdAt: string;
  updatedAt: string;
};

export type PatternTagItem = {
  ownerId: string;
  patternId: string;
  tagId: string;
  isActive: boolean;
  version: number;
  changeSeq: string;
  createdAt: string;
  updatedAt: string;
};

export type PatternTagPage = { items: PatternTagItem[] };

export type ActivePatternQuery = PatternQuery;

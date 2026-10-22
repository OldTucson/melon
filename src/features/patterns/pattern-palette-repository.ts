import "server-only";

import { sql } from "drizzle-orm";

import type {
  PatternPaletteColor,
  PatternPaletteStatus,
} from "@/features/library/library-types";
import { db } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env/server";

const MAX_PATTERN_IDS = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INDEX_VERSION_PATTERN = /^[a-z0-9-]{1,64}$/;
const PALETTE_HEX_PATTERN = /^#[0-9A-F]{6}$/;

export type PatternPaletteState = {
  paletteStatus: PatternPaletteStatus;
  palette: PatternPaletteColor[];
};

type ReadyPaletteRow = {
  patternId: string;
  colorIndex: number | null;
  displayHex: string | null;
  coverage: number | null;
};

type PaletteJobRow = {
  patternId: string;
  status: "pending" | "leased" | "complete" | "failed";
};

export const pendingPatternPaletteState = (): PatternPaletteState => ({
  paletteStatus: "pending",
  palette: [],
});

export function withPalette<T extends object>(
  dto: T,
  state: PatternPaletteState = pendingPatternPaletteState(),
): T & PatternPaletteState {
  return {
    ...dto,
    paletteStatus: state.paletteStatus,
    palette: state.palette.map((color) => ({ ...color })),
  };
}

function invalidScope(): never {
  throw new Error("PATTERN_PALETTE_SCOPE_INVALID");
}

function validateScope(input: {
  ownerId: string;
  patternIds: readonly string[];
  indexVersion: string;
}) {
  if (
    !UUID_PATTERN.test(input.ownerId) ||
    !INDEX_VERSION_PATTERN.test(input.indexVersion) ||
    input.patternIds.length > MAX_PATTERN_IDS ||
    input.patternIds.some((patternId) => !UUID_PATTERN.test(patternId)) ||
    new Set(input.patternIds).size !== input.patternIds.length
  ) {
    invalidScope();
  }
}

function patternIdList(patternIds: readonly string[]) {
  return sql.join(
    patternIds.map((patternId) => sql`${patternId}::uuid`),
    sql`, `,
  );
}

function readyState(rows: readonly ReadyPaletteRow[]): PatternPaletteState {
  if (
    rows.length < 3 ||
    rows.length > 5 ||
    rows.some((row, index) => row.colorIndex !== index) ||
    rows.some(
      (row) =>
        typeof row.displayHex !== "string" ||
        !PALETTE_HEX_PATTERN.test(row.displayHex) ||
        typeof row.coverage !== "number" ||
        !Number.isFinite(row.coverage) ||
        row.coverage <= 0 ||
        row.coverage > 1,
    ) ||
    new Set(rows.map((row) => row.displayHex)).size !== rows.length
  ) {
    throw new Error("PATTERN_PALETTE_INVALID");
  }
  const coverage = rows.reduce((sum, row) => sum + row.coverage!, 0);
  if (Math.abs(coverage - 1) > 1e-5) {
    throw new Error("PATTERN_PALETTE_INVALID");
  }
  return {
    paletteStatus: "ready",
    palette: rows.map((row) => ({
      hex: row.displayHex!,
      coverage: row.coverage!,
    })),
  };
}

export async function loadPatternPaletteStates(input: {
  ownerId: string;
  patternIds: readonly string[];
  indexVersion: string;
  executor?: Pick<typeof db, "execute">;
}): Promise<Map<string, PatternPaletteState>> {
  validateScope(input);
  const patternIds = [...input.patternIds];
  const states = new Map(
    patternIds.map((patternId) => [patternId, pendingPatternPaletteState()]),
  );
  if (patternIds.length === 0 || !getServerEnv().IMAGE_SEARCH_ENABLED) {
    return states;
  }

  const executor = input.executor ?? db;
  const readyRows = await executor.execute<ReadyPaletteRow>(sql`
    select
      documents.pattern_id as "patternId",
      colors.color_index as "colorIndex",
      colors.display_hex as "displayHex",
      colors.coverage as "coverage"
    from visual_search_documents as documents
    left join visual_search_palette_colors as colors
      on colors.document_id = documents.id
     and colors.owner_id = documents.owner_id
     and colors.pattern_id = documents.pattern_id
    where documents.owner_id = ${input.ownerId}::uuid
      and documents.index_version = ${input.indexVersion}
      and documents.status = 'ready'
      and documents.pattern_id in (${patternIdList(patternIds)})
    order by documents.pattern_id, colors.color_index
  `);
  const grouped = new Map<string, ReadyPaletteRow[]>();
  for (const row of readyRows) {
    const rows = grouped.get(row.patternId) ?? [];
    rows.push(row);
    grouped.set(row.patternId, rows);
  }
  for (const [patternId, rows] of grouped) {
    states.set(patternId, readyState(rows));
  }

  const remaining = patternIds.filter((patternId) => !grouped.has(patternId));
  if (remaining.length === 0) return states;
  const jobRows = await executor.execute<PaletteJobRow>(sql`
    select distinct on (jobs.pattern_id)
      jobs.pattern_id as "patternId",
      jobs.status as "status"
    from visual_search_jobs as jobs
    where jobs.owner_id = ${input.ownerId}::uuid
      and jobs.index_version = ${input.indexVersion}
      and jobs.pattern_id in (${patternIdList(remaining)})
    order by jobs.pattern_id, jobs.updated_at desc, jobs.created_at desc, jobs.id desc
  `);
  for (const row of jobRows) {
    states.set(
      row.patternId,
      row.status === "failed"
        ? { paletteStatus: "failed", palette: [] }
        : pendingPatternPaletteState(),
    );
  }
  return states;
}

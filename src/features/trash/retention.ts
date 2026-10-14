export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function estimateTrashPurgeOn(now = new Date()) {
  return new Date(now.getTime() + TRASH_RETENTION_MS).toISOString();
}

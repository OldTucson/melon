const transientPatternStatuses = new Set([
  "draft",
  "hashing",
  "uploading",
  "processing",
]);

export function isTransientPatternStatus(status: string | undefined) {
  return Boolean(status && transientPatternStatuses.has(status));
}

export function patternStatusRefreshInterval(
  status: string | undefined,
  watchedAt: number,
  now = Date.now(),
) {
  if (!isTransientPatternStatus(status)) return false;
  return now - watchedAt < 30_000 ? 5_000 : 15_000;
}

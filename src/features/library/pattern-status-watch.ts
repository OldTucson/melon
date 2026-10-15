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
  updatedAt: string | undefined,
  now = Date.now(),
) {
  if (!isTransientPatternStatus(status)) return false;
  const changedAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(changedAt) && now - changedAt < 30_000
    ? 5_000
    : 15_000;
}

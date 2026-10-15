type SelectablePattern = {
  id: string;
  status: string;
};

const editableStatuses = new Set(["ready", "failed"]);

export function selectionAvailability(
  selectedIds: readonly string[],
  patterns: readonly SelectablePattern[],
) {
  if (patterns.length !== selectedIds.length) return "missing" as const;
  if (patterns.some((pattern) => !editableStatuses.has(pattern.status))) {
    return "transient" as const;
  }
  return "editable" as const;
}

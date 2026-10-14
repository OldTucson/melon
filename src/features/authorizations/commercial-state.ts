export type AuthorizationKind =
  | "standard"
  | "field_exclusive"
  | "global_buyout";

export type CommercialState =
  | "unlicensed"
  | "standard"
  | "field_exclusive"
  | "global_buyout";

export function resolveCommercialState(
  kinds: readonly AuthorizationKind[],
): CommercialState {
  if (kinds.includes("global_buyout")) return "global_buyout";
  if (kinds.includes("field_exclusive")) return "field_exclusive";
  if (kinds.includes("standard")) return "standard";
  return "unlicensed";
}


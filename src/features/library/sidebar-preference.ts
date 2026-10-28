export type SidebarMode = "expanded" | "collapsed";

export const SIDEBAR_STORAGE_KEY = "melon:sidebar-mode";

export function parseSidebarMode(value: string | null): SidebarMode | null {
  return value === "expanded" || value === "collapsed" ? value : null;
}

export function defaultSidebarMode(viewportWidth: number): SidebarMode {
  return viewportWidth < 1280 ? "collapsed" : "expanded";
}

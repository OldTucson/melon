import { describe, expect, it } from "vitest";

import {
  defaultSidebarMode,
  parseSidebarMode,
  SIDEBAR_STORAGE_KEY,
} from "./sidebar-preference";

describe("sidebar preference", () => {
  it("keeps the navigation expanded at the primary MacBook width", () => {
    expect(defaultSidebarMode(1512)).toBe("expanded");
    expect(defaultSidebarMode(1280)).toBe("expanded");
    expect(defaultSidebarMode(1279)).toBe("collapsed");
  });

  it("accepts only supported persisted values", () => {
    expect(parseSidebarMode("collapsed")).toBe("collapsed");
    expect(parseSidebarMode("expanded")).toBe("expanded");
    expect(parseSidebarMode("broken")).toBeNull();
    expect(parseSidebarMode(null)).toBeNull();
    expect(SIDEBAR_STORAGE_KEY).toBe("melon:sidebar-mode");
  });
});

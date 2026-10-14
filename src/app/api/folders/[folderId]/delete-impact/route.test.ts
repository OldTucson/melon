import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getFolderDeleteImpact: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/folders/folder-service", () => ({
  getFolderDeleteImpact: mocks.getFolderDeleteImpact,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const folderId = "30000000-0000-4000-8000-000000000003";
const impact = {
  folderCount: 4,
  patternCount: 7,
  alreadyTrashedFolderCount: 1,
  alreadyTrashedPatternCount: 2,
  hasDeletingEntities: true,
  scopeFingerprint: "a".repeat(64),
  activeAuthorizationCount: 2,
  activeRevenueFen: "100000",
  totalAuthorizationCount: 3,
  assetCount: 4,
  purgeOn: "2026-11-07T00:00:00.000Z",
};

describe("folder delete-impact Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.getFolderDeleteImpact.mockResolvedValue(impact);
  });

  it("returns an owner-scoped preview for a normalized path ID", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/folders/${folderId}/delete-impact?ownerId=${attackerId}`,
      ),
      { params: Promise.resolve({ folderId: folderId.toUpperCase() }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(impact);
    expect(mocks.getFolderDeleteImpact).toHaveBeenCalledWith({
      ownerId,
      folderId,
    });
    expect(mocks.getFolderDeleteImpact).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: attackerId }),
    );
  });

  it("rejects malformed path IDs before calling the service", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/folders/not-a-uuid/delete-impact"),
      { params: Promise.resolve({ folderId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request" },
    });
    expect(mocks.getFolderDeleteImpact).not.toHaveBeenCalled();
  });

  it("preserves the tenant-neutral not-found response", async () => {
    mocks.getFolderDeleteImpact.mockRejectedValueOnce(
      new AppError("FOLDER_NOT_FOUND", 404, "Folder not found"),
    );
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/folders/${folderId}/delete-impact`),
      { params: Promise.resolve({ folderId }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
    });
  });
});

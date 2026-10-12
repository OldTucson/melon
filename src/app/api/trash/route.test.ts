import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listTrash: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/trash/trash-service", () => ({
  listTrash: mocks.listTrash,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";

describe("trash collection Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.listTrash.mockResolvedValue({ folderBatches: [], patternBatches: [] });
  });

  it("lists trash using only the authenticated owner", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/trash?ownerId=${attackerId}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      folderBatches: [],
      patternBatches: [],
    });
    expect(mocks.listTrash).toHaveBeenCalledWith({ ownerId });
    expect(mocks.listTrash).not.toHaveBeenCalledWith({ ownerId: attackerId });
  });

  it("preserves public read errors", async () => {
    mocks.listTrash.mockRejectedValueOnce(
      new AppError("INTERNAL_ERROR", 500, "Trash data is invalid"),
    );
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/trash"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL_ERROR", message: "Trash data is invalid" },
    });
  });
});

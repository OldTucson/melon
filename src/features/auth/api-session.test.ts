import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/session", () => ({ requireUser }));

describe("requireApiUser", () => {
  beforeEach(() => {
    requireUser.mockReset();
  });

  it("returns an authenticated user", async () => {
    const user = { id: "10000000-0000-4000-8000-000000000001" };
    requireUser.mockResolvedValue(user);
    const { requireApiUser } = await import("./api-session");

    await expect(requireApiUser()).resolves.toBe(user);
  });

  it("converts a login redirect into a stable 401", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    Object.assign(redirect, {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    requireUser.mockRejectedValue(redirect);
    const { requireApiUser } = await import("./api-session");

    await expect(requireApiUser()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("does not hide unrelated authentication failures", async () => {
    const failure = new Error("database unavailable");
    requireUser.mockRejectedValue(failure);
    const { requireApiUser } = await import("./api-session");

    await expect(requireApiUser()).rejects.toBe(failure);
  });
});

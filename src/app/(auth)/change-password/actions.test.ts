import { beforeEach, describe, expect, it, vi } from "vitest";

const boundaryMocks = vi.hoisted(() => ({
  changeUserPassword: vi.fn(),
  requireUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/auth", () => ({
  signOut: boundaryMocks.signOut,
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: boundaryMocks.requireUser,
}));

vi.mock("@/features/auth/user-admin", () => ({
  changeUserPassword: boundaryMocks.changeUserPassword,
}));

import * as actionModule from "./actions";

const initialState = { error: null };

const passwordChange = (
  currentPassword: string,
  newPassword: string,
  confirmPassword = newPassword,
) => {
  const formData = new FormData();
  formData.set("currentPassword", currentPassword);
  formData.set("newPassword", newPassword);
  formData.set("confirmPassword", confirmPassword);
  return formData;
};

describe("changePasswordAction", () => {
  beforeEach(() => {
    boundaryMocks.changeUserPassword.mockReset();
    boundaryMocks.requireUser.mockReset();
    boundaryMocks.signOut.mockReset();
  });

  it("exports only async server actions at runtime", () => {
    for (const exported of Object.values(actionModule)) {
      expect(typeof exported).toBe("function");
      if (typeof exported !== "function") continue;
      expect(exported.constructor.name).toBe("AsyncFunction");
    }
  });

  it("returns a generic error for invalid input", async () => {
    await expect(
      actionModule.changePasswordAction(
        initialState,
        passwordChange("current", "too-short"),
      ),
    ).resolves.toEqual({ error: "无法更改密码，请检查输入后重试。" });
    expect(boundaryMocks.requireUser).not.toHaveBeenCalled();
  });

  it("uses the authenticated id and signs out after a successful change", async () => {
    boundaryMocks.requireUser.mockResolvedValueOnce({ id: "authenticated-id" });
    boundaryMocks.changeUserPassword.mockResolvedValueOnce(undefined);
    boundaryMocks.signOut.mockResolvedValueOnce(undefined);

    await expect(
      actionModule.changePasswordAction(
        initialState,
        passwordChange("current-password", "new-private-password"),
      ),
    ).resolves.toEqual(initialState);
    expect(boundaryMocks.changeUserPassword).toHaveBeenCalledWith({
      userId: "authenticated-id",
      currentPassword: "current-password",
      newPassword: "new-private-password",
    });
    expect(boundaryMocks.signOut).toHaveBeenCalledWith({
      redirectTo: "/login",
    });
  });

  it("returns a generic error when the password service rejects", async () => {
    boundaryMocks.requireUser.mockResolvedValueOnce({ id: "authenticated-id" });
    boundaryMocks.changeUserPassword.mockRejectedValueOnce(
      new Error("sensitive service detail"),
    );

    await expect(
      actionModule.changePasswordAction(
        initialState,
        passwordChange("wrong-password", "new-private-password"),
      ),
    ).resolves.toEqual({ error: "无法更改密码，请重试。" });
    expect(boundaryMocks.signOut).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => {
  class MockAuthError extends Error {}

  return {
    MockAuthError,
    signIn: vi.fn(),
  };
});

vi.mock("next-auth", () => ({
  AuthError: authMocks.MockAuthError,
}));

vi.mock("@/auth", () => ({
  signIn: authMocks.signIn,
}));

import * as actionModule from "./actions";

const initialState = { error: null };

const credentials = (email: string, password: string) => {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  return formData;
};

describe("loginAction", () => {
  beforeEach(() => {
    authMocks.signIn.mockReset();
  });

  it("exports only async server actions at runtime", () => {
    for (const exported of Object.values(actionModule)) {
      expect(typeof exported).toBe("function");
      if (typeof exported !== "function") continue;
      expect(exported.constructor.name).toBe("AsyncFunction");
    }
  });

  it("returns the generic credentials error for invalid input", async () => {
    await expect(
      actionModule.loginAction(initialState, credentials("invalid", "")),
    ).resolves.toEqual({ error: "邮箱或密码不正确。" });
    expect(authMocks.signIn).not.toHaveBeenCalled();
  });

  it("returns the same generic error for an Auth.js authentication error", async () => {
    authMocks.signIn.mockRejectedValueOnce(
      new authMocks.MockAuthError("invalid credentials"),
    );

    await expect(
      actionModule.loginAction(
        initialState,
        credentials("owner@example.test", "wrong-password"),
      ),
    ).resolves.toEqual({ error: "邮箱或密码不正确。" });
  });

  it("normalizes credentials and redirects a successful login", async () => {
    authMocks.signIn.mockResolvedValueOnce(undefined);

    await expect(
      actionModule.loginAction(
        initialState,
        credentials("  Owner@Example.Test ", "private-password"),
      ),
    ).resolves.toEqual(initialState);
    expect(authMocks.signIn).toHaveBeenCalledWith("credentials", {
      email: "owner@example.test",
      password: "private-password",
      redirectTo: "/library",
    });
  });

  it("rethrows Auth.js control-flow errors", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    authMocks.signIn.mockRejectedValueOnce(redirect);

    await expect(
      actionModule.loginAction(
        initialState,
        credentials("owner@example.test", "private-password"),
      ),
    ).rejects.toBe(redirect);
  });
});

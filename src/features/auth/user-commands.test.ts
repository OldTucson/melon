import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runCreateUserCommand,
  runResetPasswordCommand,
} from "@/features/auth/user-commands";

const enteredPassword = "correct horse battery staple";

describe("account command entrypoints", () => {
  const promptPassword = vi.fn();
  const closeDatabase = vi.fn();
  const createUser = vi.fn();
  const resetUserPassword = vi.fn();
  const loadCreateServices = vi.fn();
  const loadResetServices = vi.fn();

  beforeEach(() => {
    promptPassword.mockReset();
    closeDatabase.mockReset();
    createUser.mockReset();
    resetUserPassword.mockReset();
    loadCreateServices.mockReset().mockResolvedValue({
      closeDatabase,
      createUser,
    });
    loadResetServices.mockReset().mockResolvedValue({
      closeDatabase,
      resetUserPassword,
    });
  });

  it("creates a normalized user after exactly two masked prompts", async () => {
    promptPassword.mockResolvedValueOnce(enteredPassword).mockResolvedValueOnce(
      enteredPassword,
    );

    await runCreateUserCommand(["--email", "  Owner@Example.Test  "], {
      loadServices: loadCreateServices,
      promptPassword,
    });

    expect(promptPassword).toHaveBeenCalledTimes(2);
    expect(promptPassword).toHaveBeenNthCalledWith(1, {
      message: "Password",
      mask: "*",
    });
    expect(promptPassword).toHaveBeenNthCalledWith(2, {
      message: "Confirm password",
      mask: "*",
    });
    expect(createUser).toHaveBeenCalledWith({
      email: "owner@example.test",
      displayName: "owner",
      password: enteredPassword,
    });
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("resets a normalized user's password after exactly two masked prompts", async () => {
    promptPassword.mockResolvedValueOnce(enteredPassword).mockResolvedValueOnce(
      enteredPassword,
    );

    await runResetPasswordCommand(["--email", "  Owner@Example.Test  "], {
      loadServices: loadResetServices,
      promptPassword,
    });

    expect(promptPassword).toHaveBeenCalledTimes(2);
    expect(promptPassword).toHaveBeenNthCalledWith(1, {
      message: "Password",
      mask: "*",
    });
    expect(promptPassword).toHaveBeenNthCalledWith(2, {
      message: "Confirm password",
      mask: "*",
    });
    expect(resetUserPassword).toHaveBeenCalledWith({
      email: "owner@example.test",
      password: enteredPassword,
    });
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it.each([
    ["create", runCreateUserCommand, loadCreateServices],
    ["reset", runResetPasswordCommand, loadResetServices],
  ] as const)("rejects a %s mismatch before loading services", async (_, run, loadServices) => {
    promptPassword.mockResolvedValueOnce(enteredPassword).mockResolvedValueOnce(
      "different private password",
    );

    await expect(
      run(["--email", "owner@example.test"], {
        loadServices,
        promptPassword,
      } as never),
    ).rejects.toThrow("Passwords do not match.");
    expect(loadServices).not.toHaveBeenCalled();
  });

  it.each([
    ["create", runCreateUserCommand, loadCreateServices],
    ["reset", runResetPasswordCommand, loadResetServices],
  ] as const)("never accepts a %s password from argv", async (_, run, loadServices) => {
    await expect(
      run(
        ["--email", "owner@example.test", "--password", enteredPassword],
        { loadServices, promptPassword } as never,
      ),
    ).rejects.toThrow("--email <email>");
    expect(promptPassword).not.toHaveBeenCalled();
    expect(loadServices).not.toHaveBeenCalled();
  });

  it("closes the database when create dispatch fails", async () => {
    promptPassword.mockResolvedValue(enteredPassword);
    const failure = new Error("create failed");
    createUser.mockRejectedValueOnce(failure);

    await expect(
      runCreateUserCommand(["--email", "owner@example.test"], {
        loadServices: loadCreateServices,
        promptPassword,
      }),
    ).rejects.toBe(failure);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("closes the database when reset dispatch fails", async () => {
    promptPassword.mockResolvedValue(enteredPassword);
    const failure = new Error("reset failed");
    resetUserPassword.mockRejectedValueOnce(failure);

    await expect(
      runResetPasswordCommand(["--email", "owner@example.test"], {
        loadServices: loadResetServices,
        promptPassword,
      }),
    ).rejects.toBe(failure);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});

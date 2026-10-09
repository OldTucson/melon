import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loginAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  loginAction,
}));

describe("LoginForm", () => {
  beforeEach(() => {
    loginAction.mockReset();
  });

  afterEach(cleanup);

  it("provides an accessible private credentials form", async () => {
    const { LoginForm } = await import("./login-form");
    render(<LoginForm />);

    expect(screen.getByLabelText("邮箱")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "登录" })).toHaveAttribute(
      "type",
      "submit",
    );
    expect(screen.getByRole("form", { name: "登录" })).toBeInTheDocument();
  });

  it("refocuses an identical error after each failed submission", async () => {
    loginAction.mockImplementation(async () => ({
      error: "邮箱或密码不正确。",
    }));
    const user = userEvent.setup();
    const { LoginForm } = await import("./login-form");
    render(<LoginForm />);

    await user.clear(screen.getByLabelText("邮箱"));
    await user.clear(screen.getByLabelText("密码"));
    await user.type(screen.getByLabelText("邮箱"), "owner@example.test");
    await user.type(screen.getByLabelText("密码"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());

    await user.clear(screen.getByLabelText("邮箱"));
    await user.clear(screen.getByLabelText("密码"));
    await user.type(screen.getByLabelText("邮箱"), "owner@example.test");
    await user.type(screen.getByLabelText("密码"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(loginAction).toHaveBeenCalledTimes(2);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  loginAction: vi.fn(),
}));

describe("LoginForm", () => {
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
    expect(screen.queryByRole("link", { name: /注册/ })).not.toBeInTheDocument();
  });
});

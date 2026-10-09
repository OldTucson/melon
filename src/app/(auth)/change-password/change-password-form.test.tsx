import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const changePasswordAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  changePasswordAction,
}));

describe("ChangePasswordForm", () => {
  beforeEach(() => {
    changePasswordAction.mockReset();
  });

  afterEach(cleanup);

  it("provides accessible current, new, and confirmation fields", async () => {
    const { ChangePasswordForm } = await import("./change-password-form");
    render(<ChangePasswordForm />);

    expect(screen.getByLabelText("当前密码")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("新密码")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText("确认新密码")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByRole("button", { name: "更新密码" })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("refocuses an identical error after each failed submission", async () => {
    changePasswordAction.mockImplementation(async () => ({
      error: "无法更改密码，请重试。",
    }));
    const user = userEvent.setup();
    const { ChangePasswordForm } = await import("./change-password-form");
    render(<ChangePasswordForm />);

    await user.type(screen.getByLabelText("当前密码"), "current-password");
    await user.type(
      screen.getByLabelText("新密码"),
      "new-private-password",
    );
    await user.type(
      screen.getByLabelText("确认新密码"),
      "new-private-password",
    );
    await user.click(screen.getByRole("button", { name: "更新密码" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());

    await user.type(screen.getByLabelText("当前密码"), "current-password");
    await user.type(
      screen.getByLabelText("新密码"),
      "new-private-password",
    );
    await user.type(
      screen.getByLabelText("确认新密码"),
      "new-private-password",
    );
    await user.click(screen.getByRole("button", { name: "更新密码" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(changePasswordAction).toHaveBeenCalledTimes(2);
  });
});

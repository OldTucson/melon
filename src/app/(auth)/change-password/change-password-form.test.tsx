import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  changePasswordAction: vi.fn(),
  initialChangePasswordState: { error: null },
}));

describe("ChangePasswordForm", () => {
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
});

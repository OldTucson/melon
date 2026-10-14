import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiResponseError } from "@/lib/query/client";

import { AuthorizationForm } from "./authorization-form";
import type {
  AuthorizationDto,
  AuthorizationFieldDto,
  AuthorizationMutationInput,
} from "./api";

const field: AuthorizationFieldDto = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: null,
  scope: "system",
  name: "家居服",
  normalizedName: "家居服",
  status: "active",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  archivedAt: null,
};

async function completeRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "普通授权" }));
  await user.click(screen.getByRole("combobox", { name: "授权领域" }));
  await user.click(screen.getByRole("option", { name: "家居服" }));
  fireEvent.change(screen.getByRole("textbox", { name: "授权客户" }), {
    target: { value: "示例客户" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "授权价格" }), {
    target: { value: "1280.50" },
  });
  fireEvent.change(screen.getByLabelText("授权日期"), {
    target: { value: "2026-10-08" },
  });
}

describe("AuthorizationForm", () => {
  afterEach(cleanup);

  it("uses a segmented kind control and clears the field for a buyout", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthorizationForm
        fields={[field]}
        commercialVersion={0}
        today="2026-10-14"
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("radio", { name: "普通授权" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "授权领域" })).toBeInTheDocument();
    await completeRequiredFields(user);
    await user.click(screen.getByRole("radio", { name: "买断" }));
    expect(
      screen.queryByRole("combobox", { name: "授权领域" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      kind: "global_buyout",
      fieldId: null,
    });
  });

  it("rejects invalid money, future dates, missing customer, and oversized notes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AuthorizationForm
        fields={[field]}
        commercialVersion={0}
        today="2026-10-14"
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "授权领域" }));
    await user.click(screen.getByRole("option", { name: "家居服" }));
    fireEvent.change(screen.getByRole("textbox", { name: "授权价格" }), {
      target: { value: "1.234" },
    });
    fireEvent.change(screen.getByLabelText("授权日期"), {
      target: { value: "2026-10-15" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "备注" }), {
      target: { value: "a".repeat(1001) },
    });
    await user.click(screen.getByRole("button", { name: "保存授权" }));

    expect(await screen.findByText("请输入授权客户")).toBeInTheDocument();
    expect(screen.getByText("金额最多保留两位小数")).toBeInTheDocument();
    expect(screen.getByText("授权日期不能晚于今天")).toBeInTheDocument();
    expect(screen.getByText("备注最多 1000 个字符")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reuses the operation intent after explicit history confirmation", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(input: AuthorizationMutationInput) => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiResponseError(
          409,
          "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
          "confirmation required",
          {
            activeCount: 1,
            recent: [
              {
                id: "00000000-0000-4000-8000-000000000009",
                licenseeName: "既有客户",
                authorizedOn: "2026-10-01",
                priceFen: "50000",
                fieldNameSnapshot: "家居服",
                kind: "standard",
              },
            ],
          },
        ),
      )
      .mockResolvedValueOnce();
    render(
      <AuthorizationForm
        fields={[field]}
        commercialVersion={3}
        today="2026-10-14"
        onSubmit={onSubmit}
      />,
    );
    await completeRequiredFields(user);
    await user.click(screen.getByRole("radio", { name: "领域独占" }));
    await user.click(screen.getByRole("button", { name: "保存授权" }));

    const dialog = await screen.findByRole("dialog", { name: "确认授权历史" });
    expect(dialog).toHaveTextContent("既有客户");
    await user.click(screen.getByRole("button", { name: "仍然保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    const first = onSubmit.mock.calls[0]![0];
    const second = onSubmit.mock.calls[1]![0];
    expect(second.operationId).toBe(first.operationId);
    expect(first.historyConfirmed).toBe(false);
    expect(second.historyConfirmed).toBe(true);
  });

  it("reuses an operation ID on a retry and refreshes stale state before a new intent", async () => {
    const user = userEvent.setup();
    const onStale = vi.fn();
    const onSubmit = vi
      .fn<(input: AuthorizationMutationInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockRejectedValueOnce(
        new ApiResponseError(
          409,
          "AUTHORIZATION_STATE_CHANGED",
          "state changed",
        ),
      );
    render(
      <AuthorizationForm
        fields={[field]}
        commercialVersion={3}
        today="2026-10-14"
        onStale={onStale}
        onSubmit={onSubmit}
      />,
    );
    await completeRequiredFields(user);

    await user.click(screen.getByRole("button", { name: "保存授权" }));
    expect(await screen.findByText("授权记录未能保存，请重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    expect(await screen.findByText("授权状态已更新，请重新操作")).toBeInTheDocument();

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]![0].operationId).toBe(
      onSubmit.mock.calls[0]![0].operationId,
    );
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("reuses the inline custom-field operation ID after a failed request", async () => {
    const user = userEvent.setup();
    const created = {
      ...field,
      id: "00000000-0000-4000-8000-000000000008",
      ownerId: "10000000-0000-4000-8000-000000000001",
      scope: "custom" as const,
      name: "童鞋",
      normalizedName: "童鞋",
    };
    const onCreateField = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(created);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthorizationForm
        fields={[field]}
        commercialVersion={0}
        today="2026-10-14"
        onCreateField={onCreateField}
        onSubmit={onSubmit}
      />,
    );

    await user.type(
      screen.getByRole("combobox", { name: "授权领域" }),
      "旧搜索词",
    );
    await user.click(screen.getByRole("button", { name: "新建授权领域" }));
    await user.type(
      screen.getByRole("textbox", { name: "自定义授权领域名称" }),
      "  童鞋  ",
    );
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("领域未能创建，请重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(onCreateField).toHaveBeenCalledTimes(2));
    expect(onCreateField.mock.calls[0]![0]).toMatchObject({ name: "童鞋" });
    expect(onCreateField.mock.calls[1]![0]).toEqual(
      onCreateField.mock.calls[0]![0],
    );
    expect(screen.getByRole("combobox", { name: "授权领域" })).toHaveValue(
      "童鞋",
    );

    fireEvent.change(screen.getByRole("textbox", { name: "授权客户" }), {
      target: { value: "示例客户" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "授权价格" }), {
      target: { value: "88.00" },
    });
    fireEvent.change(screen.getByLabelText("授权日期"), {
      target: { value: "2026-10-08" },
    });
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ fieldId: created.id });
    expect(
      screen.queryByText("该领域已归档，请选择其他领域"),
    ).not.toBeInTheDocument();
  });

  it("shows an archived field while editing and focuses its replacement error", async () => {
    const user = userEvent.setup();
    const archivedField: AuthorizationFieldDto = {
      ...field,
      id: "00000000-0000-4000-8000-000000000002",
      ownerId: "10000000-0000-4000-8000-000000000001",
      scope: "custom",
      name: "旧领域",
      normalizedName: "旧领域",
      status: "archived",
      archivedAt: "2026-10-12T00:00:00.000Z",
    };
    const initial: AuthorizationDto = {
      id: "30000000-0000-4000-8000-000000000003",
      ownerId: "10000000-0000-4000-8000-000000000001",
      patternId: "20000000-0000-4000-8000-000000000002",
      operationId: "40000000-0000-4000-8000-000000000004",
      kind: "standard",
      fieldId: archivedField.id,
      fieldNameSnapshot: archivedField.name,
      licenseeName: "历史客户",
      priceFen: "12000",
      priceYuan: "120.00",
      authorizedOn: "2026-10-08",
      note: null,
      status: "active",
      version: 1,
      voidedAt: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthorizationForm
        fields={[field, archivedField]}
        initial={initial}
        commercialVersion={2}
        today="2026-10-14"
        onSubmit={onSubmit}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "授权领域" });
    expect(combobox).toHaveValue("旧领域（已归档）");
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    expect(
      await screen.findByText("该领域已归档，请选择其他领域"),
    ).toBeInTheDocument();
    expect(combobox).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(combobox);
    await user.click(screen.getByRole("option", { name: "家居服" }));
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ fieldId: field.id });
  });
});

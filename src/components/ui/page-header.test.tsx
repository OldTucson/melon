import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("exposes a stable title, context, description, and action region", () => {
    render(
      <PageHeader
        actions={<button type="button">上传</button>}
        description="128 个素材"
        eyebrow="私人图案库"
        id="library-title"
        title="全部图案"
      />,
    );

    expect(screen.getByRole("heading", { name: "全部图案" })).toHaveAttribute(
      "id",
      "library-title",
    );
    expect(screen.getByText("私人图案库")).toBeInTheDocument();
    expect(screen.getByText("128 个素材")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传" })).toBeInTheDocument();
  });
});

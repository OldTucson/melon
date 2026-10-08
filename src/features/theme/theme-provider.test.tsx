import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const captureProviderProps = vi.hoisted(() => vi.fn());

vi.mock("next-themes", () => ({
  ThemeProvider: (props: { children: ReactNode }) => {
    captureProviderProps(props);
    return <>{props.children}</>;
  },
}));

describe("ThemeProvider", () => {
  it("configures next-themes and passes children through", async () => {
    const { ThemeProvider } = await import("./theme-provider");
    const children = <span>Library content</span>;

    render(<ThemeProvider>{children}</ThemeProvider>);

    expect(screen.getByText("Library content")).toBeInTheDocument();
    expect(captureProviderProps).toHaveBeenCalledWith({
      attribute: "data-theme",
      defaultTheme: "system",
      enableSystem: true,
      disableTransitionOnChange: true,
      children,
    });
  });
});

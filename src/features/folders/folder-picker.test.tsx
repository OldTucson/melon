import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FolderPicker } from "./folder-picker";

afterEach(cleanup);
const folders = [
  { id: "a", parentId: null, name: "夏日果园", status: "active" as const },
  { id: "b", parentId: "a", name: "柑橘", status: "active" as const },
  { id: "c", parentId: null, name: "删除中", status: "deleting" as const },
  { id: "d", parentId: null, name: "回收中", status: "trashed" as const },
];
it("offers one radio destination with full nested paths and unfiled null", () => {
  const onChange = vi.fn();
  render(<FolderPicker folders={folders} value="b" onChange={onChange} />);
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.getByRole("radio", { name: "夏日果园 / 柑橘" })).toBeChecked();
  expect(screen.getByText("柑橘")).toHaveAttribute("title", "夏日果园 / 柑橘");
  fireEvent.click(screen.getByRole("radio", { name: "未分类" }));
  expect(onChange).toHaveBeenCalledWith(null);
  fireEvent.click(screen.getByRole("radio", { name: "夏日果园" }));
  expect(onChange).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it("disables every destination while pending and omits optimistic folders", () => {
  render(
    <FolderPicker
      folders={[
        ...folders,
        {
          id: "e",
          parentId: null,
          name: "保存中",
          status: "active",
          optimisticCreate: true,
        },
      ]}
      value={null}
      disabled
      onChange={vi.fn()}
    />,
  );
  for (const radio of screen.getAllByRole("radio"))
    expect(radio).toBeDisabled();
  expect(screen.queryByText("保存中")).not.toBeInTheDocument();
});

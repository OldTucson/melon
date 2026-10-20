import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSelectionStore } from "@/features/library/selection-store";
import { QueryOwnerProvider } from "@/lib/query/provider";

import { UploadManagerProvider } from "./upload-manager";
import { recoverUploadCompletion, runUpload } from "./upload-runner";
import { useUploadStore } from "./upload-store";

const uploadTray = vi.hoisted(() => ({
  onRecover: undefined as undefined | ((id: string) => void),
}));

vi.mock("./upload-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-runner")>();
  return {
    ...actual,
    recoverUploadCompletion: vi.fn(),
    runUpload: vi.fn(),
  };
});

vi.mock("./upload-tray", () => ({
  UploadTray: (props: { onRecover: (id: string) => void }) => {
    uploadTray.onRecover = props.onRecover;
    return null;
  },
}));

const ownerId = "10000000-0000-4000-8000-000000000000";
const existingPatternId = "00000000-0000-4000-8000-000000000001";
const uploadedPatternId = "00000000-0000-4000-8000-000000000002";

describe("upload manager", () => {
  beforeEach(() => {
    useUploadStore.setState({ tasks: [] });
    useSelectionStore.getState().clear();
    uploadTray.onRecover = undefined;
    vi.mocked(recoverUploadCompletion).mockReset();
    vi.mocked(runUpload).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not change selection or open the inspector after an upload succeeds", async () => {
    useSelectionStore
      .getState()
      .select(existingPatternId, [existingPatternId], {});
    vi.mocked(runUpload).mockResolvedValue({
      status: "ready",
      patternId: uploadedPatternId,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <QueryOwnerProvider ownerId={ownerId}>
          <UploadManagerProvider>
            <span>图库</span>
          </UploadManagerProvider>
        </QueryOwnerProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("选择要上传的图案"), {
      target: {
        files: [
          new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "new.png", {
            type: "image/png",
            lastModified: 1,
          }),
        ],
      },
    });

    await waitFor(() => expect(runUpload).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(useUploadStore.getState().tasks[0]?.runPending).toBe(false),
    );
    expect(useSelectionStore.getState().selectedIds).toEqual([
      existingPatternId,
    ]);
    expect(useSelectionStore.getState().inspectorIds).toEqual([]);
  });

  it("preserves selection and inspector after upload recovery succeeds", async () => {
    const localTaskId = "local-recovery";
    useSelectionStore
      .getState()
      .select(existingPatternId, [existingPatternId], {});
    useSelectionStore.getState().openInspector([existingPatternId]);
    useUploadStore.setState({
      tasks: [
        {
          localTaskId,
          patternId: uploadedPatternId,
          sourceAssetId: "00000000-0000-4000-8000-000000000011",
          previewAssetId: "00000000-0000-4000-8000-000000000012",
          thumbnailAssetId: "00000000-0000-4000-8000-000000000013",
          operationId: "00000000-0000-4000-8000-000000000014",
          filename: "recovered.png",
          extension: "png",
          size: 1024,
          lastModified: 1,
          status: "processing",
          progress: 99,
          canRecoverCompletion: true,
        },
      ],
    });
    vi.mocked(recoverUploadCompletion).mockResolvedValue({
      status: "ready",
      patternId: uploadedPatternId,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <QueryOwnerProvider ownerId={ownerId}>
          <UploadManagerProvider>
            <span>图库</span>
          </UploadManagerProvider>
        </QueryOwnerProvider>
      </QueryClientProvider>,
    );

    expect(uploadTray.onRecover).toBeTypeOf("function");
    act(() => uploadTray.onRecover!(localTaskId));

    await waitFor(() =>
      expect(recoverUploadCompletion).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(useUploadStore.getState().tasks[0]?.recoveryPending).toBe(false),
    );
    expect(useSelectionStore.getState()).toMatchObject({
      selectedIds: [existingPatternId],
      inspectorIds: [existingPatternId],
    });
  });
});

import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  initializeUpload: vi.fn(),
  refreshUploadCredentials: vi.fn(),
  completeUpload: vi.fn(),
  cancelUpload: vi.fn(),
  signAssetDownload: vi.fn(),
  signAssetView: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/features/uploads/upload-service", () => ({
  initializeUpload: mocks.initializeUpload,
  refreshUploadCredentials: mocks.refreshUploadCredentials,
  completeUpload: mocks.completeUpload,
  cancelUpload: mocks.cancelUpload,
  signAssetDownload: mocks.signAssetDownload,
  signAssetView: mocks.signAssetView,
}));

vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const assetId = "30000000-0000-4000-8000-000000000003";

const validInit = () => ({
  patternId: randomUUID(),
  sourceAssetId: randomUUID(),
  operationId: randomUUID(),
  originalFilename: "Bloom.psd",
  extension: "psd",
  sizeBytes: 4,
  lastModified: 1_760_000_000_000,
  contentHash: "a".repeat(64),
});

const post = (url: string, body: unknown, origin = ORIGIN) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });

const expectPrivateNoStore = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
};

describe("upload and asset Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.initializeUpload.mockResolvedValue({
      operationId: randomUUID(),
      pattern: { id: randomUUID(), status: "uploading" },
      session: { id: sessionId, status: "initialized" },
      sourceAsset: { id: assetId },
      credentials: { accessKeyId: "temporary" },
    });
    mocks.refreshUploadCredentials.mockResolvedValue({
      session: { id: sessionId, status: "uploading" },
      credentials: { accessKeyId: "refreshed" },
    });
    mocks.completeUpload.mockResolvedValue({
      pattern: { id: randomUUID(), status: "ready" },
      session: { id: sessionId, status: "completed" },
      assets: [{ id: assetId, role: "source" }],
    });
    mocks.cancelUpload.mockResolvedValue({
      session: { id: sessionId, status: "aborted" },
      warning: "UPLOAD_MULTIPART_CLEANUP_PENDING",
    });
    mocks.signAssetDownload.mockResolvedValue({
      location: "https://oss.example.test/source?signature=temporary",
    });
    mocks.signAssetView.mockResolvedValue({
      location: "https://oss.example.test/preview?signature=temporary",
    });
  });

  it("authenticates before parsing initialization input", async () => {
    mocks.requireUser.mockRejectedValueOnce(new Error("AUTH_SENTINEL"));
    const { POST } = await import("./route");

    const response = await POST(post(`${ORIGIN}/api/uploads/init`, { bad: true }));

    expect(response.status).toBe(500);
    expect(mocks.initializeUpload).not.toHaveBeenCalled();
  });

  it("requires same-origin state-changing requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/init`, validInit(), "https://evil.test"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN_ORIGIN", message: "Request origin is not allowed" },
    });
    expect(mocks.initializeUpload).not.toHaveBeenCalled();
  });

  it("passes only authenticated ownership and normalized init input", async () => {
    const body = validInit();
    const { POST } = await import("./route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/init`, {
        ...body,
        patternId: body.patternId.toUpperCase(),
      }),
    );

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(mocks.initializeUpload).toHaveBeenCalledWith({
      ownerId,
      input: { ...body, patternId: body.patternId },
    });
  });

  it.each([
    [
      { ...validInit(), sizeBytes: 209_715_201 },
      413,
      "UPLOAD_FILE_TOO_LARGE",
    ],
    [{ ...validInit(), extension: "gif" }, 415, "UPLOAD_EXTENSION_UNSUPPORTED"],
  ])("returns a stable init contract error", async (body, status, code) => {
    const { POST } = await import("./route");
    const response = await POST(post(`${ORIGIN}/api/uploads/init`, body));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.initializeUpload).not.toHaveBeenCalled();
  });

  it("refreshes credentials through POST without cacheable secrets", async () => {
    const operationId = randomUUID();
    const { POST } = await import("../[sessionId]/credentials/route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/${sessionId}/credentials`, { operationId }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(mocks.refreshUploadCredentials).toHaveBeenCalledWith({
      ownerId,
      sessionId,
      operationId,
    });
  });

  it("validates completion params and body before invoking the service", async () => {
    const { POST } = await import("../[sessionId]/complete/route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/not-a-uuid/complete`, {
        operationId: randomUUID(),
        assets: [],
      }),
      { params: Promise.resolve({ sessionId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.completeUpload).not.toHaveBeenCalled();
  });

  it("passes a validated completion envelope and never caches the response", async () => {
    const operationId = randomUUID();
    const body = {
      operationId,
      assets: [
        {
          assetId,
          role: "source",
          objectKey: `users/${ownerId}/patterns/${randomUUID()}/source/${assetId}.psd`,
          extension: "psd",
          sizeBytes: 4,
        },
      ],
    };
    const { POST } = await import("../[sessionId]/complete/route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/${sessionId}/complete`, body),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(mocks.completeUpload).toHaveBeenCalledWith({
      ownerId,
      sessionId,
      input: body,
    });
  });

  it("forwards the browser multipart abort outcome without claiming server abort", async () => {
    const operationId = randomUUID();
    const body = {
      operationId,
      multipartAbort: { attempted: true, succeeded: false },
    };
    const { POST } = await import("../[sessionId]/cancel/route");
    const response = await POST(
      post(`${ORIGIN}/api/uploads/${sessionId}/cancel`, body),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.cancelUpload).toHaveBeenCalledWith({
      ownerId,
      sessionId,
      input: body,
    });
  });

  it.each([
    ["download", 300, mocks.signAssetDownload],
    ["view", 60, mocks.signAssetView],
  ] as const)(
    "returns a private 303 for authorized %s signing",
    async (kind, _expiry, signer) => {
      const route =
        kind === "download"
          ? await import("../../assets/[assetId]/download/route")
          : await import("../../assets/[assetId]/view/route");
      const response = await route.GET(
        new Request(`${ORIGIN}/api/assets/${assetId}/${kind}`),
        { params: Promise.resolve({ assetId }) },
      );

      expect(response.status).toBe(303);
      expectPrivateNoStore(response);
      expect(response.headers.get("location")).toBe(
        kind === "download"
          ? "https://oss.example.test/source?signature=temporary"
          : "https://oss.example.test/preview?signature=temporary",
      );
      expect(signer).toHaveBeenCalledWith({ ownerId, assetId });
      expect(await response.text()).toBe("");
    },
  );

  it("keeps foreign and missing asset responses indistinguishable", async () => {
    const { GET } = await import("../../assets/[assetId]/download/route");
    for (const target of [assetId, randomUUID()]) {
      mocks.signAssetDownload.mockRejectedValueOnce(
        new AppError("NOT_FOUND", 404, "Asset not found"),
      );
      const response = await GET(
        new Request(`${ORIGIN}/api/assets/${target}/download`),
        { params: Promise.resolve({ assetId: target }) },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "NOT_FOUND", message: "Asset not found" },
      });
    }
  });

  it("sanitizes unexpected OSS failures at the route boundary", async () => {
    mocks.signAssetDownload.mockRejectedValueOnce(
      new Error("OSS SDK request secret token stack"),
    );
    const { GET } = await import("../../assets/[assetId]/download/route");
    const response = await GET(
      new Request(`${ORIGIN}/api/assets/${assetId}/download`),
      { params: Promise.resolve({ assetId }) },
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toMatch(/OSS|SDK|secret|token|stack/i);
  });
});

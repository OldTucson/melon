"use client";

import { readApiResponse } from "@/lib/query/client";

import type { UploadRunnerDependencies } from "./upload-runner";

async function post<T>(url: string, body: unknown) {
  return readApiResponse<T>(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export const browserUploadApi: UploadRunnerDependencies["api"] = {
  initialize: (input) => post("/api/uploads/init", input),
  refreshCredentials: (sessionId, operationId) =>
    post(`/api/uploads/${sessionId}/credentials`, { operationId }),
  complete: (sessionId, input) =>
    post(`/api/uploads/${sessionId}/complete`, input),
  cancel: (sessionId, input) =>
    post(`/api/uploads/${sessionId}/cancel`, input),
};

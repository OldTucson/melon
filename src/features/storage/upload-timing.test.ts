import { describe, expect, it } from "vitest";

import {
  UPLOAD_CREDENTIAL_ISSUE_TIMEOUT_MS,
  UPLOAD_CREDENTIAL_LIFETIME_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
  UPLOAD_WRITE_DRAIN_GRACE_MS,
  UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS,
} from "./upload-timing";

describe("upload timing contract", () => {
  it("keeps the purge drain longer than the longest browser write request", () => {
    expect(UPLOAD_CREDENTIAL_LIFETIME_MS).toBe(15 * 60 * 1_000);
    expect(UPLOAD_CREDENTIAL_ISSUE_TIMEOUT_MS).toBe(30_000);
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS).toBe(30_000);
    expect(UPLOAD_WRITE_DRAIN_GRACE_MS).toBe(150_000);
  });
});

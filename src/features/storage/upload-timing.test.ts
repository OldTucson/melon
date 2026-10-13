import { describe, expect, it } from "vitest";

import {
  REAL_OSS_TEST_CLEANUP_MARGIN_MS,
  REAL_OSS_TEST_TIMEOUT_MS,
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

  it("reserves two request windows plus cleanup time for the real OSS test", () => {
    expect(REAL_OSS_TEST_CLEANUP_MARGIN_MS).toBe(60_000);
    expect(REAL_OSS_TEST_TIMEOUT_MS).toBe(
      UPLOAD_REQUEST_TIMEOUT_MS * 2 + REAL_OSS_TEST_CLEANUP_MARGIN_MS,
    );
    expect(REAL_OSS_TEST_TIMEOUT_MS).toBeGreaterThan(
      UPLOAD_REQUEST_TIMEOUT_MS * 2,
    );
  });
});

import { describe, expect, it } from "vitest";

import { UPLOAD_ACCEPT } from "./upload-dropzone";

describe("upload dropzone", () => {
  it("allows standalone PDF files", () => {
    expect(UPLOAD_ACCEPT.split(",")).toContain(".pdf");
  });
});

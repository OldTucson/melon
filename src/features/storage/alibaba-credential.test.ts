import { describe, expect, it } from "vitest";

import {
  createAlibabaCredential,
  resolveAlibabaSdkConstructor,
  resolveCredentialConstructor,
} from "./alibaba-credential";

class StubCredential {
  getCredential() {
    return Promise.resolve({});
  }
}

describe("resolveCredentialConstructor", () => {
  it("accepts direct and CommonJS-wrapped default exports", () => {
    expect(resolveCredentialConstructor(StubCredential)).toBe(StubCredential);
    expect(resolveCredentialConstructor({ default: StubCredential })).toBe(
      StubCredential,
    );
  });

  it("rejects an invalid credential module shape", () => {
    expect(() => resolveCredentialConstructor({})).toThrow(
      "ALIBABA_CREDENTIAL_MODULE_INVALID",
    );
  });

  it("constructs the installed Alibaba credential client", () => {
    expect(createAlibabaCredential().getCredential).toEqual(
      expect.any(Function),
    );
  });

  it("resolves another wrapped Alibaba SDK constructor", () => {
    expect(
      resolveAlibabaSdkConstructor<typeof StubCredential>({
        default: StubCredential,
      }),
    ).toBe(StubCredential);
  });
});

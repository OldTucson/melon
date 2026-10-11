import Credential from "@alicloud/credentials";

export type AlibabaCredentialConstructor = typeof Credential;

type AlibabaSdkConstructor = abstract new (...args: never[]) => unknown;

export function resolveAlibabaSdkConstructor<
  Constructor extends AlibabaSdkConstructor,
>(
  moduleValue: unknown,
  invalidModuleError = "ALIBABA_SDK_MODULE_INVALID",
): Constructor {
  if (typeof moduleValue === "function") {
    return moduleValue as Constructor;
  }

  if (
    typeof moduleValue === "object" &&
    moduleValue !== null &&
    "default" in moduleValue &&
    typeof moduleValue.default === "function"
  ) {
    return moduleValue.default as Constructor;
  }

  throw new Error(invalidModuleError);
}

export function resolveCredentialConstructor(
  moduleValue: unknown,
): AlibabaCredentialConstructor {
  return resolveAlibabaSdkConstructor<AlibabaCredentialConstructor>(
    moduleValue,
    "ALIBABA_CREDENTIAL_MODULE_INVALID",
  );
}

export function createAlibabaCredential() {
  const CredentialConstructor = resolveCredentialConstructor(
    Credential as unknown,
  );

  return new CredentialConstructor();
}

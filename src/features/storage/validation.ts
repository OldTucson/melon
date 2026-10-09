import { z } from "zod";

import type { OssConnectionConfig } from "./contracts";
import { parseObjectKey } from "./object-keys";

export const OSS_DELETE_BATCH_SIZE = 1_000;

const httpsOriginPattern =
  /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?$/;

export const httpsOriginSchema = z
  .string()
  .transform((value, context) => {
    let url: URL;

    const match = httpsOriginPattern.exec(value);
    const explicitPort = match?.[2];

    if (
      !match ||
      (explicitPort !== undefined &&
        (Number(explicitPort) < 1 || Number(explicitPort) > 65_535))
    ) {
      context.addIssue({
        code: "custom",
        message: "OSS endpoint must be an HTTPS origin",
      });
      return z.NEVER;
    }

    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "OSS endpoint must be an HTTPS origin",
      });
      return z.NEVER;
    }

    if (
      url.protocol !== "https:" ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "OSS endpoint must be an HTTPS origin",
      });
      return z.NEVER;
    }

    return url.origin;
  });

export const ossConnectionConfigSchema = z.object({
  region: z.string().regex(/^oss-[a-z0-9-]+$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  endpoint: httpsOriginSchema,
  cname: z.boolean(),
});

const signedGetInputSchema = z.object({
  key: z.string().min(1),
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[\u0000-\u001f\u002f\u005c\u007f]/.test(value), {
      message: "Invalid download filename",
    }),
  expiresSeconds: z.number().int().min(1).max(3_600),
});

export function parseOssConnectionConfig(
  input: OssConnectionConfig,
): OssConnectionConfig {
  return ossConnectionConfigSchema.parse(input);
}

export function assertCanonicalObjectKey(key: string) {
  parseObjectKey(key);
  return key;
}

export function parseDeleteObjectKeys(keys: readonly string[]) {
  const parsed = z.array(z.string()).parse(keys);
  parsed.forEach(assertCanonicalObjectKey);
  return parsed;
}

export function parseSignedGetInput(
  input: z.input<typeof signedGetInputSchema>,
) {
  const parsed = signedGetInputSchema.parse(input);
  assertCanonicalObjectKey(parsed.key);
  return parsed;
}

export function assertValidObjectRange(start: number, endInclusive: number) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start < 0 ||
    endInclusive < start
  ) {
    throw new Error("OSS_RANGE_INVALID");
  }
}

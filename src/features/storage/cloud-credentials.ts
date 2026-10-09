import "server-only";

import Credential from "@alicloud/credentials";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import StsClient, { AssumeRoleRequest } from "@alicloud/sts20150401";
import { z } from "zod";

import type {
  BrowserCredentialIssuer,
  BrowserCredentialIssuerConfig,
} from "./contracts";
import { normalizedUuidSchema } from "./identifiers";
import { createUploadPolicy } from "./sts-policy";
import { ossConnectionConfigSchema } from "./validation";

const STS_DURATION_SECONDS = 900;
const STS_EXPIRATION_CLOCK_SKEW_MS = 30_000;

const issuerConfigSchema = ossConnectionConfigSchema.extend({
  roleArn: z
    .string()
    .regex(/^acs:ram::[0-9]+:role\/[A-Za-z0-9.@_-]{1,64}$/),
});

const issueInputSchema = z.object({
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
});

const utcExpirationSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return false;
    const canonical = new Date(timestamp).toISOString();
    const normalizedInput = value.includes(".")
      ? value
      : value.replace(/Z$/, ".000Z");
    return canonical === normalizedInput;
  })
  .transform((value) => new Date(value).toISOString());

const temporaryCredentialSchema = z.object({
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
  securityToken: z.string().min(1),
  expiration: utcExpirationSchema,
});

export interface AssumeRoleInput {
  roleArn: string;
  roleSessionName: string;
  durationSeconds: number;
  policy: string;
}

export interface AssumeRoleOutput {
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  expiration?: string;
}

type AssumeRoleOperation = (
  input: AssumeRoleInput,
) => Promise<AssumeRoleOutput>;

async function assumeRoleWithDefaultCredential(
  input: AssumeRoleInput,
): Promise<AssumeRoleOutput> {
  const credential = new Credential();
  const client = new StsClient(
    new OpenApiConfig({
      credential,
      endpoint: "sts.aliyuncs.com",
      protocol: "HTTPS",
    }),
  );
  const response = await client.assumeRole(new AssumeRoleRequest(input));

  return response.body?.credentials ?? {};
}

function createRoleSessionName(ownerId: string, patternId: string) {
  const ownerFragment = ownerId.replaceAll("-", "").slice(0, 12);
  const patternFragment = patternId.replaceAll("-", "").slice(0, 12);
  return `melon-${ownerFragment}-${patternFragment}`;
}

export function createAlibabaBrowserCredentialIssuer(
  inputConfig: BrowserCredentialIssuerConfig,
  dependencies: {
    assumeRole?: AssumeRoleOperation;
    now?: () => Date;
  } = {},
): BrowserCredentialIssuer {
  const assumeRole = dependencies.assumeRole ?? assumeRoleWithDefaultCredential;
  const now = dependencies.now ?? (() => new Date());

  return {
    async issue(input) {
      const config = issuerConfigSchema.parse(inputConfig);
      const { ownerId, patternId } = issueInputSchema.parse(input);
      const response = await assumeRole({
        roleArn: config.roleArn,
        roleSessionName: createRoleSessionName(ownerId, patternId),
        durationSeconds: STS_DURATION_SECONDS,
        policy: createUploadPolicy({
          bucket: config.bucket,
          ownerId,
          patternId,
        }),
      });
      const parsed = temporaryCredentialSchema.safeParse(response);

      const nowMilliseconds = now().getTime();
      const expirationMilliseconds = parsed.success
        ? Date.parse(parsed.data.expiration)
        : Number.NaN;

      if (
        !parsed.success ||
        !Number.isFinite(nowMilliseconds) ||
        expirationMilliseconds <=
          nowMilliseconds + STS_EXPIRATION_CLOCK_SKEW_MS
      ) {
        throw new Error("STS_CREDENTIAL_RESPONSE_INVALID");
      }

      return {
        ...parsed.data,
        region: config.region,
        bucket: config.bucket,
        endpoint: config.endpoint,
        cname: config.cname,
      };
    },
  };
}

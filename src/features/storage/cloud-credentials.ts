import "server-only";

import Credential from "@alicloud/credentials";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import StsClient, { AssumeRoleRequest } from "@alicloud/sts20150401";
import { z } from "zod";

import type {
  BrowserCredentialIssuer,
  BrowserCredentialIssuerConfig,
} from "./contracts";
import { createUploadPolicy } from "./sts-policy";

const STS_DURATION_SECONDS = 900;

const issuerConfigSchema = z.object({
  region: z.string().regex(/^oss-[a-z0-9-]+$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  endpoint: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:"),
  cname: z.boolean(),
  roleArn: z
    .string()
    .regex(/^acs:ram::[0-9]+:role\/[A-Za-z0-9.@_-]{1,64}$/),
});

const issueInputSchema = z.object({
  ownerId: z.string().uuid(),
  patternId: z.string().uuid(),
});

const temporaryCredentialSchema = z.object({
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
  securityToken: z.string().min(1),
  expiration: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .transform((value) => new Date(value).toISOString()),
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
  dependencies: { assumeRole?: AssumeRoleOperation } = {},
): BrowserCredentialIssuer {
  const assumeRole = dependencies.assumeRole ?? assumeRoleWithDefaultCredential;

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

      if (!parsed.success) {
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

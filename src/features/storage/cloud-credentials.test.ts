import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAlibabaBrowserCredentialIssuer } from "./cloud-credentials";

const ownerId = randomUUID();
const patternId = randomUUID();

const config = {
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
  roleArn: "acs:ram::123456789012:role/melon-browser-upload",
};

describe("createAlibabaBrowserCredentialIssuer", () => {
  it("lazily assumes the configured role with a short, scoped session", async () => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00Z",
    });
    const issuer = createAlibabaBrowserCredentialIssuer(config, { assumeRole });

    expect(assumeRole).not.toHaveBeenCalled();

    await expect(issuer.issue({ ownerId, patternId })).resolves.toEqual({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00.000Z",
      region: config.region,
      bucket: config.bucket,
      endpoint: config.endpoint,
      cname: config.cname,
    });

    expect(assumeRole).toHaveBeenCalledOnce();
    const request = assumeRole.mock.calls[0]?.[0] as {
      roleArn: string;
      roleSessionName: string;
      durationSeconds: number;
      policy: string;
    };
    expect(request.roleArn).toBe(config.roleArn);
    expect(request.durationSeconds).toBe(900);
    expect(request.roleSessionName).toMatch(/^[A-Za-z0-9.@_-]{2,64}$/);
    expect(request.roleSessionName).not.toContain(ownerId);
    expect(request.roleSessionName).not.toContain(patternId);

    const policy = JSON.parse(request.policy) as {
      Statement: Array<{ Resource: string }>;
    };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]?.Resource).toContain(
      `/users/${ownerId}/patterns/${patternId}/*`,
    );
  });

  it("validates the issue scope before invoking STS", async () => {
    const assumeRole = vi.fn();
    const issuer = createAlibabaBrowserCredentialIssuer(config, { assumeRole });

    await expect(
      issuer.issue({ ownerId: "not-a-uuid", patternId }),
    ).rejects.toThrow();
    expect(assumeRole).not.toHaveBeenCalled();
  });

  it("fails closed when STS omits or malforms a temporary credential", async () => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "",
      expiration: "not-a-date",
    });
    const issuer = createAlibabaBrowserCredentialIssuer(config, { assumeRole });

    await expect(issuer.issue({ ownerId, patternId })).rejects.toThrow(
      "STS_CREDENTIAL_RESPONSE_INVALID",
    );
  });

  it("rejects unsafe production configuration without contacting STS", async () => {
    const assumeRole = vi.fn();
    const issuer = createAlibabaBrowserCredentialIssuer(
      { ...config, endpoint: "http://assets.example.test" },
      { assumeRole },
    );

    await expect(issuer.issue({ ownerId, patternId })).rejects.toThrow();
    expect(assumeRole).not.toHaveBeenCalled();
  });
});

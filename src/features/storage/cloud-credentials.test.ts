import { describe, expect, it, vi } from "vitest";

import { createAlibabaBrowserCredentialIssuer } from "./cloud-credentials";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patternId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const config = {
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
  roleArn: "acs:ram::123456789012:role/melon-browser-upload",
};
const now = () => new Date("2026-10-09T10:00:00.000Z");

describe("createAlibabaBrowserCredentialIssuer", () => {
  it("lazily assumes the configured role with a short, scoped session", async () => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00Z",
    });
    const issuer = createAlibabaBrowserCredentialIssuer(config, {
      assumeRole,
      now,
    });

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
    const issuer = createAlibabaBrowserCredentialIssuer(config, {
      assumeRole,
      now,
    });

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
    const issuer = createAlibabaBrowserCredentialIssuer(config, {
      assumeRole,
      now,
    });

    await expect(issuer.issue({ ownerId, patternId })).rejects.toThrow(
      "STS_CREDENTIAL_RESPONSE_INVALID",
    );
  });

  it("normalizes issue UUIDs before building the STS scope", async () => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00Z",
    });
    const issuer = createAlibabaBrowserCredentialIssuer(config, {
      assumeRole,
      now,
    });

    await issuer.issue({
      ownerId: ownerId.toUpperCase(),
      patternId: patternId.toUpperCase(),
    });

    const request = assumeRole.mock.calls[0]?.[0] as { policy: string };
    const policy = JSON.parse(request.policy) as {
      Statement: Array<{ Resource: string }>;
    };
    expect(policy.Statement[0]?.Resource).toContain(
      `/users/${ownerId}/patterns/${patternId}/*`,
    );
  });

  it.each([
    ["expired", "2026-10-09T09:59:59Z"],
    ["inside clock-skew guard", "2026-10-09T10:00:30Z"],
    ["offset timestamp", "2026-10-09T10:15:00+00:00"],
    ["noncanonical timestamp", "2026-10-09 10:15:00Z"],
  ])("rejects a %s STS expiration", async (_case, expiration) => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration,
    });
    const issuer = createAlibabaBrowserCredentialIssuer(config, {
      assumeRole,
      now,
    });

    await expect(issuer.issue({ ownerId, patternId })).rejects.toThrow(
      "STS_CREDENTIAL_RESPONSE_INVALID",
    );
  });

  it.each([
    "not-a-url",
    "http://assets.example.test",
    "https://@assets.example.test",
    "https://:@assets.example.test",
    "https://user:secret@assets.example.test",
    "https://assets.example.test/objects",
    "https://assets.example.test/a/..",
    "https://assets.example.test/%2e",
    "https://assets.example.test?",
    "https://assets.example.test?mode=unsafe",
    "https://assets.example.test#",
    "https://assets.example.test#fragment",
  ])(
    "rejects non-origin production endpoint %s without contacting STS",
    async (endpoint) => {
      const assumeRole = vi.fn();
      const issuer = createAlibabaBrowserCredentialIssuer(
        { ...config, endpoint },
        { assumeRole, now },
      );

      await expect(issuer.issue({ ownerId, patternId })).rejects.toThrow();
      expect(assumeRole).not.toHaveBeenCalled();
    },
  );

  it("allows an HTTPS origin with an explicit port", async () => {
    const assumeRole = vi.fn().mockResolvedValue({
      accessKeyId: "STS.test-access-key",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00.123Z",
    });
    const issuer = createAlibabaBrowserCredentialIssuer(
      { ...config, endpoint: "https://assets.example.test:8443" },
      { assumeRole, now },
    );

    await expect(issuer.issue({ ownerId, patternId })).resolves.toMatchObject({
      expiration: "2026-10-09T10:15:00.123Z",
      endpoint: "https://assets.example.test:8443",
    });
  });
});

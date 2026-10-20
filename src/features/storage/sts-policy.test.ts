import { describe, expect, it } from "vitest";

import { createUploadPolicy } from "./sts-policy";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patternId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("createUploadPolicy", () => {
  it("grants only the three multipart actions to one owned pattern prefix", () => {
    const policy = JSON.parse(
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId,
        patternId,
      }),
    ) as {
      Version: string;
      Statement: Array<{
        Effect: string;
        Action: string[];
        Resource: string;
      }>;
    };

    expect(policy).toEqual({
      Version: "1",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "oss:AbortMultipartUpload",
            "oss:ListParts",
            "oss:PutObject",
          ],
          Resource: [
            "acs",
            "oss",
            "*",
            "*",
            `melon-test-assets/users/${ownerId}/patterns/${patternId}/*`,
          ].join(":"),
        },
      ],
    });
  });

  it("can restrict browser writes to exact initialized object keys", () => {
    const objectKeys = [
      `users/${ownerId}/patterns/${patternId}/derived/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`,
      `users/${ownerId}/patterns/${patternId}/derived/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`,
    ];
    const policy = JSON.parse(
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId,
        patternId,
        objectKeys,
      }),
    ) as { Statement: Array<{ Resource: string[] }> };

    expect(policy.Statement[0]?.Resource).toEqual(
      objectKeys.map((key) => `acs:oss:*:*:melon-test-assets/${key}`),
    );
  });

  it("rejects exact keys outside the owned pattern or noncanonical keys", () => {
    expect(() =>
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId,
        patternId,
        objectKeys: [
          `users/${ownerId}/patterns/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/derived/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`,
        ],
      }),
    ).toThrow();
    expect(() =>
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId,
        patternId,
        objectKeys: [
          `users/${ownerId}/patterns/${patternId}/derived/not-an-asset.webp`,
        ],
      }),
    ).toThrow();
  });

  it("contains no wildcard, read, bucket-list, or invented multipart action", () => {
    const policy = JSON.parse(
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId,
        patternId,
      }),
    ) as { Statement: Array<{ Action: string[]; Resource: string }> };
    const statement = policy.Statement[0];

    expect(statement).toBeDefined();
    expect(statement?.Action).not.toContain(["oss", "*"].join(":"));
    expect(statement?.Action).not.toContain("oss:GetObject");
    expect(statement?.Action).not.toContain("oss:ListObjects");
    expect(statement?.Action).not.toContain("oss:ListMultipartUploads");
    expect(statement?.Action).not.toContain(
      ["oss", "InitiateMultipartUpload"].join(":"),
    );
    expect(statement?.Action).not.toContain(
      ["oss", "UploadPart"].join(":"),
    );
    expect(statement?.Action).not.toContain(
      ["oss", "CompleteMultipartUpload"].join(":"),
    );
    expect(statement?.Resource).not.toContain(["users", "*"].join("/"));
  });

  it("normalizes policy UUIDs to the lowercase PostgreSQL text form", () => {
    const policy = JSON.parse(
      createUploadPolicy({
        bucket: "melon-test-assets",
        ownerId: ownerId.toUpperCase(),
        patternId: patternId.toUpperCase(),
      }),
    ) as { Statement: Array<{ Resource: string }> };

    expect(policy.Statement[0]?.Resource).toBe(
      [
        "acs",
        "oss",
        "*",
        "*",
        `melon-test-assets/users/${ownerId}/patterns/${patternId}/*`,
      ].join(":"),
    );
  });

  it.each([
    { bucket: "Bad_Bucket", ownerId, patternId },
    { bucket: "melon-test-assets", ownerId: "not-a-uuid", patternId },
    { bucket: "melon-test-assets", ownerId, patternId: "not-a-uuid" },
  ])("rejects invalid scope input %#", (input) => {
    expect(() => createUploadPolicy(input)).toThrow();
  });
});

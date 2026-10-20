import { z } from "zod";

import { normalizedUuidSchema } from "./identifiers";
import {
  assertObjectKeyBelongsToPattern,
  patternObjectPrefix,
} from "./object-keys";

const uploadPolicyInputSchema = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
  objectKeys: z.array(z.string().min(1)).min(1).max(3).optional(),
});

export const uploadActions = [
  "oss:AbortMultipartUpload",
  "oss:ListParts",
  "oss:PutObject",
] as const;

export function createUploadPolicy(
  input: z.input<typeof uploadPolicyInputSchema>,
) {
  const { bucket, ownerId, patternId, objectKeys } =
    uploadPolicyInputSchema.parse(input);
  const resource = objectKeys
    ? [...new Set(objectKeys)].map((objectKey) => {
        assertObjectKeyBelongsToPattern({
          key: objectKey,
          ownerId,
          patternId,
        });
        return ["acs", "oss", "*", "*", `${bucket}/${objectKey}`].join(":");
      })
    : [
        "acs",
        "oss",
        "*",
        "*",
        `${bucket}/${patternObjectPrefix({ ownerId, patternId })}*`,
      ].join(":");

  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: uploadActions,
        Resource: resource,
      },
    ],
  });
}

import { z } from "zod";

const uploadPolicyInputSchema = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  ownerId: z.string().uuid(),
  patternId: z.string().uuid(),
});

export const uploadActions = [
  "oss:AbortMultipartUpload",
  "oss:ListParts",
  "oss:PutObject",
] as const;

export function createUploadPolicy(
  input: z.input<typeof uploadPolicyInputSchema>,
) {
  const { bucket, ownerId, patternId } = uploadPolicyInputSchema.parse(input);
  const resource = [
    "acs",
    "oss",
    "*",
    "*",
    `${bucket}/users/${ownerId}/patterns/${patternId}/*`,
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

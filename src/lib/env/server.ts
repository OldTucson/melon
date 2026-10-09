import "server-only";

import { z } from "zod";

const optionalNonBlankString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const serverEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    AUTH_SECRET: z.string().min(32),
    APP_ORIGIN: z.string().url(),
    ALIYUN_OSS_REGION: z.string().min(1),
    ALIYUN_OSS_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    ALIYUN_OSS_ENDPOINT: z.string().url(),
    ALIYUN_OSS_CNAME: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    ALIYUN_STS_ROLE_ARN: z.string().startsWith("acs:ram::"),
    OSS_ADAPTER: z.enum(["real", "fake"]).default("real"),
    ALIBABA_CLOUD_ACCESS_KEY_ID: optionalNonBlankString,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: optionalNonBlankString,
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.ALIBABA_CLOUD_ACCESS_KEY_ID) !==
      Boolean(value.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ALIBABA_CLOUD_ACCESS_KEY_ID"],
        message: "AccessKey ID and secret must be provided together",
      });
    }

    if (value.OSS_ADAPTER === "fake" && value.NODE_ENV !== "test") {
      context.addIssue({
        code: "custom",
        path: ["OSS_ADAPTER"],
        message: "Fake OSS adapter is test-only",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const parseServerEnv = (
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
) => serverEnvSchema.parse(input);

let cached: ServerEnv | undefined;

export const getServerEnv = () => (cached ??= parseServerEnv(process.env));

import "server-only";

import { z } from "zod";

import { httpsOriginSchema } from "@/features/storage/validation";

const optionalNonBlankString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const optionalBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const parseHttpOrigin = (value: string) => {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
};

const serverEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    AUTH_SECRET: z.string().min(32),
    AUTH_TRUST_PROXY: optionalBoolean,
    APP_ORIGIN: z.string().url(),
    ALIYUN_OSS_REGION: z.string().min(1),
    ALIYUN_OSS_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    ALIYUN_OSS_ENDPOINT: httpsOriginSchema,
    ALIYUN_OSS_CNAME: z
      .enum(["true", "false"])
      .transform((value) => value === "true"),
    ALIYUN_STS_ROLE_ARN: z.string().startsWith("acs:ram::"),
    OSS_ADAPTER: z.enum(["real", "fake"]).default("real"),
    ALIBABA_CLOUD_ACCESS_KEY_ID: optionalNonBlankString,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: optionalNonBlankString,
    IMAGE_SEARCH_ENABLED: optionalBoolean,
    IMAGE_SEARCH_SERVICE_URL: optionalNonBlankString,
    IMAGE_SEARCH_INTERNAL_TOKEN: optionalNonBlankString,
    IMAGE_SEARCH_ACTIVE_VERSION: optionalNonBlankString,
    IMAGE_SEARCH_MODEL_SHA256: optionalNonBlankString,
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

    if (value.IMAGE_SEARCH_ENABLED) {
      const required = [
        "IMAGE_SEARCH_SERVICE_URL",
        "IMAGE_SEARCH_INTERNAL_TOKEN",
        "IMAGE_SEARCH_ACTIVE_VERSION",
        "IMAGE_SEARCH_MODEL_SHA256",
      ] as const;
      for (const key of required) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when image search is enabled`,
          });
        }
      }
      if (
        value.IMAGE_SEARCH_INTERNAL_TOKEN &&
        !/^[\x21-\x7e]{32,}$/.test(value.IMAGE_SEARCH_INTERNAL_TOKEN)
      ) {
        context.addIssue({
          code: "custom",
          path: ["IMAGE_SEARCH_INTERNAL_TOKEN"],
          message: "Image search internal token must be at least 32 characters",
        });
      }
      if (
        value.IMAGE_SEARCH_ACTIVE_VERSION &&
        !/^[a-z0-9-]{1,64}$/.test(value.IMAGE_SEARCH_ACTIVE_VERSION)
      ) {
        context.addIssue({
          code: "custom",
          path: ["IMAGE_SEARCH_ACTIVE_VERSION"],
          message: "Image search active version is invalid",
        });
      }
      if (
        value.IMAGE_SEARCH_MODEL_SHA256 &&
        !/^[a-f0-9]{64}$/.test(value.IMAGE_SEARCH_MODEL_SHA256)
      ) {
        context.addIssue({
          code: "custom",
          path: ["IMAGE_SEARCH_MODEL_SHA256"],
          message: "Image search model SHA-256 must be 64 hexadecimal characters",
        });
      }
      const serviceUrl = value.IMAGE_SEARCH_SERVICE_URL
        ? parseHttpOrigin(value.IMAGE_SEARCH_SERVICE_URL)
        : undefined;
      if (value.IMAGE_SEARCH_SERVICE_URL && !serviceUrl) {
        context.addIssue({
          code: "custom",
          path: ["IMAGE_SEARCH_SERVICE_URL"],
          message: "Image search service must be an HTTP(S) origin",
        });
      }
      if (
        value.NODE_ENV === "production" &&
        serviceUrl &&
        (serviceUrl.protocol !== "http:" ||
          !["127.0.0.1", "localhost", "[::1]"].includes(serviceUrl.hostname))
      ) {
        context.addIssue({
          code: "custom",
          path: ["IMAGE_SEARCH_SERVICE_URL"],
          message: "Image search service must be a loopback HTTP origin",
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const parseServerEnv = (
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
) => serverEnvSchema.parse(input);

let cached: ServerEnv | undefined;

export const getServerEnv = () => (cached ??= parseServerEnv(process.env));

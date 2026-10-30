import { z } from "zod";

import type { ServerEnv } from "@/lib/env/server";

import type { WebEvidenceCandidate, WebEvidenceIntent } from "./web-evidence-intents";

export type WebAgentConfig = {
  apiKey: string;
  agentId: string;
  agentVersion: NonNullable<ServerEnv["DASHSCOPE_WEB_SEARCH_AGENT_VERSION"]>;
};

export type WebAgentSearchInput = {
  requestId: string;
  prompt: string;
  headline: string;
  summary: string;
  intents: readonly WebEvidenceIntent[];
  signal: AbortSignal;
};

export type WebAgentSearchResult = {
  requestId: string;
  candidates: WebEvidenceCandidate[];
};

export type WebEvidenceProvider = {
  search(input: WebAgentSearchInput): Promise<WebAgentSearchResult>;
};

export const webAgentRequestIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
const text = (max: number) => z.string().min(1).max(max).trim().min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const httpsUrl = z.string().min(1).max(2048)
  .refine((value) => !/[\s\u0000-\u001f\u007f\\]/u.test(value))
  .transform((value, context) => {
    const parsed = URL.parse(value);
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      context.addIssue({ code: "custom", message: "Invalid image source URL" });
      return z.NEVER;
    }
    parsed.hash = "";
    return parsed.href;
  }).pipe(z.string().max(2048));

const promptText = (max: number) => z.string().min(1).max(max).trim().min(1)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));

export const webAgentPromptInputSchema = z.object({
  requestId: webAgentRequestIdSchema,
  prompt: promptText(2000),
  headline: promptText(120),
  summary: promptText(2000),
  intents: z.array(z.object({ query: text(300) })).min(1).max(8),
});

export const webAgentConfigSchema = z.object({
  apiKey: z.string().min(1).max(4096).refine((value) => !/[\u0000-\u0020\u007f]/u.test(value)),
  agentId: z.string().regex(/^aid-[A-Za-z0-9_-]{3,128}$/u),
  agentVersion: z.enum(["beta", "release"]),
});

// Raw DashScope envelopes stay at this boundary; dimensions are validated before
// mapping to domain candidates, then the importer independently sniffs image bytes.
export const webAgentImagesSchema = z.array(z.object({
  idx: z.number().int().min(0).max(10_000),
  query: text(300),
  title: text(500),
  url: httpsUrl,
  image_info: z.object({
    url: httpsUrl,
    width: z.number().int().min(1).max(32_768),
    height: z.number().int().min(1).max(32_768),
  }).refine(({ width, height }) => width * height <= 40_000_000),
})).max(64);

const webAgentMessageSchema = z.object({
  // Unknown message fields (including content/HTML) are deliberately discarded.
  additional_kwargs: z.record(z.string(), z.unknown()).optional(),
});

export const webAgentChoicesSchema = z.array(z.object({
  message: webAgentMessageSchema.optional(),
})).max(8);

export const webAgentOutputSchema = z.object({
  choices: webAgentChoicesSchema.optional(),
});

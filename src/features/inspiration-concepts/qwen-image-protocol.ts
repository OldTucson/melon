import "server-only";

import { isIP } from "node:net";
import { z } from "zod";
import { isPublicAddress, validateRemoteUrl } from "@/features/inspiration-visuals/remote-address";
import { conceptOutputKindSchema, type ConceptOutputKind } from "./contracts";

export type QwenImageTaskState =
  | { state: "pending"; taskId: string; requestId: string }
  | { state: "succeeded"; taskId: string; requestId: string; temporaryImageUrl: string }
  | { state: "rejected"; taskId: string; requestId: string }
  | { state: "failed"; taskId: string; requestId: string };

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const envelope = z.object({ request_id: identifier, output: z.object({ task_id: identifier, task_status: z.string() }).passthrough() });
const rejection = z.object({ request_id: identifier, code: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/), message: z.string().max(16_384) });
const negativePrompt = "品牌标志，logo，水印，文字，UI，公众人物，抄袭，低清晰度，畸形服装，多余肢体";
const invalid = () => new Error("Invalid concept provider response");
const safetyCodes = new Set(["DataInspectionFailed", "InputDataInspectionFailed", "OutputDataInspectionFailed", "ContentModerationFailed"]);

/** Carries only classification, never the provider's code, message, IDs or input. */
export class QwenImageProtocolRejection extends Error {
  constructor(readonly safetyRejected: boolean) { super("Concept provider rejected submission"); }
}

export function buildQwenImageRequest(input: { kind: ConceptOutputKind; prompt: string; images: readonly string[] }) {
  try {
    const kind = conceptOutputKindSchema.parse(input.kind);
    if (!input.prompt.trim() || Array.from(input.prompt).length > 3600 || input.images.length > 3) throw invalid();
    for (const image of input.images) {
      // The only accepted attachment form is the private pipeline's bounded WebP.
      const prefix = "data:image/webp;base64,";
      if (!image.startsWith(prefix) || image.length > prefix.length + Math.ceil(10 * 1024 * 1024 / 3) * 4) throw invalid();
      const encoded = image.slice(prefix.length);
      if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, "base64").byteLength > 10 * 1024 * 1024) throw invalid();
    }
    return {
      model: "qwen-image-3.0-pro" as const,
      input: { messages: [{ role: "user" as const, content: [...input.images.map((image) => ({ image })), { text: input.prompt }] }] },
      parameters: { n: 1, size: kind === "flat" ? "2048*1536" : "1536*2048", prompt_extend: true, watermark: false, negative_prompt: negativePrompt },
    };
  } catch { throw new Error("Invalid concept provider input"); }
}

export function parseQwenImageCreateResponse(value: unknown): { taskId: string; requestId: string } {
  // Rejection is proven only by a well-formed error envelope with no task output.
  const refused = rejection.safeParse(value);
  if (refused.success && typeof value === "object" && value !== null && !("output" in value)) {
    throw new QwenImageProtocolRejection(safetyCodes.has(refused.data.code));
  }
  try {
    const data = envelope.parse(value);
    if (!["PENDING", "RUNNING"].includes(data.output.task_status)) throw invalid();
    return { taskId: data.output.task_id, requestId: data.request_id };
  } catch { throw invalid(); }
}

export function parseQwenImageQueryResponse(value: unknown, expectedTaskId: string): QwenImageTaskState {
  try {
    const data = envelope.parse(value);
    if (data.output.task_id !== identifier.parse(expectedTaskId)) throw invalid();
    const identity = { taskId: data.output.task_id, requestId: data.request_id };
    switch (data.output.task_status) {
      case "PENDING": case "RUNNING": return { state: "pending", ...identity };
      case "FAILED": return { state: safetyCodes.has(String(data.output.code)) ? "rejected" : "failed", ...identity };
      case "CANCELED": case "UNKNOWN": return { state: "failed", ...identity };
      case "SUCCEEDED": {
        if ("results" in data.output) throw invalid();
        // qwen-image-3.0 uses choices, unlike the legacy results[].url protocol.
        const output = z.object({ choices: z.tuple([z.object({ finish_reason: z.literal("stop"), message: z.object({ role: z.literal("assistant"), content: z.tuple([z.object({ image: z.string().min(1).max(2048), type: z.literal("image").optional() })]) }) })]) }).parse(data.output);
        const temporaryImageUrl = output.choices[0].message.content[0].image;
        const url = validateRemoteUrl(temporaryImageUrl);
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        if (isIP(hostname) && !isPublicAddress(hostname)) throw invalid();
        return { state: "succeeded", ...identity, temporaryImageUrl };
      }
      default: throw invalid();
    }
  } catch { throw invalid(); }
}

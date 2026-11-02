// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildQwenImageRequest, parseQwenImageCreateResponse, parseQwenImageQueryResponse } from "./qwen-image-protocol";

const taskId = "17d7d840-82b9-485b-a954-724d06bc88d2";
const requestId = "2bd94002-5624-9129-916b-fbdde107b4ba";
const temporaryImageUrl = "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/private-result.png?TemporarySignature=secret";
// Official DashScope 3.0 async query shape, including timing, rewrite and usage.
function fixture(status: string) {
  return { output: { task_id: taskId, task_status: status, submit_time: "2026-08-07 15:50:14.837", scheduled_time: "2026-08-07 15:50:14.884", end_time: "2026-08-07 15:50:33.607", rewrite_status: "not_use", choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: temporaryImageUrl, type: "image" }] } }] }, usage: { output_height: 2048, output_width: 1536, input_image_count: 0, input_image_type: "qima_input_1k", output_image_count: 1, output_image_type: "qima_output_2k" }, request_id: requestId };
}

describe("Qwen Image wire protocol", () => {
  it("builds ordered image content followed by prompt and fixed paid output parameters", () => {
    expect(buildQwenImageRequest({ kind: "sketch", prompt: "prompt", images: ["data:image/webp;base64,AAAA"] })).toEqual({ model: "qwen-image-3.0-pro", input: { messages: [{ role: "user", content: [{ image: "data:image/webp;base64,AAAA" }, { text: "prompt" }] }] }, parameters: { n: 1, size: "1536*2048", prompt_extend: true, watermark: false, negative_prompt: expect.any(String) } });
    expect(buildQwenImageRequest({ kind: "flat", prompt: "prompt", images: [] }).parameters.size).toBe("2048*1536");
  });
  it("never accepts arbitrary URL references or over-limit provider inputs", () => {
    for (const images of [["https://example.com/private"], ["data:image/svg+xml;base64,AAAA"], ["data:image/webp;base64,AA!A"], ["data:image/webp;base64," + "A".repeat(14 * 1024 * 1024)]]) {
      expect(() => buildQwenImageRequest({ kind: "sketch", prompt: "prompt", images })).toThrow();
    }
  });
  it("parses accepted create without exposing upstream fields", () => {
    expect(parseQwenImageCreateResponse({ output: { task_status: "PENDING", task_id: taskId }, request_id: requestId })).toEqual({ taskId, requestId });
  });
  it.each(["PENDING", "RUNNING"])("maps query %s to pending", (status) => {
    expect(parseQwenImageQueryResponse(fixture(status), taskId)).toEqual({ state: "pending", taskId, requestId });
  });
  it("parses exactly one image from the current model's choices response", () => {
    expect(parseQwenImageQueryResponse(fixture("SUCCEEDED"), taskId)).toEqual({ state: "succeeded", taskId, requestId, temporaryImageUrl });
  });
  it.each(["FAILED", "CANCELED", "UNKNOWN"])("maps terminal %s to failure", (status) => {
    expect(parseQwenImageQueryResponse(fixture(status), taskId)).toEqual({ state: "failed", taskId, requestId });
  });
  it("maps content safety refusal to rejected without returning code/message", () => {
    const value = fixture("FAILED");
    Object.assign(value.output, { code: "DataInspectionFailed", message: temporaryImageUrl });
    expect(parseQwenImageQueryResponse(value, taskId)).toEqual({ state: "rejected", taskId, requestId });
  });
  it("rejects unknown states, mismatched IDs, malformed outputs, empty/multiple images and unsafe URLs", () => {
    const empty = fixture("SUCCEEDED"); empty.output.choices = [];
    const multiple = fixture("SUCCEEDED"); multiple.output.choices.push(multiple.output.choices[0]!);
    const contents = fixture("SUCCEEDED"); contents.output.choices[0]!.message.content.push({ image: temporaryImageUrl, type: "image" });
    const unsafe = fixture("SUCCEEDED"); unsafe.output.choices[0]!.message.content[0]!.image = "https://127.0.0.1/private";
    for (const value of [null, {}, fixture("NEW_STATE"), empty, multiple, contents, unsafe, { ...fixture("SUCCEEDED"), output: { ...fixture("SUCCEEDED").output, task_id: "different-task" } }]) {
      const error = (() => { try { parseQwenImageQueryResponse(value, taskId); } catch (e) { return e; } })();
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/secret|private-result|TemporarySignature/);
    }
  });
});

it("rejects a fourth input attachment before a paid submission", () => {
  expect(() => buildQwenImageRequest({ kind: "effect", prompt: "prompt", images: Array(4).fill("data:image/webp;base64,AAAA") })).toThrow();
});

it("rejects conflicting legacy/current outputs rather than silently picking an image", () => {
  const value = fixture("SUCCEEDED");
  Object.assign(value.output, { results: [{ url: "https://provider.example/second.png" }] });
  expect(() => parseQwenImageQueryResponse(value, taskId)).toThrow();
});

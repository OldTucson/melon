// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQwenImageProvider } from "./qwen-image-provider";
const config = { apiKey: "sk-private", nativeBaseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" };
const taskId = "17d7d840-82b9-485b-a954-724d06bc88d2";
const requestId = "4909100c-7b5a-9f92-bfe5-388011111111";
const accepted = { output: { task_status: "PENDING", task_id: taskId }, request_id: requestId };
const input = () => ({ kind: "sketch" as const, prompt: "private-prompt", images: [] as string[], signal: new AbortController().signal });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const leaked = "sk-private data:image/webp;base64,AAAA TemporarySignature private-result private-prompt";
function redacted(error: unknown) {
  expect(String(error) + JSON.stringify(error)).not.toMatch(/sk-private|data:image|TemporarySignature|private-result|private-prompt/);
  expect(error).not.toHaveProperty("cause");
}
afterEach(() => vi.useRealTimers());

describe("Qwen Image async transport", () => {
  it("submits once with async headers and queries without cache or redirects", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(json(accepted)).mockResolvedValueOnce(json({ output: { task_status: "RUNNING", task_id: taskId }, request_id: requestId }));
    const provider = createQwenImageProvider(config, http);
    await expect(provider.createTask(input())).resolves.toEqual({ taskId, requestId });
    expect(http.mock.calls[0]).toEqual([`${config.nativeBaseUrl}/services/aigc/image-generation/generation`, expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error", headers: { authorization: "Bearer sk-private", "content-type": "application/json", "X-DashScope-Async": "enable" } })]);
    expect(JSON.parse(http.mock.calls[0]![1]!.body as string).model).toBe("qwen-image-3.0-pro");
    await expect(provider.queryTask({ taskId, signal: input().signal })).resolves.toEqual({ state: "pending", taskId, requestId });
    expect(http.mock.calls[1]).toEqual([`${config.nativeBaseUrl}/tasks/${taskId}`, expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" })]);
  });
  it("distinguishes validated rejection from ambiguous transmission", async () => {
    const rejected = createQwenImageProvider(config, async () => json({ code: "DataInspectionFailed", message: leaked, request_id: requestId }));
    const error = await rejected.createTask(input()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INSPIRATION_CONCEPT_REJECTED", definitelyNotAccepted: true }); redacted(error);
    const ambiguous = createQwenImageProvider(config, async () => { throw new Error(leaked); });
    const uncertain = await ambiguous.createTask(input()).catch((e: unknown) => e);
    expect(uncertain).toMatchObject({ code: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN", definitelyNotAccepted: false }); redacted(uncertain);
  });
  it.each([json({}, 503), new Response("not json", { headers: { "content-type": "application/json" } }), json({ output: { task_status: "PENDING" }, request_id: requestId }), json({ ...accepted, padding: "a".repeat(256 * 1024) })])("treats HTTP errors and malformed/oversized success as ambiguous", async (response) => {
    const error = await createQwenImageProvider(config, async () => response).createTask(input()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitelyNotAccepted: false, code: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN" }); redacted(error);
  });
  it("does not parse non-2xx bodies or claim acceptance rejection", async () => {
    const response = json({ code: "DataInspectionFailed", message: leaked, request_id: requestId }, 400);
    const read = vi.spyOn(response.body!, "getReader");
    await expect(createQwenImageProvider(config, async () => response).createTask(input())).rejects.toMatchObject({ definitelyNotAccepted: false });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects invalid references and a pre-aborted caller before sending", async () => {
    const http = vi.fn<typeof fetch>();
    const controller = new AbortController(); controller.abort(new Error(leaked));
    const provider = createQwenImageProvider(config, http);
    await expect(provider.createTask({ ...input(), signal: controller.signal })).rejects.toMatchObject({ definitelyNotAccepted: true });
    await expect(provider.createTask({ ...input(), images: ["https://arbitrary.test"] })).rejects.toMatchObject({ definitelyNotAccepted: true });
    expect(http).not.toHaveBeenCalled();
  });
  it("enforces create deadline even with an uncooperative HTTP boundary", async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = expect(createQwenImageProvider(config, http).createTask(input())).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN", definitelyNotAccepted: false });
    await vi.advanceTimersByTimeAsync(30_000); await pending;
    expect(http).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("sanitizes caller abort after transmission and releases listeners", async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const provider = createQwenImageProvider(config, async () => new Promise(() => {}));
    const pending = provider.createTask({ ...input(), signal: controller.signal }).catch((e: unknown) => e);
    controller.abort(new Error(leaked));
    const error = await pending; expect(error).toMatchObject({ definitelyNotAccepted: false }); redacted(error);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("sanitizes malformed query, task mismatch and query timeout", async () => {
    const provider = createQwenImageProvider(config, async () => json({ ...accepted, output: { ...accepted.output, task_id: "another-task" } }));
    await expect(provider.queryTask({ taskId, signal: input().signal })).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_UNAVAILABLE" });
    vi.useFakeTimers();
    const pending = expect(createQwenImageProvider(config, async () => new Promise(() => {})).queryTask({ taskId, signal: input().signal })).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15_000); await pending; expect(vi.getTimerCount()).toBe(0);
  });
});

it("never sends four attachments and retains definite-not-accepted classification", async () => {
  const http = vi.fn<typeof fetch>();
  await expect(createQwenImageProvider(config, http).createTask({ ...input(), images: Array(4).fill("data:image/webp;base64,AAAA") })).rejects.toMatchObject({ definitelyNotAccepted: true });
  expect(http).not.toHaveBeenCalled();
});

it("bounds an incomplete JSON body by the create deadline", async () => {
  vi.useFakeTimers();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"request_id":"')); } }), { headers: { "content-type": "application/json" } });
  const pending = expect(createQwenImageProvider(config, async () => response).createTask(input())).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN", definitelyNotAccepted: false });
  await vi.advanceTimersByTimeAsync(30_000); await pending; expect(vi.getTimerCount()).toBe(0);
});

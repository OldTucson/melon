import { describe, expect, it } from "vitest";

import { buildWebAgentRequest, parseWebAgentStream } from "./web-agent-protocol";

const encoder = new TextEncoder();
const candidate = (overrides: Record<string, unknown> = {}) => ({
  idx: 1, query: "linen trend", title: "亚麻衬衫",
  url: "https://journal.test/article",
  image_info: { url: "https://images.test/shirt.jpg?sig=a%2Fb&x=1", width: 800, height: 600 },
  ...overrides,
});
const chunk = (data: unknown = [candidate()]) => ({
  request_id: "request-1",
  output: { choices: [{ message: {
    content: '<img src="https://untrusted.test/from-html.jpg">',
    additional_kwargs: { data_type: "image", data_json: data },
  } }] },
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function stream(bytes: Uint8Array, split = bytes.length) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, split));
    controller.enqueue(bytes.slice(split));
    controller.close();
  } });
}
const parse = (text: string) => parseWebAgentStream(stream(encoder.encode(text)));
const expected = {
  query: "linen trend", title: "亚麻衬衫", sourcePageUrl: "https://journal.test/article",
  imageUrl: "https://images.test/shirt.jpg?sig=a%2Fb&x=1",
};

describe("Web Search Agent SSE protocol", () => {
  it("decodes structured images across every byte split, including multibyte text and CRLF", async () => {
    const bytes = encoder.encode(`: heartbeat\r\n\r\nevent: message\r\n${event(chunk()).replaceAll("\n", "\r\n")}data: [DONE]\r\n\r\n`);
    for (let split = 0; split <= bytes.length; split++) {
      await expect(parseWebAgentStream(stream(bytes, split))).resolves.toEqual({
        requestId: "request-1", candidates: [expected],
      });
    }
  });

  it("joins multiline data and accepts LF, empty events, ignored fields, and a final event at EOF", async () => {
    const json = JSON.stringify(chunk(), null, 2).split("\n").map((line) => `data: ${line}`).join("\n");
    await expect(parse(`\n\n: comment\nid: not-a-request-id\nretry: 100\n\n${json}`)).resolves.toEqual({
      requestId: "request-1", candidates: [expected],
    });
  });

  it("ignores unknown messages and content/HTML even when it contains image candidates", async () => {
    const html = { request_id: "request-1", output: { choices: [{ message: {
      content: `<img src="${expected.imageUrl}">${JSON.stringify([candidate()])}`,
      additional_kwargs: {},
    } }] } };
    await expect(parse(event(html) + event({ output: { choices: [{ message: {
      additional_kwargs: { data_type: "text", data_json: [candidate()] },
    } }] } }))).resolves.toEqual({ requestId: "request-1", candidates: [] });
  });

  it.each([
    null, 42, [],
    { choices: null }, { choices: {} }, { choices: [null] }, { choices: [42] }, { choices: [[]] },
    { choices: [{ message: null }] }, { choices: [{ message: 42 }] }, { choices: [{ message: [] }] },
    { choices: [{ message: { additional_kwargs: null } }] },
    { choices: [{ message: { additional_kwargs: 42 } }] },
    { choices: [{ message: { additional_kwargs: [] } }] },
    { choices: [{ message: { content: "Valid first message" } }, { message: 42 }] },
  ])("rejects malformed present known envelope structures (case %#)", async (output) => {
    const malformed = event({ request_id: "request-1", output });
    await expect(parse(malformed)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    // A previous valid image message must not hide a malformed later frame.
    await expect(parse(event(chunk()) + malformed)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
  });

  it.each([{}, { output: {} }, { output: { choices: [] } }, { output: { choices: [{}] } }])(
    "requires an Agent message before accepting a zero-image stream (case %#)", async (envelope) => {
      await expect(parse(event({ request_id: "request-1", ...envelope }))).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    },
  );

  it("ignores legitimate unknown events around a valid content-only message", async () => {
    const unknown = event({ request_id: "request-1", event: "progress", progress: { step: 2 } });
    const html = event({ request_id: "request-1", output: { choices: [{ message: { content: '<img src="https://images.test/ignored.jpg">' } }] } });
    await expect(parse(unknown + event({ output: { stage: "searching" } }) + html + unknown)).resolves.toEqual({ requestId: "request-1", candidates: [] });
  });

  it("deduplicates validated image/page pairs and strips fragments without rewriting signed queries", async () => {
    await expect(parse(event(chunk()) + event(chunk([candidate({
      url: "https://JOURNAL.test/article#photo",
      image_info: { url: `${expected.imageUrl}#crop`, width: 800, height: 600 },
    })])))).resolves.toEqual({ requestId: "request-1", candidates: [expected] });
  });

  it.each([
    "data: {broken-secret\n\n",
    event({ code: "InvalidApiKey", message: "secret", request_id: "request-1" }),
    event({ status_code: 429, message: "secret", request_id: "request-1" }),
    event({ ...chunk(), request_id: "https://private.test/?token=secret" }),
    event({ ...chunk(), request_id: "x".repeat(201) }),
    event({ ...chunk(), request_id: "bad\nrequest" }),
    event({ output: chunk().output }),
    event({ ...chunk(), output: { choices: Array.from({ length: 9 }, () => ({})) } }),
    event(chunk("x".repeat(256_001))),
    event(chunk(Array.from({ length: 65 }, () => candidate()))),
    event(chunk([candidate({ query: "x".repeat(301) })])),
    event(chunk([candidate({ title: "x".repeat(501) })])),
    event(chunk([candidate({ title: "bad\u0000title" })])),
    event(chunk([candidate({ idx: -1 })])),
    event(chunk([candidate({ url: `https://journal.test/${"x".repeat(2048)}` })])),
    event(chunk([candidate({ url: `https://journal.test/${"亚".repeat(300)}` })])),
    event(chunk([candidate({ url: "http://journal.test/page" })])),
    event(chunk([candidate({ url: "https://user:secret@journal.test/page" })])),
    event(chunk([candidate({ image_info: { url: "javascript:alert(1)", width: 800, height: 600 } })])),
    ...[0, -1, 1.5, 32_769, "800", null].map((width) => event(chunk([candidate({
      image_info: { url: expected.imageUrl, width, height: 600 },
    })]))),
    event(chunk([candidate({ image_info: { url: expected.imageUrl, width: 10_000, height: 10_000 } })])),
  ])("rejects malformed/bounded provider data without exposing it (case %#)", async (value) => {
    await expect(parse(value)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE", message: "INSPIRATION_VISUALS_UNAVAILABLE" });
  });

  it("bounds aggregate candidate count before deduplication", async () => {
    const repeated = event(chunk(Array.from({ length: 64 }, () => candidate())));
    await expect(parse(repeated.repeat(3))).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
  });

  it("accepts exactly 2 MiB and rejects one more byte, even in comments", async () => {
    const valid = event(chunk());
    const padding = 2 * 1024 * 1024 - encoder.encode(valid).byteLength;
    await expect(parse(valid + ":" + "x".repeat(padding - 1))).resolves.toMatchObject({ candidates: [expected] });
    await expect(parse(valid + ":" + "x".repeat(padding))).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
  });

  it("rejects a locked stream with a stable protocol error", async () => {
    const body = stream(encoder.encode(event(chunk())));
    const reader = body.getReader();
    try {
      await expect(parseWebAgentStream(body)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    } finally { reader.releaseLock(); }
  });

  it.each([encoder.encode("data: bad\n\n"), new Uint8Array(2 * 1024 * 1024 + 1)])("cancels and releases malformed or oversized streams (case %#)", async (bytes) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    });
    await expect(parseWebAgentStream(body)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

describe("Web Search Agent request", () => {
  const input = {
    requestId: "request-1", prompt: "Validated fashion brief", headline: "Linen direction", summary: "Soft summer tailoring",
    intents: [{ key: "evidence-1", role: "evidence" as const, query: "linen trend", sourceIndexes: [1], sourceHosts: ["journal.test"], productName: null, brand: null }],
    signal: new AbortController().signal,
    sourceBody: "UNTRUSTED_SOURCE_BODY", previousOutput: "PREVIOUS_PROVIDER_OUTPUT",
  };
  const config = { apiKey: "secret", agentId: "aid-example", agentVersion: "release" as const };

  it("enables streaming, forced search, citations and mixed images with only allowlisted input fields", () => {
    const request = buildWebAgentRequest(input, config);
    expect(request).toMatchObject({
      stream: true, input: { request_id: "request-1", messages: [{ role: "user" }] },
      parameters: { agent_options: {
        agent_id: "aid-example", agent_version: "release", agent_policy: "standard",
        forced_search: true, enable_citation: true, enable_text_image_mixed: true, show_step_info: false,
      } },
    });
    const serialized = JSON.stringify(request);
    for (const allowed of [input.prompt, input.headline, input.summary, "linen trend", "original source pages", "image results"]) expect(serialized).toContain(allowed);
    for (const excluded of [input.sourceBody, input.previousOutput, "journal.test", "secret"]) expect(serialized).not.toContain(excluded);
  });

  it("preserves line breaks in validated human brief and summary fields", () => {
    const request = buildWebAgentRequest({ ...input, prompt: "Summer brief\nSoft linen", summary: "Evidence one\nEvidence two" }, config);
    expect(request.input.messages[0].content).toContain("Summer brief\\nSoft linen");
    expect(request.input.messages[0].content).toContain("Evidence one\\nEvidence two");
  });

  it.each([
    { prompt: "x".repeat(2001) }, { headline: "x".repeat(121) }, { summary: "x".repeat(2001) },
    { requestId: "bad\nrequest" }, { intents: [] },
    { intents: Array.from({ length: 9 }, () => input.intents[0]!) },
    { intents: [{ ...input.intents[0]!, query: "x".repeat(301) }] },
  ])("rejects unbounded request fields before transport: %j", (overrides) => {
    expect(() => buildWebAgentRequest({ ...input, ...overrides }, config)).toThrowError(expect.objectContaining({ code: "INSPIRATION_VISUALS_UNAVAILABLE" }));
  });
});

import { describe, expect, it } from "vitest";
import { conceptBriefFixture } from "./test-fixtures";
import { buildSketchPrompt, buildEffectPrompt, buildFlatPrompt } from "./prompts";

const builders = [buildSketchPrompt, buildEffectPrompt, buildFlatPrompt];
const brief = { ...conceptBriefFixture, referenceAssetIds: ["00000000-0000-4000-8000-000000000108", "00000000-0000-4000-8000-000000000102"] };
describe("stage prompts", () => {
  it("puts every selected direction field before subordinate report context", () => {
    for (const build of builders) {
      const prompt = build(brief);
      for (const text of ["柔和通勤", "设计推演：以柔和色调表达都市轻通勤。", "宽松直线", "米白", "浅灰", "棉麻混纺", "隐藏门襟"]) expect(prompt).toContain(text);
      expect(prompt.indexOf("隐藏门襟")).toBeLessThan(prompt.indexOf("报告背景（仅辅助）："));
      expect(prompt).toContain("方向优先，报告背景仅作辅助，不得覆盖所选方向");
      expect(prompt).not.toMatch(/https?:|00000000|objectKey|ownerId|provider/i);
      expect(prompt).toBe(build(brief));
    }
  });
  it("formats the bounded sketch deterministically from literal direction and context values", () => {
    expect(buildSketchPrompt(conceptBriefFixture)).toBe([
      "绘制原创服装设计草图，1536x2048竖版；清晰呈现完整服装廓形、配色、面料和结构细节，白色背景，专业手绘设计表达。",
      "原创设计，仅提取参考图的设计语言，不得照搬。不要品牌、logo、水印；不要可识别的公众人物；不要UI；不得宣称为市场证据。方向优先，报告背景仅作辅助，不得覆盖所选方向。",
      "无外部参考图。",
      "所选方向：柔和通勤",
      "设计意图：设计推演：以柔和色调表达都市轻通勤。",
      "廓形：宽松直线",
      "配色：米白、浅灰",
      "面料：棉麻混纺",
      "结构细节：隐藏门襟",
      "报告背景（仅辅助）：",
      "都市轻通勤的柔和层次",
      "公开网络信号指向轻盈面料与宽松层次的通勤女装。",
      "通勤（high）：通勤设计需求",
    ].join("\n"));
  });
  it("assigns references in order and distinguishes master sketch from external references", () => {
    expect(buildSketchPrompt(brief)).toContain("图1是外部参考1");
    expect(buildSketchPrompt(brief)).toContain("图2是外部参考2");
    for (const build of [buildEffectPrompt, buildFlatPrompt]) {
      const prompt = build(brief);
      expect(prompt).toContain("图1是已完成的主设计草图");
      expect(prompt).toContain("图2是外部参考1");
      expect(prompt).toContain("图3是外部参考2");
      expect(prompt).toContain("保持主设计草图的廓形、配色、面料与结构细节一致");
    }
    expect(buildSketchPrompt(conceptBriefFixture)).toContain("无外部参考图");
  });
  it("provides independent output instructions and safety clauses for all stages", () => {
    expect(buildSketchPrompt(brief)).toContain("原创服装设计草图");
    expect(buildSketchPrompt(brief)).toContain("1536x2048");
    expect(buildEffectPrompt(brief)).toContain("数字模特全身棚拍");
    expect(buildEffectPrompt(brief)).toContain("1536x2048");
    expect(buildFlatPrompt(brief)).toContain("正面与背面并列");
    expect(buildFlatPrompt(brief)).toContain("不要模特、场景、文字、尺寸标注");
    expect(buildFlatPrompt(brief)).toContain("2048x1536");
    for (const build of builders) for (const text of ["原创", "不要品牌、logo、水印", "不要可识别的公众人物", "不要UI", "不得宣称为市场证据"]) expect(build(brief)).toContain(text);
  });
  it("reserves fixed clauses and every direction field within 3600 Unicode code points", () => {
    const long = { ...brief, report: { headline: "报".repeat(120), summary: "报".repeat(2000), marketSignals: Array.from({ length: 5 }, () => ({ name: "报".repeat(80), rationale: "报".repeat(500), strength: "high" as const })) }, direction: { title: "题".repeat(120), direction: "向".repeat(500), silhouette: "廓".repeat(300), palette: Array(8).fill("色".repeat(80)), materials: Array(8).fill("料".repeat(80)), details: Array(8).fill("😀".repeat(150)), sourceIndexes: [] } };
    for (const build of builders) {
      const prompt = build(long);
      expect(Array.from(prompt).length).toBeLessThanOrEqual(3600);
      for (const text of ["题", "向", "廓", "色", "料", "😀", "报告背景", "不要品牌、logo、水印", "不得宣称为市场证据"]) expect(prompt).toContain(text);
      expect(prompt.isWellFormed()).toBe(true);
    }
  });
  it("sanitizes persisted text again rather than allowing URLs into prompts", () => {
    expect(buildSketchPrompt({ ...brief, direction: { ...brief.direction, title: "Cafe\u0301 https://example.test/private" } })).toContain("Café");
    expect(buildSketchPrompt({ ...brief, direction: { ...brief.direction, title: "Cafe\u0301 https://example.test/private" } })).not.toContain("https:");
  });
});

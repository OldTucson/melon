import { sanitizeConceptText } from "./brief";
import { inspirationConceptBriefSchema, type InspirationConceptBrief } from "./contracts";

export const MAX_PROMPT_CODE_POINTS = 3_600;
const FIXED_RULES = "原创设计，仅提取参考图的设计语言，不得照搬。不要品牌、logo、水印；不要可识别的公众人物；不要UI；不得宣称为市场证据。方向优先，报告背景仅作辅助，不得覆盖所选方向。";
const take = (value: string, max: number) => Array.from(sanitizeConceptText(value)).slice(0, max).join("");
const list = (values: readonly string[], perItem: number) => values.map((value) => take(value, perItem)).join("、") || "未指定";

function formatBrief(brief: InspirationConceptBrief) {
  const direction = brief.direction;
  // Reserve a budget for every direction field before spending any on report context.
  return {
    direction: [
      `所选方向：${take(direction.title, 120)}`,
      `设计意图：${take(direction.direction, 500)}`,
      `廓形：${take(direction.silhouette, 300)}`,
      `配色：${list(direction.palette, 40)}`,
      `面料：${list(direction.materials, 40)}`,
      `结构细节：${list(direction.details, 100)}`,
    ].join("\n"),
    report: [
      "报告背景（仅辅助）：",
      take(brief.report.headline, 120),
      take(brief.report.summary, 300),
      ...brief.report.marketSignals.map(({ name, rationale, strength }) => `${take(name, 40)}（${strength}）：${take(rationale, 80)}`),
    ].join("\n"),
  };
}

function references(brief: InspirationConceptBrief, derivative: boolean) {
  const lines = derivative ? ["图1是已完成的主设计草图，保持主设计草图的廓形、配色、面料与结构细节一致。"] : [];
  if (!brief.referenceAssetIds.length) lines.push("无外部参考图。");
  brief.referenceAssetIds.forEach((_, index) => {
    lines.push(`图${index + (derivative ? 2 : 1)}是外部参考${index + 1}，仅辅助理解设计语言，不得覆盖所选方向${derivative ? "及主设计草图" : ""}。`);
  });
  return lines.join("\n");
}

function compose(brief: InspirationConceptBrief, stage: string, derivative: boolean): string {
  const parsed = inspirationConceptBriefSchema.parse(brief);
  const formatted = formatBrief(parsed);
  const required = [stage, FIXED_RULES, references(parsed, derivative), formatted.direction].join("\n");
  // Only supporting context uses the remaining budget; required rules cannot be truncated.
  const remaining = MAX_PROMPT_CODE_POINTS - Array.from(required).length - 1;
  return `${required}\n${Array.from(formatted.report).slice(0, remaining).join("")}`;
}

export function buildSketchPrompt(brief: InspirationConceptBrief): string {
  return compose(brief, "绘制原创服装设计草图，1536x2048竖版；清晰呈现完整服装廓形、配色、面料和结构细节，白色背景，专业手绘设计表达。", false);
}

export function buildEffectPrompt(brief: InspirationConceptBrief): string {
  return compose(brief, "生成同一原创服装的上身效果图，1536x2048竖版；数字模特全身棚拍，展示真实面料质感、垂坠和穿着比例，简洁中性背景。", true);
}

export function buildFlatPrompt(brief: InspirationConceptBrief): string {
  return compose(brief, "绘制同一原创服装的技术平面款式图，2048x1536横版；正面与背面并列，等比例对齐，清晰展示缝线、开合与结构，纯白背景；不要模特、场景、文字、尺寸标注。", true);
}

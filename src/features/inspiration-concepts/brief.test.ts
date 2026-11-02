import { describe, expect, it } from "vitest";
import { inspirationResultFixture } from "@/features/inspiration/test-fixtures";
import { buildInspirationConceptBrief } from "./brief";

const ids = ["00000000-0000-4000-8000-000000000108", "00000000-0000-4000-8000-000000000102"];
describe("frozen concept brief", () => {
  it("copies the selected direction exactly, bounds supporting signals, and stores ordered IDs only", () => {
    const result = structuredClone(inspirationResultFixture);
    result.marketSignals = Array.from({ length: 8 }, (_, i) => ({ ...result.marketSignals[0]!, name: `signal-${i}` }));
    const brief = buildInspirationConceptBrief({ result, directionIndex: 1, referenceAssetIds: ids });
    expect(brief).toMatchObject({ schemaVersion: "inspiration-concept-brief-v1", directionIndex: 1, direction: { title: "轻盈叠穿", silhouette: "短外搭配长内衬", palette: ["米白", "浅蓝"], details: ["可调袖口"] }, model: "qwen-image-3.0-pro", promptTemplateVersion: "inspiration-concept-prompts-v1", sizes: { sketch: "1536*2048", effect: "1536*2048", flat: "2048*1536" }, referenceAssetIds: ids });
    expect(brief.report.marketSignals.map(({ name }) => name)).toEqual(["signal-0", "signal-1", "signal-2", "signal-3", "signal-4"]);
    expect(JSON.stringify(brief)).not.toMatch(/https?:|objectKey|ownerId|provider/i);
    expect(Object.isFrozen(brief)).toBe(true);
    expect(Object.isFrozen(brief.direction.palette)).toBe(true);
    expect(Object.isFrozen(brief.report.marketSignals[0])).toBe(true);
    expect(Object.isFrozen(brief.referenceAssetIds)).toBe(true);
    result.inspirationPrompts[1]!.palette[0] = "changed";
    expect(brief.direction.palette).toEqual(["米白", "浅蓝"]);
    expect(Object.isFrozen(result)).toBe(false);
  });
  it("normalizes all text to NFC and omits embedded URLs", () => {
    const result = structuredClone(inspirationResultFixture);
    result.headline = "Cafe\u0301";
    result.inspirationPrompts[0]!.details = ["Cafe\u0301 https://example.test/private ftp://example.test/private //example.test/private data:image/png;base64,AAAA"];
    const brief = buildInspirationConceptBrief({ result, directionIndex: 0, referenceAssetIds: [] });
    expect(brief.report.headline).toBe("Café");
    expect(brief.direction.details).toEqual(["Café"]);
    expect(JSON.stringify(brief)).not.toContain("https:");
    expect(buildInspirationConceptBrief({ result, directionIndex: 0, referenceAssetIds: [] })).toEqual(brief);
  });
  it("rejects absent directions, invalid reports, too many references and duplicate IDs", () => {
    for (const directionIndex of [-1, 0.5, 3, 5, NaN]) expect(() => buildInspirationConceptBrief({ result: inspirationResultFixture, directionIndex, referenceAssetIds: [] })).toThrow();
    expect(() => buildInspirationConceptBrief({ result: { ...inspirationResultFixture, headline: "" }, directionIndex: 0, referenceAssetIds: [] })).toThrow();
    for (const referenceAssetIds of [[...ids, ...ids], [ids[0]!, ids[0]!], ["https://example.test"]]) expect(() => buildInspirationConceptBrief({ result: inspirationResultFixture, directionIndex: 0, referenceAssetIds })).toThrow();
  });
});

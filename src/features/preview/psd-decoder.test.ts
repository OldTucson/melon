import { writePsd } from "ag-psd";
import { describe, expect, it } from "vitest";

import { decodePsdComposite } from "./psd-decoder";

const createImageData = (width: number, height: number) =>
  ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData;

describe("PSD composite decoder", () => {
  it("reads the flattened composite without decoding layer pixels", () => {
    const source = {
      width: 2,
      height: 1,
      imageData: {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
          255, 0, 0, 255,
          0, 255, 0, 255,
        ]),
      },
    };
    const decoded = decodePsdComposite(writePsd(source), { createImageData });

    expect(decoded).toMatchObject({ width: 2, height: 1 });
    expect(decoded.pixels).toHaveLength(8);
  });

  it("rejects invalid PSD bytes with a stable preview error", () => {
    expect(() =>
      decodePsdComposite(new TextEncoder().encode("not a psd").buffer, {
        createImageData,
      }),
    ).toThrow("PREVIEW_DECODE_FAILED");
  });

  it("rejects oversized canvas dimensions before decoding image pixels", () => {
    const header = new Uint8Array(26);
    header.set(new TextEncoder().encode("8BPS"));
    const view = new DataView(header.buffer);
    view.setUint16(4, 1);
    view.setUint16(12, 4);
    view.setUint32(14, 20_000);
    view.setUint32(18, 20_000);
    view.setUint16(22, 8);
    view.setUint16(24, 3);

    expect(() => decodePsdComposite(header.buffer, { createImageData })).toThrow(
      "PREVIEW_PIXEL_LIMIT",
    );
  });
});

import { describe, expect, it } from "vitest";
import { parsePhotoMetadata } from "./photo-metadata";

function jpegWithGps(): Uint8Array {
  const tiff = new Uint8Array(128);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49], 0);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8825, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, 4, true);
  view.setUint16(28, 1, true);
  view.setUint16(30, 2, true);
  view.setUint32(32, 2, true);
  tiff.set([0x4e, 0x00], 36);
  view.setUint16(40, 2, true);
  view.setUint16(42, 5, true);
  view.setUint32(44, 3, true);
  view.setUint32(48, 80, true);
  view.setUint16(52, 3, true);
  view.setUint16(54, 2, true);
  view.setUint32(56, 2, true);
  tiff.set([0x45, 0x00], 60);
  view.setUint16(64, 4, true);
  view.setUint16(66, 5, true);
  view.setUint32(68, 3, true);
  view.setUint32(72, 104, true);
  view.setUint32(76, 0, true);
  [[35, 1], [40, 1], [30, 1]].forEach(([numerator, denominator], index) => {
    view.setUint32(80 + index * 8, numerator, true);
    view.setUint32(84 + index * 8, denominator, true);
  });
  [[139, 1], [45, 1], [30, 1]].forEach(([numerator, denominator], index) => {
    view.setUint32(104 + index * 8, numerator, true);
    view.setUint32(108 + index * 8, denominator, true);
  });

  const exif = new TextEncoder().encode("Exif\0\0");
  const payload = new Uint8Array(exif.length + tiff.length);
  payload.set(exif);
  payload.set(tiff, exif.length);
  const result = new Uint8Array(2 + 2 + 2 + payload.length + 2);
  const resultView = new DataView(result.buffer);
  result.set([0xff, 0xd8, 0xff, 0xe1], 0);
  resultView.setUint16(4, payload.length + 2, false);
  result.set(payload, 6);
  result.set([0xff, 0xd9], 6 + payload.length);
  return result;
}

describe("photo metadata", () => {
  it("reads GPS coordinates from JPEG EXIF", () => {
    const metadata = parsePhotoMetadata(jpegWithGps());
    expect(metadata?.latitude).toBeCloseTo(35.675, 5);
    expect(metadata?.longitude).toBeCloseTo(139.758333, 5);
  });

  it("ignores images without an EXIF JPEG segment", () => {
    expect(parsePhotoMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

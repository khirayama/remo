import { describe, expect, it } from "vitest";
import { isFreshFix, isStationary, CaptureSample } from "./capture-policy";

function sample(receivedAt: number, overrides: Partial<CaptureSample> = {}): CaptureSample {
  return {
    receivedAt,
    latitude: 35.6812,
    longitude: 139.7671,
    speedMps: 0.2,
    accuracyMeters: 10,
    ...overrides,
  };
}

describe("capture policy", () => {
  it("accepts only a newer fix received within 30 seconds", () => {
    expect(isFreshFix(1_000, 2_000, 999)).toBe(true);
    expect(isFreshFix(999, 2_000, 999)).toBe(false);
    expect(isFreshFix(1_000, 32_001, 999)).toBe(false);
  });

  it("requires continuous accurate evidence before stationary mode", () => {
    const samples = Array.from({ length: 19 }, (_, index) => sample(index * 10_000));
    expect(isStationary(samples, 180_000)).toBe(true);
    expect(isStationary(samples.map((item, index) => index === 10 ? { ...item, accuracyMeters: 60 } : item), 180_000)).toBe(false);
    expect(isStationary(samples.map((item, index) => index === 10 ? { ...item, receivedAt: item.receivedAt + 40_000 } : item), 180_000)).toBe(false);
  });
});


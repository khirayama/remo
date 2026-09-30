import { describe, expect, it } from "vitest";
import { normalizeEvent } from "../src/lib/life-events";

describe("timeline record validation", () => {
  it("normalizes a location sample", () => {
    const result = normalizeEvent({ id: "device:event-1", startedAt: 1_700_000_000_000, latitude: 35.6812, longitude: 139.7671, accuracyMeters: 12.5, source: "location" });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ source: "location", photoCount: 0, latitude: 35.6812, accuracyMeters: 12.5 });
    expect(result.data?.updatedAt).toEqual(expect.any(Number));
  });

  it("normalizes a photo sample", () => {
    expect(normalizeEvent({ id: "1", startedAt: 10, source: "photo" }).data).toMatchObject({ source: "photo", photoCount: 1 });
  });

  it("keeps video media type on a photo sample", () => {
    expect(normalizeEvent({ id: "video-1", startedAt: 10, source: "photo", mediaType: "video" }).data)
      .toMatchObject({ source: "photo", mediaType: "video", photoCount: 1 });
    expect(normalizeEvent({ id: "location-video", startedAt: 10, source: "location", mediaType: "video" }).error)
      .toContain("only applies");
  });

  it("normalizes a corrected photo location while retaining the original", () => {
    expect(normalizeEvent({
      id: "photo-1",
      startedAt: 10,
      latitude: 35.6817,
      longitude: 139.7681,
      originalLatitude: 35.7,
      originalLongitude: 139.8,
      locationSource: "inferred",
      photoLocationAutoPlacementDisabled: false,
      source: "photo",
    }).data).toMatchObject({
      latitude: 35.6817,
      longitude: 139.7681,
      originalLatitude: 35.7,
      originalLongitude: 139.8,
      locationSource: "inferred",
      photoLocationAutoPlacementDisabled: false,
    });
  });

  it("normalizes the automatic photo placement lock", () => {
    expect(normalizeEvent({ id: "photo-locked", startedAt: 10, source: "photo", photoLocationAutoPlacementDisabled: true }).data)
      .toMatchObject({ photoLocationAutoPlacementDisabled: true });
    expect(normalizeEvent({ id: "photo-invalid", startedAt: 10, photoLocationAutoPlacementDisabled: "true" }).error)
      .toContain("photoLocationAutoPlacementDisabled");
  });

  it("keeps the public update timestamp", () => {
    expect(normalizeEvent({ id: "1", startedAt: 10, updatedAt: 20 }).data?.updatedAt).toBe(20);
  });

  it("rejects invalid coordinates", () => {
    expect(normalizeEvent({ id: "1", startedAt: 10, latitude: 100 }).error).toContain("latitude");
    expect(normalizeEvent({ id: "1", startedAt: 10, longitude: 200 }).error).toContain("longitude");
    expect(normalizeEvent({ id: "1", startedAt: 10, latitude: 35 }).error).toContain("together");
    expect(normalizeEvent({ id: "1", startedAt: 10, source: "manual" }).error).toContain("source");
    expect(normalizeEvent({ id: "1", startedAt: 10, accuracyMeters: -1 }).error).toContain("accuracyMeters");
  });

  it("ignores the zero coordinate", () => {
    expect(normalizeEvent({ id: "zero", startedAt: 10, latitude: 0, longitude: 0 }).data).toMatchObject({ latitude: null, longitude: null });
  });

});

import { describe, expect, it } from "vitest";
import timelineFixture from "../../../fixtures/timeline/remo-timeline-2026-09-01.sample.json";
import { LifeEvent } from "./life-log";
import { buildMovementSegments, buildRawRouteSegments, buildStayClusters, buildStayPlaces, buildStayVisitHistory, buildTimelineActivities, clusterPhotoEvents, correctedLocationEvents, displayPhotoEvents, distanceMeters, PHOTO_CLUSTER_RADIUS_METERS, routeOpacity, STAY_CLUSTER_RADIUS_METERS, stayCircleRadiusMeters, suggestPhotoLocation } from "./timeline-map";

function event(overrides: Partial<LifeEvent> = {}): LifeEvent {
  return {
    id: crypto.randomUUID(),
    startedAt: "2026-08-31T01:00:00.000Z",
    latitude: 35.6812,
    longitude: 139.7671,
    photoCount: 0,
    source: "location",
    updatedAt: "2026-08-31T01:00:00.000Z",
    ...overrides,
  };
}

/** One sample every [stepSeconds] from [start] at a fixed coordinate. */
function samples(prefix: string, start: string, count: number, stepSeconds: number, overrides: Partial<LifeEvent> = {}): LifeEvent[] {
  return Array.from({ length: count }, (_, index) => event({
    id: `${prefix}-${index}`,
    startedAt: new Date(Date.parse(start) + index * stepSeconds * 1000).toISOString(),
    ...overrides,
  }));
}

describe("map timeline", () => {
  it("keeps every raw location pair, including a spike, in the raw route", () => {
    const spike = event({ id: "spike", startedAt: "2026-08-31T01:01:00.000Z", latitude: 35.7, longitude: 139.8 });
    const segments = buildRawRouteSegments([
      event({ id: "start", startedAt: "2026-08-31T01:00:00.000Z" }),
      spike,
      event({ id: "end", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.6813, longitude: 139.7672 }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].to).toEqual([spike.latitude, spike.longitude]);
    expect(segments[1].from).toEqual([spike.latitude, spike.longitude]);
  });

  it("keeps low-confidence locations in raw data but omits them from processed movement", () => {
    const events = [
      event({ id: "start", accuracyMeters: 10 }),
      event({ id: "low-confidence", startedAt: "2026-08-31T01:01:00.000Z", latitude: 35.682, accuracyMeters: 120 }),
      event({ id: "end", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.6813, longitude: 139.7672, accuracyMeters: 10 }),
    ];
    const raw = buildRawRouteSegments(events);
    const movement = buildMovementSegments(events);

    expect(raw).toHaveLength(2);
    expect(raw[0].to).toEqual([35.682, 139.7671]);
    expect(movement).toHaveLength(1);
    expect(movement[0].from).toEqual([35.6812, 139.7671]);
    expect(movement[0].to).toEqual([35.6813, 139.7672]);
  });

  it("includes geotagged photos in movement and stay processing", () => {
    const entries = [
      event({ id: "location-1", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:05:00.000Z", latitude: 35.6813 }),
      event({ id: "location-2", startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.68135, longitude: 139.7672 }),
    ];
    const raw = buildRawRouteSegments(entries);
    const stays = buildStayClusters(entries);

    expect(raw).toHaveLength(2);
    expect(raw[0].to).toEqual([35.6813, 139.7671]);
    expect(stays).toHaveLength(1);
    expect(stays[0].events.map((location) => location.event.id)).toContain("photo");
  });

  it("groups nearby corrected locations into a stay and omits its stationary lines", () => {
    const stay = buildStayClusters([
      event({ id: "stay-1", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "stay-2", startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.68145 }),
      event({ id: "stay-3", startedAt: "2026-08-31T01:20:00.000Z", latitude: 35.68135, longitude: 139.7672 }),
      event({ id: "move", startedAt: "2026-08-31T01:30:00.000Z", latitude: 35.684, longitude: 139.77 }),
    ]);
    const movement = buildMovementSegments([
      event({ id: "stay-1", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "stay-2", startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.68145 }),
      event({ id: "stay-3", startedAt: "2026-08-31T01:20:00.000Z", latitude: 35.68135, longitude: 139.7672 }),
      event({ id: "move", startedAt: "2026-08-31T01:30:00.000Z", latitude: 35.684, longitude: 139.77 }),
    ], Date.parse("2026-08-31T02:00:00.000Z"));

    expect(stay).toHaveLength(1);
    expect(stay[0].events).toHaveLength(3);
    expect(stay[0].durationMs).toBe(20 * 60 * 1000);
    expect(distanceMeters(stay[0], { latitude: 35.6812, longitude: 139.7671 })).toBeLessThan(STAY_CLUSTER_RADIUS_METERS);
    expect(movement).toHaveLength(1);
    expect(movement[0].from).toEqual([35.68135, 139.7672]);
    expect(movement[0].to).toEqual([35.684, 139.77]);
  });

  it("keeps processed movement connected across a stay", () => {
    const movement = buildMovementSegments([
      event({ id: "before", startedAt: "2026-08-31T01:00:00.000Z", latitude: 35.684, longitude: 139.77 }),
      event({ id: "stay-1", startedAt: "2026-08-31T01:10:00.000Z" }),
      event({ id: "stay-2", startedAt: "2026-08-31T01:20:00.000Z" }),
      event({ id: "stay-3", startedAt: "2026-08-31T01:30:00.000Z" }),
      event({ id: "after", startedAt: "2026-08-31T01:40:00.000Z", latitude: 35.684, longitude: 139.77 }),
    ]);

    expect(movement).toHaveLength(2);
    expect(movement[0].to).toEqual(movement[1].from);
    expect(movement[0].to).toEqual([35.6812, 139.7671]);
  });

  it("groups nearby separate stays into recurring places without merging distant stays", () => {
    const places = buildStayPlaces([
      event({ id: "home-1", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "home-2", startedAt: "2026-08-31T01:10:00.000Z" }),
      event({ id: "home-3", startedAt: "2026-08-31T01:20:00.000Z" }),
      event({ id: "between-1", startedAt: "2026-08-31T01:30:00.000Z", latitude: 35.683, longitude: 139.769 }),
      event({ id: "between-2", startedAt: "2026-08-31T01:40:00.000Z", latitude: 35.685, longitude: 139.77 }),
      event({ id: "between-3", startedAt: "2026-08-31T01:50:00.000Z", latitude: 35.687, longitude: 139.772 }),
      event({ id: "home-near-1", startedAt: "2026-08-31T02:00:00.000Z", latitude: 35.6818, longitude: 139.7671 }),
      event({ id: "home-near-2", startedAt: "2026-08-31T02:10:00.000Z", latitude: 35.6818, longitude: 139.7671 }),
      event({ id: "home-near-3", startedAt: "2026-08-31T02:20:00.000Z", latitude: 35.6818, longitude: 139.7671 }),
      event({ id: "work-1", startedAt: "2026-08-31T02:40:00.000Z", latitude: 35.69, longitude: 139.78 }),
      event({ id: "work-2", startedAt: "2026-08-31T02:50:00.000Z", latitude: 35.69, longitude: 139.78 }),
      event({ id: "work-3", startedAt: "2026-08-31T03:00:00.000Z", latitude: 35.69, longitude: 139.78 }),
    ]);

    expect(places).toHaveLength(2);
    expect(places[0].visitCount).toBe(2);
    expect(places[0].visits).toHaveLength(2);
    expect(places[1].visitCount).toBe(1);
  });

  it("builds chronological stay and movement intervals and assigns photos to their ranges", () => {
    const activities = buildTimelineActivities([
      event({ id: "before", startedAt: "2026-08-31T01:00:00.000Z", latitude: 35.684, longitude: 139.77 }),
      event({ id: "travel-photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:05:00.000Z", latitude: 35.6841, longitude: 139.7701 }),
      event({ id: "stay-1", startedAt: "2026-08-31T01:10:00.000Z" }),
      event({ id: "stay-2", startedAt: "2026-08-31T01:20:00.000Z" }),
      event({ id: "stay-photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:25:00.000Z", latitude: 35.6813, longitude: 139.7671 }),
      event({ id: "stay-3", startedAt: "2026-08-31T01:30:00.000Z" }),
      event({ id: "after-photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:40:00.000Z", latitude: 35.6841, longitude: 139.7701 }),
      event({ id: "after", startedAt: "2026-08-31T01:50:00.000Z", latitude: 35.688, longitude: 139.775 }),
    ]);

    expect(activities.map((activity) => `${activity.kind}:${activity.startedAt.slice(11, 16)}-${activity.endedAt.slice(11, 16)}`)).toEqual([
      "movement:01:00-01:10",
      "stay:01:10-01:30",
      "movement:01:30-01:50",
    ]);
    expect(activities[0].photos.map((photo) => photo.id)).toEqual(["travel-photo"]);
    expect(activities[1].photos.map((photo) => photo.id)).toEqual(["stay-photo"]);
    expect(activities[2].photos.map((photo) => photo.id)).toEqual(["after-photo"]);
    expect(activities[1].durationMs).toBe(20 * 60 * 1000);
  });

  it("merges consecutive movement intervals into one route", () => {
    const activities = buildTimelineActivities([
      event({ id: "start", startedAt: "2026-08-31T01:00:00.000Z", latitude: 35.6812, longitude: 139.7671 }),
      event({ id: "middle", startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.684, longitude: 139.77 }),
      event({ id: "travel-photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:15:00.000Z", latitude: 35.685, longitude: 139.771 }),
      event({ id: "end", startedAt: "2026-08-31T01:20:00.000Z", latitude: 35.688, longitude: 139.775 }),
    ]);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: "movement", startedAt: "2026-08-31T01:00:00.000Z", endedAt: "2026-08-31T01:20:00.000Z", durationMs: 20 * 60 * 1000 });
    expect(activities[0].kind === "movement" && activities[0].path).toEqual([
      [35.6812, 139.7671],
      [35.684, 139.77],
      [35.688, 139.775],
    ]);
    expect(activities[0].photos.map((photo) => photo.id)).toEqual(["travel-photo"]);
  });

  it("fades processed movement by distance from the current time", () => {
    const movement = buildMovementSegments([
      event({ id: "old", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "middle", startedAt: "2026-08-31T01:30:00.000Z", latitude: 35.684, longitude: 139.77 }),
      event({ id: "new", startedAt: "2026-08-31T01:55:00.000Z", latitude: 35.69, longitude: 139.78 }),
    ], Date.parse("2026-08-31T02:00:00.000Z"));

    expect(movement[0].opacity).toBeLessThan(movement[1].opacity);
    expect(routeOpacity(0)).toBe(0.95);
  });

  it("counts videos separately in a photo cluster", () => {
    const clusters = clusterPhotoEvents([
      event({ id: "photo", source: "photo", photoCount: 1 }),
      event({ id: "video", source: "photo", mediaType: "video", photoCount: 1, latitude: 35.6813 }),
    ]);

    expect(clusters[0]).toMatchObject({ photoCount: 1, videoCount: 1 });
  });

  it("scales stay circles with a deliberately bounded maximum", () => {
    expect(stayCircleRadiusMeters(5 * 60 * 1000)).toBeLessThan(stayCircleRadiusMeters(60 * 60 * 1000));
    expect(stayCircleRadiusMeters(365 * 24 * 60 * 60 * 1000)).toBe(75);
  });

  it("corrects an isolated GPS spike for display while keeping its record", () => {
    const previous = event({ id: "previous", startedAt: "2026-08-31T01:00:00.000Z", accuracyMeters: 10 });
    const spike = event({ id: "spike", startedAt: "2026-08-31T01:01:00.000Z", latitude: 35.7, longitude: 139.8, accuracyMeters: 50 });
    const next = event({ id: "next", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.6813, longitude: 139.7672, accuracyMeters: 10 });

    const corrected = correctedLocationEvents([previous, spike, next]);

    expect(corrected[1]).toMatchObject({ event: spike, corrected: true });
    expect(corrected[1].latitude).toBeCloseTo((previous.latitude! + next.latitude!) / 2);
    expect(corrected[1].longitude).toBeCloseTo((previous.longitude! + next.longitude!) / 2);
    expect(spike.latitude).toBe(35.7);
    expect(spike.longitude).toBe(139.8);
  });

  it("suggests an interpolated location for a photo with a mismatched EXIF coordinate", () => {
    const photo = event({ id: "photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:05:00.000Z", latitude: 35.7, longitude: 139.8 });
    const suggestion = suggestPhotoLocation(photo, [
      event({ id: "before", startedAt: "2026-08-31T01:00:00.000Z", latitude: 35.6812, longitude: 139.7671 }),
      event({ id: "after", startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.6822, longitude: 139.7691 }),
    ]);

    expect(suggestion).toMatchObject({ previousId: "before", nextId: "after" });
    expect(suggestion?.latitude).toBeCloseTo(35.6817);
    expect(suggestion?.longitude).toBeCloseTo(139.7681);
    expect(suggestion?.distanceFromOriginalMeters).toBeGreaterThan(200);
  });

  it("uses the corrected location coordinate when a nearby GPS sample is a spike", () => {
    const photo = event({ id: "photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:02:30.000Z", latitude: 35.7, longitude: 139.8 });
    const suggestion = suggestPhotoLocation(photo, [
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "spike", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.7, longitude: 139.8 }),
      photo,
      event({ id: "after-1", startedAt: "2026-08-31T01:03:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:04:00.000Z" }),
    ]);

    expect(suggestion).toMatchObject({ previousId: "spike", nextId: "after-1" });
    expect(suggestion?.latitude).toBeCloseTo(35.6812);
    expect(suggestion?.longitude).toBeCloseTo(139.7671);
  });

  it("uses the processed location for an untouched photo marker without changing the record", () => {
    const photo = event({
      id: "photo-display",
      source: "photo",
      photoCount: 1,
      startedAt: "2026-08-31T01:02:30.000Z",
      latitude: 35.7,
      longitude: 139.8,
      originalLatitude: 35.7,
      originalLongitude: 139.8,
      locationSource: "exif",
    });
    const display = displayPhotoEvents([
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "spike", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.7, longitude: 139.8 }),
      photo,
      event({ id: "after-1", startedAt: "2026-08-31T01:03:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:04:00.000Z" }),
    ]);
    const displayedPhoto = display.find((item) => item.id === photo.id)!;

    expect(displayedPhoto.latitude).toBeCloseTo(35.6812);
    expect(displayedPhoto.longitude).toBeCloseTo(139.7671);
    expect(photo.latitude).toBe(35.7);
    expect(photo.longitude).toBe(139.8);
  });

  it("keeps an explicitly restored EXIF photo at its stored position", () => {
    const photo = event({
      id: "photo-restored",
      source: "photo",
      photoCount: 1,
      startedAt: "2026-08-31T01:02:00.000Z",
      latitude: 35.7,
      longitude: 139.8,
      originalLatitude: 35.7,
      originalLongitude: 139.8,
      locationSource: "exif",
      photoLocationAutoPlacementDisabled: true,
    });
    const displayedPhoto = displayPhotoEvents([
      event({ id: "before", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "after", startedAt: "2026-08-31T01:03:00.000Z" }),
      photo,
    ]).find((item) => item.id === photo.id)!;

    expect(displayedPhoto.latitude).toBe(35.7);
    expect(displayedPhoto.longitude).toBe(139.8);
  });

  it("suggests the nearest location when a photo has no EXIF coordinate", () => {
    const photo = event({ id: "photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:04:00.000Z", latitude: undefined, longitude: undefined });
    const location = event({ id: "location", startedAt: "2026-08-31T01:00:00.000Z", latitude: 35.6812, longitude: 139.7671 });

    expect(suggestPhotoLocation(photo, [location])).toMatchObject({
      latitude: location.latitude,
      longitude: location.longitude,
      previousId: location.id,
    });
  });

  it("does not suggest from stale or low-confidence location logs", () => {
    const photo = event({ id: "photo", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:30:00.000Z", latitude: undefined, longitude: undefined });
    expect(suggestPhotoLocation(photo, [
      event({ id: "stale", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "inaccurate", startedAt: "2026-08-31T01:29:00.000Z", accuracyMeters: 120 }),
    ])).toBeUndefined();
  });

  it("corrects a moderate spike when a wider local window is stable", () => {
    const corrected = correctedLocationEvents([
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "spike", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.682 }),
      event({ id: "after-1", startedAt: "2026-08-31T01:03:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:04:00.000Z" }),
    ]);

    expect(corrected[2]).toMatchObject({ corrected: true, latitude: 35.6812, longitude: 139.7671 });
  });

  it("corrects a repeated short excursion when both sides return to the anchor", () => {
    const corrected = correctedLocationEvents([
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "spike-1", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.682 }),
      event({ id: "spike-2", startedAt: "2026-08-31T01:03:00.000Z", latitude: 35.682 }),
      event({ id: "after-1", startedAt: "2026-08-31T01:04:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:05:00.000Z" }),
    ]);

    expect(corrected.slice(2, 4).every((item) => item.corrected)).toBe(true);
    expect(corrected[2]).toMatchObject({ latitude: 35.6812, longitude: 139.7671 });
    expect(corrected[3]).toMatchObject({ latitude: 35.6812, longitude: 139.7671 });
  });

  it("keeps a sustained multi-sample movement as raw data", () => {
    const corrected = correctedLocationEvents([
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "move-1", startedAt: "2026-08-31T01:02:00.000Z", longitude: 139.769 }),
      event({ id: "move-2", startedAt: "2026-08-31T01:03:00.000Z", longitude: 139.771 }),
      event({ id: "move-3", startedAt: "2026-08-31T01:04:00.000Z", longitude: 139.773 }),
      event({ id: "after-1", startedAt: "2026-08-31T01:05:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:06:00.000Z" }),
    ]);

    expect(corrected.slice(2, 5).every((item) => !item.corrected)).toBe(true);
  });

  it("corrects a moderate local deviation as display noise", () => {
    const corrected = correctedLocationEvents([
      event({ id: "before-2", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "before-1", startedAt: "2026-08-31T01:01:00.000Z" }),
      event({ id: "ambiguous", startedAt: "2026-08-31T01:02:00.000Z", latitude: 35.68185 }),
      event({ id: "after-1", startedAt: "2026-08-31T01:03:00.000Z" }),
      event({ id: "after-2", startedAt: "2026-08-31T01:04:00.000Z" }),
    ]);

    expect(corrected[2]).toMatchObject({ event: expect.objectContaining({ id: "ambiguous" }), corrected: true, latitude: 35.6812 });
  });

  it("uses the sample timeline as a regression fixture for spike correction", () => {
    const corrected = correctedLocationEvents(timelineFixture.events as unknown as LifeEvent[]);
    const correctedIds = corrected.filter((item) => item.corrected).map((item) => item.event.id);

    expect(correctedIds.length).toBeGreaterThan(5);
    expect(correctedIds.length).toBeLessThan(50);
    expect(correctedIds).toEqual(expect.arrayContaining([
      "348850a0-cc8e-486c-8644-6732c54b5f60",
      "a78b8aaa-eff8-4379-897b-cf8f489debce",
      "299ef140-836c-4e53-8bf5-78c0f9700992",
      "b3c932d3-b592-462c-8134-02ac63acbcef",
      "52060172-c35e-4569-9b54-7cfa1e2b7ff9",
    ]));
  });

  it("makes older route segments lighter", () => {
    expect(routeOpacity(5 * 60 * 1000)).toBeGreaterThan(routeOpacity(60 * 60 * 1000));
  });

  it("uses the photo cluster radius for nearby photo selection", () => {
    const origin = event({ id: "origin", source: "photo", photoCount: 1 }) as LifeEvent & { latitude: number; longitude: number };
    const nearby = event({ id: "nearby", source: "photo", photoCount: 1, latitude: 35.6815 }) as LifeEvent & { latitude: number; longitude: number };
    const distant = event({ id: "distant", source: "photo", photoCount: 1, latitude: 35.69, longitude: 139.78 }) as LifeEvent & { latitude: number; longitude: number };

    expect(distanceMeters(origin, nearby)).toBeLessThan(PHOTO_CLUSTER_RADIUS_METERS);
    expect(distanceMeters(origin, distant)).toBeGreaterThan(PHOTO_CLUSTER_RADIUS_METERS);
  });

  it("groups nearby photo records into one display cluster without changing the records", () => {
    const first = event({ id: "photo-1", source: "photo", photoCount: 1 });
    const nearby = event({ id: "photo-2", source: "photo", photoCount: 2, startedAt: "2026-08-31T01:05:00.000Z", latitude: 35.6815 });
    const distant = event({ id: "photo-3", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:10:00.000Z", latitude: 35.69, longitude: 139.78 });
    const clusters = clusterPhotoEvents([first, nearby, distant]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ photoCount: 3, latitude: first.latitude, longitude: first.longitude });
    expect(clusters[0].events.map((item) => item.id)).toEqual(["photo-1", "photo-2"]);
    expect([first, nearby, distant].map((item) => item.id)).toEqual(["photo-1", "photo-2", "photo-3"]);
  });

  it("does not use location records to split photo clusters", () => {
    const firstLocation = event({ id: "location-1", startedAt: "2026-08-31T01:00:00.000Z" });
    const firstLocation2 = event({ id: "location-1b", startedAt: "2026-08-31T01:05:00.000Z" });
    const firstLocation3 = event({ id: "location-1c", startedAt: "2026-08-31T01:10:00.000Z" });
    const secondLocation = event({ id: "location-2", startedAt: "2026-08-31T01:30:00.000Z" });
    const secondLocation2 = event({ id: "location-2b", startedAt: "2026-08-31T01:35:00.000Z" });
    const secondLocation3 = event({ id: "location-2c", startedAt: "2026-08-31T01:40:00.000Z" });
    const firstPhoto = event({ id: "photo-1", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:05:00.000Z" });
    const secondPhoto = event({ id: "photo-2", source: "photo", photoCount: 1, startedAt: "2026-08-31T01:35:00.000Z" });

    const clusters = clusterPhotoEvents([firstLocation, firstLocation2, firstLocation3, secondLocation, secondLocation2, secondLocation3, firstPhoto, secondPhoto]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].events.map((item) => item.id)).toEqual(["photo-1", "photo-2"]);
  });

  it("keeps a stay across a short GPS drift that never goes far", () => {
    const stays = buildStayClusters([
      ...samples("before", "2026-08-31T01:00:00.000Z", 9, 60),
      ...samples("drift", "2026-08-31T01:09:00.000Z", 4, 60, { latitude: 35.6825 }),
      ...samples("after", "2026-08-31T01:13:00.000Z", 8, 60),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ startedAt: "2026-08-31T01:00:00.000Z", endedAt: "2026-08-31T01:20:00.000Z" });
    expect(stays[0].events.map((location) => location.event.id)).toContain("drift-0");
    expect(distanceMeters(stays[0], { latitude: 35.6812, longitude: 139.7671 })).toBeLessThan(1);
    expect(buildMovementSegments([
      ...samples("before", "2026-08-31T01:00:00.000Z", 9, 60),
      ...samples("drift", "2026-08-31T01:09:00.000Z", 4, 60, { latitude: 35.6825 }),
      ...samples("after", "2026-08-31T01:13:00.000Z", 8, 60),
    ])).toHaveLength(0);
  });

  it("keeps a stay across a brief far excursion", () => {
    const stays = buildStayClusters([
      ...samples("before", "2026-08-31T01:00:00.000Z", 9, 60),
      ...samples("jump", "2026-08-31T01:08:30.000Z", 3, 30, { latitude: 35.6912 }),
      ...samples("after", "2026-08-31T01:10:30.000Z", 8, 60),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0].durationMs).toBe(17.5 * 60 * 1000);
  });

  it("keeps a real short visit a few hundred meters away as its own stay", () => {
    const stays = buildStayClusters([
      ...samples("home", "2026-08-31T01:00:00.000Z", 11, 120),
      ...samples("neighbor", "2026-08-31T01:22:00.000Z", 4, 120, { latitude: 35.6839 }),
      ...samples("back", "2026-08-31T01:30:00.000Z", 6, 120),
    ]);

    expect(stays.map((stay) => `${stay.startedAt.slice(11, 16)}-${stay.endedAt.slice(11, 16)}`)).toEqual(["01:00-01:20", "01:22-01:28", "01:30-01:40"]);
  });

  it("joins neighboring stays that are too close to tell apart", () => {
    const stays = buildStayClusters([
      ...samples("home", "2026-08-31T01:00:00.000Z", 30, 60),
      ...samples("next-door", "2026-08-31T01:30:00.000Z", 10, 60, { latitude: 35.6825 }),
      ...samples("home-again", "2026-08-31T01:40:00.000Z", 10, 60),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ startedAt: "2026-08-31T01:00:00.000Z", endedAt: "2026-08-31T01:49:00.000Z" });
    expect(distanceMeters(stays[0], { latitude: 35.6812, longitude: 139.7671 })).toBeLessThan(1);
  });

  it("keeps one stay at the dominant place while fixes flip to another spot", () => {
    const flip = Array.from({ length: 40 }, (_, index) => event({
      id: `flip-${index}`,
      startedAt: new Date(Date.parse("2026-08-31T01:30:00.000Z") + index * 30_000).toISOString(),
      // Mostly the other fix, returning to the hotel every fourth sample.
      latitude: index % 4 === 3 ? 35.6812 : 35.6833,
    }));
    const stays = buildStayClusters([
      ...samples("hotel", "2026-08-31T00:00:00.000Z", 90, 60),
      ...flip,
      ...samples("hotel-again", "2026-08-31T01:50:00.000Z", 60, 60),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0].durationMs).toBe((2 * 60 + 49) * 60 * 1000);
    expect(distanceMeters(stays[0], { latitude: 35.6812, longitude: 139.7671 })).toBeLessThan(1);
    expect(buildTimelineActivities([...samples("hotel", "2026-08-31T00:00:00.000Z", 90, 60), ...flip, ...samples("hotel-again", "2026-08-31T01:50:00.000Z", 60, 60)])
      .map((activity) => activity.kind)).toEqual(["stay"]);
  });

  it("corrects a stale fix that snaps back while moving", () => {
    const corrected = correctedLocationEvents([
      ...Array.from({ length: 4 }, (_, index) => event({ id: `drive-${index}`, startedAt: new Date(Date.parse("2026-08-31T01:00:00.000Z") + index * 10_000).toISOString(), latitude: 35.6812 + index * 0.002 })),
      event({ id: "stale", startedAt: "2026-08-31T01:00:40.000Z", latitude: 35.6812, accuracyMeters: 20 }),
      ...Array.from({ length: 4 }, (_, index) => event({ id: `drive-${index + 5}`, startedAt: new Date(Date.parse("2026-08-31T01:00:50.000Z") + index * 10_000).toISOString(), latitude: 35.6812 + (index + 5) * 0.002 })),
    ]);
    const stale = corrected.find((item) => item.event.id === "stale")!;

    expect(stale.corrected).toBe(true);
    expect(stale.latitude).toBeCloseTo(35.6812 + 4 * 0.002);
  });

  it("bridges a long sampling gap that ends where it started", () => {
    const stays = buildStayClusters([
      ...samples("evening", "2026-08-31T12:00:00.000Z", 3, 120),
      ...samples("morning", "2026-08-31T20:00:00.000Z", 2, 60, { latitude: 35.6813 }),
      event({ id: "leave", startedAt: "2026-08-31T20:05:00.000Z", latitude: 35.69, longitude: 139.78 }),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ startedAt: "2026-08-31T12:00:00.000Z", endedAt: "2026-08-31T20:01:00.000Z" });
  });

  it("does not bridge a sampling gap longer than half a day", () => {
    const stays = buildStayClusters([
      ...samples("evening", "2026-08-31T08:00:00.000Z", 4, 120),
      ...samples("next-day", "2026-08-31T21:00:00.000Z", 2, 60),
    ]);

    expect(stays).toHaveLength(1);
    expect(stays[0].endedAt).toBe("2026-08-31T08:06:00.000Z");
  });

  it("widens the stay radius for inaccurate indoor fixes", () => {
    const stays = buildStayClusters(Array.from({ length: 11 }, (_, index) => event({
      id: `indoor-${index}`,
      startedAt: new Date(Date.parse("2026-08-31T01:00:00.000Z") + index * 60_000).toISOString(),
      latitude: index % 2 ? 35.6820 : 35.6812,
      accuracyMeters: 95,
    })));

    expect(stays).toHaveLength(1);
    expect(stays[0].events).toHaveLength(11);
  });

  it("collects revisits to one place across days, newest first", () => {
    const home = { latitude: 35.6812, longitude: 139.7671 };
    const history = buildStayVisitHistory([
      ...samples("day1-home", "2026-08-29T12:00:00.000Z", 3, 600),
      ...samples("day2-work", "2026-08-30T12:00:00.000Z", 3, 600, { latitude: 35.69, longitude: 139.78 }),
      ...samples("day2-next-door", "2026-08-30T14:00:00.000Z", 3, 600, { latitude: 35.6826 }),
      ...samples("day3-home", "2026-08-31T12:00:00.000Z", 3, 600),
      ...samples("day3-work", "2026-08-31T13:00:00.000Z", 3, 600, { latitude: 35.69, longitude: 139.78 }),
      ...samples("day3-home-again", "2026-08-31T14:00:00.000Z", 3, 600, { latitude: 35.6813 }),
      ...samples("elsewhere", "2026-08-28T12:00:00.000Z", 3, 600, { latitude: 35.7, longitude: 139.8 }),
    ], home);

    expect(history.visits.map((visit) => visit.startedAt)).toEqual([
      "2026-08-31T14:00:00.000Z",
      "2026-08-31T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ]);
    expect(history.dayCount).toBe(2);
    expect(history.totalDurationMs).toBe(3 * 20 * 60 * 1000);
  });
});

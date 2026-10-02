import { dateKey, LifeEvent } from "./life-log";

export const PHOTO_CLUSTER_RADIUS_METERS = 50;
export const MAX_DISPLAY_ACCURACY_METERS = 100;
export const PHOTO_LOCATION_SUGGESTION_WINDOW_MS = 15 * 60 * 1000;

export type LocatedEvent = LifeEvent & { latitude: number; longitude: number };

export type CorrectedLocation = {
  event: LocatedEvent;
  latitude: number;
  longitude: number;
  corrected: boolean;
};

export type PhotoLocationSuggestion = {
  latitude: number;
  longitude: number;
  timeDistanceMs: number;
  distanceFromOriginalMeters?: number;
  previousId?: string;
  nextId?: string;
};

const MAX_CORRECTION_GAP_MS = 15 * 60 * 1000;
const MAX_REASONABLE_SPEED_MPS = 80;
const MIN_SPIKE_DISTANCE_METERS = 250;
const LOCAL_OUTLIER_WINDOW = 2;
const LOCAL_NEIGHBOR_RADIUS_METERS = 100;
const MIN_LOCAL_SPIKE_DISTANCE_METERS = 35;
const MAX_SPIKE_RUN_SAMPLES = 2;
// While moving, a stale fix can snap back to where the device was a moment
// ago. Such a fix lies far off the line between its neighbors.
const MOVING_SPIKE_MAX_SPAN_MS = 2 * 60 * 1000;
const MIN_MOVING_SPIKE_DISTANCE_METERS = 200;

export function locationEvents(events: LifeEvent[]): LocatedEvent[] {
  return positionEvents(events).filter((event) => event.source === "location");
}

export function positionEvents(events: LifeEvent[]): LocatedEvent[] {
  return events
    .filter((event): event is LocatedEvent => (event.source === "location" || event.source === "photo")
      && typeof event.latitude === "number" && Number.isFinite(event.latitude)
      && typeof event.longitude === "number" && Number.isFinite(event.longitude)
      && !(event.latitude === 0 && event.longitude === 0))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function displayLocationEvents(events: LifeEvent[]): LocatedEvent[] {
  return locationEvents(events).filter((event) => event.accuracyMeters === undefined || event.accuracyMeters <= MAX_DISPLAY_ACCURACY_METERS);
}

export function displayPositionEvents(events: LifeEvent[]): LocatedEvent[] {
  return positionEvents(events).filter((event) => event.accuracyMeters === undefined || event.accuracyMeters <= MAX_DISPLAY_ACCURACY_METERS);
}

/**
 * Estimate a photo's position from nearby, reasonably accurate, processed location logs.
 * This is deliberately a suggestion: the EXIF coordinate is never changed by
 * this function and a user still decides whether to apply it.
 */
export function suggestPhotoLocation(event: LifeEvent, events: LifeEvent[]): PhotoLocationSuggestion | undefined {
  if (event.source !== "photo") return undefined;
  const photoTime = timestamp(event.startedAt);
  if (!Number.isFinite(photoTime)) return undefined;
  const locations = correctedLocationEvents(events);
  if (!locations.length) return undefined;
  const nextIndex = locations.findIndex((location) => timestamp(location.event.startedAt) >= photoTime);
  const previous = nextIndex < 0 ? locations.at(-1) : nextIndex === 0 ? undefined : locations[nextIndex - 1];
  const next = nextIndex < 0 ? undefined : locations[nextIndex];
  const previousDistance = previous ? photoTime - timestamp(previous.event.startedAt) : Number.POSITIVE_INFINITY;
  const nextDistance = next ? timestamp(next.event.startedAt) - photoTime : Number.POSITIVE_INFINITY;
  if (previousDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS && nextDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS) return undefined;

  let latitude: number;
  let longitude: number;
  let timeDistanceMs: number;
  if (previous && next && previous.event.id !== next.event.id
    && previousDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS
    && nextDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS) {
    const totalGap = timestamp(next.event.startedAt) - timestamp(previous.event.startedAt);
    const ratio = totalGap > 0 ? previousDistance / totalGap : 0;
    latitude = previous.latitude + (next.latitude - previous.latitude) * ratio;
    longitude = previous.longitude + (next.longitude - previous.longitude) * ratio;
    timeDistanceMs = Math.min(previousDistance, nextDistance);
  } else {
    const nearest = previousDistance <= nextDistance ? previous : next;
    if (!nearest) return undefined;
    latitude = nearest.latitude;
    longitude = nearest.longitude;
    timeDistanceMs = Math.min(previousDistance, nextDistance);
  }

  const originalCoordinate = event.originalLatitude !== undefined && event.originalLongitude !== undefined
    ? { latitude: event.originalLatitude, longitude: event.originalLongitude }
    : event;
  const distanceFromOriginalMeters = hasCoordinates(originalCoordinate)
    ? distanceMeters(originalCoordinate, { latitude, longitude })
    : undefined;
  return {
    latitude,
    longitude,
    timeDistanceMs,
    ...(distanceFromOriginalMeters !== undefined ? { distanceFromOriginalMeters } : {}),
    ...(previous ? { previousId: previous.event.id } : {}),
    ...(next ? { nextId: next.event.id } : {}),
  };
}

/**
 * Return photo records with display-only coordinates. Only untouched EXIF
 * records are eligible; manual, inferred, removed, and explicitly restored
 * records keep their stored coordinate (or lack of one).
 */
export function displayPhotoEvents(events: LifeEvent[]): LifeEvent[] {
  return displayPhotoEventsWithLocations(events, correctedLocationEvents(events));
}

function displayPhotoEventsWithLocations(events: LifeEvent[], locations: CorrectedLocation[]): LifeEvent[] {
  return events.map((event) => {
    if (event.source !== "photo"
      || event.photoLocationAutoPlacementDisabled === true
      || event.locationSource === "inferred"
      || event.locationSource === "manual"
      || event.locationSource === "removed") return event;
    const suggestion = suggestPhotoLocationFromLocations(event, locations);
    if (!suggestion) return event;
    return {
      ...event,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
      ...(event.originalLatitude === undefined && typeof event.latitude === "number" && typeof event.longitude === "number"
        ? { originalLatitude: event.latitude, originalLongitude: event.longitude }
        : {}),
    };
  });
}

function hasCoordinates(event: Pick<LifeEvent, "latitude" | "longitude">): event is LocatedEvent {
  return typeof event.latitude === "number" && Number.isFinite(event.latitude)
    && typeof event.longitude === "number" && Number.isFinite(event.longitude);
}

function accuracyMeters(event: LocatedEvent): number {
  return Math.max(event.accuracyMeters ?? 30, 10);
}

export function isLikelyLocationOutlier(previous: LocatedEvent, current: LocatedEvent, next: LocatedEvent): boolean {
  const previousGap = timestamp(current.startedAt) - timestamp(previous.startedAt);
  const nextGap = timestamp(next.startedAt) - timestamp(current.startedAt);
  if (previousGap <= 0 || nextGap <= 0 || previousGap > MAX_CORRECTION_GAP_MS || nextGap > MAX_CORRECTION_GAP_MS) return false;

  const distanceToPrevious = distanceMeters(previous, current);
  const distanceToNext = distanceMeters(current, next);
  const distanceBetweenNeighbors = distanceMeters(previous, next);
  const neighborAccuracy = Math.max(accuracyMeters(previous), accuracyMeters(next));
  if (distanceBetweenNeighbors > Math.max(120, neighborAccuracy * 3)) return false;

  const shortestJump = Math.min(distanceToPrevious, distanceToNext);
  const largeJump = shortestJump >= Math.max(MIN_SPIKE_DISTANCE_METERS, accuracyMeters(current) * 4, neighborAccuracy * 8);
  const highSpeed = distanceToPrevious / (previousGap / 1000) > MAX_REASONABLE_SPEED_MPS
    || distanceToNext / (nextGap / 1000) > MAX_REASONABLE_SPEED_MPS;
  const lowConfidence = current.accuracyMeters !== undefined
    && current.accuracyMeters >= 100
    && shortestJump >= Math.max(MIN_SPIKE_DISTANCE_METERS, current.accuracyMeters * 2);
  return largeJump || (highSpeed && shortestJump >= MIN_SPIKE_DISTANCE_METERS) || lowConfidence;
}

export function correctedPositionEvents(events: LifeEvent[]): CorrectedLocation[] {
  const locations = displayPositionEvents(events);
  const corrections = new Map<number, { latitude: number; longitude: number }>();

  // Keep the stricter point-to-point test for very large isolated jumps.
  locations.slice(1, -1).forEach((event, offset) => {
    const index = offset + 1;
    const previous = locations[index - 1];
    const next = locations[index + 1];
    if (!isLikelyLocationOutlier(previous, event, next)) return;
    const totalGap = timestamp(next.startedAt) - timestamp(previous.startedAt);
    const ratio = (timestamp(event.startedAt) - timestamp(previous.startedAt)) / totalGap;
    corrections.set(index, {
      latitude: previous.latitude + (next.latitude - previous.latitude) * ratio,
      longitude: previous.longitude + (next.longitude - previous.longitude) * ratio,
    });
  });

  // A bad fix can be repeated for two samples. Treat a short excursion as a
  // spike only when both sides independently return to one stable cluster.
  for (let start = LOCAL_OUTLIER_WINDOW; start < locations.length - LOCAL_OUTLIER_WINDOW; start += 1) {
    if (corrections.has(start)) continue;
    for (let length = MAX_SPIKE_RUN_SAMPLES; length >= 1; length -= 1) {
      const end = start + length - 1;
      if (end + LOCAL_OUTLIER_WINDOW >= locations.length) continue;
      const anchor = stableLocalAnchor(locations, start, end);
      if (!anchor) continue;
      const run = locations.slice(start, end + 1);
      if (!run.every((event) => distanceMeters(event, anchor) >= spikeThreshold(event))) continue;
      const previous = locations[start - 1];
      const next = locations[end + 1];
      const totalGap = timestamp(next.startedAt) - timestamp(previous.startedAt);
      if (totalGap <= 0) continue;
      run.forEach((event, offset) => {
        const ratio = (timestamp(event.startedAt) - timestamp(previous.startedAt)) / totalGap;
        corrections.set(start + offset, {
          latitude: previous.latitude + (next.latitude - previous.latitude) * ratio,
          longitude: previous.longitude + (next.longitude - previous.longitude) * ratio,
        });
      });
      break;
    }
  }

  // Moving spikes: one or two fixes far off the path between their neighbors.
  for (let start = 1; start < locations.length - 1; start += 1) {
    for (let length = MAX_SPIKE_RUN_SAMPLES; length >= 1; length -= 1) {
      const end = start + length - 1;
      if (end + 1 >= locations.length) continue;
      const run = Array.from({ length }, (_, offset) => start + offset);
      if (run.some((index) => corrections.has(index))) continue;
      const previous = locations[start - 1];
      const next = locations[end + 1];
      const totalGap = timestamp(next.startedAt) - timestamp(previous.startedAt);
      if (totalGap <= 0 || totalGap > MOVING_SPIKE_MAX_SPAN_MS) continue;
      const step = distanceMeters(previous, next);
      const interpolated = run.map((index) => {
        const ratio = (timestamp(locations[index].startedAt) - timestamp(previous.startedAt)) / totalGap;
        return {
          latitude: previous.latitude + (next.latitude - previous.latitude) * ratio,
          longitude: previous.longitude + (next.longitude - previous.longitude) * ratio,
        };
      });
      if (!run.every((index, offset) => distanceMeters(locations[index], interpolated[offset])
        >= Math.max(MIN_MOVING_SPIKE_DISTANCE_METERS, step * 2, (locations[index].accuracyMeters ?? 0) * 4))) continue;
      run.forEach((index, offset) => corrections.set(index, interpolated[offset]));
      break;
    }
  }

  return locations.map((event, index) => {
    const correction = corrections.get(index);
    if (!correction) {
      return { event, latitude: event.latitude, longitude: event.longitude, corrected: false };
    }
    return { event, ...correction, corrected: true };
  });
}

export function correctedLocationEvents(events: LifeEvent[]): CorrectedLocation[] {
  return correctedPositionEvents(events.filter((event) => event.source === "location"));
}

export type PhotoCluster = {
  id: string;
  latitude: number;
  longitude: number;
  photoCount: number;
  videoCount: number;
  events: LocatedEvent[];
};

export type RouteSegment = {
  from: [number, number];
  to: [number, number];
  gapMs: number;
  opacity: number;
};

export type RawRouteSegment = {
  from: [number, number];
  to: [number, number];
};

export type StayCluster = {
  id: string;
  latitude: number;
  longitude: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: CorrectedLocation[];
};

export type TimelineAnalysis = {
  correctedPositions: CorrectedLocation[];
  correctedLocations: CorrectedLocation[];
  stayClusters: StayCluster[];
};

export type TimelineRenderSnapshot = TimelineAnalysis & {
  displayEvents: LifeEvent[];
  photoClusters: PhotoCluster[];
  stayPlaces: StayPlace[];
  activities: TimelineActivity[];
  movementSegments: RouteSegment[];
  mapNodes: [number, number][];
};

/** A recurring place built from one or more stays near the same coordinate. */
export type StayPlace = {
  id: string;
  latitude: number;
  longitude: number;
  visits: StayCluster[];
  visitCount: number;
  totalDurationMs: number;
};

export type TimelineActivity =
  | {
    kind: "stay";
    id: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    latitude: number;
    longitude: number;
    photos: LifeEvent[];
    events: CorrectedLocation[];
  }
  | {
    kind: "movement";
    id: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    photos: LifeEvent[];
    from: [number, number];
    to: [number, number];
    path: [number, number][];
    distanceMeters: number;
  };

export const STAY_CLUSTER_RADIUS_METERS = 80;
// Keep recurring-place grouping close to the stay detector so neighboring
// buildings do not get presented as the same place.
export const STAY_PLACE_RADIUS_METERS = 100;
const MAX_STAY_GAP_MS = 15 * 60 * 1000;
const MIN_STAY_SAMPLES = 3;
const MIN_STAY_DURATION_MS = 5 * 60 * 1000;
// Stationary capture can stop delivering samples for a long time (iOS only
// reports after 50m of movement). A gap that ends where it started is a stay.
const MAX_STAY_BRIDGE_GAP_MS = 12 * 60 * 60 * 1000;
// Any brief departure that returns to the same place is treated as GPS noise.
const MAX_STAY_EXCURSION_MS = 3 * 60 * 1000;
// Longer interruptions are kept inside the stay while they stay nearby.
const STAY_DRIFT_RADIUS_METERS = 200;
// Indoor positioning often flips between two fixes a couple hundred meters
// apart (Wi-Fi vs. GPS). Neighboring stays without a real trip between them
// are one stay; the fixes are not precise enough to tell them apart.
const STAY_MERGE_RADIUS_METERS = 200;
const STAY_MERGE_DRIFT_RADIUS_METERS = 300;
// Between neighboring stays, a few far fixes among nearby ones are noise; a
// real trip spends most of its samples away.
const STAY_MERGE_MAX_FAR_SHARE = 0.3;
// A stay's coordinate is where its samples are densest, so a minority of
// flipped fixes does not pull it between two places.
const STAY_CENTER_RADIUS_METERS = 50;
const STAY_CENTER_CANDIDATES = 64;
// A "stay" whose own samples keep landing back at the neighboring stay never
// really left it: the device was flipping between fixes.
const STAY_FLIP_RADIUS_METERS = 500;
const STAY_FLIP_SHARE = 0.2;
// Revisit history only analyzes days that came near the place.
const STAY_HISTORY_SEARCH_RADIUS_METERS = 1000;

function timestamp(value: string) {
  return new Date(value).getTime();
}

export function distanceMeters(from: Pick<LocatedEvent, "latitude" | "longitude">, to: Pick<LocatedEvent, "latitude" | "longitude">) {
  const earthRadius = 6_371_000;
  const latitudeDelta = (to.latitude - from.latitude) * Math.PI / 180;
  const longitudeDelta = (to.longitude - from.longitude) * Math.PI / 180;
  const fromLatitude = from.latitude * Math.PI / 180;
  const toLatitude = to.latitude * Math.PI / 180;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.sin(longitudeDelta / 2) ** 2 * Math.cos(fromLatitude) * Math.cos(toLatitude);
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function stableLocalAnchor(locations: LocatedEvent[], start: number, end: number): { latitude: number; longitude: number } | undefined {
  if (start < LOCAL_OUTLIER_WINDOW || end + LOCAL_OUTLIER_WINDOW >= locations.length) return undefined;
  const window = locations.slice(start - LOCAL_OUTLIER_WINDOW, end + LOCAL_OUTLIER_WINDOW + 1);
  if (!window.slice(1).every((event, offset) => timestamp(event.startedAt) - timestamp(window[offset].startedAt) > 0
    && timestamp(event.startedAt) - timestamp(window[offset].startedAt) <= MAX_CORRECTION_GAP_MS)) return undefined;
  const anchors = [
    ...locations.slice(start - LOCAL_OUTLIER_WINDOW, start),
    ...locations.slice(end + 1, end + LOCAL_OUTLIER_WINDOW + 1),
  ];
  const anchor = { latitude: median(anchors.map((event) => event.latitude)), longitude: median(anchors.map((event) => event.longitude)) };
  return anchors.every((event) => distanceMeters(event, anchor) <= LOCAL_NEIGHBOR_RADIUS_METERS) ? anchor : undefined;
}

function spikeThreshold(event: LocatedEvent) {
  return Math.max(MIN_LOCAL_SPIKE_DISTANCE_METERS, (event.accuracyMeters ?? 0) * 2);
}

export function clusterPhotoEvents(events: LifeEvent[]): PhotoCluster[] {
  const photos = events
    .filter((event): event is LocatedEvent => event.source === "photo"
      && typeof event.latitude === "number" && Number.isFinite(event.latitude)
      && typeof event.longitude === "number" && Number.isFinite(event.longitude))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const clusters: PhotoCluster[] = [];

  for (const event of photos) {
    const cluster = clusters.find((candidate) => distanceMeters(candidate, event) <= PHOTO_CLUSTER_RADIUS_METERS);
    if (cluster) {
      cluster.events.push(event);
      if (event.mediaType === "video") cluster.videoCount += event.photoCount;
      else cluster.photoCount += event.photoCount;
    } else {
      clusters.push({
        id: `photo-cluster:${event.id}`,
        latitude: event.latitude,
        longitude: event.longitude,
        photoCount: event.mediaType === "video" ? 0 : event.photoCount,
        videoCount: event.mediaType === "video" ? event.photoCount : 0,
        events: [event],
      });
    }
  }
  return clusters;
}

export function routeOpacity(ageMs: number) {
  const ageMinutes = Math.max(0, ageMs) / 60_000;
  return Math.max(0.18, Math.min(0.95, 0.95 - Math.log10(ageMinutes + 1) * 0.18));
}

export function buildRawRouteSegments(events: LifeEvent[]): RawRouteSegment[] {
  const locations = positionEvents(events);
  return locations.slice(1).map((location, index) => {
    const previous = locations[index];
    return {
      from: [previous.latitude, previous.longitude],
      to: [location.latitude, location.longitude],
    };
  });
}

/** Keeps values sorted so the upper median matches `median` without re-sorting. */
class SortedValues {
  private values: number[] = [];

  add(value: number) {
    let low = 0;
    let high = this.values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.values[middle] <= value) low = middle + 1;
      else high = middle;
    }
    this.values.splice(low, 0, value);
  }

  median() {
    return this.values[this.values.length >> 1];
  }
}

/** The per-axis median of a growing set of locations. */
class MedianCenter {
  private latitudes = new SortedValues();
  private longitudes = new SortedValues();

  constructor(locations: CorrectedLocation[] = []) {
    this.addAll(locations);
  }

  addAll(locations: CorrectedLocation[]) {
    locations.forEach((location) => {
      this.latitudes.add(location.latitude);
      this.longitudes.add(location.longitude);
    });
  }

  get value() {
    return { latitude: this.latitudes.median(), longitude: this.longitudes.median() };
  }
}

function locationCenter(locations: CorrectedLocation[]) {
  return {
    latitude: median(locations.map((item) => item.latitude)),
    longitude: median(locations.map((item) => item.longitude)),
  };
}

/** Indoor fixes wander as far as their reported accuracy, so allow that much. */
function stayRadiusMeters(location: CorrectedLocation) {
  return Math.max(STAY_CLUSTER_RADIUS_METERS, Math.min(location.event.accuracyMeters ?? 0, MAX_DISPLAY_ACCURACY_METERS));
}

function runDurationMs(run: CorrectedLocation[]) {
  return timestamp(run[run.length - 1].event.startedAt) - timestamp(run[0].event.startedAt);
}

function isStayRun(run: CorrectedLocation[]) {
  return run.length >= MIN_STAY_SAMPLES && runDurationMs(run) >= MIN_STAY_DURATION_MS;
}

/** Split samples into maximal runs whose points stay close to each other. */
function nearbyRuns(locations: CorrectedLocation[]): CorrectedLocation[][] {
  const runs: CorrectedLocation[][] = [];
  let current: CorrectedLocation[] = [];
  let center = new MedianCenter();
  locations.forEach((location) => {
    const previous = current[current.length - 1];
    if (previous) {
      const gapMs = timestamp(location.event.startedAt) - timestamp(previous.event.startedAt);
      const radius = stayRadiusMeters(location);
      const nearby = distanceMeters(previous, location) <= radius
        && distanceMeters(center.value, location) <= radius;
      if (gapMs >= 0 && gapMs <= MAX_STAY_GAP_MS && nearby) {
        current.push(location);
        center.addAll([location]);
        return;
      }
      runs.push(current);
    }
    current = [location];
    center = new MedianCenter(current);
  });
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Whether the samples between two runs at the same place are noise rather
 * than a real departure: a plain data gap, a brief excursion, or a short
 * drift that never went far.
 */
function isStayInterruption(before: CorrectedLocation, after: CorrectedLocation, between: CorrectedLocation[], center: { latitude: number; longitude: number }) {
  const gapMs = timestamp(after.event.startedAt) - timestamp(before.event.startedAt);
  if (gapMs > MAX_STAY_BRIDGE_GAP_MS) return false;
  return gapMs <= MAX_STAY_EXCURSION_MS || between.every((location) => distanceMeters(center, location) <= STAY_DRIFT_RADIUS_METERS);
}

/**
 * The looser test between two detected stays: mostly nearby fixes, or fixes
 * that keep flipping back to the place, are noise rather than a trip.
 */
function isNoiseBetweenStays(before: CorrectedLocation, after: CorrectedLocation, between: CorrectedLocation[], center: { latitude: number; longitude: number }) {
  if (isStayInterruption(before, after, between, center)) return true;
  if (timestamp(after.event.startedAt) - timestamp(before.event.startedAt) > MAX_STAY_BRIDGE_GAP_MS) return false;
  const far = between.filter((location) => distanceMeters(center, location) > STAY_MERGE_DRIFT_RADIUS_METERS).length;
  return far <= Math.floor(between.length * STAY_MERGE_MAX_FAR_SHARE) || returningShare(between, center) >= STAY_FLIP_SHARE;
}

/** The median of the samples around the densest sample. */
function stayCenter(locations: CorrectedLocation[]) {
  const step = Math.max(1, Math.floor(locations.length / STAY_CENTER_CANDIDATES));
  let densest = locations[0];
  let densestCount = -1;
  for (let index = 0; index < locations.length; index += step) {
    const candidate = locations[index];
    const count = locations.reduce((total, location) => total + (distanceMeters(candidate, location) <= STAY_CENTER_RADIUS_METERS ? 1 : 0), 0);
    if (count > densestCount) {
      densest = candidate;
      densestCount = count;
    }
  }
  return locationCenter(locations.filter((location) => distanceMeters(densest, location) <= STAY_CENTER_RADIUS_METERS));
}

type StaySpan = { core: CorrectedLocation[]; start: number; end: number };

/** Whether `stay` keeps returning to `center` while it records fixes elsewhere. */
function isFlippedStay(stay: StaySpan, center: { latitude: number; longitude: number }, locations: CorrectedLocation[]) {
  return returningShare(locations.slice(stay.start, stay.end + 1), center) >= STAY_FLIP_SHARE;
}

/** Share of samples recorded at `center`. */
function returningShare(samples: CorrectedLocation[], center: { latitude: number; longitude: number }) {
  if (!samples.length) return 0;
  // Spike correction moves an isolated returning fix onto its neighbors, so
  // count the recorded coordinates here.
  const returning = samples.filter((location) => distanceMeters(center, location.event) <= STAY_CLUSTER_RADIUS_METERS).length;
  return returning / samples.length;
}

/** Join neighboring stays that have no real trip between them. */
function mergeNearbyStays(stays: StaySpan[], locations: CorrectedLocation[]): StaySpan[] {
  const merged: StaySpan[] = [];
  let center: { latitude: number; longitude: number } | undefined;
  for (const stay of stays) {
    const previous = merged[merged.length - 1];
    if (previous && center) {
      const between = locations.slice(previous.end + 1, stay.start);
      const stayCenterValue = stayCenter(stay.core);
      const distance = distanceMeters(center, stayCenterValue);
      const sameStay = distance <= STAY_MERGE_RADIUS_METERS
        || (distance <= STAY_FLIP_RADIUS_METERS
          && (isFlippedStay(stay, center, locations) || isFlippedStay(previous, stayCenterValue, locations)));
      if (sameStay && isNoiseBetweenStays(locations[previous.end], locations[stay.start], between, center)) {
        previous.core.push(...stay.core);
        previous.end = stay.end;
        center = stayCenter(previous.core);
        continue;
      }
    }
    merged.push({ ...stay, core: [...stay.core] });
    center = stayCenter(stay.core);
  }
  return merged;
}

function correctedStayClusters(locations: CorrectedLocation[]): StayCluster[] {
  const runs = nearbyRuns(locations);
  const runCenters = runs.map(locationCenter);
  const runStarts: number[] = [];
  runs.reduce((start, run) => { runStarts.push(start); return start + run.length; }, 0);
  const stays: StaySpan[] = [];

  for (let index = 0; index < runs.length;) {
    // `core` holds the samples at the place; the span also covers the noisy
    // samples in between so they are hidden from the movement line.
    const core = [...runs[index]];
    const start = runStarts[index];
    let end = start + runs[index].length - 1;
    index += 1;
    const coreCenter = new MedianCenter(core);
    let center = coreCenter.value;
    for (let next = index, between: CorrectedLocation[] = []; next < runs.length; next += 1) {
      const run = runs[next];
      const last = core[core.length - 1];
      if (distanceMeters(center, runCenters[next]) <= STAY_CLUSTER_RADIUS_METERS) {
        if (!isStayInterruption(last, run[0], between, center)) break;
        core.push(...run);
        end = runStarts[next] + run.length - 1;
        coreCenter.addAll(run);
        center = coreCenter.value;
        between = [];
        index = next + 1;
        continue;
      }
      // Another stay, or a departure that can no longer count as an interruption.
      if (isStayRun(run)) break;
      between.push(...run);
      const elapsedMs = timestamp(run[run.length - 1].event.startedAt) - timestamp(last.event.startedAt);
      if (elapsedMs > MAX_STAY_BRIDGE_GAP_MS
        || (elapsedMs > MAX_STAY_EXCURSION_MS && run.some((location) => distanceMeters(center, location) > STAY_DRIFT_RADIUS_METERS))) break;
    }
    if (isStayRun(core)) stays.push({ core, start, end });
  }

  return mergeNearbyStays(stays, locations).map(({ core, start, end }, index) => {
    const events = locations.slice(start, end + 1);
    const startedAt = events[0].event.startedAt;
    const endedAt = events[events.length - 1].event.startedAt;
    return {
      id: `stay:${startedAt}:${index}`,
      ...stayCenter(core),
      startedAt,
      endedAt,
      durationMs: Math.max(0, timestamp(endedAt) - timestamp(startedAt)),
      events,
    };
  });
}

export function buildStayClusters(events: LifeEvent[], analysis?: TimelineAnalysis): StayCluster[] {
  // Stay detection intentionally uses quality-filtered, corrected locations;
  // raw coordinate records are never used for stay detection.
  return analysis?.stayClusters ?? correctedStayClusters(correctedPositionEvents(events));
}

function stayPlaceCoordinate(visits: StayCluster[]): { latitude: number; longitude: number } {
  return {
    latitude: median(visits.map((visit) => visit.latitude)),
    longitude: median(visits.map((visit) => visit.longitude)),
  };
}

/**
 * Group separate stay intervals into recurring places. This is display-only:
 * the original location records and the per-day stay intervals are preserved.
 */
export function buildStayPlaces(events: LifeEvent[], analysis?: TimelineAnalysis): StayPlace[] {
  const places: StayPlace[] = [];
  for (const stay of analysis?.stayClusters ?? buildStayClusters(events)) {
    const nearest = places
      .map((place, index) => ({ index, distance: distanceMeters(place, stay) }))
      .sort((first, second) => first.distance - second.distance)[0];
    if (nearest && nearest.distance <= STAY_PLACE_RADIUS_METERS) {
      const place = places[nearest.index];
      const visits = [...place.visits, stay];
      const coordinate = stayPlaceCoordinate(visits);
      places[nearest.index] = {
        ...place,
        ...coordinate,
        visits,
        visitCount: visits.length,
        totalDurationMs: visits.reduce((total, visit) => total + visit.durationMs, 0),
      };
    } else {
      places.push({
        id: `stay-place:${stay.id}`,
        latitude: stay.latitude,
        longitude: stay.longitude,
        visits: [stay],
        visitCount: 1,
        totalDurationMs: stay.durationMs,
      });
    }
  }
  return places.sort((first, second) => second.visitCount - first.visitCount
    || second.visits.at(-1)!.startedAt.localeCompare(first.visits.at(-1)!.startedAt));
}

/** The part of a stay that the visit history shows. */
export type StayVisit = Pick<StayCluster, "id" | "latitude" | "longitude" | "startedAt" | "endedAt" | "durationMs">;

/** Every stay near one place across all recorded days, newest first. */
export type StayVisitHistory = {
  visits: StayVisit[];
  dayCount: number;
  totalDurationMs: number;
};

/**
 * Collect revisits to the place at [target]. Stays are detected per day,
 * exactly like the day timeline, so every visit matches what that day shows.
 */
export function buildStayVisitHistory(events: LifeEvent[], target: { latitude: number; longitude: number }): StayVisitHistory {
  const days = new Map<string, LifeEvent[]>();
  const nearbyDays = new Set<string>();
  events.forEach((event) => {
    const day = dateKey(event.startedAt);
    const dayEvents = days.get(day);
    if (dayEvents) dayEvents.push(event);
    else days.set(day, [event]);
    if (hasCoordinates(event) && distanceMeters(event, target) <= STAY_HISTORY_SEARCH_RADIUS_METERS) nearbyDays.add(day);
  });
  const visits = [...nearbyDays]
    .flatMap((day) => buildStayClusters(days.get(day) ?? []))
    .filter((stay) => distanceMeters(stay, target) <= STAY_PLACE_RADIUS_METERS)
    .sort((first, second) => second.startedAt.localeCompare(first.startedAt));
  return {
    visits,
    dayCount: new Set(visits.map((visit) => dateKey(visit.startedAt))).size,
    totalDurationMs: visits.reduce((total, visit) => total + visit.durationMs, 0),
  };
}

type TimelineNode =
  | { kind: "stay"; activity: Omit<Extract<TimelineActivity, { kind: "stay" }>, "photos"> }
  | { kind: "location"; startedAt: string; latitude: number; longitude: number };

/**
 * Build the high-level intervals shown in the map sheet. A stay is kept as
 * one interval, while the gaps between stays and location samples become
 * movement intervals. Photos are assigned by capture time, with stay taking
 * precedence at an exact boundary.
 */
export function buildTimelineActivities(events: LifeEvent[], analysis?: TimelineAnalysis): TimelineActivity[] {
  const resolvedAnalysis = analysis ?? analyzeTimeline(events);
  const stays = resolvedAnalysis.stayClusters;
  const stayEventIDs = new Set(stays.flatMap((stay) => stay.events.map((location) => location.event.id)));
  const nodes: TimelineNode[] = [
    ...stays.map((stay) => ({
      kind: "stay" as const,
      activity: {
        kind: "stay" as const,
        id: stay.id,
        startedAt: stay.startedAt,
        endedAt: stay.endedAt,
        durationMs: stay.durationMs,
        latitude: stay.latitude,
        longitude: stay.longitude,
        events: stay.events,
      },
    })),
    ...resolvedAnalysis.correctedLocations
      .filter((location) => !stayEventIDs.has(location.event.id))
      .map((location) => ({
        kind: "location" as const,
        startedAt: location.event.startedAt,
        latitude: location.latitude,
        longitude: location.longitude,
      })),
  ].sort((a, b) => {
    const startedAt = a.kind === "stay" ? a.activity.startedAt : a.startedAt;
    const otherStartedAt = b.kind === "stay" ? b.activity.startedAt : b.startedAt;
    return startedAt.localeCompare(otherStartedAt) || (a.kind === "stay" ? -1 : 1);
  });

  const activities: TimelineActivity[] = [];
  nodes.forEach((node, index) => {
    const previous = nodes[index - 1];
    if (previous) {
      const previousEndedAt = previous.kind === "stay" ? previous.activity.endedAt : previous.startedAt;
      const currentStartedAt = node.kind === "stay" ? node.activity.startedAt : node.startedAt;
      const previousLatitude = previous.kind === "stay" ? previous.activity.latitude : previous.latitude;
      const previousLongitude = previous.kind === "stay" ? previous.activity.longitude : previous.longitude;
      const currentLatitude = node.kind === "stay" ? node.activity.latitude : node.latitude;
      const currentLongitude = node.kind === "stay" ? node.activity.longitude : node.longitude;
      const startedAtMs = timestamp(previousEndedAt);
      const endedAtMs = timestamp(currentStartedAt);
      if (Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs > startedAtMs) {
        const movement: Extract<TimelineActivity, { kind: "movement" }> = {
          kind: "movement",
          id: `movement:${previousEndedAt}:${currentStartedAt}:${index}`,
          startedAt: previousEndedAt,
          endedAt: currentStartedAt,
          durationMs: endedAtMs - startedAtMs,
          photos: [],
          from: [previousLatitude, previousLongitude],
          to: [currentLatitude, currentLongitude],
          path: [[previousLatitude, previousLongitude], [currentLatitude, currentLongitude]],
          distanceMeters: distanceMeters(
            { latitude: previousLatitude, longitude: previousLongitude },
            { latitude: currentLatitude, longitude: currentLongitude },
          ),
        };
        const previousActivity = activities.at(-1);
        if (previousActivity?.kind === "movement" && previousActivity.endedAt === movement.startedAt) {
          activities[activities.length - 1] = {
            ...previousActivity,
            endedAt: movement.endedAt,
            durationMs: previousActivity.durationMs + movement.durationMs,
            to: movement.to,
            path: [...previousActivity.path, ...movement.path.slice(1)],
            distanceMeters: previousActivity.distanceMeters + movement.distanceMeters,
          };
        } else {
          activities.push(movement);
        }
      }
    }
    if (node.kind === "stay") activities.push({ ...node.activity, photos: [] });
  });

  // Location samples that fall inside a stay's time range but not in the stay
  // (spikes, points outside its radius) start a movement that overlaps the
  // stay, so boundaries do not always meet exactly. After ordering, any two
  // movements that end up next to each other are one movement in the sheet.
  activities.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const merged = mergeAdjacentMovements(activities);

  const photos = events.filter((event) => event.source === "photo").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  photos.forEach((photo) => {
    const photoTime = timestamp(photo.startedAt);
    if (!Number.isFinite(photoTime)) return;
    const stay = merged.find((activity) => activity.kind === "stay"
      && photoTime >= timestamp(activity.startedAt)
      && photoTime <= timestamp(activity.endedAt));
    const movement = stay ? undefined : merged.find((activity) => activity.kind === "movement"
      && photoTime >= timestamp(activity.startedAt)
      && photoTime <= timestamp(activity.endedAt));
    const activity = stay ?? movement;
    if (!activity) return;
    activity.photos.push(photo);
  });

  return merged;
}

/** Joins movements that are adjacent in time order into one movement. */
export function mergeAdjacentMovements(activities: TimelineActivity[]): TimelineActivity[] {
  const result: TimelineActivity[] = [];
  for (const activity of activities) {
    const previous = result.at(-1);
    if (previous?.kind === "movement" && activity.kind === "movement") {
      const endedAt = activity.endedAt > previous.endedAt ? activity.endedAt : previous.endedAt;
      result[result.length - 1] = {
        ...previous,
        endedAt,
        durationMs: Math.max(0, timestamp(endedAt) - timestamp(previous.startedAt)),
        to: activity.endedAt > previous.endedAt ? activity.to : previous.to,
        path: [...previous.path, ...activity.path.slice(1)],
        distanceMeters: previous.distanceMeters + activity.distanceMeters,
        photos: [...previous.photos, ...activity.photos],
      };
    } else {
      result.push(activity);
    }
  }
  return result;
}

/** Geographic stay circle radius in meters, shared with Android's stayCircleRadiusMeters. */
export function stayCircleRadiusMeters(durationMs: number) {
  const minutes = Math.max(0, durationMs) / 60_000;
  return Math.min(75, 20 + Math.sqrt(minutes) * 6);
}

export function buildMovementSegments(events: LifeEvent[], referenceTimeMs = Date.now(), analysis?: TimelineAnalysis): RouteSegment[] {
  const resolvedAnalysis = analysis ?? analyzeTimeline(events);
  const locations = resolvedAnalysis.correctedPositions;
  const stayClusters = resolvedAnalysis.stayClusters;
  const stayEventIds = new Set(stayClusters.flatMap((stay) => stay.events.map((location) => location.event.id)));
  const stayEndEventIds = new Set(stayClusters.map((stay) => stay.events[stay.events.length - 1]?.event.id).filter((id): id is string => id !== undefined));
  // Stationary samples are represented by the stay circle. Keep one
  // processed endpoint per stay so the movement line remains continuous
  // when the samples inside that stay are omitted.
  const routeLocations = locations.filter((location) => !stayEventIds.has(location.event.id) || stayEndEventIds.has(location.event.id));

  return routeLocations.slice(1).flatMap((location, index) => {
    const previous = routeLocations[index];
    const gapMs = Math.max(0, timestamp(location.event.startedAt) - timestamp(previous.event.startedAt));
    return [{
      from: [previous.latitude, previous.longitude],
      to: [location.latitude, location.longitude],
      gapMs,
      opacity: routeOpacity(Math.max(0, referenceTimeMs - timestamp(location.event.startedAt))),
    }];
  });
}

export function buildRouteSegments(events: LifeEvent[], referenceTimeMs = Date.now()): RouteSegment[] {
  return buildMovementSegments(events, referenceTimeMs);
}

function suggestPhotoLocationFromLocations(event: LifeEvent, locations: CorrectedLocation[]): PhotoLocationSuggestion | undefined {
  if (event.source !== "photo") return undefined;
  const photoTime = timestamp(event.startedAt);
  const nextIndex = locations.findIndex((location) => timestamp(location.event.startedAt) >= photoTime);
  const previous = nextIndex < 0 ? locations.at(-1) : nextIndex === 0 ? undefined : locations[nextIndex - 1];
  const next = nextIndex < 0 ? undefined : locations[nextIndex];
  const previousDistance = previous ? photoTime - timestamp(previous.event.startedAt) : Number.POSITIVE_INFINITY;
  const nextDistance = next ? timestamp(next.event.startedAt) - photoTime : Number.POSITIVE_INFINITY;
  if (previousDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS && nextDistance > PHOTO_LOCATION_SUGGESTION_WINDOW_MS) return undefined;
  if (previous && next && previous.event.id !== next.event.id && previousDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS && nextDistance <= PHOTO_LOCATION_SUGGESTION_WINDOW_MS) {
    const ratio = (timestamp(next.event.startedAt) - timestamp(previous.event.startedAt)) > 0
      ? previousDistance / (timestamp(next.event.startedAt) - timestamp(previous.event.startedAt)) : 0;
    return { latitude: previous.latitude + (next.latitude - previous.latitude) * ratio, longitude: previous.longitude + (next.longitude - previous.longitude) * ratio, timeDistanceMs: Math.min(previousDistance, nextDistance), previousId: previous.event.id, nextId: next.event.id };
  }
  const nearest = previousDistance <= nextDistance ? previous : next;
  if (!nearest) return undefined;
  return { latitude: nearest.latitude, longitude: nearest.longitude, timeDistanceMs: Math.min(previousDistance, nextDistance), previousId: previous?.event.id, nextId: next?.event.id };
}

function analyzeTimeline(events: LifeEvent[]): TimelineAnalysis {
  const correctedPositions = correctedPositionEvents(events);
  return {
    correctedPositions,
    correctedLocations: correctedPositions.filter((location) => location.event.source === "location"),
    stayClusters: correctedStayClusters(correctedPositions),
  };
}

export function buildTimelineSnapshot(events: LifeEvent[], referenceTimeMs = Date.now()): TimelineRenderSnapshot {
  const analysis = analyzeTimeline(events);
  const displayEvents = displayPhotoEventsWithLocations(events, analysis.correctedLocations);
  const photoClusters = clusterPhotoEvents(displayEvents);
  const stayPlaces = buildStayPlaces(events, analysis);
  const activities = buildTimelineActivities(displayEvents, analysis);
  const movementSegments = buildMovementSegments(events, referenceTimeMs, analysis);
  const mapNodes: [number, number][] = [
    ...analysis.correctedLocations.map((location) => [location.latitude, location.longitude] as [number, number]),
    ...analysis.stayClusters.map((stay) => [stay.latitude, stay.longitude] as [number, number]),
    ...photoClusters.map((cluster) => [cluster.latitude, cluster.longitude] as [number, number]),
  ];
  return { ...analysis, displayEvents, photoClusters, stayPlaces, activities, movementSegments, mapNodes };
}

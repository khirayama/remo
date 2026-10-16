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
// A coarse fix (cell tower / Wi-Fi) between two clearly better fixes adds
// nothing but error: its position is taken from the better fixes around it.
const COARSE_FIX_MIN_ACCURACY_METERS = 50;
const COARSE_FIX_NEIGHBOR_WINDOW_MS = 45 * 1000;
// Positioning can flip to a second source that reports a place the device
// left a moment ago, with a confident accuracy. The jump there is far faster
// than the device was actually travelling.
const MIN_SPEED_SPIKE_DISTANCE_METERS = 60;
const SPEED_SPIKE_RATIO = 3;
const SPEED_SPIKE_MARGIN_MPS = 3;
// On foot the same flip lands only a few dozen meters away, every half minute
// or so: one fix behind the fix before it or beyond the fix after it, where
// walking on would not have taken the device. Coarse fixes are left to the
// rules above; indoors they are often the correct ones.
const WALKING_SPIKE_MAX_SPEED_MPS = 3;
const MIN_WALKING_SPIKE_DISTANCE_METERS = 30;
const WALKING_SPIKE_RATIO = 2;
const WALKING_SPIKE_MARGIN_MPS = 1.5;

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

  const times = locations.map((event) => timestamp(event.startedAt));
  const position = (index: number) => corrections.get(index) ?? locations[index];
  const interpolate = (index: number, before: number, after: number) => {
    const from = position(before);
    const to = position(after);
    const ratio = (times[index] - times[before]) / (times[after] - times[before]);
    return {
      latitude: from.latitude + (to.latitude - from.latitude) * ratio,
      longitude: from.longitude + (to.longitude - from.longitude) * ratio,
    };
  };

  // Speed spikes: one or two fixes reached at a speed the surrounding path
  // rules out. Runs in order, so each fix is judged from an already cleaned
  // predecessor and a real fix is not blamed for the bad one before it. A
  // single fix is tried first: taking two at once would trust the fix after
  // them, which is the bad one when a real fix sits between two spikes.
  for (let start = 1; start < locations.length - 1; start += 1) {
    if (corrections.has(start)) continue;
    for (let length = 1; length <= MAX_SPIKE_RUN_SAMPLES; length += 1) {
      const end = start + length - 1;
      const next = end + 1;
      if (next >= locations.length || (length > 1 && corrections.has(end))) continue;
      const previous = start - 1;
      const totalGap = times[next] - times[previous];
      const entryGap = times[start] - times[previous];
      if (entryGap <= 0 || totalGap <= 0 || totalGap > MOVING_SPIKE_MAX_SPAN_MS) continue;
      const bypassSpeed = distanceMeters(position(previous), position(next)) / (totalGap / 1000);
      const entrySpeed = distanceMeters(position(previous), locations[start]) / (entryGap / 1000);
      if (entrySpeed < Math.max(bypassSpeed * SPEED_SPIKE_RATIO, bypassSpeed + SPEED_SPIKE_MARGIN_MPS)) continue;
      const run = Array.from({ length }, (_, offset) => start + offset);
      const interpolated = run.map((index) => interpolate(index, previous, next));
      if (!run.every((index, offset) => distanceMeters(locations[index], interpolated[offset])
        >= Math.max(MIN_SPEED_SPIKE_DISTANCE_METERS, (locations[index].accuracyMeters ?? 0) * 2))) continue;
      run.forEach((index, offset) => corrections.set(index, interpolated[offset]));
      break;
    }
  }

  // A bad fix can be repeated for two samples. Treat a short excursion as a
  // spike only when both sides independently return to one stable cluster.
  for (let start = LOCAL_OUTLIER_WINDOW; start < locations.length - LOCAL_OUTLIER_WINDOW; start += 1) {
    if (corrections.has(start)) continue;
    for (let length = MAX_SPIKE_RUN_SAMPLES; length >= 1; length -= 1) {
      const end = start + length - 1;
      if (end + LOCAL_OUTLIER_WINDOW >= locations.length) continue;
      const anchor = stableLocalAnchor(locations, start, end, position);
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

  // Coarse fixes: replaced by the clearly better fixes right before and after.
  for (let index = 1; index < locations.length - 1; index += 1) {
    const accuracy = locations[index].accuracyMeters;
    if (accuracy === undefined || accuracy < COARSE_FIX_MIN_ACCURACY_METERS || corrections.has(index)) continue;
    const isBetter = (other: number) => (locations[other].accuracyMeters ?? 30) <= accuracy / 2;
    let before = index - 1;
    while (before >= 0 && times[index] - times[before] <= COARSE_FIX_NEIGHBOR_WINDOW_MS && !isBetter(before)) before -= 1;
    let after = index + 1;
    while (after < locations.length && times[after] - times[index] <= COARSE_FIX_NEIGHBOR_WINDOW_MS && !isBetter(after)) after += 1;
    if (before < 0 || after >= locations.length) continue;
    if (times[index] - times[before] > COARSE_FIX_NEIGHBOR_WINDOW_MS || times[after] - times[index] > COARSE_FIX_NEIGHBOR_WINDOW_MS) continue;
    if (times[after] <= times[before]) continue;
    corrections.set(index, interpolate(index, before, after));
  }

  // Walking spikes: runs last, so the fixes the rules above settled stay as they are.
  for (let index = 1; index < locations.length - 1; index += 1) {
    const accuracy = locations[index].accuracyMeters ?? 0;
    if (corrections.has(index) || accuracy >= COARSE_FIX_MIN_ACCURACY_METERS) continue;
    const totalGap = times[index + 1] - times[index - 1];
    const entryGap = times[index] - times[index - 1];
    if (entryGap <= 0 || totalGap <= entryGap || totalGap > MOVING_SPIKE_MAX_SPAN_MS) continue;
    const bypass = distanceMeters(position(index - 1), position(index + 1));
    const bypassSpeed = bypass / (totalGap / 1000);
    if (bypassSpeed > WALKING_SPIKE_MAX_SPEED_MPS) continue;
    const out = distanceMeters(position(index - 1), locations[index]);
    const back = distanceMeters(locations[index], position(index + 1));
    if (out * out + bypass * bypass >= back * back && back * back + bypass * bypass >= out * out) continue;
    if (out / (entryGap / 1000) < Math.max(bypassSpeed * WALKING_SPIKE_RATIO, bypassSpeed + WALKING_SPIKE_MARGIN_MPS)) continue;
    const interpolated = interpolate(index, index - 1, index + 1);
    if (distanceMeters(locations[index], interpolated) < Math.max(MIN_WALKING_SPIKE_DISTANCE_METERS, accuracy)) continue;
    corrections.set(index, interpolated);
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
  /** The line's opacity at `to`; `startOpacity` is its opacity at `from`. */
  opacity: number;
  startOpacity: number;
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
    /** Time inside this movement during which nothing was recorded. */
    untrackedMs: number;
  };

// Walks are drawn through the weighted average of five fixes. Ten seconds
// apart, the fixes of seven recorded walks turned by more than 60 degrees at a
// quarter to half of them and made the line 17 to 43% longer than its average.
const WALK_SMOOTHING_REACH = 2;
const WALK_SMOOTHING_MAX_GAP_MS = 30 * 1000;
const WALK_SMOOTHING_MAX_SPEED_MPS = 3;
const WALK_SMOOTHING_MIN_ACCURACY_METERS = 5;
const WALK_SMOOTHING_DEFAULT_ACCURACY_METERS = 20;
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
// A walk that turns around within the cluster radius is not a stay: 30m or
// more of headway (the fixes' own error at least) over 45 seconds to 2 minutes,
// in 70% of the fixes. In 85 recorded stays the share reached 65% once and
// stayed under 55% otherwise; the two walks taken for stays had 78% and 100%.
const STAY_HEADWAY_MIN_WINDOW_MS = 45 * 1000;
const STAY_HEADWAY_MAX_WINDOW_MS = 2 * 60 * 1000;
const STAY_HEADWAY_METERS = 30;
const STAY_HEADWAY_MAX_SHARE = 0.7;
const STAY_HEADWAY_MIN_WINDOWS = 8;
// A "stay" whose own samples keep landing back at the neighboring stay never
// really left it: the device was flipping between fixes.
const STAY_FLIP_RADIUS_METERS = 500;
const STAY_FLIP_SHARE = 0.2;
// The noise rules above exist for indoor fixes. A run of confident fixes
// that stays away from the place is the device actually leaving it.
const DEPARTURE_MAX_ACCURACY_METERS = 30;
const DEPARTURE_MIN_SAMPLES = 6;
const DEPARTURE_MIN_DURATION_MS = 2 * 60 * 1000;
// The detector takes in samples as far as its radius, so a stay would begin
// while the device is still walking up to the place and end after it left.
// Samples at either edge that are away from the final coordinate are movement.
const STAY_EDGE_RADIUS_METERS = 50;
const MAX_STAY_EDGE_TRIM_MS = 3 * 60 * 1000;
// A movement with no sample for this long was not recorded during that time.
export const UNTRACKED_GAP_MS = 10 * 60 * 1000;
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

function stableLocalAnchor(
  locations: LocatedEvent[],
  start: number,
  end: number,
  position: (index: number) => { latitude: number; longitude: number },
): { latitude: number; longitude: number } | undefined {
  if (start < LOCAL_OUTLIER_WINDOW || end + LOCAL_OUTLIER_WINDOW >= locations.length) return undefined;
  const window = locations.slice(start - LOCAL_OUTLIER_WINDOW, end + LOCAL_OUTLIER_WINDOW + 1);
  if (!window.slice(1).every((event, offset) => timestamp(event.startedAt) - timestamp(window[offset].startedAt) > 0
    && timestamp(event.startedAt) - timestamp(window[offset].startedAt) <= MAX_CORRECTION_GAP_MS)) return undefined;
  // Neighbors that are spikes themselves count where they were corrected to.
  const anchors = [
    ...Array.from({ length: LOCAL_OUTLIER_WINDOW }, (_, offset) => position(start - LOCAL_OUTLIER_WINDOW + offset)),
    ...Array.from({ length: LOCAL_OUTLIER_WINDOW }, (_, offset) => position(end + 1 + offset)),
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

const ROUTE_START_OPACITY = 0.25;
const ROUTE_END_OPACITY = 0.95;

/**
 * The day's route fades in from its first point to its last, measured along
 * the drawn line, so every day uses the full range and the line reads as
 * going from faint to strong.
 */
export function routeOpacity(travelledMeters: number, totalMeters: number) {
  if (totalMeters <= 0) return ROUTE_END_OPACITY;
  const progress = Math.min(1, Math.max(0, travelledMeters / totalMeters));
  return ROUTE_START_OPACITY + (ROUTE_END_OPACITY - ROUTE_START_OPACITY) * progress;
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
  if (gapMs <= MAX_STAY_EXCURSION_MS) return true;
  return between.every((location) => distanceMeters(center, location) <= STAY_DRIFT_RADIUS_METERS) && !isConfidentDeparture(between, center);
}

/**
 * Whether `samples` hold a sustained run of accurate fixes away from
 * `center`. Indoor flips come back between fixes or report a coarse accuracy.
 */
function isConfidentDeparture(samples: CorrectedLocation[], center: { latitude: number; longitude: number }) {
  let count = 0;
  let startedAt = 0;
  for (const location of samples) {
    const distance = distanceMeters(center, location);
    if (distance <= STAY_CLUSTER_RADIUS_METERS) {
      count = 0;
      continue;
    }
    const accuracy = location.event.accuracyMeters;
    if (accuracy === undefined || accuracy > DEPARTURE_MAX_ACCURACY_METERS || distance <= STAY_CLUSTER_RADIUS_METERS + accuracy) continue;
    const time = timestamp(location.event.startedAt);
    if (count === 0) startedAt = time;
    count += 1;
    if (count >= DEPARTURE_MIN_SAMPLES && time - startedAt >= DEPARTURE_MIN_DURATION_MS) return true;
  }
  return false;
}

/**
 * The looser test between two detected stays: mostly nearby fixes, or fixes
 * that keep flipping back to the place, are noise rather than a trip.
 */
function isNoiseBetweenStays(before: CorrectedLocation, after: CorrectedLocation, between: CorrectedLocation[], center: { latitude: number; longitude: number }) {
  if (isStayInterruption(before, after, between, center)) return true;
  if (timestamp(after.event.startedAt) - timestamp(before.event.startedAt) > MAX_STAY_BRIDGE_GAP_MS) return false;
  if (isConfidentDeparture(between, center)) return false;
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

/**
 * Whether the samples stop somewhere. Walking a short way out and back keeps
 * every fix within the cluster radius too, but the fixes keep making headway:
 * most of them are a walk away from the fix taken a minute earlier. Someone
 * who stays moves about now and then, and a jumping fix moves back.
 */
function isSettled(core: CorrectedLocation[]) {
  let windows = 0;
  let moving = 0;
  for (let from = 0, to = 0; from < core.length; from += 1) {
    const time = timestamp(core[from].event.startedAt);
    while (to < core.length && timestamp(core[to].event.startedAt) - time < STAY_HEADWAY_MIN_WINDOW_MS) to += 1;
    if (to >= core.length) break;
    if (timestamp(core[to].event.startedAt) - time > STAY_HEADWAY_MAX_WINDOW_MS) continue;
    windows += 1;
    const error = (core[from].event.accuracyMeters ?? 0) + (core[to].event.accuracyMeters ?? 0);
    if (distanceMeters(core[from], core[to]) >= Math.max(STAY_HEADWAY_METERS, error)) moving += 1;
  }
  return windows < STAY_HEADWAY_MIN_WINDOWS || moving < windows * STAY_HEADWAY_MAX_SHARE;
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
      // Accurate fixes that stay away are a second place nearby, not a flip.
      const separatePlace = isConfidentDeparture(locations.slice(stay.start, stay.end + 1), center);
      if (sameStay && !separatePlace && isNoiseBetweenStays(locations[previous.end], locations[stay.start], between, center)) {
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

/** Drop the approach and the departure from the ends of a stay. */
function trimStayEdges(stay: StaySpan, center: { latitude: number; longitude: number }, locations: CorrectedLocation[]) {
  const isAway = (index: number) => distanceMeters(center, locations[index])
    > Math.max(STAY_EDGE_RADIUS_METERS, Math.min(locations[index].event.accuracyMeters ?? 0, MAX_DISPLAY_ACCURACY_METERS));
  const time = (index: number) => timestamp(locations[index].event.startedAt);
  // The first and last sample of the day have no movement to hand samples to.
  let start = stay.start;
  while (start > 0 && start < stay.end && isAway(start) && time(start + 1) - time(stay.start) <= MAX_STAY_EDGE_TRIM_MS) start += 1;
  let end = stay.end;
  while (end < locations.length - 1 && end > start && isAway(end) && time(stay.end) - time(end - 1) <= MAX_STAY_EDGE_TRIM_MS) end -= 1;
  // A stop shorter than a stay once the walk up to it is taken off is still
  // shown, but without that walk: kept, it would be drawn as a straight line.
  return end - start + 1 >= MIN_STAY_SAMPLES ? { start, end } : { start: stay.start, end: stay.end };
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
    const first = index;
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
    if (!isStayRun(core)) continue;
    if (isSettled(core)) stays.push({ core, start, end });
    // The runs it took in may still be stays of their own.
    else index = first + 1;
  }

  return mergeNearbyStays(stays, locations).map((stay, index) => {
    const center = stayCenter(stay.core);
    const { start, end } = trimStayEdges(stay, center, locations);
    const events = locations.slice(start, end + 1);
    const startedAt = events[0].event.startedAt;
    const endedAt = events[events.length - 1].event.startedAt;
    return {
      id: `stay:${startedAt}:${index}`,
      ...center,
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
          untrackedMs: endedAtMs - startedAtMs >= UNTRACKED_GAP_MS ? endedAtMs - startedAtMs : 0,
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
            untrackedMs: previousActivity.untrackedMs + movement.untrackedMs,
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

/** Whether a movement is a hole in the record rather than a recorded trip. */
export function isMostlyUntracked(activity: Extract<TimelineActivity, { kind: "movement" }>) {
  return activity.untrackedMs > 0 && activity.untrackedMs * 2 >= activity.durationMs;
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
        untrackedMs: previous.untrackedMs + activity.untrackedMs,
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

export function buildMovementSegments(events: LifeEvent[], analysis?: TimelineAnalysis): RouteSegment[] {
  const resolvedAnalysis = analysis ?? analyzeTimeline(events);
  const locations = resolvedAnalysis.correctedPositions;
  const stayClusters = resolvedAnalysis.stayClusters;
  const stayEventIds = new Set(stayClusters.flatMap((stay) => stay.events.map((location) => location.event.id)));
  const stayEndEventIds = new Set(stayClusters.map((stay) => stay.events[stay.events.length - 1]?.event.id).filter((id): id is string => id !== undefined));
  // Stationary samples are represented by the stay circle. Keep one
  // processed endpoint per stay so the movement line remains continuous
  // when the samples inside that stay are omitted.
  const routeLocations = locations.filter((location) => !stayEventIds.has(location.event.id) || stayEndEventIds.has(location.event.id));

  const lengths = routeLocations.slice(1).map((location, index) => distanceMeters(routeLocations[index], location));
  const totalMeters = lengths.reduce((sum, length) => sum + length, 0);
  let travelledMeters = 0;
  return routeLocations.slice(1).map((location, index) => {
    const previous = routeLocations[index];
    const startOpacity = routeOpacity(travelledMeters, totalMeters);
    travelledMeters += lengths[index];
    return {
      from: [previous.latitude, previous.longitude],
      to: [location.latitude, location.longitude],
      gapMs: Math.max(0, timestamp(location.event.startedAt) - timestamp(previous.event.startedAt)),
      opacity: routeOpacity(travelledMeters, totalMeters),
      startOpacity,
    };
  });
}

export function buildRouteSegments(events: LifeEvent[]): RouteSegment[] {
  return buildMovementSegments(events);
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

/**
 * The positions with the walked parts of the route evened out. On foot a fix
 * is as far off as the device gets between two fixes, so the recorded line
 * zigzags along the street. Each fix outside a stay is drawn at the average of
 * itself and up to two fixes on either side, the accurate and the near ones
 * counting most. Both ends of a walk, the fixes next to a hole in the record
 * and anything faster than walking keep their place.
 */
function smoothedWalks(positions: CorrectedLocation[], stays: StayCluster[]): CorrectedLocation[] {
  const inStay = new Set(stays.flatMap((stay) => stay.events.map((location) => location.event.id)));
  const times = positions.map((location) => timestamp(location.event.startedAt));
  // Whether the fixes from `index - reach` to `index + reach` are one stretch of walking.
  const isWalk = (index: number, reach: number) => {
    const from = index - reach;
    const to = index + reach;
    if (from < 0 || to >= positions.length) return false;
    for (let other = from; other <= to; other += 1) {
      if (inStay.has(positions[other].event.id)) return false;
      if (other > from && !(times[other] - times[other - 1] > 0 && times[other] - times[other - 1] <= WALK_SMOOTHING_MAX_GAP_MS)) return false;
    }
    return distanceMeters(positions[from], positions[to]) <= WALK_SMOOTHING_MAX_SPEED_MPS * (times[to] - times[from]) / 1000;
  };
  return positions.map((location, index) => {
    const reach = isWalk(index, WALK_SMOOTHING_REACH) ? WALK_SMOOTHING_REACH : isWalk(index, 1) ? 1 : 0;
    if (reach === 0) return location;
    let latitude = 0;
    let longitude = 0;
    let total = 0;
    for (let other = index - reach; other <= index + reach; other += 1) {
      const error = Math.max(WALK_SMOOTHING_MIN_ACCURACY_METERS, positions[other].event.accuracyMeters ?? WALK_SMOOTHING_DEFAULT_ACCURACY_METERS);
      const weight = (WALK_SMOOTHING_REACH + 1 - Math.abs(other - index)) / (error * error);
      latitude += positions[other].latitude * weight;
      longitude += positions[other].longitude * weight;
      total += weight;
    }
    return { ...location, latitude: latitude / total, longitude: longitude / total };
  });
}

function analyzeTimeline(events: LifeEvent[]): TimelineAnalysis {
  const corrected = correctedPositionEvents(events);
  // Stays are detected on the corrected positions; smoothing only changes how the walks between them are drawn.
  const stayClusters = correctedStayClusters(corrected);
  const correctedPositions = smoothedWalks(corrected, stayClusters);
  return {
    correctedPositions,
    correctedLocations: correctedPositions.filter((location) => location.event.source === "location"),
    stayClusters,
  };
}

export function buildTimelineSnapshot(events: LifeEvent[]): TimelineRenderSnapshot {
  const analysis = analyzeTimeline(events);
  const displayEvents = displayPhotoEventsWithLocations(events, analysis.correctedLocations);
  const photoClusters = clusterPhotoEvents(displayEvents);
  const stayPlaces = buildStayPlaces(events, analysis);
  const activities = buildTimelineActivities(displayEvents, analysis);
  const movementSegments = buildMovementSegments(events, analysis);
  const mapNodes: [number, number][] = [
    ...analysis.correctedLocations.map((location) => [location.latitude, location.longitude] as [number, number]),
    ...analysis.stayClusters.map((stay) => [stay.latitude, stay.longitude] as [number, number]),
    ...photoClusters.map((cluster) => [cluster.latitude, cluster.longitude] as [number, number]),
  ];
  return { ...analysis, displayEvents, photoClusters, stayPlaces, activities, movementSegments, mapNodes };
}

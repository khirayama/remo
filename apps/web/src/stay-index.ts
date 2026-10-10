import { dateKey, LifeEvent } from "./life-log";
import { buildStayClusters, distanceMeters, StayCluster, StayVisit, StayVisitHistory, STAY_PLACE_RADIUS_METERS } from "./timeline-map";

/** The part of a stay the all-time views need; cached per day. */
export type StaySummary = StayVisit;

// Bump whenever stay detection or the cache layout changes so every cached
// day is recomputed.
export const STAY_INDEX_VERSION = 3;

/**
 * Derived, device-local cache of each past day's stays. It is never synced or
 * exported and can be dropped at any time: the storage layer records which
 * days had a record written or removed, and those days are detected again.
 */
export type StayIndexCache = {
  version: number;
  timeZone: string;
  /** False while the first pass over every recorded day is still running. */
  complete: boolean;
  days: Record<string, StaySummary[]>;
};

export function emptyStayIndexCache(timeZone: string): StayIndexCache {
  return { version: STAY_INDEX_VERSION, timeZone, complete: false, days: {} };
}

/**
 * Parse a stored cache. A corrupt cache, or one from another algorithm or
 * time zone (days are local calendar days), cannot be reused: `rebuild` says
 * that every recorded day has to be detected again.
 */
export function parseStayIndexCache(value: string | undefined, timeZone: string): { cache: StayIndexCache; rebuild: boolean } {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<StayIndexCache>;
      if (parsed.version === STAY_INDEX_VERSION && parsed.timeZone === timeZone && typeof parsed.days === "object" && parsed.days !== null) {
        const complete = parsed.complete === true;
        return { cache: { version: STAY_INDEX_VERSION, timeZone, complete, days: parsed.days }, rebuild: !complete };
      }
    } catch {
      // Rebuilt below.
    }
  }
  return { cache: emptyStayIndexCache(timeZone), rebuild: true };
}

function summarize(stays: StayCluster[]): StaySummary[] {
  return stays.map(({ id, latitude, longitude, startedAt, endedAt, durationMs }) => ({ id, latitude, longitude, startedAt, endedAt, durationMs }));
}

/** The stays of one day's records. */
export function detectDayStays(dayEvents: LifeEvent[]): StaySummary[] {
  return summarize(buildStayClusters(dayEvents));
}

const YIELD_AFTER_MS = 12;

/**
 * Detects the stays of [days] again, reading each day's records through
 * [loadDay]. Days from today on are skipped: today is still being recorded
 * and is never cached. Work is split into short slices so the map stays
 * responsive. Returns the days that were processed and whether the cache,
 * which is updated in place, changed. When aborted, the days finished before
 * that are kept and reported.
 */
export async function refreshStayIndex(
  cache: StayIndexCache,
  days: string[],
  loadDay: (day: string) => Promise<LifeEvent[]>,
  options: { today: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<{ processed: string[]; changed: boolean; aborted: boolean }> {
  const stale = [...new Set(days)].filter((day) => day < options.today).sort();
  const processed: string[] = [];
  let changed = false;
  // Days recorded as "today" earlier and never finished are not cached.
  for (const day of Object.keys(cache.days)) {
    if (day >= options.today) {
      delete cache.days[day];
      changed = true;
    }
  }
  let sliceStartedAt = performance.now();
  for (const [index, day] of stale.entries()) {
    if (options.signal?.aborted) return { processed, changed, aborted: true };
    const stays = detectDayStays(await loadDay(day));
    if (stays.length) cache.days[day] = stays;
    else delete cache.days[day];
    processed.push(day);
    changed = true;
    if (performance.now() - sliceStartedAt >= YIELD_AFTER_MS) {
      options.onProgress?.(index + 1, stale.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStartedAt = performance.now();
    }
  }
  return { processed, changed, aborted: options.signal?.aborted === true };
}

/** Every cached stay followed by today's, oldest first. */
export function allStays(cache: StayIndexCache, todayStays: StaySummary[]): StaySummary[] {
  return [...Object.values(cache.days).flat(), ...todayStays]
    .sort((first, second) => first.startedAt.localeCompare(second.startedAt));
}

/** A place built from every stay within [STAY_PLACE_RADIUS_METERS] across all days. */
export type AllTimeStayPlace = {
  id: string;
  latitude: number;
  longitude: number;
  /** Newest first. */
  visits: StaySummary[];
  dayCount: number;
  totalDurationMs: number;
  lastVisitedAt: string;
};

/** Keeps values sorted so the upper median is available without re-sorting. */
function insertSorted(values: number[], value: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

// Grid cells are much larger than the join radius, so a place's median can
// drift from the cell it was filed under and still be found from a neighbor.
const PLACE_GRID_DEGREES = 0.01;

function gridCell(latitude: number, longitude: number) {
  return [Math.floor(latitude / PLACE_GRID_DEGREES), Math.floor(longitude / PLACE_GRID_DEGREES)] as const;
}

/**
 * Group every stay into places the same way the day timeline groups one day
 * (buildStayPlaces): each stay joins the nearest place within
 * [STAY_PLACE_RADIUS_METERS], and a place sits at the median of its visits.
 */
export function buildAllTimeStayPlaces(stays: StaySummary[]): AllTimeStayPlace[] {
  type Building = { id: string; latitude: number; longitude: number; latitudes: number[]; longitudes: number[]; visits: StaySummary[] };
  const places: Building[] = [];
  const grid = new Map<string, Building[]>();
  const ordered = [...stays].sort((first, second) => first.startedAt.localeCompare(second.startedAt));
  for (const stay of ordered) {
    const [row, column] = gridCell(stay.latitude, stay.longitude);
    let nearest: Building | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        for (const place of grid.get(`${row + rowOffset}:${column + columnOffset}`) ?? []) {
          const distance = distanceMeters(place, stay);
          if (distance < nearestDistance) {
            nearest = place;
            nearestDistance = distance;
          }
        }
      }
    }
    if (nearest && nearestDistance <= STAY_PLACE_RADIUS_METERS) {
      nearest.visits.push(stay);
      insertSorted(nearest.latitudes, stay.latitude);
      insertSorted(nearest.longitudes, stay.longitude);
      nearest.latitude = nearest.latitudes[nearest.latitudes.length >> 1];
      nearest.longitude = nearest.longitudes[nearest.longitudes.length >> 1];
      continue;
    }
    const place: Building = { id: `place:${stay.id}`, latitude: stay.latitude, longitude: stay.longitude, latitudes: [stay.latitude], longitudes: [stay.longitude], visits: [stay] };
    places.push(place);
    const key = `${row}:${column}`;
    const cell = grid.get(key);
    if (cell) cell.push(place);
    else grid.set(key, [place]);
  }
  return places.map(({ id, latitude, longitude, visits }) => ({
    id,
    latitude,
    longitude,
    visits: [...visits].reverse(),
    dayCount: new Set(visits.map((visit) => dateKey(visit.startedAt))).size,
    totalDurationMs: visits.reduce((total, visit) => total + visit.durationMs, 0),
    lastVisitedAt: visits[visits.length - 1].startedAt,
  })).sort((first, second) => second.visits.length - first.visits.length
    || second.totalDurationMs - first.totalDurationMs
    || second.lastVisitedAt.localeCompare(first.lastVisitedAt));
}

/** The same result as buildStayVisitHistory, read from already detected stays. */
export function stayVisitHistoryFromStays(stays: StaySummary[], target: { latitude: number; longitude: number }): StayVisitHistory {
  const visits = stays
    .filter((stay) => distanceMeters(stay, target) <= STAY_PLACE_RADIUS_METERS)
    .sort((first, second) => second.startedAt.localeCompare(first.startedAt));
  return historyOf(visits);
}

/** Summary counts for visits that are already newest first. */
export function historyOf(visits: StaySummary[]): StayVisitHistory {
  return {
    visits,
    dayCount: new Set(visits.map((visit) => dateKey(visit.startedAt))).size,
    totalDurationMs: visits.reduce((total, visit) => total + visit.durationMs, 0),
  };
}

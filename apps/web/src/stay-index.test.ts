import { describe, expect, it } from "vitest";
import { LifeEvent } from "./life-log";
import { buildAllTimeStayPlaces, dayFingerprint, emptyStayIndexCache, parseStayIndexCache, STAY_INDEX_VERSION, stayVisitHistoryFromStays, updateStayIndex } from "./stay-index";
import { buildStayVisitHistory } from "./timeline-map";

/** One sample every [stepSeconds] from [start] at a fixed coordinate. */
function samples(prefix: string, start: string, count: number, stepSeconds: number, overrides: Partial<LifeEvent> = {}): LifeEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    startedAt: new Date(Date.parse(start) + index * stepSeconds * 1000).toISOString(),
    latitude: 35.6812,
    longitude: 139.7671,
    photoCount: 0,
    source: "location" as const,
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  }));
}

const WORK = { latitude: 35.69, longitude: 139.78 };
const TODAY = "2026-09-01";

function history(): LifeEvent[] {
  return [
    ...samples("day1-home", "2026-08-29T12:00:00.000Z", 3, 600),
    ...samples("day2-work", "2026-08-30T12:00:00.000Z", 3, 600, WORK),
    ...samples("day3-home", "2026-08-31T12:00:00.000Z", 3, 600),
    ...samples("today-home", "2026-09-01T12:00:00.000Z", 3, 600),
  ];
}

describe("stay index", () => {
  it("caches past days only and returns every stay oldest first", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    const result = await updateStayIndex(history(), cache, { today: TODAY });

    expect(result?.changed).toBe(true);
    expect(Object.keys(cache.days).sort()).toEqual(["2026-08-29", "2026-08-30", "2026-08-31"]);
    expect(result?.stays.map((stay) => stay.startedAt)).toEqual([
      "2026-08-29T12:00:00.000Z",
      "2026-08-30T12:00:00.000Z",
      "2026-08-31T12:00:00.000Z",
      "2026-09-01T12:00:00.000Z",
    ]);
  });

  it("reuses unchanged days and recomputes a day whose records changed", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    await updateStayIndex(history(), cache, { today: TODAY });
    const cachedWorkDay = cache.days["2026-08-30"];

    const unchanged = await updateStayIndex(history(), cache, { today: TODAY });
    expect(unchanged?.changed).toBe(false);
    expect(cache.days["2026-08-30"]).toBe(cachedWorkDay);

    // Moving the work-day records (e.g. a correction) must refresh only that day.
    const edited = history().map((event) => event.id.startsWith("day2-work")
      ? { ...event, latitude: 35.7, updatedAt: "2026-09-01T00:00:00.000Z" }
      : event);
    const cachedHomeDay = cache.days["2026-08-29"];
    const result = await updateStayIndex(edited, cache, { today: TODAY });
    expect(result?.changed).toBe(true);
    expect(cache.days["2026-08-29"]).toBe(cachedHomeDay);
    expect(cache.days["2026-08-30"].stays[0].latitude).toBeCloseTo(35.7);
  });

  it("drops cached days whose records were deleted", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    await updateStayIndex(history(), cache, { today: TODAY });

    const result = await updateStayIndex(history().filter((event) => !event.id.startsWith("day2-work")), cache, { today: TODAY });

    expect(result?.changed).toBe(true);
    expect(cache.days["2026-08-30"]).toBeUndefined();
  });

  it("changes the fingerprint when a record is deleted or edited", () => {
    const events = samples("a", "2026-08-30T12:00:00.000Z", 3, 600);
    const base = dayFingerprint(events);

    expect(dayFingerprint([...events].reverse())).toBe(base);
    expect(dayFingerprint(events.slice(1))).not.toBe(base);
    expect(dayFingerprint([{ ...events[0], updatedAt: "2026-09-01T00:00:00.000Z" }, ...events.slice(1)])).not.toBe(base);
  });

  it("discards a stored cache from another version, time zone, or a corrupt one", () => {
    const stored = JSON.stringify({ version: STAY_INDEX_VERSION, timeZone: "Asia/Tokyo", days: { "2026-08-30": { fingerprint: "x", stays: [] } } });

    expect(Object.keys(parseStayIndexCache(stored, "Asia/Tokyo").days)).toEqual(["2026-08-30"]);
    expect(parseStayIndexCache(stored, "Europe/London").days).toEqual({});
    expect(parseStayIndexCache(JSON.stringify({ version: STAY_INDEX_VERSION + 1, timeZone: "Asia/Tokyo", days: {} }), "Asia/Tokyo").days).toEqual({});
    expect(parseStayIndexCache("{", "Asia/Tokyo").days).toEqual({});
  });

  it("stops without losing finished days when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cache = emptyStayIndexCache("Asia/Tokyo");

    expect(await updateStayIndex(history(), cache, { today: TODAY, signal: controller.signal })).toBeUndefined();
  });
});

describe("all-time stay places", () => {
  it("groups stays within 100m across days, most visited first", async () => {
    const events = [
      ...history(),
      // About 90m north of home, on a day that otherwise was at work.
      ...samples("day2-near-home", "2026-08-30T14:00:00.000Z", 3, 600, { latitude: 35.6820 }),
    ];
    const result = await updateStayIndex(events, emptyStayIndexCache("Asia/Tokyo"), { today: TODAY });
    const places = buildAllTimeStayPlaces(result!.stays);

    expect(places).toHaveLength(2);
    expect(places[0].visits.map((visit) => visit.startedAt)).toEqual([
      "2026-09-01T12:00:00.000Z",
      "2026-08-31T12:00:00.000Z",
      "2026-08-30T14:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ]);
    expect(places[0].dayCount).toBe(4);
    expect(places[0].lastVisitedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(places[1].visits).toHaveLength(1);
  });

  it("builds the same visit history as detecting stays day by day", async () => {
    const events = history();
    const result = await updateStayIndex(events, emptyStayIndexCache("Asia/Tokyo"), { today: TODAY });
    const home = { latitude: 35.6812, longitude: 139.7671 };

    const fromIndex = stayVisitHistoryFromStays(result!.stays, home);
    const direct = buildStayVisitHistory(events, home);

    expect(fromIndex.visits.map((visit) => visit.id)).toEqual(direct.visits.map((visit) => visit.id));
    expect(fromIndex.dayCount).toBe(direct.dayCount);
    expect(fromIndex.totalDurationMs).toBe(direct.totalDurationMs);
  });
});

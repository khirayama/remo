import { describe, expect, it } from "vitest";
import { dateKey, LifeEvent } from "./life-log";
import { allStays, buildAllTimeStayPlaces, detectDayStays, emptyStayIndexCache, parseStayIndexCache, refreshStayIndex, STAY_INDEX_VERSION, stayVisitHistoryFromStays } from "./stay-index";
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

const byDay = (events: LifeEvent[]) => async (day: string) => events.filter((event) => dateKey(event.startedAt) === day);
const DAYS = ["2026-08-29", "2026-08-30", "2026-08-31", TODAY];

/** Every stay of [events], the way the app assembles them. */
async function staysOf(events: LifeEvent[]) {
  const cache = emptyStayIndexCache("Asia/Tokyo");
  await refreshStayIndex(cache, DAYS, byDay(events), { today: TODAY });
  return allStays(cache, detectDayStays(await byDay(events)(TODAY)));
}

describe("stay index", () => {
  it("caches past days only and returns every stay oldest first", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    const result = await refreshStayIndex(cache, DAYS, byDay(history()), { today: TODAY });

    expect(result).toEqual({ processed: ["2026-08-29", "2026-08-30", "2026-08-31"], changed: true, aborted: false });
    expect(Object.keys(cache.days).sort()).toEqual(["2026-08-29", "2026-08-30", "2026-08-31"]);
    expect((await staysOf(history())).map((stay) => stay.startedAt)).toEqual([
      "2026-08-29T12:00:00.000Z",
      "2026-08-30T12:00:00.000Z",
      "2026-08-31T12:00:00.000Z",
      "2026-09-01T12:00:00.000Z",
    ]);
  });

  it("detects only the days it is given", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    await refreshStayIndex(cache, DAYS, byDay(history()), { today: TODAY });
    const cachedHomeDay = cache.days["2026-08-29"];

    expect(await refreshStayIndex(cache, [], byDay(history()), { today: TODAY })).toEqual({ processed: [], changed: false, aborted: false });

    // Moving the work-day records (e.g. a correction) refreshes only that day.
    const edited = history().map((event) => event.id.startsWith("day2-work") ? { ...event, latitude: 35.7 } : event);
    const loaded: string[] = [];
    const result = await refreshStayIndex(cache, ["2026-08-30"], (day) => { loaded.push(day); return byDay(edited)(day); }, { today: TODAY });
    expect(result?.changed).toBe(true);
    expect(loaded).toEqual(["2026-08-30"]);
    expect(cache.days["2026-08-29"]).toBe(cachedHomeDay);
    expect(cache.days["2026-08-30"][0].latitude).toBeCloseTo(35.7);
  });

  it("drops cached days whose records were deleted", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    await refreshStayIndex(cache, DAYS, byDay(history()), { today: TODAY });

    const remaining = history().filter((event) => !event.id.startsWith("day2-work"));
    const result = await refreshStayIndex(cache, ["2026-08-30"], byDay(remaining), { today: TODAY });

    expect(result?.changed).toBe(true);
    expect(cache.days["2026-08-30"]).toBeUndefined();
  });

  it("discards a stored cache from another version, time zone, or a corrupt one", () => {
    const stored = JSON.stringify({ version: STAY_INDEX_VERSION, timeZone: "Asia/Tokyo", complete: true, days: { "2026-08-30": [] } });

    expect(parseStayIndexCache(stored, "Asia/Tokyo")).toMatchObject({ rebuild: false, cache: { days: { "2026-08-30": [] } } });
    expect(parseStayIndexCache(stored, "Europe/London")).toMatchObject({ rebuild: true, cache: { days: {} } });
    expect(parseStayIndexCache(JSON.stringify({ version: STAY_INDEX_VERSION - 1, timeZone: "Asia/Tokyo", days: {} }), "Asia/Tokyo").rebuild).toBe(true);
    // A cache whose first pass was interrupted is kept and finished.
    expect(parseStayIndexCache(stored.replace("true", "false"), "Asia/Tokyo")).toMatchObject({ rebuild: true, cache: { days: { "2026-08-30": [] } } });
    expect(parseStayIndexCache("{", "Asia/Tokyo").rebuild).toBe(true);
    expect(parseStayIndexCache(undefined, "Asia/Tokyo").rebuild).toBe(true);
  });

  it("stops when aborted and keeps the days already finished", async () => {
    const cache = emptyStayIndexCache("Asia/Tokyo");
    const controller = new AbortController();
    const result = await refreshStayIndex(cache, DAYS, async (day) => {
      if (day === "2026-08-30") controller.abort();
      return byDay(history())(day);
    }, { today: TODAY, signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, processed: ["2026-08-29", "2026-08-30"] });
    expect(Object.keys(cache.days).sort()).toEqual(["2026-08-29", "2026-08-30"]);
  });
});

describe("all-time stay places", () => {
  it("groups stays within 100m across days, most visited first", async () => {
    const events = [
      ...history(),
      // About 90m north of home, on a day that otherwise was at work.
      ...samples("day2-near-home", "2026-08-30T14:00:00.000Z", 3, 600, { latitude: 35.6820 }),
    ];
    const places = buildAllTimeStayPlaces(await staysOf(events));

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
    const stays = await staysOf(events);
    const home = { latitude: 35.6812, longitude: 139.7671 };

    const fromIndex = stayVisitHistoryFromStays(stays, home);
    const direct = buildStayVisitHistory(events, home);

    expect(fromIndex.visits.map((visit) => visit.id)).toEqual(direct.visits.map((visit) => visit.id));
    expect(fromIndex.dayCount).toBe(direct.dayCount);
    expect(fromIndex.totalDurationMs).toBe(direct.totalDurationMs);
  });
});

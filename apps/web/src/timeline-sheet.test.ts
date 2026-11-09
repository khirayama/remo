import { describe, expect, it } from "vitest";
import { LifeEvent } from "./life-log";
import { buildTimelineSnapshot } from "./timeline-map";
import { buildSheetItems, daySummary, sleepStartedBefore } from "./timeline-sheet";

function photo(id: string, at: Date): LifeEvent {
  return { id, startedAt: at.toISOString(), latitude: 35.68, longitude: 139.76, photoCount: 1, source: "photo", updatedAt: at.toISOString() };
}

const local = (hour: number, minute = 0, dayOffset = 0) => new Date(2026, 8, 10 + dayOffset, hour, minute);
const sleep = (id: string, start: Date, end: Date) => ({ id, startedAt: start.getTime(), endedAt: end.getTime() });

describe("buildSheetItems with sleep", () => {
  it("orders sleep by wake-up time among other rows", () => {
    const timeline = buildTimelineSnapshot([photo("early", local(6)), photo("late", local(9))]);
    const items = buildSheetItems(timeline, [sleep("s", local(23, 10, -1), local(7, 5))]);
    expect(items.map((item) => item.kind)).toEqual(["photos", "sleep", "photos"]);
  });

  it("puts sleep first when something starts at the same moment", () => {
    const wake = local(7, 5);
    const timeline = buildTimelineSnapshot([photo("p", wake)]);
    const items = buildSheetItems(timeline, [sleep("s", local(23, 10, -1), wake)]);
    expect(items.map((item) => item.kind)).toEqual(["sleep", "photos"]);
  });

  it("works without sleep and shows a sleep-only day", () => {
    const timeline = buildTimelineSnapshot([]);
    expect(buildSheetItems(timeline)).toEqual([]);
    expect(buildSheetItems(timeline, [sleep("s", local(23, 10, -1), local(7, 5))])).toHaveLength(1);
  });
});

describe("daySummary with sleep", () => {
  it("sums sleep durations", () => {
    const timeline = buildTimelineSnapshot([]);
    const summary = daySummary(timeline, [sleep("a", local(23, 10, -1), local(7, 5)), sleep("b", local(13), local(14))]);
    expect(summary.sleepMs).toBe((7 * 60 + 55) * 60_000 + 60 * 60_000);
    expect(summary.mediaCount).toBe(0);
    expect(daySummary(timeline).sleepMs).toBe(0);
  });
});

describe("sleepStartedBefore", () => {
  it("is true for a sleep that began the previous day", () => {
    expect(sleepStartedBefore(sleep("s", local(23, 10, -1), local(7, 5)), "2026-09-10")).toBe(true);
    expect(sleepStartedBefore(sleep("n", local(13), local(14)), "2026-09-10")).toBe(false);
  });
});

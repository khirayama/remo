import { describe, expect, it } from "vitest";
import cases from "../../../fixtures/timeline/corrections.cases.json";
import fixture20260901 from "../../../fixtures/timeline/remo-timeline-2026-09-01.sample.json";
import fixture20261001 from "../../../fixtures/timeline/remo-timeline-2026-10-01.sample.json";
import fixture20261002 from "../../../fixtures/timeline/remo-timeline-2026-10-02.sample.json";
import fixture20261011 from "../../../fixtures/timeline/remo-timeline-2026-10-11.sample.json";
import fixture20261013 from "../../../fixtures/timeline/remo-timeline-2026-10-13.sample.json";
import { LifeEvent } from "./life-log";
import { buildAllTimeStayPlaces, detectDayStays } from "./stay-index";
import { analyzeTimeline, buildTimelineActivities, findOutlierCandidates, NamedPlace, TimelineCorrection } from "./timeline-map";

// Corrections and named places over the shared samples. The expected file is
// shared with the Android and iOS tests like the plain timeline fixtures;
// regenerate it with `npx vitest run -u src/corrections-golden.test.ts` after an
// intended change and make the native implementations match.
const samples: Record<string, { events: unknown[] }> = {
  "2026-09-01": fixture20260901,
  "2026-10-01": fixture20261001,
  "2026-10-02": fixture20261002,
  "2026-10-11": fixture20261011,
  "2026-10-13": fixture20261013,
};

type Case = { name: string; day: string; extraEvents?: unknown[]; corrections: TimelineCorrection[]; places?: NamedPlace[] };

function eventsOf(day: string, extra: unknown[] = []): LifeEvent[] {
  return [...samples[day].events, ...extra]
    .map((event) => event as LifeEvent)
    .sort((first, second) => first.startedAt.localeCompare(second.startedAt));
}

function caseResult(item: Case) {
  const events = eventsOf(item.day, item.extraEvents);
  const analysis = analyzeTimeline(events, { corrections: item.corrections, places: item.places });
  return {
    name: item.name,
    activities: buildTimelineActivities(events, analysis).map((activity) => ({
      kind: activity.kind,
      startedAt: Date.parse(activity.startedAt),
      endedAt: Date.parse(activity.endedAt),
      ...(activity.kind === "stay"
        ? {
          latitude: Number(activity.latitude.toFixed(5)),
          longitude: Number(activity.longitude.toFixed(5)),
          placeId: activity.placeId ?? null,
          corrected: activity.corrected === true,
        }
        : {}),
      ...(activity.kind === "movement" ? { untrackedMs: activity.untrackedMs } : {}),
      photoCount: activity.photos.length,
    })),
    outliers: findOutlierCandidates(analysis).map(({ startedAt, endedAt, eventIds }) => ({ startedAt, endedAt, eventIds })),
  };
}

function allPlacesResult() {
  const { days, corrections, places } = cases.allPlaces as { days: string[]; corrections: TimelineCorrection[]; places: NamedPlace[] };
  const stays = days.flatMap((day) => detectDayStays(eventsOf(day), corrections));
  return buildAllTimeStayPlaces(stays, places).map((place) => ({
    placeId: place.placeId ?? null,
    latitude: Number(place.latitude.toFixed(5)),
    longitude: Number(place.longitude.toFixed(5)),
    visitCount: place.visits.length,
    dayCount: place.dayCount,
    totalDurationMs: place.totalDurationMs,
  }));
}

describe("shared corrections fixture", () => {
  it("produces the corrected timelines and all-time places every platform expects", async () => {
    const actual = { cases: (cases.cases as Case[]).map(caseResult), allPlaces: allPlacesResult() };
    await expect(`${JSON.stringify(actual, null, 2)}\n`).toMatchFileSnapshot("../../../fixtures/timeline/corrections.expected.json");
  });
});

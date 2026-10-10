import { describe, expect, it } from "vitest";
import fixture20260901 from "../../../fixtures/timeline/remo-timeline-2026-09-01.sample.json";
import fixture20261001 from "../../../fixtures/timeline/remo-timeline-2026-10-01.sample.json";
import fixture20261002 from "../../../fixtures/timeline/remo-timeline-2026-10-02.sample.json";
import { LifeEvent } from "./life-log";
import { buildTimelineActivities } from "./timeline-map";

// The expected activities are shared with the Android and iOS tests, which
// run the same fixture through their own implementations of the timeline
// algorithm. After an intended algorithm change, regenerate the file with
// `npx vitest run -u src/golden.test.ts`, then make the native
// implementations match.
function activitySummary(events: LifeEvent[]) {
  return buildTimelineActivities(events).map((activity) => ({
    kind: activity.kind,
    startedAt: Date.parse(activity.startedAt),
    endedAt: Date.parse(activity.endedAt),
    ...(activity.kind === "stay"
      ? { latitude: Number(activity.latitude.toFixed(5)), longitude: Number(activity.longitude.toFixed(5)) }
      : {}),
    ...(activity.kind === "movement" ? { untrackedMs: activity.untrackedMs } : {}),
    photoCount: activity.photos.length,
  }));
}

// 2026-09-01: a quiet day at home. 2026-10-01: a recording hole with photos
// in it. 2026-10-02: walks with stale fixes that jump back along the path.
const fixtures = {
  "2026-09-01": fixture20260901,
  "2026-10-01": fixture20261001,
  "2026-10-02": fixture20261002,
};

describe("shared timeline fixture", () => {
  it.each(Object.entries(fixtures))("produces the activities every platform expects for %s", async (day, fixture) => {
    const actual = { activities: activitySummary(fixture.events as LifeEvent[]) };
    await expect(`${JSON.stringify(actual, null, 2)}\n`).toMatchFileSnapshot(`../../../fixtures/timeline/remo-timeline-${day}.expected.json`);
  });
});

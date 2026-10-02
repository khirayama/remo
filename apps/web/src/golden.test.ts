import { describe, expect, it } from "vitest";
import timelineFixture from "../../../fixtures/timeline/remo-timeline-2026-09-01.sample.json";
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
    photoCount: activity.photos.length,
  }));
}

describe("shared timeline fixture", () => {
  it("produces the activities every platform expects", async () => {
    const actual = { activities: activitySummary(timelineFixture.events as LifeEvent[]) };
    await expect(`${JSON.stringify(actual, null, 2)}\n`).toMatchFileSnapshot("../../../fixtures/timeline/remo-timeline-2026-09-01.expected.json");
  });
});

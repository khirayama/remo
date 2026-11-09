import { dateKey } from "./day";
import type { LifeEvent } from "./life-log";
import type { SleepSession } from "./sleep-api";
import type { TimelineActivity, TimelineRenderSnapshot } from "./timeline-map";

export const PHOTO_GROUP_GAP_MS = 30 * 60 * 1000;

export type SheetItem =
  | { kind: "activity"; id: string; startedAt: string; activity: TimelineActivity }
  | { kind: "photos"; id: string; startedAt: string; entries: LifeEvent[] }
  | { kind: "sleep"; id: string; startedAt: string; session: SleepSession };

const KIND_ORDER = { sleep: 0, activity: 1, photos: 2 } as const;

/**
 * The day's rows in time order. Sleep sits at the moment the person woke up
 * (its end) and goes first when something else starts at the same time.
 */
export function buildSheetItems(timeline: TimelineRenderSnapshot, sleep: SleepSession[] = []): SheetItem[] {
  const assignedPhotoIds = new Set(timeline.activities.flatMap((activity) => activity.photos.map((photo) => photo.id)));
  const ordered: SheetItem[] = [
    ...sleep.map((session) => ({ kind: "sleep" as const, id: `sleep:${session.id}`, startedAt: new Date(session.endedAt).toISOString(), session })),
    ...timeline.activities.map((activity) => ({ kind: "activity" as const, id: activity.id, startedAt: activity.startedAt, activity })),
    ...timeline.displayEvents.filter((event) => event.source === "photo" && !assignedPhotoIds.has(event.id))
      .map((event) => ({ kind: "photos" as const, id: `photos:${event.id}`, startedAt: event.startedAt, entries: [event] })),
  ].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const result: SheetItem[] = [];
  for (const item of ordered) {
    const previous = result.at(-1);
    if (item.kind === "photos" && previous?.kind === "photos"
      && new Date(item.startedAt).getTime() - new Date(previous.entries.at(-1)!.startedAt).getTime() <= PHOTO_GROUP_GAP_MS) {
      result[result.length - 1] = { ...previous, entries: [...previous.entries, ...item.entries] };
    } else {
      result.push(item);
    }
  }
  return result;
}

export function daySummary(timeline: TimelineRenderSnapshot, sleep: SleepSession[] = []) {
  const media = timeline.displayEvents.filter((event) => event.source === "photo");
  return {
    distanceMeters: timeline.activities.reduce((sum, activity) => sum + (activity.kind === "movement" && Number.isFinite(activity.distanceMeters) ? activity.distanceMeters : 0), 0),
    stayCount: timeline.activities.filter((activity) => activity.kind === "stay").length,
    mediaCount: media.reduce((sum, event) => sum + event.photoCount, 0),
    sleepMs: sleep.reduce((sum, session) => sum + Math.max(0, session.endedAt - session.startedAt), 0),
  };
}

/** True when the sleep began on an earlier local day than [day] ("YYYY-MM-DD"). */
export function sleepStartedBefore(session: SleepSession, day: string): boolean {
  return dateKey(session.startedAt) < day;
}

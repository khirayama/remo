import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import {
  buildTimelineSnapshot,
  distanceMeters,
  findOutlierCandidates,
  placeAnchors,
  withoutExcludedSamples,
  type LifeEvent,
  type NamedPlace,
  type TimelineActivity,
  type TimelineAnalysis,
  type TimelineCorrection,
} from "@remo/timeline-map";
import type { Context } from "hono";
import * as z from "zod";
import type { Env } from "../env";
import { resolveApiToken, type ApiTokenScope } from "./api-tokens";
import {
  CorrectionLimitError,
  MAX_CORRECTION_SPAN_MS,
  readCorrection,
  readCorrectionsInRange,
  writeCorrections,
  type Correction,
  type CorrectionKind,
} from "./corrections";
import { CHUNK_MS, EVENT_COLUMNS, mapEvent, parseChunk, sampleEvent, type TimelineEvent } from "./life-events";
import {
  clampRadius,
  DEFAULT_PLACE_RADIUS_METERS,
  MAX_PLACE_ANCHORS,
  MAX_PLACE_NAME_LENGTH,
  PlaceLimitError,
  readPlaces,
  writePlaces,
  type Place,
} from "./places";

// The external API: an MCP server (Streamable HTTP, stateless) over the
// user's cloud backup. It answers with the same stays and movements the app's
// Timeline shows, computed by the web app's timeline algorithm with the user's
// corrections and named places laid over the records. A token with the write
// scope may also change those corrections and places, never the records. Only
// what was backed up is visible: records kept on a device without signing in
// are not.

export const MAX_RANGE_DAYS = 31;
/** The longest window get_location_samples returns. */
export const MAX_SAMPLE_WINDOW_MS = 3 * 60 * 60 * 1000;

class ToolError extends Error {}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const dateSchema = z.string().refine(isValidDate, "Use an existing calendar date in yyyy-MM-dd format");
const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, "Use an IANA time zone such as Asia/Tokyo")
  .describe("The user's IANA time zone, e.g. Asia/Tokyo. Days start at local midnight in this zone.");

// ---- Local time --------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** How far the zone's wall clock is ahead of UTC at `at`, in milliseconds. */
export function timeZoneOffsetMs(timeZone: string, at: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  return wallClock - (at - (((at % 1000) + 1000) % 1000));
}

/** The first millisecond of a local calendar day. */
export function localDayStart(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const midnight = Date.UTC(year, month - 1, day);
  // The offset at the guess can differ from the offset at the result across a
  // DST change; the second pass settles on the offset in force at midnight.
  const guess = midnight - timeZoneOffsetMs(timeZone, midnight);
  return midnight - timeZoneOffsetMs(timeZone, guess);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A moment as local ISO 8601 with its offset, e.g. 2026-11-08T09:15:00+09:00. */
export function formatLocal(at: number, timeZone: string): string {
  const offset = timeZoneOffsetMs(timeZone, at);
  const local = new Date(at + offset).toISOString().slice(0, 19);
  const minutes = Math.round(Math.abs(offset) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  return `${local}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---- Reading the backup ------------------------------------------------------

function toLifeEvent(event: TimelineEvent): LifeEvent {
  return {
    id: event.id,
    startedAt: new Date(event.startedAt).toISOString(),
    ...(event.latitude !== null && event.longitude !== null ? { latitude: event.latitude, longitude: event.longitude } : {}),
    ...(event.originalLatitude !== null && event.originalLongitude !== null
      ? { originalLatitude: event.originalLatitude, originalLongitude: event.originalLongitude }
      : {}),
    ...(event.locationSource ? { locationSource: event.locationSource } : {}),
    ...(event.photoLocationAutoPlacementDisabled ? { photoLocationAutoPlacementDisabled: true } : {}),
    ...(event.accuracyMeters !== null ? { accuracyMeters: event.accuracyMeters } : {}),
    ...(event.mediaType ? { mediaType: event.mediaType } : {}),
    photoCount: event.photoCount,
    source: event.source,
    updatedAt: new Date(event.updatedAt).toISOString(),
  };
}

/**
 * Reads days in order. Location chunks are 6-hour UTC windows, so a window can
 * belong to two local days; it is read once and kept until the next day no
 * longer needs it, which bounds memory to about one day of samples.
 */
class BackupReader {
  private chunks = new Map<number, TimelineEvent[]>();

  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async events(from: number, to: number): Promise<LifeEvent[]> {
    const firstBucket = Math.floor(from / CHUNK_MS);
    const lastBucket = Math.floor((to - 1) / CHUNK_MS);
    for (const bucket of this.chunks.keys()) if (bucket < firstBucket) this.chunks.delete(bucket);
    const missingFrom = Math.max(firstBucket, ...[...this.chunks.keys()].map((bucket) => bucket + 1));
    const [chunkResult, photoResult] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare("SELECT bucket, payload FROM location_chunk WHERE user_id = ?1 AND bucket BETWEEN ?2 AND ?3")
        .bind(this.userId, missingFrom, lastBucket),
      this.db.prepare(
        `SELECT ${EVENT_COLUMNS} FROM life_event
         WHERE user_id = ?1 AND source = 'photo' AND deleted_at IS NULL AND started_at >= ?2 AND started_at < ?3`,
      ).bind(this.userId, from, to),
    ]);
    for (let bucket = missingFrom; bucket <= lastBucket; bucket += 1) this.chunks.set(bucket, []);
    for (const row of chunkResult?.results ?? []) {
      this.chunks.set(Number(row.bucket), parseChunk(row.payload).map(sampleEvent));
    }
    const events: TimelineEvent[] = [];
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      for (const event of this.chunks.get(bucket) ?? []) {
        if (event.startedAt >= from && event.startedAt < to) events.push(event);
      }
    }
    for (const row of photoResult?.results ?? []) events.push(mapEvent(row));
    return events.sort((first, second) => first.startedAt - second.startedAt || (first.id < second.id ? -1 : 1)).map(toLifeEvent);
  }
}

// ---- Places and corrections -------------------------------------------------

const livePlaces = (places: Place[]): Place[] => places.filter((place) => !place.deleted);

/** A place by id, following merges to the place that took it in. */
function resolvePlace(places: Place[], id: string): Place | undefined {
  let place = places.find((candidate) => candidate.id === id);
  for (let hops = 0; place?.deleted && place.mergedInto && hops < 5; hops += 1) {
    const target: string = place.mergedInto;
    place = places.find((candidate) => candidate.id === target);
  }
  return place && !place.deleted ? place : undefined;
}

/** Live corrections that touch one local day. */
function correctionsOfDay(corrections: Correction[], dayStart: number, dayEnd: number): TimelineCorrection[] {
  return corrections.filter((correction) => correction.startedAt < dayEnd && correction.endedAt >= dayStart);
}

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const instantSchema = z
  .string()
  .refine((value) => INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value)), "Use ISO 8601 with an offset, e.g. 2026-11-08T09:15:00+09:00");

const localDate = (at: number, timeZone: string) => formatLocal(at, timeZone).slice(0, 10);

// ---- Output ------------------------------------------------------------------

const minutes = (ms: number) => Math.round(ms / 60_000);
const round = (value: number, digits: number) => Number(value.toFixed(digits));

function mediaCounts(photos: LifeEvent[]) {
  let photoCount = 0;
  let videoCount = 0;
  for (const photo of photos) {
    if (photo.mediaType === "video") videoCount += photo.photoCount;
    else photoCount += photo.photoCount;
  }
  return { photoCount, videoCount };
}

function stayOutput(activity: Extract<TimelineActivity, { kind: "stay" }>, places: Place[], timeZone: string) {
  const place = activity.placeId ? places.find((candidate) => candidate.id === activity.placeId) : undefined;
  return {
    startedAt: formatLocal(Date.parse(activity.startedAt), timeZone),
    endedAt: formatLocal(Date.parse(activity.endedAt), timeZone),
    durationMinutes: minutes(activity.durationMs),
    latitude: round(activity.latitude, 5),
    longitude: round(activity.longitude, 5),
    place: place ? { id: place.id, name: place.name } : null,
    ...(activity.corrected ? { corrected: true } : {}),
  };
}

function activityOutput(activity: TimelineActivity, places: Place[], timeZone: string) {
  if (activity.kind === "stay") {
    return { kind: "stay" as const, ...stayOutput(activity, places, timeZone), ...mediaCounts(activity.photos) };
  }
  return {
    kind: "movement" as const,
    startedAt: formatLocal(Date.parse(activity.startedAt), timeZone),
    endedAt: formatLocal(Date.parse(activity.endedAt), timeZone),
    durationMinutes: minutes(activity.durationMs),
    distanceMeters: Math.round(activity.distanceMeters),
    untrackedMinutes: minutes(activity.untrackedMs),
    ...mediaCounts(activity.photos),
  };
}

function correctionOutput(correction: TimelineCorrection, timeZone: string) {
  return {
    id: correction.id,
    kind: correction.kind,
    startedAt: formatLocal(correction.startedAt, timeZone),
    endedAt: formatLocal(correction.endedAt, timeZone),
    createdAt: formatLocal(correction.createdAt, timeZone),
    createdBy: correction.source === "mcp" ? "ai" : "app",
  };
}

function placeOutput(place: Place) {
  return {
    id: place.id,
    name: place.name,
    latitude: round(place.latitude, 5),
    longitude: round(place.longitude, 5),
    radiusMeters: place.radiusMeters ?? DEFAULT_PLACE_RADIUS_METERS,
    anchors: (place.anchors ?? []).map((anchor, index) => ({
      index,
      latitude: round(anchor.latitude, 5),
      longitude: round(anchor.longitude, 5),
      radiusMeters: anchor.radiusMeters,
    })),
  };
}

function daySummary(events: LifeEvent[]) {
  const locationSamples = events.filter((event) => event.source === "location").length;
  return { locationSamples, photoRecords: events.length - locationSamples };
}

// ---- Reading days ------------------------------------------------------------

type Day = {
  date: string;
  events: LifeEvent[];
  corrections: TimelineCorrection[];
  snapshot: TimelineAnalysis & { activities: TimelineActivity[] };
};

/** Reads days in order with the user's places and corrections laid over them. */
class Timeline {
  private readonly reader: BackupReader;
  private placesPromise?: Promise<Place[]>;

  constructor(private readonly db: D1Database, private readonly userId: string, readonly timeZone: string) {
    this.reader = new BackupReader(db, userId);
  }

  places(): Promise<Place[]> {
    this.placesPromise ??= readPlaces(this.db, this.userId);
    return this.placesPromise;
  }

  /** Corrections for the local days [from, to]. */
  corrections(from: string, to: string): Promise<Correction[]> {
    return readCorrectionsInRange(this.db, this.userId, localDayStart(from, this.timeZone), localDayStart(addDays(to, 1), this.timeZone) - 1);
  }

  async day(date: string, corrections?: Correction[]): Promise<Day> {
    const start = localDayStart(date, this.timeZone);
    const end = localDayStart(addDays(date, 1), this.timeZone);
    const [events, places, loaded] = await Promise.all([
      this.reader.events(start, end),
      this.places(),
      corrections ? Promise.resolve(corrections) : this.corrections(date, date),
    ]);
    const dayCorrections = correctionsOfDay(loaded, start, end);
    return {
      date,
      events,
      corrections: dayCorrections,
      snapshot: buildTimelineSnapshot(events, { corrections: dayCorrections, places: livePlaces(places) as NamedPlace[] }),
    };
  }

  async dayOutput(date: string) {
    const [day, places] = await Promise.all([this.day(date), this.places()]);
    return {
      date,
      ...daySummary(day.events),
      activities: day.snapshot.activities.map((activity) => activityOutput(activity, places, this.timeZone)),
      corrections: day.corrections.map((correction) => correctionOutput(correction, this.timeZone)),
    };
  }
}

function checkRange(from: string, to: string) {
  if (to < from) throw new ToolError("to must not be before from.");
  const dayCount = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (dayCount > MAX_RANGE_DAYS) throw new ToolError(`The range can cover at most ${MAX_RANGE_DAYS} days.`);
}

// ---- Suggestions -------------------------------------------------------------

const JOIN_MAX_GAP_MS = 45 * 60 * 1000;
const JOIN_MAX_DISTANCE_METERS = 250;
const NOT_STAY_MAX_DURATION_MS = 15 * 60 * 1000;
const NOT_STAY_MIN_SPEED_MPS = 5;
const PLACE_CLUSTER_RADIUS_METERS = 100;
const NAME_PLACE_MIN_VISITS = 3;
const NAME_PLACE_MIN_DURATION_MS = 3 * 60 * 60 * 1000;
const ANCHOR_SEARCH_RADIUS_METERS = 300;
const ANCHOR_MIN_VISITS = 2;

type Movement = Extract<TimelineActivity, { kind: "movement" }>;
type Stay = Extract<TimelineActivity, { kind: "stay" }>;

const isFastMovement = (movement: TimelineActivity | undefined): movement is Movement =>
  movement?.kind === "movement"
  && movement.untrackedMs * 2 < movement.durationMs
  && movement.durationMs > 0
  && movement.distanceMeters / (movement.durationMs / 1000) >= NOT_STAY_MIN_SPEED_MPS;

function daySuggestions(day: Day, timeZone: string) {
  const suggestions: Array<Record<string, unknown>> = [];
  for (const outlier of findOutlierCandidates(day.snapshot)) {
    suggestions.push({
      kind: "exclude",
      startedAt: formatLocal(outlier.startedAt, timeZone),
      endedAt: formatLocal(outlier.endedAt, timeZone),
      reason: `${outlier.eventIds.length} location fix(es) jump about ${Math.round(outlier.distanceMeters)} m off the route and straight back`,
    });
  }
  const activities = day.snapshot.activities;
  activities.forEach((activity, index) => {
    if (activity.kind !== "stay") return;
    const next = activities[index + 2];
    const between = activities[index + 1];
    if (next?.kind === "stay" && between?.kind === "movement") {
      const gap = Date.parse(next.startedAt) - Date.parse(activity.endedAt);
      const samePlace = activity.placeId !== undefined && activity.placeId === next.placeId;
      const distance = distanceMeters(activity, next);
      if (gap <= JOIN_MAX_GAP_MS && (samePlace || distance <= JOIN_MAX_DISTANCE_METERS)) {
        suggestions.push({
          kind: "join_stay",
          startedAt: formatLocal(Date.parse(activity.startedAt), timeZone),
          endedAt: formatLocal(Date.parse(next.endedAt), timeZone),
          reason: samePlace
            ? `Two stays at the same named place, ${minutes(gap)} min apart`
            : `Two stays ${Math.round(distance)} m apart with ${minutes(gap)} min between them`,
        });
      }
    }
    if (activity.durationMs <= NOT_STAY_MAX_DURATION_MS && !activity.placeId
      && isFastMovement(activities[index - 1]) && isFastMovement(activities[index + 1])) {
      suggestions.push({
        kind: "not_stay",
        startedAt: formatLocal(Date.parse(activity.startedAt), timeZone),
        endedAt: formatLocal(Date.parse(activity.endedAt), timeZone),
        reason: `A ${minutes(activity.durationMs)} min stop between two trips faster than ${NOT_STAY_MIN_SPEED_MPS} m/s (likely a stop of a vehicle)`,
      });
    }
  });
  return suggestions;
}

type Cluster = { latitude: number; longitude: number; visits: Stay[]; days: Set<string> };

/** Greedy grouping of the stays that match no named place, at the running mean of their visits. */
function clusterStays(stays: Array<{ stay: Stay; date: string }>): Cluster[] {
  const clusters: Cluster[] = [];
  for (const { stay, date } of stays) {
    let nearest: Cluster | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const distance = distanceMeters(cluster, stay);
      if (distance < nearestDistance) {
        nearest = cluster;
        nearestDistance = distance;
      }
    }
    if (nearest && nearestDistance <= PLACE_CLUSTER_RADIUS_METERS) {
      const count = nearest.visits.length;
      nearest.latitude = (nearest.latitude * count + stay.latitude) / (count + 1);
      nearest.longitude = (nearest.longitude * count + stay.longitude) / (count + 1);
      nearest.visits.push(stay);
      nearest.days.add(date);
    } else {
      clusters.push({ latitude: stay.latitude, longitude: stay.longitude, visits: [stay], days: new Set([date]) });
    }
  }
  return clusters;
}

function placeSuggestions(stays: Array<{ stay: Stay; date: string }>, places: Place[]) {
  const named = livePlaces(places);
  const suggestions: Array<Record<string, unknown>> = [];
  for (const cluster of clusterStays(stays)) {
    const totalMs = cluster.visits.reduce((total, visit) => total + visit.durationMs, 0);
    let nearby: { place: Place; distance: number } | undefined;
    for (const place of named) {
      for (const anchor of placeAnchors(place as NamedPlace)) {
        const distance = distanceMeters(anchor, cluster);
        if (distance <= ANCHOR_SEARCH_RADIUS_METERS && (!nearby || distance < nearby.distance)) nearby = { place, distance };
      }
    }
    const base = {
      latitude: round(cluster.latitude, 5),
      longitude: round(cluster.longitude, 5),
      visitCount: cluster.visits.length,
      dayCount: cluster.days.size,
      totalMinutes: minutes(totalMs),
    };
    if (nearby && cluster.visits.length >= ANCHOR_MIN_VISITS) {
      suggestions.push({
        kind: "add_place_anchor",
        placeId: nearby.place.id,
        placeName: nearby.place.name,
        distanceMeters: Math.round(nearby.distance),
        reason: `Stays ${Math.round(nearby.distance)} m from ${nearby.place.name}, outside its radius`,
        ...base,
      });
    } else if (!nearby && (cluster.visits.length >= NAME_PLACE_MIN_VISITS || totalMs >= NAME_PLACE_MIN_DURATION_MS)) {
      suggestions.push({ kind: "name_place", reason: "A recurring place without a name", ...base });
    }
  }
  return suggestions.sort((first, second) => Number(second.visitCount) - Number(first.visitCount));
}

// ---- Server ------------------------------------------------------------------

const runTool = async (tool: string, run: () => Promise<unknown>) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await run()) }] };
  } catch (error) {
    if (error instanceof ToolError) {
      return { content: [{ type: "text" as const, text: error.message }], isError: true };
    }
    if (error instanceof CorrectionLimitError || error instanceof PlaceLimitError) {
      return { content: [{ type: "text" as const, text: error.message }], isError: true };
    }
    console.error(JSON.stringify({
      level: "error",
      event: "mcp_tool_failed",
      tool,
      message: error instanceof Error ? error.message : String(error),
    }));
    return { content: [{ type: "text" as const, text: "Internal error" }], isError: true };
  }
};

const READ_INSTRUCTIONS = [
  "Remo is the user's own location and photo timeline (a life log). Use these tools whenever the user asks where they were, where they went, how long they stayed somewhere, when they last visited a place, how they spent a day, or where they took photos, even if Remo is not mentioned.",
  "Requests in other languages count too, for example Japanese どこにいた, どこへ行った, 行った場所, 滞在, 移動, 何時に家を出た, 最後に行ったのはいつ.",
  "Resolve relative dates such as today, yesterday or last week to the user's local calendar dates (yyyy-MM-dd) yourself, and always pass the user's IANA time zone.",
  "Only data the user has backed up to the cloud from a signed-in device is available. Coordinates are precise personal location data: do not share them beyond what the user asks for.",
  "The timeline already includes the corrections the user made (list_corrections) and stays at named places carry the place.",
];

const WRITE_INSTRUCTIONS = [
  "This token may also correct the timeline and manage named places (補正, 統合, 場所名). Corrections never change the recorded data and every one can be undone with delete_correction; the user's apps show them and can undo them too.",
  "To tidy up a period, call suggest_corrections, check doubtful candidates with get_location_samples or get_timeline, apply the ones that are clearly right, and tell the user what you changed. Ask before broad or uncertain changes, and before merging or deleting places.",
];

export function createServer(db: D1Database, userId: string, scope: ApiTokenScope = "read"): McpServer {
  const server = new McpServer(
    { name: "remo", title: "Remo", version: "1.1.0" },
    { instructions: [...READ_INSTRUCTIONS, ...(scope === "write" ? WRITE_INSTRUCTIONS : [])].join(" ") },
  );

  server.registerTool(
    "get_timeline",
    {
      title: "Get a day's timeline",
      description:
        "Get one day of the user's Remo timeline: stays (where they stayed, from when to when) and movements between them, in time order, as the app shows it. A stay at a place the user named (such as Home or Office) includes that place; corrected marks a stay made or reshaped by a correction. Times are local ISO 8601 with offset. untrackedMinutes is time inside a movement with no recording. corrections lists the corrections that apply to the day.",
      inputSchema: z.object({ date: dateSchema.describe("The local calendar date (yyyy-MM-dd)"), timeZone: timeZoneSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ date, timeZone }) =>
      runTool("get_timeline", async () => ({ timeZone, ...(await new Timeline(db, userId, timeZone).dayOutput(date)) })),
  );

  server.registerTool(
    "list_stays",
    {
      title: "List stays over a period",
      description:
        `List every stay in a date range (at most ${MAX_RANGE_DAYS} days, both ends included), grouped by local day, with the named place when there is one. Days without any backed-up record are listed with recorded false. Pass placeId (from list_places) to keep only stays at that place, for questions like "when did I go to the gym this month".`,
      inputSchema: z.object({
        from: dateSchema.describe("First local calendar date (yyyy-MM-dd)"),
        to: dateSchema.describe("Last local calendar date (yyyy-MM-dd), included"),
        timeZone: timeZoneSchema,
        placeId: z.string().min(1).max(120).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ from, to, timeZone, placeId }) =>
      runTool("list_stays", async () => {
        checkRange(from, to);
        const timeline = new Timeline(db, userId, timeZone);
        const places = await timeline.places();
        const target = placeId === undefined ? undefined : resolvePlace(places, placeId);
        if (placeId !== undefined && !target) throw new ToolError(`Place not found: ${placeId}`);
        const corrections = await timeline.corrections(from, to);
        const days = [];
        for (let date = from; date <= to; date = addDays(date, 1)) {
          const day = await timeline.day(date, corrections);
          const stays = day.snapshot.activities
            .flatMap((activity) => activity.kind === "stay" && (!target || activity.placeId === target.id) ? [stayOutput(activity, places, timeZone)] : []);
          days.push({ date, recorded: day.events.length > 0, stays });
        }
        return { from, to, timeZone, ...(target ? { place: { id: target.id, name: target.name } } : {}), days };
      }),
  );

  server.registerTool(
    "list_places",
    {
      title: "List named places",
      description:
        "List the places the user has named in Remo (such as Home or Office). A place has its own coordinate with radiusMeters and may have further anchors merged into it; a stay within any anchor's radius is at that place (the nearest anchor wins).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool("list_places", async () => ({
        places: livePlaces(await readPlaces(db, userId))
          .sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id))
          .map(placeOutput),
      })),
  );

  server.registerTool(
    "list_corrections",
    {
      title: "List timeline corrections",
      description:
        `List the corrections laid over the timeline in a date range (at most ${MAX_RANGE_DAYS} days). kind is exclude (location fixes in the range are ignored), join_stay (the range is one stay) or not_stay (stays in the range are movement). createdBy is app or ai.`,
      inputSchema: z.object({
        from: dateSchema.describe("First local calendar date (yyyy-MM-dd)"),
        to: dateSchema.describe("Last local calendar date (yyyy-MM-dd), included"),
        timeZone: timeZoneSchema,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ from, to, timeZone }) =>
      runTool("list_corrections", async () => {
        checkRange(from, to);
        const corrections = await new Timeline(db, userId, timeZone).corrections(from, to);
        return { from, to, timeZone, corrections: corrections.map((correction) => correctionOutput(correction, timeZone)) };
      }),
  );

  server.registerTool(
    "suggest_corrections",
    {
      title: "Suggest timeline corrections",
      description:
        `Find likely mistakes in a date range (at most ${MAX_RANGE_DAYS} days): location fixes that jump far away and back (exclude), one stay split in two (join_stay), a short stop inside a fast trip (not_stay), recurring places without a name (name_place) and stays just outside a named place (add_place_anchor). Each day suggestion has the startedAt/endedAt to pass to the matching tool. These are heuristics: check them before applying.`,
      inputSchema: z.object({
        from: dateSchema.describe("First local calendar date (yyyy-MM-dd)"),
        to: dateSchema.describe("Last local calendar date (yyyy-MM-dd), included"),
        timeZone: timeZoneSchema,
      }),
      annotations: { readOnlyHint: true },
    },
    ({ from, to, timeZone }) =>
      runTool("suggest_corrections", async () => {
        checkRange(from, to);
        const timeline = new Timeline(db, userId, timeZone);
        const corrections = await timeline.corrections(from, to);
        const days = [];
        const unnamedStays: Array<{ stay: Stay; date: string }> = [];
        for (let date = from; date <= to; date = addDays(date, 1)) {
          const day = await timeline.day(date, corrections);
          const suggestions = daySuggestions(day, timeZone);
          if (suggestions.length) days.push({ date, suggestions });
          for (const activity of day.snapshot.activities) {
            if (activity.kind === "stay" && !activity.placeId) unnamedStays.push({ stay: activity, date });
          }
        }
        return { from, to, timeZone, days, places: placeSuggestions(unnamedStays, await timeline.places()) };
      }),
  );

  server.registerTool(
    "get_location_samples",
    {
      title: "Get raw location samples",
      description:
        `Get the recorded location fixes in a window of at most ${MAX_SAMPLE_WINDOW_MS / 3_600_000} hours within one local day, to check a suspected jump or stay. Each fix has its accuracy, whether an exclude correction removes it, whether it is part of a stay, and where the timeline draws it when that differs from the recorded coordinate.`,
      inputSchema: z.object({ startedAt: instantSchema, endedAt: instantSchema, timeZone: timeZoneSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ startedAt, endedAt, timeZone }) =>
      runTool("get_location_samples", async () => {
        const from = Date.parse(startedAt);
        const to = Date.parse(endedAt);
        if (to < from) throw new ToolError("endedAt must not be before startedAt.");
        if (to - from > MAX_SAMPLE_WINDOW_MS) throw new ToolError(`The window can cover at most ${MAX_SAMPLE_WINDOW_MS / 3_600_000} hours.`);
        const date = localDate(from, timeZone);
        if (localDate(to, timeZone) !== date) throw new ToolError("The window has to stay within one local day; split it at midnight.");
        const day = await new Timeline(db, userId, timeZone).day(date);
        const kept = new Set(withoutExcludedSamples(day.events, day.corrections).map((event) => event.id));
        const drawn = new Map(day.snapshot.correctedLocations.map((location) => [location.event.id, location]));
        const inStay = new Set(day.snapshot.stayClusters.flatMap((stay) => stay.events.map((location) => location.event.id)));
        const samples = day.events
          .filter((event) => event.source === "location" && event.latitude !== undefined && event.longitude !== undefined)
          .filter((event) => {
            const at = Date.parse(event.startedAt);
            return at >= from && at <= to;
          })
          .map((event) => {
            const location = drawn.get(event.id);
            return {
              at: formatLocal(Date.parse(event.startedAt), timeZone),
              latitude: round(event.latitude!, 5),
              longitude: round(event.longitude!, 5),
              accuracyMeters: event.accuracyMeters === undefined ? null : Math.round(event.accuracyMeters),
              excluded: !kept.has(event.id),
              inStay: inStay.has(event.id),
              ...(location?.corrected ? { drawnLatitude: round(location.latitude, 5), drawnLongitude: round(location.longitude, 5) } : {}),
            };
          });
        return { startedAt, endedAt, timeZone, samples };
      }),
  );

  if (scope === "write") registerWriteTools(server, db, userId);
  return server;
}

function registerWriteTools(server: McpServer, db: D1Database, userId: string) {
  /** The timelines of the local days a range touches, as get_timeline returns them. */
  const affectedDays = async (startedAt: number, endedAt: number, timeZone: string) => {
    const timeline = new Timeline(db, userId, timeZone);
    const days = [];
    for (let date = localDate(startedAt, timeZone); date <= localDate(endedAt, timeZone); date = addDays(date, 1)) {
      days.push(await timeline.dayOutput(date));
    }
    return days;
  };

  const correctionTool = (name: string, kind: CorrectionKind, title: string, description: string) => {
    server.registerTool(
      name,
      {
        title,
        description: `${description} The range is at most 24 hours, both ends included. Returns the correction and the corrected timeline of the days it touches. Undo with delete_correction.`,
        inputSchema: z.object({ startedAt: instantSchema, endedAt: instantSchema, timeZone: timeZoneSchema }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      ({ startedAt, endedAt, timeZone }) =>
        runTool(name, async () => {
          const from = Date.parse(startedAt);
          const to = Date.parse(endedAt);
          if (to < from) throw new ToolError("endedAt must not be before startedAt.");
          if (to - from > MAX_CORRECTION_SPAN_MS) throw new ToolError("A correction can cover at most 24 hours.");
          const correction: Correction = {
            id: crypto.randomUUID(),
            kind,
            startedAt: from,
            endedAt: to,
            createdAt: Date.now(),
            source: "mcp",
            deleted: false,
          };
          await writeCorrections(db, userId, [correction]);
          return { correction: correctionOutput(correction, timeZone), days: await affectedDays(from, to, timeZone) };
        }),
    );
  };

  correctionTool(
    "exclude_location_samples",
    "exclude",
    "Exclude location fixes",
    "Ignore the recorded location fixes in a range (for fixes that jumped far off), so the timeline is built without them. Photos are kept. For a jump found by suggest_corrections, pass its startedAt and endedAt exactly.",
  );
  correctionTool(
    "join_stays",
    "join_stay",
    "Join into one stay",
    "Make a range one stay: every stay it overlaps is taken in, together with what lies between them (for one stay that the timeline split in two, or a stay it missed). To join two stays, pass the start of the first and the end of the second.",
  );
  correctionTool(
    "mark_not_stay",
    "not_stay",
    "Mark as not a stay",
    "Turn the stays that lie at least half inside a range into movement (for a stop the timeline took for a stay in the middle of a trip). Pass the stay's own start and end.",
  );

  server.registerTool(
    "delete_correction",
    {
      title: "Undo a correction",
      description: "Delete a correction (from list_corrections or get_timeline) so the timeline is built as before it.",
      inputSchema: z.object({ correctionId: z.string().min(1).max(120), timeZone: timeZoneSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ correctionId, timeZone }) =>
      runTool("delete_correction", async () => {
        const correction = await readCorrection(db, userId, correctionId);
        if (!correction) throw new ToolError(`Correction not found: ${correctionId}`);
        if (!correction.deleted) await writeCorrections(db, userId, [{ ...correction, deleted: true }]);
        return { deleted: correctionOutput(correction, timeZone), days: await affectedDays(correction.startedAt, correction.endedAt, timeZone) };
      }),
  );

  /** Reads the live place or fails. */
  const livePlace = async (placeId: string) => {
    const places = await readPlaces(db, userId);
    const place = places.find((candidate) => candidate.id === placeId && !candidate.deleted);
    if (!place) throw new ToolError(`Place not found: ${placeId}`);
    return { place, places };
  };
  // Newer than the stored copy even when a device clock ran ahead of the server's.
  const nextUpdatedAt = (place?: Place) => Math.max(Date.now(), (place?.updatedAt ?? 0) + 1);
  const coordinate = { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) };
  const radius = z.number().min(25).max(500).describe("Radius in meters (25-500). Stays within it are at the place.");

  server.registerTool(
    "save_place",
    {
      title: "Name or edit a place",
      description:
        "Create a named place (name, latitude and longitude required), or with placeId change its name, coordinate or radius. Stays within the radius of the place's coordinate or of one of its anchors show its name. Use coordinates of stays from get_timeline or list_stays.",
      inputSchema: z.object({
        placeId: z.string().min(1).max(120).optional(),
        name: z.string().trim().min(1).max(MAX_PLACE_NAME_LENGTH).optional(),
        latitude: coordinate.latitude.optional(),
        longitude: coordinate.longitude.optional(),
        radiusMeters: radius.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ placeId, name, latitude, longitude, radiusMeters }) =>
      runTool("save_place", async () => {
        if ((latitude === undefined) !== (longitude === undefined)) throw new ToolError("Pass latitude and longitude together.");
        let place: Place;
        if (placeId !== undefined) {
          const { place: current } = await livePlace(placeId);
          place = {
            ...current,
            ...(name !== undefined ? { name } : {}),
            ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}),
            ...(radiusMeters !== undefined ? { radiusMeters: clampRadius(radiusMeters) } : {}),
            anchors: current.anchors ?? [],
            updatedAt: nextUpdatedAt(current),
          };
        } else {
          if (name === undefined || latitude === undefined || longitude === undefined) {
            throw new ToolError("A new place needs name, latitude and longitude.");
          }
          place = {
            id: crypto.randomUUID(),
            name,
            latitude,
            longitude,
            radiusMeters: clampRadius(radiusMeters ?? DEFAULT_PLACE_RADIUS_METERS),
            anchors: [],
            updatedAt: Date.now(),
            deleted: false,
          };
        }
        await writePlaces(db, userId, [place]);
        return { place: placeOutput(place) };
      }),
  );

  server.registerTool(
    "add_place_anchor",
    {
      title: "Add an anchor to a place",
      description:
        `Add a further point to a named place, so stays around it are at the place too (for a place whose stays land in more than one spot, or a stay just outside its radius). At most ${MAX_PLACE_ANCHORS} anchors per place.`,
      inputSchema: z.object({ placeId: z.string().min(1).max(120), ...coordinate, radiusMeters: radius.optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ placeId, latitude, longitude, radiusMeters }) =>
      runTool("add_place_anchor", async () => {
        const { place } = await livePlace(placeId);
        const anchors = [...(place.anchors ?? []), { latitude, longitude, radiusMeters: clampRadius(radiusMeters ?? DEFAULT_PLACE_RADIUS_METERS) }];
        if (anchors.length > MAX_PLACE_ANCHORS) throw new ToolError(`A place can have at most ${MAX_PLACE_ANCHORS} anchors.`);
        const updated: Place = { ...place, anchors, updatedAt: nextUpdatedAt(place) };
        await writePlaces(db, userId, [updated]);
        return { place: placeOutput(updated) };
      }),
  );

  server.registerTool(
    "remove_place_anchor",
    {
      title: "Remove an anchor from a place",
      description: "Remove one of a place's further anchors by its index (from list_places). The place's own coordinate cannot be removed; move it with save_place.",
      inputSchema: z.object({ placeId: z.string().min(1).max(120), anchorIndex: z.number().int().min(0) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ placeId, anchorIndex }) =>
      runTool("remove_place_anchor", async () => {
        const { place } = await livePlace(placeId);
        const anchors = place.anchors ?? [];
        if (anchorIndex >= anchors.length) throw new ToolError(`The place has ${anchors.length} further anchor(s).`);
        const updated: Place = { ...place, anchors: anchors.filter((_, index) => index !== anchorIndex), updatedAt: nextUpdatedAt(place) };
        await writePlaces(db, userId, [updated]);
        return { place: placeOutput(updated) };
      }),
  );

  server.registerTool(
    "merge_places",
    {
      title: "Merge places",
      description:
        "Merge named places into one: every anchor of the source places is added to the target place and the source places are deleted (their stays then show the target's name). Confirm with the user first.",
      inputSchema: z.object({
        targetPlaceId: z.string().min(1).max(120),
        sourcePlaceIds: z.array(z.string().min(1).max(120)).min(1).max(MAX_PLACE_ANCHORS),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ targetPlaceId, sourcePlaceIds }) =>
      runTool("merge_places", async () => {
        const { place: target, places } = await livePlace(targetPlaceId);
        const sources = [...new Set(sourcePlaceIds)].map((id) => {
          if (id === targetPlaceId) throw new ToolError("A place cannot be merged into itself.");
          const source = places.find((candidate) => candidate.id === id && !candidate.deleted);
          if (!source) throw new ToolError(`Place not found: ${id}`);
          return source;
        });
        const anchors = [...(target.anchors ?? []), ...sources.flatMap((source) => placeAnchors(source as NamedPlace))];
        if (anchors.length > MAX_PLACE_ANCHORS) throw new ToolError(`A place can have at most ${MAX_PLACE_ANCHORS} anchors.`);
        const merged: Place = { ...target, anchors, updatedAt: nextUpdatedAt(target) };
        await writePlaces(db, userId, [
          merged,
          ...sources.map((source): Place => ({ ...source, name: "", deleted: true, mergedInto: target.id, updatedAt: nextUpdatedAt(source) })),
        ]);
        return { place: placeOutput(merged), merged: sources.map((source) => ({ id: source.id, name: source.name })) };
      }),
  );

  server.registerTool(
    "delete_place",
    {
      title: "Delete a place",
      description: "Delete a named place. Its stays are shown without a name again. Confirm with the user first.",
      inputSchema: z.object({ placeId: z.string().min(1).max(120) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ placeId }) =>
      runTool("delete_place", async () => {
        const { place } = await livePlace(placeId);
        await writePlaces(db, userId, [{ ...place, name: "", deleted: true, updatedAt: nextUpdatedAt(place) }]);
        return { deleted: { id: place.id, name: place.name } };
      }),
  );
}

type McpAuthExtra = { userId: string; scope: ApiTokenScope; db: D1Database };

const mcpHandler = createMcpHandler(({ authInfo }) => {
  const extra = authInfo?.extra as Partial<McpAuthExtra> | undefined;
  if (typeof extra?.userId !== "string" || !extra.db) throw new Error("Missing authenticated user");
  return createServer(extra.db, extra.userId, extra.scope === "write" ? "write" : "read");
});

/** /api/mcp: authenticates the API token, then serves the MCP request. */
export async function handleMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = await resolveApiToken(c.env.DB, c.req.header("authorization"));
  if (!token) {
    return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  const limiter = c.env.API_RATE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `mcp:${token.userId}` });
    if (!success) return c.json({ error: "rate_limited" }, 429);
  }
  const extra: McpAuthExtra = { userId: token.userId, scope: token.scope, db: c.env.DB };
  const response = await mcpHandler.fetch(c.req.raw, {
    authInfo: { token: "", clientId: token.userId, scopes: [token.scope], extra },
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

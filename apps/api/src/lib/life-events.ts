import { Hono } from "hono";
import type { AppContext } from "./auth";

export const EVENT_SOURCES = ["location", "photo"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export const PHOTO_LOCATION_SOURCES = ["exif", "inferred", "manual", "removed"] as const;
export type PhotoLocationSource = (typeof PHOTO_LOCATION_SOURCES)[number];
export const MEDIA_TYPES = ["photo", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const MAX_ID_LENGTH = 120;
// One request carries up to this many records. Location samples of one request
// usually fall into one or two chunks, so a large batch costs a handful of row
// writes; a restore or first backup needs few round trips.
export const MAX_BATCH_ITEMS = 500;
// Client clocks decide last-writer-wins. A device whose clock runs far ahead
// would otherwise win every later conflict, so its timestamps are capped at the
// server time plus this tolerance.
export const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Photos can carry old EXIF dates (scans), but not dates before 1900 or in the
// future beyond a day of time-zone and clock slack.
const MIN_STARTED_AT = Date.UTC(1900, 0, 1);
const MAX_STARTED_AT_AHEAD_MS = 24 * 60 * 60 * 1000;
// Records returned by one sync response. A chunk is never split, so a response
// can exceed this by the samples of its last chunk.
const SYNC_PAGE_SIZE = 5_000;
// Chunk rows read by one sync response.
const SYNC_CHUNK_PAGE = 24;

/** Location samples are stored per user in windows of this length. */
export const CHUNK_MS = 6 * 60 * 60 * 1000;
// A window of continuous 10-second sampling is about 250 KB per device. The
// limit keeps a row well under D1's 2 MB row size and bounds what one account
// can store; samples beyond it are rejected.
export const MAX_CHUNK_BYTES = 1_500_000;
// About 27 years of windows.
export const MAX_CHUNKS = 40_000;
// A chunk is read, merged in the Worker and written back only if it is still
// the version that was read. A concurrent write to the same window makes the
// write a no-op and the merge is repeated.
const MAX_WRITE_ATTEMPTS = 5;
// D1 allows 100 bound parameters per statement.
const ID_LOOKUP_SIZE = 90;

// Server timestamps are taken inside SQLite rather than from the Worker clock.
// D1 executes writes serially on one primary, so the sync cursor order follows
// commit order instead of the order in which Workers happened to read clocks.
const DB_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// Every row written takes its updated_at from the user's sync sequence
// (user_sync_state.seq), inside the transaction that writes it. A request
// first advances the sequence by the number of rows it may write and each
// statement takes its own value below the new top, so updated_at is unique per
// user and strictly increasing in commit order: an exclusive cursor on it
// never misses a committed write, even when two transactions share a
// millisecond or the clock steps backwards. ?1 is the user id in every
// statement that uses it.
const seqAt = (offsetParameter: string) =>
  `((SELECT seq FROM user_sync_state WHERE user_id = ?1) - ${offsetParameter})`;

// A tombstone only needs its key and timestamps for last-writer-wins; the
// recorded payload is erased so a deletion does not keep location history.
const ERASE_PAYLOAD = `started_at = 0, latitude = NULL, longitude = NULL,
  original_latitude = NULL, original_longitude = NULL, location_source = NULL,
  photo_location_auto_placement_disabled = 0, accuracy_meters = NULL,
  media_type = NULL, photo_count = 0`;

export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 1_000;
const PURGE_MAX_BATCHES = 50;

const EVENT_COLUMNS = `id, started_at, latitude, longitude, original_latitude, original_longitude,
  location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type,
  photo_count, source, updated_at, client_updated_at`;

type EventInput = {
  id?: unknown;
  startedAt?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  originalLatitude?: unknown;
  originalLongitude?: unknown;
  locationSource?: unknown;
  photoLocationAutoPlacementDisabled?: unknown;
  accuracyMeters?: unknown;
  mediaType?: unknown;
  photoCount?: unknown;
  source?: unknown;
  updatedAt?: unknown;
};

export type TimelineEvent = {
  id: string;
  startedAt: number;
  latitude: number | null;
  longitude: number | null;
  originalLatitude: number | null;
  originalLongitude: number | null;
  locationSource: PhotoLocationSource | null;
  photoLocationAutoPlacementDisabled: boolean | null;
  accuracyMeters: number | null;
  mediaType: MediaType | null;
  photoCount: number;
  source: EventSource;
  updatedAt: number;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function source(value: unknown): EventSource | null {
  return typeof value === "string" && EVENT_SOURCES.includes(value as EventSource)
    ? value as EventSource
    : null;
}

function photoLocationSource(value: unknown): PhotoLocationSource | null {
  return typeof value === "string" && PHOTO_LOCATION_SOURCES.includes(value as PhotoLocationSource)
    ? value as PhotoLocationSource
    : null;
}

function mediaType(value: unknown): MediaType | null {
  return typeof value === "string" && MEDIA_TYPES.includes(value as MediaType)
    ? value as MediaType
    : null;
}

function coordinate(value: unknown, minimum: number, maximum: number): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function eventId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_ID_LENGTH ? normalized : null;
}

function clientTimestamp(value: unknown, now: number): number | null {
  const timestamp = finiteNumber(value);
  return timestamp === null ? null : Math.min(Math.round(timestamp), now + MAX_CLIENT_CLOCK_SKEW_MS);
}

export function normalizeEvent(input: EventInput, now = Date.now()): { data?: TimelineEvent; error?: string } {
  const id = eventId(input.id);
  const startedAt = finiteNumber(input.startedAt);
  const latitude = input.latitude == null ? null : coordinate(input.latitude, -90, 90);
  const longitude = input.longitude == null ? null : coordinate(input.longitude, -180, 180);
  const originalLatitude = input.originalLatitude == null ? null : coordinate(input.originalLatitude, -90, 90);
  const originalLongitude = input.originalLongitude == null ? null : coordinate(input.originalLongitude, -180, 180);
  const locationSource = input.locationSource == null ? null : photoLocationSource(input.locationSource);
  const photoLocationAutoPlacementDisabled = input.photoLocationAutoPlacementDisabled == null
    ? null
    : typeof input.photoLocationAutoPlacementDisabled === "boolean" ? input.photoLocationAutoPlacementDisabled : null;
  const accuracyMeters = input.accuracyMeters == null ? null : finiteNumber(input.accuracyMeters);
  const eventSource = input.source == null ? "location" : source(input.source);
  const eventMediaType = input.mediaType == null ? null : mediaType(input.mediaType);
  const photoCount = Math.max(0, Math.round(finiteNumber(input.photoCount) ?? (eventSource === "photo" ? 1 : 0)));

  if (input.id != null && !id) return { error: `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
  if (!id || startedAt === null) return { error: "id and startedAt are required" };
  if (startedAt < MIN_STARTED_AT || startedAt > now + MAX_STARTED_AT_AHEAD_MS) return { error: "startedAt is out of range" };
  if (input.latitude != null && latitude === null) return { error: "latitude is invalid" };
  if (input.longitude != null && longitude === null) return { error: "longitude is invalid" };
  if ((latitude === null) !== (longitude === null)) return { error: "latitude and longitude must be provided together" };
  if (input.originalLatitude != null && originalLatitude === null) return { error: "originalLatitude is invalid" };
  if (input.originalLongitude != null && originalLongitude === null) return { error: "originalLongitude is invalid" };
  if ((originalLatitude === null) !== (originalLongitude === null)) return { error: "originalLatitude and originalLongitude must be provided together" };
  if (input.locationSource != null && locationSource === null) return { error: "locationSource is invalid" };
  if (input.photoLocationAutoPlacementDisabled != null && photoLocationAutoPlacementDisabled === null) return { error: "photoLocationAutoPlacementDisabled is invalid" };
  if (input.accuracyMeters != null && (accuracyMeters === null || accuracyMeters < 0 || accuracyMeters > 1_000_000)) return { error: "accuracyMeters is invalid" };
  if (input.mediaType != null && eventMediaType === null) return { error: "mediaType is invalid" };
  if (eventSource !== "photo" && eventMediaType !== null) return { error: "mediaType only applies to photo events" };
  if (!eventSource) return { error: "source is invalid" };
  const hasZeroCoordinate = latitude === 0 && longitude === 0;

  return {
    data: {
      id,
      startedAt,
      latitude: hasZeroCoordinate ? null : latitude,
      longitude: hasZeroCoordinate ? null : longitude,
      originalLatitude,
      originalLongitude,
      locationSource,
      photoLocationAutoPlacementDisabled,
      accuracyMeters,
      mediaType: eventSource === "photo" ? eventMediaType ?? "photo" : null,
      photoCount,
      source: eventSource,
      updatedAt: clientTimestamp(input.updatedAt, now) ?? now,
    },
  };
}


function mapEvent(row: Record<string, unknown>): TimelineEvent {
  const latitude = coordinate(row.latitude, -90, 90);
  const longitude = coordinate(row.longitude, -180, 180);
  const originalLatitude = coordinate(row.original_latitude, -90, 90);
  const originalLongitude = coordinate(row.original_longitude, -180, 180);
  const accuracyMeters = finiteNumber(row.accuracy_meters);
  const eventSource = source(row.source) ?? "location";
  const updatedAt = finiteNumber(row.client_updated_at) ?? finiteNumber(row.updated_at) ?? 0;
  const hasZeroCoordinate = latitude === 0 && longitude === 0;

  return {
    id: String(row.id),
    startedAt: finiteNumber(row.started_at) ?? 0,
    latitude: hasZeroCoordinate ? null : latitude,
    longitude: hasZeroCoordinate ? null : longitude,
    originalLatitude,
    originalLongitude,
    locationSource: photoLocationSource(row.location_source),
    photoLocationAutoPlacementDisabled: row.photo_location_auto_placement_disabled === 1,
    accuracyMeters: accuracyMeters !== null && accuracyMeters >= 0 && accuracyMeters <= 1_000_000 ? accuracyMeters : null,
    mediaType: eventSource === "photo" ? mediaType(row.media_type) ?? "photo" : null,
    photoCount: Math.max(0, Math.round(finiteNumber(row.photo_count) ?? 0)),
    source: eventSource,
    updatedAt,
  };
}

// ---- Location chunks ---------------------------------------------------------

/** One stored location sample: [id, startedAt, latitude, longitude, accuracyMeters, clientUpdatedAt, seq]. */
type Sample = [string, number, number | null, number | null, number | null, number, number];

type ChunkRow = { bucket: number; payload: string; updated_at: number };

// Stands for the sequence value of the statement that writes the chunk; SQLite
// replaces it. JSON escapes control characters inside strings, so the raw
// character cannot occur anywhere else in a payload.
const SEQ_TOKEN = "\u0001";

export function chunkBucket(startedAt: number): number {
  return Math.floor(startedAt / CHUNK_MS);
}

function parseChunk(payload: unknown): Sample[] {
  try {
    const value: unknown = JSON.parse(String(payload));
    return Array.isArray(value)
      ? value.filter((item): item is Sample => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "number")
      : [];
  } catch {
    return [];
  }
}

function encodeSample(sample: Sample, fresh: boolean): string {
  const fields = JSON.stringify(sample.slice(0, 6));
  return `${fields.slice(0, -1)},${fresh ? SEQ_TOKEN : Math.round(finiteNumber(sample[6]) ?? 0)}]`;
}

function sampleEvent(sample: Sample): TimelineEvent {
  const latitude = coordinate(sample[2], -90, 90);
  const longitude = coordinate(sample[3], -180, 180);
  const accuracyMeters = finiteNumber(sample[4]);
  const hasCoordinate = latitude !== null && longitude !== null && !(latitude === 0 && longitude === 0);
  return {
    id: sample[0],
    startedAt: sample[1],
    latitude: hasCoordinate ? latitude : null,
    longitude: hasCoordinate ? longitude : null,
    originalLatitude: null,
    originalLongitude: null,
    locationSource: null,
    photoLocationAutoPlacementDisabled: false,
    accuracyMeters: accuracyMeters !== null && accuracyMeters >= 0 && accuracyMeters <= 1_000_000 ? accuracyMeters : null,
    mediaType: null,
    photoCount: 0,
    source: "location",
    updatedAt: finiteNumber(sample[5]) ?? 0,
  };
}

function sameSample(stored: Sample, event: TimelineEvent): boolean {
  return stored[1] === event.startedAt && stored[2] === event.latitude && stored[3] === event.longitude
    && stored[4] === event.accuracyMeters;
}

// ---- Cursors -----------------------------------------------------------------

type EventCursor = {
  updatedAt: number;
  id: string;
};

/** Where a paged full sync continues: after an event id, then after a chunk. */
type FullPageCursor = {
  snapshotAt: number;
  phase: "events" | "chunks";
  position: string;
};

type DeletionInput = {
  id?: unknown;
  deletedAt?: unknown;
  startedAt?: unknown;
  source?: unknown;
};

export type EventDeletion = {
  id: string;
  deletedAt: number | null;
  /** Optional hints from the client that say where the record is stored. */
  startedAt: number | null;
  source: EventSource | null;
};

// The id of a cursor that ends a sync: "~" sorts after the ids clients generate.
const END_CURSOR_ID = "~";

function encodeEventCursor(cursor: EventCursor): string {
  return `${cursor.updatedAt}|${cursor.id}`;
}

function parseEventCursor(value: string | undefined): EventCursor | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("|");
  if (separator <= 0) return undefined;
  const updatedAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || !id) return undefined;
  return { updatedAt, id };
}

// A continuation of a paged incremental sync carries the cursor the sync
// started from: a chunk returns the samples written after that cursor, not
// after the previous page. It travels in the id part, which clients send back
// unchanged.
function continuationId(since: number, lastEventId: string): string {
  return `s${since}~${lastEventId}`;
}

function parseContinuationId(id: string): { since: number; eventId: string } | undefined {
  const match = /^s(\d+)~(.*)$/s.exec(id);
  if (!match) return undefined;
  const since = Number(match[1]);
  return Number.isSafeInteger(since) ? { since, eventId: match[2] ?? "" } : undefined;
}

function encodeFullPageCursor(cursor: FullPageCursor): string {
  return `${cursor.snapshotAt}|${cursor.phase === "events" ? 0 : 1}|${cursor.phase === "events" ? "e" : "b"}${cursor.position}`;
}

function parseFullPageCursor(value: string | undefined): FullPageCursor | undefined {
  if (!value) return undefined;
  const firstSeparator = value.indexOf("|");
  const secondSeparator = value.indexOf("|", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return undefined;
  const snapshotAt = Number(value.slice(0, firstSeparator));
  const phase = value.slice(firstSeparator + 1, secondSeparator);
  const position = value.slice(secondSeparator + 1);
  if (!Number.isSafeInteger(snapshotAt) || snapshotAt < 0 || !position) return undefined;
  if (phase === "0" && position.startsWith("e")) return { snapshotAt, phase: "events", position: position.slice(1) };
  if (phase === "1" && position.startsWith("b") && Number.isSafeInteger(Number(position.slice(1)))) {
    return { snapshotAt, phase: "chunks", position: position.slice(1) };
  }
  return undefined;
}

export function normalizeDeletion(input: DeletionInput, now = Date.now()): { data?: EventDeletion; error?: string } {
  const id = eventId(input.id);
  const deletedAt = input.deletedAt == null ? null : clientTimestamp(input.deletedAt, now);
  if (!id) return { error: `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
  if (input.deletedAt != null && deletedAt === null) return { error: "deletedAt is invalid" };
  return {
    data: {
      id,
      deletedAt,
      startedAt: input.startedAt == null ? null : finiteNumber(input.startedAt),
      source: input.source == null ? null : source(input.source),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupsOf<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

// ---- Statements ----------------------------------------------------------------

// Advances the user's sequence by the rows this request may write.
function advanceSequenceStatement(db: D1Database, userId: string, rows: number, newChunks: number) {
  return db.prepare(
    `INSERT INTO user_sync_state (user_id, seq, chunk_count)
     VALUES (?1, MAX(${DB_NOW_MS}, 1) + ?2 - 1, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       seq = MAX(${DB_NOW_MS}, seq + 1) + ?2 - 1,
       chunk_count = chunk_count + ?3`,
  ).bind(userId, rows, newChunks);
}

// ?9 is the nullable auto-placement flag: null keeps the stored value.
// ?15 is the statement's offset below the top of the sequence.
function upsertStatement(db: D1Database, userId: string, event: TimelineEvent, offset: number) {
  return db.prepare(
    `INSERT INTO life_event
      (user_id, id, started_at, latitude, longitude, original_latitude, original_longitude, location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type, photo_count, source, updated_at, client_updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 0), ?10, ?11, ?12, ?13, ${seqAt("?15")}, ?14)
     ON CONFLICT(user_id, id) DO UPDATE SET
       started_at = excluded.started_at,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       original_latitude = COALESCE(excluded.original_latitude, life_event.original_latitude),
       original_longitude = COALESCE(excluded.original_longitude, life_event.original_longitude),
       location_source = COALESCE(excluded.location_source, life_event.location_source),
       photo_location_auto_placement_disabled = COALESCE(?9, life_event.photo_location_auto_placement_disabled),
       accuracy_meters = excluded.accuracy_meters,
       media_type = excluded.media_type,
       photo_count = excluded.photo_count,
       source = excluded.source,
       updated_at = excluded.updated_at,
       client_updated_at = excluded.client_updated_at,
       deleted_at = NULL,
       deletion_propagates = 0
     WHERE excluded.client_updated_at >= life_event.client_updated_at
       AND (
         excluded.client_updated_at > life_event.client_updated_at
         OR excluded.started_at IS NOT life_event.started_at
         OR excluded.latitude IS NOT life_event.latitude
         OR excluded.longitude IS NOT life_event.longitude
         OR COALESCE(excluded.original_latitude, life_event.original_latitude) IS NOT life_event.original_latitude
         OR COALESCE(excluded.original_longitude, life_event.original_longitude) IS NOT life_event.original_longitude
         OR COALESCE(excluded.location_source, life_event.location_source) IS NOT life_event.location_source
         OR COALESCE(?9, life_event.photo_location_auto_placement_disabled) IS NOT life_event.photo_location_auto_placement_disabled
         OR excluded.accuracy_meters IS NOT life_event.accuracy_meters
         OR excluded.media_type IS NOT life_event.media_type
         OR excluded.photo_count IS NOT life_event.photo_count
         OR excluded.source IS NOT life_event.source
         OR life_event.deleted_at IS NOT NULL
       )`,
  ).bind(
    userId,
    event.id,
    event.startedAt,
    event.latitude,
    event.longitude,
    event.originalLatitude,
    event.originalLongitude,
    event.locationSource,
    event.photoLocationAutoPlacementDisabled,
    event.accuracyMeters,
    event.mediaType,
    event.photoCount,
    event.source,
    event.updatedAt,
    offset,
  );
}

// deletedAt is the client clock, the same clock as upsert updatedAt, so a
// deletion and an edit from another device resolve as last-writer-wins.
// Without it the deletion always wins. The tombstone is marked as one that
// other devices apply to their own copy.
function deleteStatement(db: D1Database, userId: string, deletion: EventDeletion, offset: number) {
  return db.prepare(
    `UPDATE life_event
     SET ${ERASE_PAYLOAD}, deleted_at = ${DB_NOW_MS}, deletion_propagates = 1, updated_at = ${seqAt("?4")},
       client_updated_at = COALESCE(?3, ${DB_NOW_MS})
     WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL
       AND (?3 IS NULL OR client_updated_at <= ?3)`,
  ).bind(userId, deletion.id, deletion.deletedAt, offset);
}

// A location sample removed from its chunk leaves its tombstone here, where
// the sync and the retention purge already look for tombstones.
function sampleTombstoneStatement(db: D1Database, userId: string, deletion: EventDeletion, offset: number) {
  return db.prepare(
    `INSERT INTO life_event (user_id, id, started_at, photo_count, source, updated_at, client_updated_at, deleted_at, deletion_propagates)
     VALUES (?1, ?2, 0, 0, 'location', ${seqAt("?4")}, COALESCE(?3, ${DB_NOW_MS}), ${DB_NOW_MS}, 1)
     ON CONFLICT(user_id, id) DO UPDATE SET
       ${ERASE_PAYLOAD}, source = 'location', deleted_at = excluded.deleted_at, deletion_propagates = 1,
       updated_at = excluded.updated_at, client_updated_at = excluded.client_updated_at`,
  ).bind(userId, deletion.id, deletion.deletedAt, offset);
}

// Written only while the chunk is still the version that was merged.
function chunkWriteStatement(db: D1Database, userId: string, bucket: number, payload: string, count: number, readVersion: number | null, offset: number) {
  return readVersion === null
    ? db.prepare(
      `INSERT INTO location_chunk (user_id, bucket, payload, sample_count, updated_at)
       VALUES (?1, ?2, replace(?3, char(1), ${seqAt("?5")}), ?4, ${seqAt("?5")})
       ON CONFLICT(user_id, bucket) DO NOTHING`,
    ).bind(userId, bucket, payload, count, offset)
    : db.prepare(
      `UPDATE location_chunk
       SET payload = replace(?3, char(1), ${seqAt("?5")}), sample_count = ?4, updated_at = ${seqAt("?5")}
       WHERE user_id = ?1 AND bucket = ?2 AND updated_at = ?6`,
    ).bind(userId, bucket, payload, count, offset, readVersion);
}

// Removes tombstones past the retention window in bounded batches. A device
// that later uploads an older copy of a purged record simply backs it up
// again, which matches the device-as-source-of-truth model. Returns the number
// of rows removed.
export async function purgeExpiredTombstones(db: D1Database, now: number): Promise<number> {
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  let purged = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const result = await db.prepare(
      `DELETE FROM life_event
       WHERE (user_id, id) IN (
         SELECT user_id, id FROM life_event
         WHERE deleted_at IS NOT NULL AND deleted_at < ?1
         LIMIT ?2
       )`,
    ).bind(cutoff, PURGE_BATCH_SIZE).run();
    purged += result.meta.changes;
    if (result.meta.changes < PURGE_BATCH_SIZE) break;
  }
  return purged;
}

// ---- Reading -------------------------------------------------------------------

export const lifeEventRoutes = new Hono<AppContext>();

lifeEventRoutes.get("/events/head", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT seq FROM user_sync_state WHERE user_id = ?1")
    .bind(user.id).first<{ seq: number }>();
  const seq = finiteNumber(row?.seq) ?? 0;
  const response = c.json({ data: { cursor: seq > 0 ? encodeEventCursor({ updatedAt: seq, id: END_CURSOR_ID }) : null } });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

type SyncPayload = {
  events: TimelineEvent[];
  deletedIds: string[];
  deletions: Array<{ id: string; deletedAt: number }>;
};

function addEventRow(target: SyncPayload, row: Record<string, unknown>) {
  if (row.deleted_at == null) {
    target.events.push(mapEvent(row));
    return;
  }
  const id = String(row.id);
  target.deletedIds.push(id);
  // Only a record deleted on its own removes other devices' copies.
  if (row.deletion_propagates === 1) {
    target.deletions.push({ id, deletedAt: finiteNumber(row.client_updated_at) ?? 0 });
  }
}

const eventRowQuery = (where: string, order: string) =>
  `SELECT ${EVENT_COLUMNS}, deleted_at, deletion_propagates FROM life_event WHERE user_id = ?1 AND ${where} ORDER BY ${order} LIMIT ?`;

// Without a cursor the client receives everything, paged in primary-key order
// (photo records and tombstones first, then location chunks) and ending with a
// cursor at the sequence the snapshot started from; with a cursor it receives
// the changes after that cursor in sequence order. Every read is a bounded
// range on an index.
lifeEventRoutes.get("/events", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const rawCursor = c.req.query("cursor");
  const rawPage = c.req.query("page");
  if (rawCursor !== undefined && rawPage !== undefined) {
    return c.json({ error: { code: "invalid_cursor", message: "cursor and page cannot be combined" } }, 400);
  }
  const cursor = rawCursor === undefined ? undefined : parseEventCursor(rawCursor);
  if (rawCursor !== undefined && !cursor) {
    return c.json({ error: { code: "invalid_cursor", message: "cursor must contain updatedAt and id" } }, 400);
  }
  const stateStatement = db.prepare("SELECT seq FROM user_sync_state WHERE user_id = ?1").bind(user.id);
  const payload: SyncPayload = { events: [], deletedIds: [], deletions: [] };

  if (!cursor) {
    // A page token this version did not issue (an older client resuming) starts over.
    const page = parseFullPageCursor(rawPage);
    const readsEvents = page?.phase !== "chunks";
    const [state, eventResult, chunkResult] = await db.batch<Record<string, unknown>>([
      stateStatement,
      db.prepare(eventRowQuery("id > ?2", "id")).bind(user.id, page?.phase === "events" ? page.position : "", readsEvents ? SYNC_PAGE_SIZE : 0),
      db.prepare("SELECT bucket, payload, updated_at FROM location_chunk WHERE user_id = ?1 AND bucket > ?2 ORDER BY bucket LIMIT ?3")
        .bind(user.id, page?.phase === "chunks" ? Number(page.position) : -Number.MAX_SAFE_INTEGER, SYNC_CHUNK_PAGE),
    ]);
    const snapshotAt = page?.snapshotAt ?? finiteNumber(state?.results[0]?.seq) ?? 0;
    const eventRows = eventResult?.results ?? [];
    const chunkRows = (chunkResult?.results ?? []) as unknown as ChunkRow[];
    eventRows.forEach((row) => addEventRow(payload, row));
    let nextPage: FullPageCursor | undefined;
    if (readsEvents && eventRows.length === SYNC_PAGE_SIZE) {
      nextPage = { snapshotAt, phase: "events", position: String(eventRows.at(-1)!.id) };
    } else {
      chunkRows.forEach((row) => parseChunk(row.payload).forEach((sample) => payload.events.push(sampleEvent(sample))));
      if (chunkRows.length === SYNC_CHUNK_PAGE) {
        nextPage = { snapshotAt, phase: "chunks", position: String(chunkRows.at(-1)!.bucket) };
      }
    }
    return c.json({
      data: payload.events,
      meta: {
        deletedIds: payload.deletedIds,
        deletions: payload.deletions,
        // Writes committed while the pages were read have a larger sequence
        // and arrive with the first incremental sync from this cursor.
        cursor: snapshotAt > 0 ? encodeEventCursor({ updatedAt: snapshotAt, id: END_CURSOR_ID }) : null,
        hasMore: nextPage !== undefined,
        nextPage: nextPage ? encodeFullPageCursor(nextPage) : null,
        nextCursorToken: null,
        full: true,
      },
    });
  }

  const continuation = parseContinuationId(cursor.id);
  const since = continuation?.since ?? cursor.updatedAt;
  const [state, eventResult, chunkResult] = await db.batch<Record<string, unknown>>([
    stateStatement,
    db.prepare(eventRowQuery("(updated_at, id) > (?2, ?3)", "updated_at, id"))
      .bind(user.id, cursor.updatedAt, continuation ? continuation.eventId : cursor.id, SYNC_PAGE_SIZE),
    db.prepare("SELECT bucket, payload, updated_at FROM location_chunk WHERE user_id = ?1 AND updated_at > ?2 ORDER BY updated_at LIMIT ?3")
      .bind(user.id, cursor.updatedAt, SYNC_CHUNK_PAGE),
  ]);
  const eventRows = eventResult?.results ?? [];
  const chunkRows = (chunkResult?.results ?? []) as unknown as ChunkRow[];
  // A list cut by its LIMIT is complete only up to its last row.
  const bound = Math.min(
    eventRows.length === SYNC_PAGE_SIZE ? Number(eventRows.at(-1)!.updated_at) : Infinity,
    chunkRows.length === SYNC_CHUNK_PAGE ? chunkRows.at(-1)!.updated_at : Infinity,
  );
  let eventIndex = 0;
  let chunkIndex = 0;
  let emitted = 0;
  let last: EventCursor | undefined;
  while (emitted < SYNC_PAGE_SIZE && (eventIndex < eventRows.length || chunkIndex < chunkRows.length)) {
    const eventRow = eventRows[eventIndex];
    const chunkRow = chunkRows[chunkIndex];
    // A chunk goes first on a tie, so the continuation (which resumes strictly
    // after the last chunk) cannot skip it.
    const takeEvent = eventRow !== undefined && (chunkRow === undefined || Number(eventRow.updated_at) < chunkRow.updated_at);
    const updatedAt = takeEvent ? Number(eventRow!.updated_at) : chunkRow!.updated_at;
    if (updatedAt > bound) break;
    if (takeEvent) {
      addEventRow(payload, eventRow!);
      eventIndex += 1;
      emitted += 1;
      last = { updatedAt, id: String(eventRow!.id) };
    } else {
      const samples = parseChunk(chunkRow!.payload).filter((sample) => sample[6] > since);
      samples.forEach((sample) => payload.events.push(sampleEvent(sample)));
      chunkIndex += 1;
      emitted += samples.length;
      last = { updatedAt, id: "" };
    }
  }
  const hasMore = last !== undefined
    && (eventIndex < eventRows.length || chunkIndex < chunkRows.length || bound !== Infinity);
  const seq = finiteNumber(state?.results[0]?.seq) ?? 0;
  const responseCursor = hasMore
    ? encodeEventCursor({ updatedAt: last!.updatedAt, id: continuationId(since, last!.id) })
    // Everything committed so far has been returned: later syncs start from
    // the sequence read in the same transaction as the rows.
    : encodeEventCursor(seq > cursor.updatedAt ? { updatedAt: seq, id: END_CURSOR_ID } : cursor);

  return c.json({
    data: payload.events,
    meta: {
      deletedIds: payload.deletedIds,
      deletions: payload.deletions,
      cursor: responseCursor,
      hasMore,
      nextPage: null,
      nextCursorToken: hasMore ? responseCursor : null,
      full: false,
    },
  });
});

// ---- Writing -------------------------------------------------------------------

export type BatchRejection = {
  kind: "event" | "deletion";
  index: number;
  id: string | null;
  message: string;
};

type ChunkPlan = {
  bucket: number;
  readVersion: number | null;
  payload: string;
  count: number;
  changed: number;
  removed: EventDeletion[];
};

// Merges the pending samples and removals of one window into the chunk read
// from the database. Returns undefined when nothing changes.
function planChunk(
  bucket: number,
  row: ChunkRow | undefined,
  upserts: TimelineEvent[],
  removals: EventDeletion[],
  reject: (event: TimelineEvent, message: string) => void,
): ChunkPlan | undefined {
  const stored = row ? parseChunk(row.payload) : [];
  const byId = new Map(stored.map((sample) => [sample[0], sample]));
  const fresh = new Set<string>();
  let changed = 0;
  for (const event of upserts) {
    const current = byId.get(event.id);
    if (current && (event.updatedAt < current[5] || (event.updatedAt === current[5] && sameSample(current, event)))) continue;
    byId.set(event.id, [event.id, event.startedAt, event.latitude, event.longitude, event.accuracyMeters, event.updatedAt, 0]);
    fresh.add(event.id);
    changed += 1;
  }
  const removed: EventDeletion[] = [];
  for (const removal of removals) {
    const current = byId.get(removal.id);
    if (!current || (removal.deletedAt !== null && current[5] > removal.deletedAt)) continue;
    byId.delete(removal.id);
    fresh.delete(removal.id);
    removed.push(removal);
  }
  if (!changed && !removed.length) return undefined;
  const encode = () => `[${[...byId.values()].map((sample) => encodeSample(sample, fresh.has(sample[0]))).join(",")}]`;
  let payload = encode();
  if (payload.length > MAX_CHUNK_BYTES) {
    // The window is full: keep what is stored and turn away the new samples.
    for (const event of upserts) {
      if (!fresh.has(event.id)) continue;
      const previous = stored.find((sample) => sample[0] === event.id);
      if (previous) byId.set(event.id, previous);
      else byId.delete(event.id);
      fresh.delete(event.id);
      reject(event, "the time window of this record is full");
    }
    changed = 0;
    if (!removed.length) return undefined;
    payload = encode();
  }
  return { bucket, readVersion: row ? row.updated_at : null, payload, count: byId.size, changed, removed };
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// One malformed item must not block the rest of a device's upload queue: valid
// items are applied and invalid ones are reported back so the client can stop
// retrying them. Only a malformed request body is rejected as a whole.
lifeEventRoutes.post("/events/batch", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ events?: unknown; deletions?: unknown }>().catch(() => null);
  const rawEvents = body?.events ?? [];
  const rawDeletions = body?.deletions ?? [];
  if (!isObject(body) || !Array.isArray(rawEvents) || !Array.isArray(rawDeletions)
    || rawEvents.length + rawDeletions.length === 0 || rawEvents.length + rawDeletions.length > MAX_BATCH_ITEMS) {
    return c.json({ error: { code: "invalid_batch", message: `events and deletions must contain 1-${MAX_BATCH_ITEMS} items in total` } }, 400);
  }

  const now = Date.now();
  const rejected: BatchRejection[] = [];
  const rejectedId = (value: unknown) => isObject(value) && typeof value.id === "string" ? value.id : null;
  const events: TimelineEvent[] = [];
  const eventIndexes = new Map<TimelineEvent, number>();
  for (const [index, value] of rawEvents.entries()) {
    const parsed = isObject(value) ? normalizeEvent(value, now) : { error: "must be an object" };
    if (parsed.data) {
      events.push(parsed.data);
      eventIndexes.set(parsed.data, index);
    } else rejected.push({ kind: "event", index, id: rejectedId(value), message: parsed.error ?? "invalid" });
  }
  const deletions: EventDeletion[] = [];
  for (const [index, value] of rawDeletions.entries()) {
    const parsed = isObject(value) ? normalizeDeletion(value, now) : { error: "must be an object" };
    if (parsed.data) deletions.push(parsed.data);
    else rejected.push({ kind: "deletion", index, id: rejectedId(value), message: parsed.error ?? "invalid" });
  }

  const db = c.env.DB;
  const photoEvents = events.filter((event) => event.source === "photo");
  let accepted = events.length;
  const rejectEvent = (event: TimelineEvent, message: string) => {
    accepted -= 1;
    rejected.push({ kind: "event", index: eventIndexes.get(event) ?? -1, id: event.id, message });
  };

  // Location samples and their removals, by time window.
  const pendingUpserts = new Map<number, TimelineEvent[]>();
  events.filter((event) => event.source !== "photo").forEach((event) => addTo(pendingUpserts, chunkBucket(event.startedAt), event));
  const pendingRemovals = new Map<number, EventDeletion[]>();

  // A deletion names only the record. Clients say where it is stored when
  // they know; otherwise it is looked up: first among photo records and
  // tombstones, then inside the location chunks.
  const eventDeletions: EventDeletion[] = [];
  const unresolved: EventDeletion[] = [];
  for (const deletion of deletions) {
    if (deletion.source === "photo") eventDeletions.push(deletion);
    else if (deletion.source === "location" && deletion.startedAt !== null) addTo(pendingRemovals, chunkBucket(deletion.startedAt), deletion);
    else unresolved.push(deletion);
  }
  if (unresolved.length) {
    const known = new Set<string>();
    for (const group of groupsOf(unresolved, ID_LOOKUP_SIZE)) {
      const { results } = await db.prepare(
        `SELECT id FROM life_event WHERE user_id = ?1 AND id IN (${group.map((_, index) => `?${index + 2}`).join(", ")})`,
      ).bind(user.id, ...group.map((deletion) => deletion.id)).all<{ id: string }>();
      results.forEach((row) => known.add(row.id));
    }
    const missing = new Map<string, EventDeletion>();
    for (const deletion of unresolved) {
      if (known.has(deletion.id)) eventDeletions.push(deletion);
      else missing.set(deletion.id, deletion);
    }
    for (const group of groupsOf([...missing.values()], ID_LOOKUP_SIZE)) {
      const { results } = await db.prepare(
        `SELECT bucket, payload FROM location_chunk WHERE user_id = ?1 AND (${group.map((_, index) => `instr(payload, ?${index + 2}) > 0`).join(" OR ")})`,
      ).bind(user.id, ...group.map((deletion) => `[${JSON.stringify(deletion.id)},`)).all<ChunkRow>();
      for (const row of results) {
        for (const sample of parseChunk(row.payload)) {
          const deletion = missing.get(sample[0]);
          if (deletion) addTo(pendingRemovals, row.bucket, deletion);
        }
      }
    }
  }

  let changed = 0;
  let deleted = 0;
  let recordStatementsPending = photoEvents.length + eventDeletions.length > 0;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const buckets = [...new Set([...pendingUpserts.keys(), ...pendingRemovals.keys()])];
    if (!buckets.length && !recordStatementsPending) break;

    const chunkRows = new Map<number, ChunkRow>();
    let chunkCount = 0;
    if (buckets.length) {
      const [state, ...chunkResults] = await db.batch<Record<string, unknown>>([
        db.prepare("SELECT chunk_count FROM user_sync_state WHERE user_id = ?1").bind(user.id),
        ...groupsOf(buckets, ID_LOOKUP_SIZE).map((group) => db.prepare(
          `SELECT bucket, payload, updated_at FROM location_chunk WHERE user_id = ?1 AND bucket IN (${group.map((_, index) => `?${index + 2}`).join(", ")})`,
        ).bind(user.id, ...group)),
      ]);
      chunkCount = finiteNumber(state?.results[0]?.chunk_count) ?? 0;
      chunkResults.forEach((result) => (result.results as unknown as ChunkRow[]).forEach((row) => chunkRows.set(row.bucket, row)));
    }

    const plans: ChunkPlan[] = [];
    let newChunks = 0;
    for (const bucket of buckets) {
      const row = chunkRows.get(bucket);
      let upserts = pendingUpserts.get(bucket) ?? [];
      if (!row && upserts.length && chunkCount + newChunks >= MAX_CHUNKS) {
        upserts.forEach((event) => rejectEvent(event, "the account has reached its storage limit"));
        upserts = [];
      }
      const plan = planChunk(bucket, row, upserts, pendingRemovals.get(bucket) ?? [], rejectEvent);
      if (plan) {
        plans.push(plan);
        if (plan.readVersion === null) newChunks += 1;
      } else {
        pendingUpserts.delete(bucket);
        pendingRemovals.delete(bucket);
      }
    }

    // Statements that take a sequence value, in the order they run.
    const sequenced: Array<(offset: number) => D1PreparedStatement> = [];
    const trailing: D1PreparedStatement[] = [];
    const photoCount = recordStatementsPending ? photoEvents.length : 0;
    const eventDeletionCount = recordStatementsPending ? eventDeletions.length : 0;
    if (recordStatementsPending) {
      photoEvents.forEach((event) => sequenced.push((offset) => upsertStatement(db, user.id, event, offset)));
      eventDeletions.forEach((deletion) => sequenced.push((offset) => deleteStatement(db, user.id, deletion, offset)));
      // Only photo records own preview images. The cleanup job checks again
      // that the record is still deleted before removing anything from R2.
      for (const deletion of eventDeletions) {
        const isDeleted = "EXISTS (SELECT 1 FROM life_event WHERE user_id = ?1 AND id = ?2 AND source = 'photo' AND deleted_at IS NOT NULL)";
        trailing.push(
          db.prepare(`INSERT OR IGNORE INTO photo_cleanup(prefix) SELECT ?1 || '/' || ?2 || '/' WHERE ${isDeleted}`).bind(user.id, deletion.id),
          db.prepare(
            `UPDATE user_sync_state SET preview_count = MAX(0, preview_count
               - (SELECT COUNT(*) FROM photo_preview WHERE user_id = ?1 AND event_id = ?2))
             WHERE user_id = ?1 AND ${isDeleted}`,
          ).bind(user.id, deletion.id),
          db.prepare(`DELETE FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 AND ${isDeleted}`).bind(user.id, deletion.id),
        );
      }
    }
    for (const plan of plans) {
      sequenced.push((offset) => chunkWriteStatement(db, user.id, plan.bucket, plan.payload, plan.count, plan.readVersion, offset));
      plan.removed.forEach((removal) => sequenced.push((offset) => sampleTombstoneStatement(db, user.id, removal, offset)));
    }
    if (!sequenced.length) break;

    const results = await db.batch([
      advanceSequenceStatement(db, user.id, sequenced.length, newChunks),
      ...sequenced.map((build, index) => build(sequenced.length - 1 - index)),
      ...trailing,
    ]);
    const changedAt = (index: number) => (results[index + 1]?.meta.changes ?? 0) > 0;
    if (recordStatementsPending) {
      for (let index = 0; index < photoCount; index += 1) if (changedAt(index)) changed += 1;
      for (let index = 0; index < eventDeletionCount; index += 1) if (changedAt(photoCount + index)) deleted += 1;
      recordStatementsPending = false;
    }
    let statementIndex = photoCount + eventDeletionCount;
    for (const plan of plans) {
      if (changedAt(statementIndex)) {
        changed += plan.changed;
        deleted += plan.removed.length;
        pendingUpserts.delete(plan.bucket);
        pendingRemovals.delete(plan.bucket);
      }
      statementIndex += 1 + plan.removed.length;
    }
  }
  if (pendingUpserts.size || pendingRemovals.size) {
    // Concurrent writes to the same window kept winning. Everything is
    // idempotent, so the client sends the batch again.
    return c.json({ error: { code: "write_conflict", message: "The records are being updated by another device. Try again." } }, 503);
  }

  return c.json({
    data: {
      accepted,
      changed,
      deleted,
      ...(rejected.length ? { rejected } : {}),
    },
  });
});

// Deleting everything removes the rows themselves. Other devices keep their
// own copies (each device is the source of truth for its records) and do not
// upload them again: a device only uploads records it has not backed up yet.
lifeEventRoutes.delete("/data", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO photo_cleanup(prefix) SELECT user_id || '/' || id || '/' FROM life_event WHERE user_id = ?1 AND source = 'photo' AND deleted_at IS NULL",
    ).bind(user.id),
    db.prepare("DELETE FROM photo_preview WHERE user_id = ?1").bind(user.id),
    db.prepare("DELETE FROM life_event WHERE user_id = ?1").bind(user.id),
    db.prepare("DELETE FROM location_chunk WHERE user_id = ?1").bind(user.id),
    db.prepare("DELETE FROM place WHERE user_id = ?1").bind(user.id),
    db.prepare("UPDATE user_sync_state SET chunk_count = 0, preview_count = 0 WHERE user_id = ?1").bind(user.id),
  ]);
  return c.body(null, 204);
});

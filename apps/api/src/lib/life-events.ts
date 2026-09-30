import { Hono } from "hono";
import type { AppContext } from "./auth";

export const EVENT_SOURCES = ["location", "photo"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export const PHOTO_LOCATION_SOURCES = ["exif", "inferred", "manual", "removed"] as const;
export type PhotoLocationSource = (typeof PHOTO_LOCATION_SOURCES)[number];
export const MEDIA_TYPES = ["photo", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const MAX_ID_LENGTH = 120;
const MAX_BATCH_ITEMS = 40;
const SYNC_PAGE_SIZE = 5_000;

// Server timestamps are taken inside SQLite rather than from the Worker clock.
// D1 executes writes serially on one primary, so the sync cursor order follows
// commit order instead of the order in which Workers happened to read clocks.
const DB_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// The sync cursor is exclusive on (updated_at, id), so every committed write
// must sort after every row a client may already have read. Wall time alone
// does not guarantee that: two transactions can share a millisecond (the later
// one with a smaller id), and the clock can step backwards. Taking the user's
// newest updated_at + 1 as a floor keeps updated_at strictly increasing across
// transactions. The max is one step on life_event_user_sync_idx. ?1 is the
// user id in every statement that uses it.
const NEXT_UPDATED_AT = `MAX(${DB_NOW_MS}, COALESCE((SELECT MAX(updated_at) FROM life_event WHERE user_id = ?1), -1) + 1)`;

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

export function normalizeEvent(input: EventInput): { data?: TimelineEvent; error?: string } {
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
      updatedAt: finiteNumber(input.updatedAt) ?? Date.now(),
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

type EventCursor = {
  updatedAt: number;
  id: string;
};

type FullPageCursor = EventCursor & {
  snapshotAt: number;
};

type DeletionInput = {
  id?: unknown;
  deletedAt?: unknown;
};

export type EventDeletion = {
  id: string;
  deletedAt: number | null;
};

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

function encodeFullPageCursor(cursor: FullPageCursor): string {
  return `${cursor.snapshotAt}|${cursor.updatedAt}|${cursor.id}`;
}

function parseFullPageCursor(value: string | undefined): FullPageCursor | undefined {
  if (!value) return undefined;
  const firstSeparator = value.indexOf("|");
  const secondSeparator = value.indexOf("|", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return undefined;
  const snapshotAt = Number(value.slice(0, firstSeparator));
  const updatedAt = Number(value.slice(firstSeparator + 1, secondSeparator));
  const id = value.slice(secondSeparator + 1);
  if (!Number.isSafeInteger(snapshotAt) || snapshotAt < 0) return undefined;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || !id) return undefined;
  return { snapshotAt, updatedAt, id };
}

function eventCursor(row: Record<string, unknown>): EventCursor | null {
  const updatedAt = finiteNumber(row.updated_at);
  const id = typeof row.id === "string" ? row.id : null;
  return updatedAt !== null && id ? { updatedAt: Math.round(updatedAt), id } : null;
}

export function normalizeDeletion(input: DeletionInput): { data?: EventDeletion; error?: string } {
  const id = eventId(input.id);
  const deletedAt = input.deletedAt == null ? null : finiteNumber(input.deletedAt);
  if (!id) return { error: `id must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
  if (input.deletedAt != null && deletedAt === null) return { error: "deletedAt is invalid" };
  return { data: { id, deletedAt } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ?9 is the nullable auto-placement flag: null keeps the stored value.
function upsertStatement(db: D1Database, userId: string, event: TimelineEvent) {
  return db.prepare(
    `INSERT INTO life_event
      (user_id, id, started_at, latitude, longitude, original_latitude, original_longitude, location_source, photo_location_auto_placement_disabled, accuracy_meters, media_type, photo_count, source, updated_at, client_updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 0), ?10, ?11, ?12, ?13, ${NEXT_UPDATED_AT}, ?14)
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
       deleted_at = NULL
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
  );
}

// deletedAt is the client clock, the same clock as upsert updatedAt, so a
// deletion and an edit from another device resolve as last-writer-wins.
// Without it the deletion always wins.
function deleteStatement(db: D1Database, userId: string, deletion: EventDeletion) {
  return db.prepare(
    `UPDATE life_event
     SET ${ERASE_PAYLOAD}, deleted_at = ${DB_NOW_MS}, updated_at = ${NEXT_UPDATED_AT},
       client_updated_at = COALESCE(?3, ${DB_NOW_MS})
     WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL
       AND (?3 IS NULL OR client_updated_at <= ?3)`,
  ).bind(userId, deletion.id, deletion.deletedAt);
}

// Deleting everything leaves tombstones instead of removing rows. Other
// devices keep their own copies (each device is the source of truth for its
// records), and the tombstones stop those copies from being uploaded again on
// their next full sync; a head that only moves forward also keeps every
// device's incremental cursor valid.
function deleteAllStatement(db: D1Database, userId: string) {
  return db.prepare(
    `UPDATE life_event
     SET ${ERASE_PAYLOAD}, deleted_at = ${DB_NOW_MS}, updated_at = ${NEXT_UPDATED_AT},
       client_updated_at = MAX(client_updated_at, ${DB_NOW_MS})
     WHERE user_id = ?1 AND deleted_at IS NULL`,
  ).bind(userId);
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

export const lifeEventRoutes = new Hono<AppContext>();

lifeEventRoutes.get("/events/head", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT updated_at, id
     FROM life_event
     WHERE user_id = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  ).bind(user.id).first<Record<string, unknown>>();
  const cursor = row ? eventCursor(row) : null;
  const response = c.json({ data: { cursor: cursor ? encodeEventCursor(cursor) : null } });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

// Every read is an index range on (user_id, updated_at, id) bounded by
// SYNC_PAGE_SIZE. Without a cursor the client receives a snapshot paged with
// `page`; with a cursor it receives the changes after that cursor.
lifeEventRoutes.get("/events", async (c) => {
  const user = c.get("user");
  const rawCursor = c.req.query("cursor");
  const rawPage = c.req.query("page");
  if (rawCursor !== undefined && rawPage !== undefined) {
    return c.json({ error: { code: "invalid_cursor", message: "cursor and page cannot be combined" } }, 400);
  }
  const cursor = rawCursor === undefined ? undefined : parseEventCursor(rawCursor);
  const page = rawPage === undefined ? undefined : parseFullPageCursor(rawPage);
  if (rawCursor !== undefined && !cursor) {
    return c.json({ error: { code: "invalid_cursor", message: "cursor must contain updatedAt and id" } }, 400);
  }
  if (rawPage !== undefined && !page) {
    return c.json({ error: { code: "invalid_page", message: "page is invalid" } }, 400);
  }

  const full = cursor === undefined;
  const after = cursor ?? page;
  // The first full page needs no upper bound: every committed row is at or
  // below the user's newest updated_at, which the same statement reads as the
  // snapshot for the following pages. Taking it from SQLite keeps the bound on
  // the same clock (and monotonic sequence) as updated_at itself.
  const query = cursor
    ? `SELECT ${EVENT_COLUMNS}, deleted_at
       FROM life_event
       WHERE user_id = ? AND (updated_at, id) > (?, ?)
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`
    : page
      ? `SELECT ${EVENT_COLUMNS}, deleted_at
         FROM life_event
         WHERE user_id = ? AND updated_at <= ? AND (updated_at, id) > (?, ?)
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`
      : `SELECT ${EVENT_COLUMNS}, deleted_at,
           (SELECT MAX(updated_at) FROM life_event WHERE user_id = ?1) AS snapshot_at
         FROM life_event
         WHERE user_id = ?1
         ORDER BY updated_at ASC, id ASC
         LIMIT ?2`;
  const bindArgs = cursor
    ? [user.id, cursor.updatedAt, cursor.id, SYNC_PAGE_SIZE]
    : page
      ? [user.id, page.snapshotAt, page.updatedAt, page.id, SYNC_PAGE_SIZE]
      : [user.id, SYNC_PAGE_SIZE];
  const { results: rows } = await c.env.DB.prepare(query).bind(...bindArgs).all<Record<string, unknown>>();
  const snapshotAt = page?.snapshotAt ?? finiteNumber(rows[0]?.snapshot_at);

  const events: Array<Record<string, unknown>> = [];
  const deletedIds: string[] = [];
  for (const row of rows) {
    if (row.deleted_at == null) events.push(row);
    else deletedIds.push(String(row.id));
  }
  // Rows are ordered by the cursor key, so the last row is the newest cursor.
  const last = rows.at(-1);
  const responseCursor = (last ? eventCursor(last) : null)
    ?? (after ? { updatedAt: after.updatedAt, id: after.id } : null);
  const hasMore = rows.length === SYNC_PAGE_SIZE && responseCursor !== null;

  return c.json({
    data: events.map(mapEvent),
    meta: {
      deletedIds,
      cursor: responseCursor ? encodeEventCursor(responseCursor) : null,
      hasMore,
      nextPage: full && hasMore && snapshotAt !== null ? encodeFullPageCursor({ snapshotAt, ...responseCursor }) : null,
      nextCursorToken: !full && hasMore ? encodeEventCursor(responseCursor) : null,
      full,
    },
  });
});

lifeEventRoutes.post("/events/batch", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ events?: unknown; deletions?: unknown }>().catch(() => null);
  const rawEvents = body?.events ?? [];
  const rawDeletions = body?.deletions ?? [];
  if (!isObject(body) || !Array.isArray(rawEvents) || !Array.isArray(rawDeletions)
    || rawEvents.length + rawDeletions.length === 0 || rawEvents.length + rawDeletions.length > MAX_BATCH_ITEMS) {
    return c.json({ error: { code: "invalid_batch", message: `events and deletions must contain 1-${MAX_BATCH_ITEMS} items in total` } }, 400);
  }

  const events: TimelineEvent[] = [];
  for (const [index, value] of rawEvents.entries()) {
    const parsed = isObject(value) ? normalizeEvent(value) : { error: "must be an object" };
    if (!parsed.data) {
      return c.json({ error: { code: "invalid_event", message: `events[${index}]: ${parsed.error}` } }, 400);
    }
    events.push(parsed.data);
  }
  const deletions: EventDeletion[] = [];
  for (const [index, value] of rawDeletions.entries()) {
    const parsed = isObject(value) ? normalizeDeletion(value) : { error: "must be an object" };
    if (!parsed.data) {
      return c.json({ error: { code: "invalid_deletion", message: `deletions[${index}]: ${parsed.error}` } }, 400);
    }
    deletions.push(parsed.data);
  }

  const results = await c.env.DB.batch([
    ...events.map((event) => upsertStatement(c.env.DB, user.id, event)),
    ...deletions.map((deletion) => deleteStatement(c.env.DB, user.id, deletion)),
    ...deletions.map((deletion) => c.env.DB.prepare(
      "INSERT OR IGNORE INTO photo_cleanup(prefix) VALUES (?1)",
    ).bind(`${user.id}/${deletion.id}/`)),
  ]);
  const changedCount = (from: number, to: number) =>
    results.slice(from, to).filter((result) => result.meta.changes > 0).length;
  return c.json({
    data: {
      accepted: events.length,
      changed: changedCount(0, events.length),
      deleted: changedCount(events.length, results.length),
    },
  });
});

lifeEventRoutes.delete("/data", async (c) => {
  const user = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO photo_cleanup(prefix) SELECT user_id || '/' || id || '/' FROM life_event WHERE user_id = ?1 AND source = 'photo' AND deleted_at IS NULL",
    ).bind(user.id),
    deleteAllStatement(c.env.DB, user.id),
  ]);
  return c.body(null, 204);
});

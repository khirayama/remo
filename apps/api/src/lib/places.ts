import { Hono } from "hono";
import type { AppContext } from "./auth";
import { MAX_CLIENT_CLOCK_SKEW_MS } from "./life-events";

// Names the user gives to places they stay at ("Home", "Office"). A place is a
// name at one or more anchors (a coordinate and a radius); clients show the
// name for stays within an anchor's radius (docs/CORRECTIONS.md). There are few
// of them, so they are synced as a whole: a client reads the full list and
// sends the places it changed. Conflicts resolve as last-writer-wins on the
// client clock, like timeline records.
export const placeRoutes = new Hono<AppContext>();

export const MAX_PLACES = 2_000;
const MAX_BATCH = 200;
export const MAX_PLACE_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 120;
export const MIN_PLACE_RADIUS_METERS = 25;
export const MAX_PLACE_RADIUS_METERS = 500;
export const DEFAULT_PLACE_RADIUS_METERS = 100;
export const MAX_PLACE_ANCHORS = 20;

export type PlaceAnchor = { latitude: number; longitude: number; radiusMeters: number };

/**
 * A place as clients send and receive it. `radiusMeters`, `anchors` and
 * `mergedInto` are undefined when a client did not send them (an older app);
 * the stored values are then kept.
 */
export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  anchors?: PlaceAnchor[];
  mergedInto?: string;
  updatedAt: number;
  deleted: boolean;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isLatitude = (value: unknown): value is number => finite(value) && value >= -90 && value <= 90;
const isLongitude = (value: unknown): value is number => finite(value) && value >= -180 && value <= 180;

export function clampRadius(value: number): number {
  return Math.min(MAX_PLACE_RADIUS_METERS, Math.max(MIN_PLACE_RADIUS_METERS, Math.round(value)));
}

export function normalizeAnchors(value: unknown): PlaceAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_PLACE_ANCHORS).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Record<string, unknown>;
    if (!isLatitude(raw.latitude) || !isLongitude(raw.longitude)) return [];
    const radius = finite(raw.radiusMeters) ? clampRadius(raw.radiusMeters) : DEFAULT_PLACE_RADIUS_METERS;
    return [{ latitude: raw.latitude, longitude: raw.longitude, radiusMeters: radius }];
  });
}

export function normalizePlace(input: unknown, now = Date.now()): Place | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const deleted = raw.deleted === true;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_PLACE_NAME_LENGTH) : "";
  if (!id || id.length > MAX_ID_LENGTH || !finite(raw.updatedAt)) return undefined;
  if (!isLatitude(raw.latitude) || !isLongitude(raw.longitude)) return undefined;
  if (!deleted && !name) return undefined;
  const mergedInto = typeof raw.mergedInto === "string" ? raw.mergedInto.trim() : "";
  const anchors = normalizeAnchors(raw.anchors);
  return {
    id,
    name,
    latitude: raw.latitude,
    longitude: raw.longitude,
    ...(finite(raw.radiusMeters) ? { radiusMeters: clampRadius(raw.radiusMeters) } : {}),
    ...(anchors ? { anchors } : {}),
    ...(deleted && mergedInto && mergedInto.length <= MAX_ID_LENGTH && mergedInto !== id ? { mergedInto } : {}),
    updatedAt: Math.min(Math.round(raw.updatedAt), now + MAX_CLIENT_CLOCK_SKEW_MS),
    deleted,
  };
}

export const PLACE_COLUMNS = "id, name, latitude, longitude, radius_meters, anchors, merged_into, updated_at, deleted";

/** A stored row as clients receive it. A deleted place keeps only what last-writer-wins and merging need. */
export function placeFromRow(row: Record<string, unknown>): Place {
  const deleted = row.deleted === 1;
  let anchors: PlaceAnchor[] | undefined;
  if (!deleted && typeof row.anchors === "string") {
    try {
      anchors = normalizeAnchors(JSON.parse(row.anchors));
    } catch {
      anchors = undefined;
    }
  }
  return {
    id: String(row.id),
    name: deleted ? "" : String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    ...(!deleted && finite(row.radius_meters) ? { radiusMeters: row.radius_meters } : {}),
    ...(anchors?.length ? { anchors } : {}),
    ...(deleted && typeof row.merged_into === "string" && row.merged_into ? { mergedInto: row.merged_into } : {}),
    updatedAt: Number(row.updated_at),
    deleted,
  };
}

export async function readPlaces(db: D1Database, userId: string): Promise<Place[]> {
  const { results } = await db.prepare(`SELECT ${PLACE_COLUMNS} FROM place WHERE user_id = ?1 ORDER BY id LIMIT ?2`)
    .bind(userId, MAX_PLACES).all<Record<string, unknown>>();
  return results.map(placeFromRow);
}

export class PlaceLimitError extends Error {}

/**
 * Writes places, each only when it is newer than the stored copy. Fields a
 * client did not send keep their stored value; deleting a place erases its
 * name, coordinate, radius and anchors.
 */
export async function writePlaces(db: D1Database, userId: string, places: Place[]): Promise<void> {
  if (!places.length) return;
  const count = await db.prepare("SELECT COUNT(*) AS count FROM place WHERE user_id = ?1").bind(userId).first<{ count: number }>();
  if ((count?.count ?? 0) + places.length > MAX_PLACES) throw new PlaceLimitError("The place limit has been reached");
  await db.batch(places.map((place) => db.prepare(
    `INSERT INTO place (user_id, id, name, latitude, longitude, radius_meters, anchors, merged_into, updated_at, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(user_id, id) DO UPDATE SET
       name = excluded.name, latitude = excluded.latitude, longitude = excluded.longitude,
       radius_meters = CASE WHEN excluded.deleted = 1 THEN NULL ELSE COALESCE(excluded.radius_meters, place.radius_meters) END,
       anchors = CASE WHEN excluded.deleted = 1 THEN NULL ELSE COALESCE(excluded.anchors, place.anchors) END,
       merged_into = excluded.merged_into,
       updated_at = excluded.updated_at, deleted = excluded.deleted
     WHERE excluded.updated_at > place.updated_at`,
  ).bind(
    userId,
    place.id,
    place.deleted ? "" : place.name,
    // The coordinate of a deleted place is erased with its name.
    place.deleted ? 0 : place.latitude,
    place.deleted ? 0 : place.longitude,
    place.deleted ? null : place.radiusMeters ?? null,
    place.deleted || !place.anchors ? null : JSON.stringify(place.anchors),
    place.deleted ? place.mergedInto ?? null : null,
    place.updatedAt,
    place.deleted ? 1 : 0,
  )));
}

placeRoutes.get("/places", async (c) => {
  const response = c.json({ data: await readPlaces(c.env.DB, c.get("user").id) });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

placeRoutes.put("/places", async (c) => {
  const body = await c.req.json<{ places?: unknown }>().catch(() => null);
  const raw = body?.places;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) {
    return c.json({ error: { code: "invalid_places", message: `places must contain 1-${MAX_BATCH} items` } }, 400);
  }
  const now = Date.now();
  const places = raw.flatMap((item) => normalizePlace(item, now) ?? []);
  if (!places.length) return c.json({ data: { accepted: 0 } });
  try {
    await writePlaces(c.env.DB, c.get("user").id, places);
  } catch (error) {
    if (error instanceof PlaceLimitError) {
      return c.json({ error: { code: "storage_limit", message: error.message } }, 507);
    }
    throw error;
  }
  return c.json({ data: { accepted: places.length } });
});

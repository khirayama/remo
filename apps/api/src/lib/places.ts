import { Hono } from "hono";
import type { AppContext } from "./auth";
import { MAX_CLIENT_CLOCK_SKEW_MS } from "./life-events";

// Names the user gives to places they stay at ("Home", "Office"). A place is a
// name at a coordinate; clients show the name for stays near it. There are few
// of them, so they are synced as a whole: a client reads the full list and
// sends the places it changed. Conflicts resolve as last-writer-wins on the
// client clock, like timeline records.
export const placeRoutes = new Hono<AppContext>();

const MAX_PLACES = 2_000;
const MAX_BATCH = 200;
const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 120;

export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  updatedAt: number;
  deleted: boolean;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function normalizePlace(input: unknown, now = Date.now()): Place | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const deleted = raw.deleted === true;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  if (!id || id.length > MAX_ID_LENGTH || !finite(raw.updatedAt)) return undefined;
  if (!finite(raw.latitude) || raw.latitude < -90 || raw.latitude > 90) return undefined;
  if (!finite(raw.longitude) || raw.longitude < -180 || raw.longitude > 180) return undefined;
  if (!deleted && !name) return undefined;
  return {
    id,
    name,
    latitude: raw.latitude,
    longitude: raw.longitude,
    updatedAt: Math.min(Math.round(raw.updatedAt), now + MAX_CLIENT_CLOCK_SKEW_MS),
    deleted,
  };
}

placeRoutes.get("/places", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, latitude, longitude, updated_at, deleted FROM place WHERE user_id = ?1 ORDER BY id LIMIT ?2",
  ).bind(c.get("user").id, MAX_PLACES).all<Record<string, unknown>>();
  const response = c.json({
    data: results.map((row) => ({
      id: String(row.id),
      // A deleted place keeps only what last-writer-wins needs.
      name: row.deleted === 1 ? "" : String(row.name),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      updatedAt: Number(row.updated_at),
      deleted: row.deleted === 1,
    })),
  });
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
  const userId = c.get("user").id;
  const db = c.env.DB;
  const count = await db.prepare("SELECT COUNT(*) AS count FROM place WHERE user_id = ?1").bind(userId).first<{ count: number }>();
  if ((count?.count ?? 0) + places.length > MAX_PLACES) {
    return c.json({ error: { code: "storage_limit", message: "The place limit has been reached" } }, 507);
  }
  await db.batch(places.map((place) => db.prepare(
    `INSERT INTO place (user_id, id, name, latitude, longitude, updated_at, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id, id) DO UPDATE SET
       name = excluded.name, latitude = excluded.latitude, longitude = excluded.longitude,
       updated_at = excluded.updated_at, deleted = excluded.deleted
     WHERE excluded.updated_at > place.updated_at`,
    // The coordinate of a deleted place is erased with its name.
  ).bind(userId, place.id, place.deleted ? "" : place.name, place.deleted ? 0 : place.latitude, place.deleted ? 0 : place.longitude, place.updatedAt, place.deleted)));
  return c.json({ data: { accepted: places.length } });
});

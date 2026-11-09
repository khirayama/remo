import { Hono } from "hono";
import type { AppContext } from "./auth";
import { MAX_CLIENT_CLOCK_SKEW_MS } from "./life-events";

// Sleep sessions backed up from the device so the web app can show them. A
// device reads its sessions from Health Connect / HealthKit and sends the ones
// the cloud does not have yet; the web app reads them by the day they ended on.
// Conflicts resolve as last-writer-wins on the client clock, like timeline
// records.
export const sleepRoutes = new Hono<AppContext>();

export const MAX_SLEEP_SESSIONS = 20_000;
export const MAX_SLEEP_BATCH = 500;
const MAX_ID_LENGTH = 120;
const MAX_LIST_ROWS = 100_000;
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 48 * 60 * 60 * 1000;
const MIN_STARTED_AT = Date.UTC(1900, 0, 1);
const MAX_END_AHEAD_MS = 24 * 60 * 60 * 1000;
// D1 allows 100 bound parameters per statement.
const LOOKUP_CHUNK = 90;

export type SleepSession = { id: string; startedAt: number; endedAt: number; updatedAt: number };

export type SleepRejection = { index: number; id: string | null; message: string };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function normalizeSleepSession(input: unknown, now = Date.now()): { data?: SleepSession; error?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { error: "must be an object" };
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > MAX_ID_LENGTH) return { error: `id must be 1-${MAX_ID_LENGTH} characters` };
  if (!finite(raw.startedAt) || !finite(raw.endedAt)) return { error: "startedAt and endedAt must be numbers" };
  if (raw.updatedAt !== undefined && !finite(raw.updatedAt)) return { error: "updatedAt must be a number" };
  const startedAt = Math.round(raw.startedAt);
  const endedAt = Math.round(raw.endedAt);
  if (startedAt >= endedAt) return { error: "startedAt must be before endedAt" };
  if (endedAt - startedAt < MIN_DURATION_MS || endedAt - startedAt > MAX_DURATION_MS) {
    return { error: "duration must be between 1 second and 48 hours" };
  }
  if (startedAt < MIN_STARTED_AT) return { error: "startedAt is too old" };
  if (endedAt > now + MAX_END_AHEAD_MS) return { error: "endedAt is too far in the future" };
  return {
    data: {
      id,
      startedAt,
      endedAt,
      updatedAt: Math.min(Math.round(raw.updatedAt ?? now), now + MAX_CLIENT_CLOCK_SKEW_MS),
    },
  };
}

const invalidRange = (message: string) => ({ error: { code: "invalid_range", message } });

// A bound is a non-negative number of milliseconds; a missing one is undefined.
function parseBound(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

sleepRoutes.get("/sleep", async (c) => {
  const from = parseBound(c.req.query("from"));
  const to = parseBound(c.req.query("to"));
  if (from === null || to === null) return c.json(invalidRange("from and to must be non-negative numbers"), 400);
  if ((from === undefined) !== (to === undefined)) return c.json(invalidRange("from and to must be given together"), 400);
  if (from !== undefined && to !== undefined && from >= to) return c.json(invalidRange("from must be before to"), 400);

  const userId = c.get("user").id;
  const statement = from === undefined || to === undefined
    ? c.env.DB.prepare(
      `SELECT id, started_at, ended_at, updated_at FROM sleep_session
       WHERE user_id = ?1 ORDER BY started_at ASC, id ASC LIMIT ?2`,
    ).bind(userId, MAX_LIST_ROWS)
    : c.env.DB.prepare(
      `SELECT id, started_at, ended_at, updated_at FROM sleep_session
       WHERE user_id = ?1 AND ended_at >= ?2 AND ended_at < ?3 ORDER BY started_at ASC, id ASC LIMIT ?4`,
    ).bind(userId, from, to, MAX_LIST_ROWS);
  const { results } = await statement.all<Record<string, unknown>>();
  const response = c.json({
    data: results.map((row): SleepSession => ({
      id: String(row.id),
      startedAt: Number(row.started_at),
      endedAt: Number(row.ended_at),
      updatedAt: Number(row.updated_at),
    })),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

// One malformed session must not block the rest of a device's upload queue:
// valid ones are applied and invalid ones are reported back so the client can
// stop retrying them. Only a malformed request body is rejected as a whole.
sleepRoutes.post("/sleep/batch", async (c) => {
  const body = await c.req.json<{ sessions?: unknown }>().catch(() => null);
  const raw = body?.sessions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SLEEP_BATCH) {
    return c.json({ error: { code: "invalid_batch", message: `sessions must contain 1-${MAX_SLEEP_BATCH} items` } }, 400);
  }

  const now = Date.now();
  const rejected: SleepRejection[] = [];
  const sessions: SleepSession[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = normalizeSleepSession(value, now);
    if (parsed.data) sessions.push(parsed.data);
    else {
      const id = typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
        ? (value as { id: string }).id
        : null;
      rejected.push({ index, id, message: parsed.error ?? "invalid" });
    }
  }

  const db = c.env.DB;
  const userId = c.get("user").id;
  let changed = 0;
  if (sessions.length) {
    // Only a session with a new id counts against the limit; updating a stored
    // one is always allowed.
    const ids = [...new Set(sessions.map((session) => session.id))];
    const existing = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK) {
      const chunk = ids.slice(offset, offset + LOOKUP_CHUNK);
      const marks = chunk.map((_, index) => `?${index + 2}`).join(", ");
      const { results } = await db.prepare(`SELECT id FROM sleep_session WHERE user_id = ?1 AND id IN (${marks})`)
        .bind(userId, ...chunk).all<{ id: string }>();
      for (const row of results) existing.add(row.id);
    }
    const added = ids.length - existing.size;
    if (added > 0) {
      const count = await db.prepare("SELECT COUNT(*) AS count FROM sleep_session WHERE user_id = ?1").bind(userId).first<{ count: number }>();
      if ((count?.count ?? 0) + added > MAX_SLEEP_SESSIONS) {
        return c.json({ error: { code: "storage_limit", message: "The sleep session limit has been reached" } }, 507);
      }
    }
    const results = await db.batch(sessions.map((session) => db.prepare(
      `INSERT INTO sleep_session (user_id, id, started_at, ended_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id, id) DO UPDATE SET
         started_at = excluded.started_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= sleep_session.updated_at`,
    ).bind(userId, session.id, session.startedAt, session.endedAt, session.updatedAt)));
    changed = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }

  return c.json({
    data: {
      accepted: sessions.length,
      changed,
      ...(rejected.length ? { rejected } : {}),
    },
  });
});

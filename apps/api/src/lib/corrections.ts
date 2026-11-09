import { Hono } from "hono";
import type { AppContext } from "./auth";
import { advanceSequenceStatement, DB_NOW_MS, MAX_CLIENT_CLOCK_SKEW_MS, seqAt, TOMBSTONE_RETENTION_MS } from "./life-events";

// Corrections laid over the timeline (docs/CORRECTIONS.md): exclude location
// samples, join a range into one stay, or turn the stays in a range into
// movement. A correction is never edited, only created or deleted, so a write
// inserts a new id or marks an existing one deleted. Clients download what
// changed after their cursor (the user's sync sequence), so a sync reads only
// the corrections written since the last one.
export const correctionRoutes = new Hono<AppContext>();

export const CORRECTION_KINDS = ["exclude", "join_stay", "not_stay"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export type CorrectionSource = "app" | "mcp";

export type Correction = {
  id: string;
  kind: CorrectionKind;
  startedAt: number;
  endedAt: number;
  createdAt: number;
  source: CorrectionSource;
  deleted: boolean;
};

export const MAX_CORRECTION_SPAN_MS = 24 * 60 * 60 * 1000;
export const MAX_LIVE_CORRECTIONS = 10_000;
const MAX_BATCH = 200;
const PAGE_SIZE = 1_000;
const MAX_ID_LENGTH = 120;
const PURGE_BATCH_SIZE = 1_000;
const PURGE_MAX_BATCHES = 20;

const integer = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

export function normalizeCorrection(input: unknown, source: CorrectionSource, now = Date.now()): Correction | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > MAX_ID_LENGTH) return undefined;
  if (typeof raw.kind !== "string" || !(CORRECTION_KINDS as readonly string[]).includes(raw.kind)) return undefined;
  if (!integer(raw.startedAt) || !integer(raw.endedAt) || raw.startedAt < 0) return undefined;
  if (raw.endedAt < raw.startedAt || raw.endedAt - raw.startedAt > MAX_CORRECTION_SPAN_MS) return undefined;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? Math.round(raw.createdAt) : now;
  return {
    id,
    kind: raw.kind as CorrectionKind,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    createdAt: Math.min(createdAt, now + MAX_CLIENT_CLOCK_SKEW_MS),
    source,
    deleted: raw.deleted === true,
  };
}

const CORRECTION_COLUMNS = "id, kind, started_at, ended_at, created_at, source, deleted_at, updated_at";

export function correctionFromRow(row: Record<string, unknown>): Correction {
  return {
    id: String(row.id),
    kind: String(row.kind) as CorrectionKind,
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    createdAt: Number(row.created_at),
    source: row.source === "mcp" ? "mcp" : "app",
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
  };
}

export class CorrectionLimitError extends Error {}

/**
 * Adds new corrections and marks deleted ones. A correction that already
 * exists only ever changes from live to deleted; everything else about it is
 * fixed when it is created.
 */
export async function writeCorrections(db: D1Database, userId: string, corrections: Correction[]): Promise<void> {
  if (!corrections.length) return;
  const created = corrections.filter((correction) => !correction.deleted).length;
  if (created) {
    const live = await db.prepare("SELECT COUNT(*) AS count FROM timeline_correction WHERE user_id = ?1 AND deleted_at IS NULL")
      .bind(userId).first<{ count: number }>();
    if ((live?.count ?? 0) + created > MAX_LIVE_CORRECTIONS) throw new CorrectionLimitError("The correction limit has been reached");
  }
  await db.batch([
    advanceSequenceStatement(db, userId, corrections.length, 0),
    ...corrections.map((correction, index) => db.prepare(
      `INSERT INTO timeline_correction (user_id, id, kind, started_at, ended_at, created_at, source, deleted_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?8 = 1 THEN ${DB_NOW_MS} ELSE NULL END, ${seqAt("?9")})
       ON CONFLICT(user_id, id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
       WHERE timeline_correction.deleted_at IS NULL AND excluded.deleted_at IS NOT NULL`,
    ).bind(
      userId,
      correction.id,
      correction.kind,
      correction.startedAt,
      correction.endedAt,
      correction.createdAt,
      correction.source,
      correction.deleted ? 1 : 0,
      corrections.length - 1 - index,
    )),
  ]);
}

/** Live corrections that touch [from, to] (milliseconds, both ends included), oldest first. */
export async function readCorrectionsInRange(db: D1Database, userId: string, from: number, to: number): Promise<Correction[]> {
  // A correction covers at most MAX_CORRECTION_SPAN_MS, so its start is bounded too.
  const { results } = await db.prepare(
    `SELECT ${CORRECTION_COLUMNS} FROM timeline_correction
     WHERE user_id = ?1 AND deleted_at IS NULL AND started_at BETWEEN ?2 AND ?3 AND ended_at >= ?4
     ORDER BY created_at, id LIMIT ?5`,
  ).bind(userId, from - MAX_CORRECTION_SPAN_MS, to, from, MAX_LIVE_CORRECTIONS).all<Record<string, unknown>>();
  return results.map(correctionFromRow);
}

export async function readCorrection(db: D1Database, userId: string, id: string): Promise<Correction | undefined> {
  const row = await db.prepare(`SELECT ${CORRECTION_COLUMNS} FROM timeline_correction WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id).first<Record<string, unknown>>();
  return row ? correctionFromRow(row) : undefined;
}

/** Removes deleted corrections past the tombstone retention window. Returns the rows removed. */
export async function purgeDeletedCorrections(db: D1Database, now: number): Promise<number> {
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  let purged = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const result = await db.prepare(
      `DELETE FROM timeline_correction
       WHERE (user_id, id) IN (
         SELECT user_id, id FROM timeline_correction WHERE deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT ?2
       )`,
    ).bind(cutoff, PURGE_BATCH_SIZE).run();
    purged += result.meta.changes;
    if (result.meta.changes < PURGE_BATCH_SIZE) break;
  }
  return purged;
}

correctionRoutes.get("/corrections", async (c) => {
  const afterParameter = c.req.query("after") ?? "0";
  const after = /^\d{1,16}$/.test(afterParameter) ? Number(afterParameter) : Number.NaN;
  if (!Number.isSafeInteger(after)) {
    return c.json({ error: { code: "invalid_cursor", message: "after must be a cursor returned by this endpoint" } }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${CORRECTION_COLUMNS} FROM timeline_correction WHERE user_id = ?1 AND updated_at > ?2 ORDER BY updated_at LIMIT ?3`,
  ).bind(c.get("user").id, after, PAGE_SIZE + 1).all<Record<string, unknown>>();
  const page = results.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const response = c.json({
    data: {
      corrections: page.map(correctionFromRow),
      cursor: last ? Number(last.updated_at) : after,
      hasMore: results.length > PAGE_SIZE,
    },
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

correctionRoutes.put("/corrections", async (c) => {
  const body = await c.req.json<{ corrections?: unknown }>().catch(() => null);
  const raw = body?.corrections;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) {
    return c.json({ error: { code: "invalid_corrections", message: `corrections must contain 1-${MAX_BATCH} items` } }, 400);
  }
  const now = Date.now();
  // The same id twice in one request would take two sequence values for one row.
  const byId = new Map<string, Correction>();
  for (const item of raw) {
    const correction = normalizeCorrection(item, "app", now);
    if (!correction) continue;
    const previous = byId.get(correction.id);
    byId.set(correction.id, previous ? { ...previous, deleted: previous.deleted || correction.deleted } : correction);
  }
  const corrections = [...byId.values()];
  try {
    await writeCorrections(c.env.DB, c.get("user").id, corrections);
  } catch (error) {
    if (error instanceof CorrectionLimitError) {
      return c.json({ error: { code: "storage_limit", message: error.message } }, 507);
    }
    throw error;
  }
  return c.json({ data: { accepted: corrections.length } });
});

/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/lib/auth";
import { lifeEventRoutes, TOMBSTONE_RETENTION_MS } from "../src/lib/life-events";
import { runMaintenance } from "../src/lib/maintenance";

// Runs the routes against real SQLite with every migration applied, so the
// SQL itself (conflict targets, numbered parameters, LWW guards) is exercised.
// The adapter mirrors the D1 surface the routes use, including D1's
// boolean-to-integer binding and all-or-nothing batches.
function d1(database: DatabaseSync): D1Database {
  const toParams = (values: unknown[]) => values.map((value) =>
    typeof value === "boolean" ? Number(value) : value) as Array<string | number | null>;
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => ({ results: database.prepare(sql).all(...toParams(params)) }),
    first: async () => database.prepare(sql).get(...toParams(params)) ?? null,
    run: async () => ({ meta: { changes: Number(database.prepare(sql).run(...toParams(params)).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const current of statements) results.push(await current.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function setup() {
  const database = new DatabaseSync(":memory:");
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url).href);
  for (const file of readdirSync(migrations).sort()) {
    database.exec(readFileSync(join(migrations, file), "utf8"));
  }
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES ('user-1', 'One', 'one@example.com', 0, 0), ('user-2', 'Two', 'two@example.com', 0, 0)`);
  const env = { DB: d1(database) };
  const as = (userId: string) => {
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("user", { id: userId, email: `${userId}@example.com`, name: userId });
      await next();
    });
    app.route("/", lifeEventRoutes);
    return {
      get: async (path: string) => {
        const response = await app.request(path, {}, env);
        return { status: response.status, body: await response.json() as any };
      },
      batch: async (body: unknown) => {
        const response = await app.request("/events/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, env);
        return { status: response.status, body: await response.json() as any };
      },
      deleteAll: async () => (await app.request("/data", { method: "DELETE" }, env)).status,
    };
  };
  return { database, as, env };
}

const event = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  startedAt: 1_000,
  latitude: 35.6,
  longitude: 139.7,
  source: "location",
  updatedAt,
  ...extra,
});

describe("timeline sync against SQLite", () => {
  it("stores records without a separate id index", () => {
    const { database } = setup();
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'life_event'").all();
    expect(indexes).toEqual([{ name: "life_event_user_sync_idx" }, { name: "life_event_tombstone_idx" }]);
  });

  it("applies last-writer-wins and skips identical rewrites", async () => {
    const { as } = setup();
    const user = as("user-1");

    expect((await user.batch({ events: [event("a", 10)] })).body.data).toEqual({ accepted: 1, changed: 1, deleted: 0 });
    expect((await user.batch({ events: [event("a", 10)] })).body.data.changed).toBe(0);
    expect((await user.batch({ events: [event("a", 5, { latitude: 1, longitude: 1 })] })).body.data.changed).toBe(0);
    expect((await user.batch({ events: [event("a", 20, { photoCount: 3 })] })).body.data.changed).toBe(1);

    const synced = await user.get("/events");
    expect(synced.body.data).toMatchObject([{ id: "a", photoCount: 3, latitude: 35.6, updatedAt: 20 }]);
  });

  it("keeps the auto-placement flag when a client omits it", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("p", 10, { source: "photo", photoLocationAutoPlacementDisabled: true })] });
    await user.batch({ events: [event("p", 20, { source: "photo", photoLocationAutoPlacementDisabled: null })] });

    expect((await user.get("/events")).body.data[0].photoLocationAutoPlacementDisabled).toBe(true);
  });

  it("scopes client ids per user", async () => {
    const { as } = setup();
    await as("user-1").batch({ events: [event("shared", 10)] });
    expect((await as("user-2").batch({ events: [event("shared", 5)] })).body.data.changed).toBe(1);

    expect((await as("user-1").get("/events")).body.data).toMatchObject([{ id: "shared", updatedAt: 10 }]);
    expect((await as("user-2").get("/events")).body.data).toMatchObject([{ id: "shared", updatedAt: 5 }]);
  });

  it("deletes in a batch using the client clock", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("old", 10), event("newer", 30)] });

    const result = await user.batch({ deletions: [{ id: "old", deletedAt: 20 }, { id: "newer", deletedAt: 20 }, { id: "missing" }] });
    expect(result.body.data).toEqual({ accepted: 0, changed: 0, deleted: 1 });

    const synced = await user.get("/events");
    expect(synced.body.data).toMatchObject([{ id: "newer" }]);
    expect(synced.body.meta.deletedIds).toEqual(["old"]);

    // An edit made after the deletion restores the record; a stale one does not.
    expect((await user.batch({ events: [event("old", 15)] })).body.data.changed).toBe(0);
    expect((await user.batch({ events: [event("old", 25)] })).body.data.changed).toBe(1);
  });

  it("returns only rows after the incremental cursor", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10)] });
    const first = await user.get("/events");
    const cursor = first.body.meta.cursor as string;

    const unchanged = await user.get(`/events?cursor=${encodeURIComponent(cursor)}`);
    expect(unchanged.body).toMatchObject({ data: [], meta: { cursor, full: false, hasMore: false } });

    await user.batch({ events: [event("b", 10)] });
    const head = await user.get("/events/head");
    const changed = await user.get(`/events?cursor=${encodeURIComponent(cursor)}`);
    expect(changed.body.data.map((row: { id: string }) => row.id)).toEqual(["b"]);
    expect(changed.body.meta.cursor).toBe(head.body.data.cursor);
  });

  it("rejects oversized ids and empty batches", async () => {
    const { as } = setup();
    const user = as("user-1");
    expect((await user.batch({ events: [event("x".repeat(121), 10)] })).status).toBe(400);
    expect((await user.batch({ events: [null] })).status).toBe(400);
    expect((await user.batch({ events: [], deletions: [] })).status).toBe(400);
  });

  it("keeps updated_at increasing across transactions in the same millisecond", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("b", 10)] });
    // Simulate a clock step backwards: the stored row is ahead of wall time.
    const future = Date.now() + 60_000;
    database.exec(`UPDATE life_event SET updated_at = ${future} WHERE id = 'b'`);
    const cursor = (await user.get("/events")).body.meta.cursor as string;

    // "a" sorts before "b"; with wall time alone it would land behind the cursor.
    await user.batch({ events: [event("a", 10), event("c", 10)] });
    const changed = await user.get(`/events?cursor=${encodeURIComponent(cursor)}`);
    expect(changed.body.data.map((row: { id: string }) => row.id)).toEqual(["a", "c"]);

    const rows = database.prepare("SELECT id, updated_at FROM life_event ORDER BY updated_at").all() as Array<{ id: string; updated_at: number }>;
    expect(rows.map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(rows[1]!.updated_at).toBe(future + 1);
    expect(rows[2]!.updated_at).toBe(future + 2);
  });

  it("finds the newest updated_at with one index step", () => {
    const { database } = setup();
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT MAX(updated_at) FROM life_event WHERE user_id = 'user-1'").all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("life_event_user_sync_idx");
  });

  it("erases the payload of deleted records", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("p", 10, { source: "photo", photoCount: 2, accuracyMeters: 5 })] });
    await user.batch({ deletions: [{ id: "p", deletedAt: 20 }] });

    expect(database.prepare("SELECT started_at, latitude, longitude, accuracy_meters, media_type, photo_count FROM life_event WHERE id = 'p'").get())
      .toEqual({ started_at: 0, latitude: null, longitude: null, accuracy_meters: null, media_type: null, photo_count: 0 });
    // A later edit still restores the full record.
    await user.batch({ events: [event("p", 30, { source: "photo", photoCount: 2 })] });
    expect((await user.get("/events")).body.data).toMatchObject([{ id: "p", latitude: 35.6, photoCount: 2, mediaType: "photo" }]);
  });

  it("turns delete-all into tombstones that reach other devices", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    const now = Date.now();
    await user.batch({ events: [event("a", now - 1_000), event("b", now - 1_000)] });
    await as("user-2").batch({ events: [event("other", now - 1_000)] });
    // Another device has already synced both records.
    const cursor = (await user.get("/events")).body.meta.cursor as string;

    expect(await user.deleteAll()).toBe(204);

    const head = await user.get("/events/head");
    expect(head.body.data.cursor > cursor).toBe(true);
    const changed = await user.get(`/events?cursor=${encodeURIComponent(cursor)}`);
    expect(changed.body).toMatchObject({ data: [], meta: { deletedIds: ["a", "b"] } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM life_event WHERE user_id = 'user-1' AND latitude IS NOT NULL").get()).toEqual({ count: 0 });

    // That device's older copy is not uploaded back by its next full sync.
    expect((await user.batch({ events: [event("a", now - 1_000)] })).body.data.changed).toBe(0);
    // Records created after the deletion are backed up as usual.
    expect((await user.batch({ events: [event("new", Date.now() + 1_000)] })).body.data.changed).toBe(1);
    // Other users are untouched.
    expect((await as("user-2").get("/events")).body.data).toMatchObject([{ id: "other" }]);
  });

  it("purges tombstones, sessions and verifications past their retention", async () => {
    const { as, database, env } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("old", 10), event("recent", 10), event("active", 10)] });
    await user.batch({ deletions: [{ id: "old", deletedAt: 20 }, { id: "recent", deletedAt: 20 }] });
    const now = Date.now();
    database.exec(`UPDATE life_event SET deleted_at = ${now - TOMBSTONE_RETENTION_MS - 1} WHERE id = 'old'`);
    database.exec(`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
      VALUES ('expired', ${now - 1}, 't1', 0, 0, 'user-1'), ('valid', ${now + 60_000}, 't2', 0, 0, 'user-1')`);
    database.exec(`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES ('expired', 'reset', 'v', ${now - 1}, 0, 0)`);

    expect(await runMaintenance(env.DB, now)).toEqual({ tombstones: 1, sessions: 1, verifications: 1 });
    expect(database.prepare("SELECT id FROM life_event ORDER BY id").all()).toEqual([{ id: "active" }, { id: "recent" }]);
    expect(database.prepare("SELECT id FROM session").all()).toEqual([{ id: "valid" }]);
  });

  it("finds expired tombstones through the partial index", () => {
    const { database } = setup();
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT user_id, id FROM life_event WHERE deleted_at IS NOT NULL AND deleted_at < 1 LIMIT 10").all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("life_event_tombstone_idx");
  });

  it("pages a full sync against a snapshot taken from the database", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001)
      INSERT INTO life_event (user_id, id, started_at, source, updated_at, client_updated_at)
      SELECT 'user-1', printf('e%05d', i), i, 'location', i, i FROM n`);

    const first = await user.get("/events");
    expect(first.body.data).toHaveLength(5000);
    expect(first.body.meta.nextPage).toBe("5001|5000|e05000");

    // A write between pages is left to the incremental sync that follows.
    await user.batch({ events: [event("late", 10)] });
    const second = await user.get(`/events?page=${encodeURIComponent(first.body.meta.nextPage)}`);
    expect(second.body.data.map((row: { id: string }) => row.id)).toEqual(["e05001"]);
    expect(second.body.meta).toMatchObject({ hasMore: false, nextPage: null, cursor: "5001|e05001" });

    const rest = await user.get(`/events?cursor=${encodeURIComponent(second.body.meta.cursor)}`);
    expect(rest.body.data.map((row: { id: string }) => row.id)).toEqual(["late"]);
  });
});

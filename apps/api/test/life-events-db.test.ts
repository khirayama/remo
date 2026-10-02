/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/lib/auth";
import { lifeEventRoutes, MAX_BATCH_ITEMS, MAX_CHUNK_BYTES, MAX_CLIENT_CLOCK_SKEW_MS, TOMBSTONE_RETENTION_MS } from "../src/lib/life-events";
import { placeRoutes } from "../src/lib/places";
import { runMaintenance } from "../src/lib/maintenance";
import { photoRoutes } from "../src/lib/photos";

// Runs the routes against real SQLite with every migration applied, so the
// SQL itself (conflict targets, numbered parameters, LWW guards) is exercised.
// The adapter mirrors the D1 surface the routes use, including D1's
// boolean-to-integer binding and all-or-nothing batches.
function d1(database: DatabaseSync, onStatement: (sql: string) => void = () => {}): D1Database {
  const toParams = (values: unknown[]) => values.map((value) =>
    typeof value === "boolean" ? Number(value) : value) as Array<string | number | null>;
  const isRead = (sql: string) => /^\s*SELECT/i.test(sql);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => { onStatement(sql); return { results: database.prepare(sql).all(...toParams(params)), meta: { changes: 0 } }; },
    first: async () => { onStatement(sql); return database.prepare(sql).get(...toParams(params)) ?? null; },
    run: async () => { onStatement(sql); return { results: [], meta: { changes: Number(database.prepare(sql).run(...toParams(params)).changes) } }; },
    execute: async () => isRead(sql) ? statement(sql, params).all() : statement(sql, params).run(),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const current of statements) results.push(await current.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const migrations = fileURLToPath(new URL("../migrations", import.meta.url).href);

function migrate(database: DatabaseSync, from: string, through: string) {
  for (const file of readdirSync(migrations).sort()) {
    if (file > from && file.slice(0, 4) <= through) database.exec(readFileSync(join(migrations, file), "utf8"));
  }
}

function setup(onStatement?: (sql: string) => void) {
  const database = new DatabaseSync(":memory:");
  migrate(database, "", "9999");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES ('user-1', 'One', 'one@example.com', 0, 0), ('user-2', 'Two', 'two@example.com', 0, 0)`);
  const env = { DB: d1(database, onStatement) };
  const as = (userId: string) => {
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("user", { id: userId, email: `${userId}@example.com`, name: userId });
      await next();
    });
    app.route("/", lifeEventRoutes);
    app.route("/", placeRoutes);
    const json = async (path: string, method: string, body?: unknown) => {
      const response = await app.request(path, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }, env);
      return { status: response.status, body: await response.json() as any };
    };
    return {
      get: (path: string) => json(path, "GET"),
      batch: (body: unknown) => json("/events/batch", "POST", body),
      putPlaces: (places: unknown) => json("/places", "PUT", { places }),
      deleteAll: async () => (await app.request("/data", { method: "DELETE" }, env)).status,
      /** Follows a sync to its end and returns everything it delivered. */
      sync: async (cursor?: string) => {
        const ids: string[] = [];
        const deletedIds: string[] = [];
        const deletions: Array<{ id: string; deletedAt: number }> = [];
        let path = cursor ? `/events?cursor=${encodeURIComponent(cursor)}` : "/events";
        let pages = 0;
        for (;;) {
          const { body } = await json(path, "GET");
          pages += 1;
          ids.push(...body.data.map((row: { id: string }) => row.id));
          deletedIds.push(...body.meta.deletedIds);
          deletions.push(...body.meta.deletions);
          if (body.meta.nextPage) path = `/events?page=${encodeURIComponent(body.meta.nextPage)}`;
          else if (body.meta.nextCursorToken) path = `/events?cursor=${encodeURIComponent(body.meta.nextCursorToken)}`;
          else return { ids, deletedIds, deletions, cursor: body.meta.cursor as string | null, pages, full: body.meta.full as boolean };
        }
      },
    };
  };
  return { database, as, env };
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1);

const event = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  startedAt: T0,
  latitude: 35.6,
  longitude: 139.7,
  source: "location",
  updatedAt,
  ...extra,
});
const photo = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => event(id, updatedAt, { source: "photo", ...extra });

describe("timeline sync against SQLite", () => {
  it("stores location samples in one row per time window", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    const result = await user.batch({ events: [
      event("a", 10), event("b", 10, { startedAt: T0 + HOUR }), event("c", 10, { startedAt: T0 + 7 * HOUR }),
    ] });
    expect(result.body.data).toEqual({ accepted: 3, changed: 3, deleted: 0 });

    expect(database.prepare("SELECT sample_count FROM location_chunk ORDER BY bucket").all()).toEqual([{ sample_count: 2 }, { sample_count: 1 }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM life_event").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT chunk_count FROM user_sync_state").get()).toEqual({ chunk_count: 2 });
    expect((await user.sync()).ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("applies last-writer-wins and skips identical rewrites", async () => {
    const { as } = setup();
    const user = as("user-1");

    for (const make of [event, photo]) {
      const id = make === event ? "loc" : "pic";
      expect((await user.batch({ events: [make(id, 10)] })).body.data).toEqual({ accepted: 1, changed: 1, deleted: 0 });
      expect((await user.batch({ events: [make(id, 10)] })).body.data.changed).toBe(0);
      expect((await user.batch({ events: [make(id, 5, { latitude: 1, longitude: 1 })] })).body.data.changed).toBe(0);
      expect((await user.batch({ events: [make(id, 20, { latitude: 36 })] })).body.data.changed).toBe(1);
    }

    const synced = await user.get("/events");
    expect(synced.body.data).toMatchObject([
      { id: "pic", source: "photo", latitude: 36, updatedAt: 20 },
      { id: "loc", source: "location", latitude: 36, updatedAt: 20 },
    ]);
  });

  it("does not write when a batch changes nothing", async () => {
    const statements: string[] = [];
    const { as } = setup((sql) => statements.push(sql));
    const user = as("user-1");
    await user.batch({ events: [event("a", 10)] });
    statements.length = 0;
    await user.batch({ events: [event("a", 10)] });
    expect(statements.filter((sql) => !/^\s*SELECT/i.test(sql))).toEqual([]);
  });

  it("keeps the auto-placement flag when a client omits it", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("p", 10, { photoLocationAutoPlacementDisabled: true })] });
    await user.batch({ events: [photo("p", 20, { photoLocationAutoPlacementDisabled: null })] });

    expect((await user.get("/events")).body.data[0].photoLocationAutoPlacementDisabled).toBe(true);
  });

  it("scopes client ids per user", async () => {
    const { as } = setup();
    for (const make of [event, photo]) {
      const id = make === event ? "shared" : "shared-photo";
      await as("user-1").batch({ events: [make(id, 10)] });
      expect((await as("user-2").batch({ events: [make(id, 5)] })).body.data.changed).toBe(1);
    }
    expect((await as("user-1").get("/events")).body.data.map((row: any) => row.updatedAt)).toEqual([10, 10]);
    expect((await as("user-2").get("/events")).body.data.map((row: any) => row.updatedAt)).toEqual([5, 5]);
  });

  it("deletes photo records and location samples using the client clock", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("old", 10), photo("newer", 30), event("loc-old", 10), event("loc-newer", 30)] });

    const result = await user.batch({ deletions: [
      { id: "old", deletedAt: 20 }, { id: "newer", deletedAt: 20 },
      { id: "loc-old", deletedAt: 20 }, { id: "loc-newer", deletedAt: 20 }, { id: "missing" },
    ] });
    expect(result.body.data).toEqual({ accepted: 0, changed: 0, deleted: 2 });

    const synced = await user.sync();
    expect(synced.ids.sort()).toEqual(["loc-newer", "newer"]);
    expect(synced.deletedIds.sort()).toEqual(["loc-old", "old"]);
    // Records deleted one by one are removed from other devices too.
    expect(synced.deletions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "loc-old", deletedAt: 20 }, { id: "old", deletedAt: 20 }]);

    // An edit made after the deletion restores the record; a stale one does not.
    expect((await user.batch({ events: [photo("old", 15)] })).body.data.changed).toBe(0);
    expect((await user.batch({ events: [photo("old", 25)] })).body.data.changed).toBe(1);
    expect((await user.sync()).deletions.map((item) => item.id)).toEqual(["loc-old"]);
  });

  it("finds a location sample to delete from the hints or by searching the chunks", async () => {
    const statements: string[] = [];
    const { as } = setup((sql) => statements.push(sql));
    const user = as("user-1");
    await user.batch({ events: [event("hinted", 10), event("searched", 10, { startedAt: T0 + 30 * HOUR })] });

    statements.length = 0;
    expect((await user.batch({ deletions: [{ id: "hinted", deletedAt: 20, startedAt: T0, source: "location" }] })).body.data.deleted).toBe(1);
    expect(statements.some((sql) => sql.includes("instr("))).toBe(false);

    expect((await user.batch({ deletions: [{ id: "searched", deletedAt: 20 }] })).body.data.deleted).toBe(1);
    expect((await user.sync()).ids).toEqual([]);
    // A photo hint never searches the chunks.
    statements.length = 0;
    await user.batch({ deletions: [{ id: "unknown-photo", deletedAt: 20, source: "photo" }] });
    expect(statements.some((sql) => sql.includes("location_chunk"))).toBe(false);
  });

  it("returns only what changed after the incremental cursor", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10), photo("p", 10)] });
    const first = await user.sync();
    expect(first.full).toBe(true);
    const cursor = first.cursor!;
    expect((await user.get("/events/head")).body.data.cursor).toBe(cursor);

    const unchanged = await user.get(`/events?cursor=${encodeURIComponent(cursor)}`);
    expect(unchanged.body).toMatchObject({ data: [], meta: { cursor, full: false, hasMore: false } });

    // "b" joins the chunk that already holds "a"; only "b" is sent.
    await user.batch({ events: [event("b", 10, { startedAt: T0 + 1 }), photo("q", 10)] });
    const head = await user.get("/events/head");
    const changed = await user.sync(cursor);
    expect(changed.ids.sort()).toEqual(["b", "q"]);
    expect(changed.cursor).toBe(head.body.data.cursor);
    expect((await user.sync(changed.cursor!)).ids).toEqual([]);
  });

  it("moves the cursor past writes that changed nothing", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("p", 10)] });
    const cursor = (await user.sync()).cursor!;
    // A stale edit takes a sequence value but leaves the row alone.
    await user.batch({ events: [photo("p", 5, { photoCount: 9 })] });
    const head = (await user.get("/events/head")).body.data.cursor as string;
    expect(head).not.toBe(cursor);
    expect((await user.sync(cursor)).cursor).toBe(head);
  });

  it("applies valid items and reports invalid ones instead of failing the batch", async () => {
    const { as } = setup();
    const user = as("user-1");
    const result = await user.batch({
      events: [event("x".repeat(121), 10), null, event("ok", 10)],
      deletions: [{ id: "" }],
    });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 1, changed: 1, deleted: 0 });
    expect(result.body.data.rejected.map((item: { kind: string; index: number }) => [item.kind, item.index]))
      .toEqual([["event", 0], ["event", 1], ["deletion", 0]]);
    expect((await user.get("/events")).body.data.map((row: { id: string }) => row.id)).toEqual(["ok"]);

    expect((await user.batch({ events: [], deletions: [] })).status).toBe(400);
    expect((await user.batch({ events: "x" })).status).toBe(400);
    expect((await user.batch({ events: Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) => event(`e${index}`, 10)) })).status).toBe(400);
  });

  it("caps client timestamps that run ahead of the server clock", async () => {
    const { as } = setup();
    const user = as("user-1");
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await user.batch({ events: [photo("skewed", farFuture)] });
    const stored = (await user.get("/events")).body.data[0].updatedAt as number;
    expect(stored).toBeLessThanOrEqual(Date.now() + MAX_CLIENT_CLOCK_SKEW_MS);
    // A correct device editing later still wins.
    expect((await user.batch({ events: [photo("skewed", Date.now() + MAX_CLIENT_CLOCK_SKEW_MS + 1_000, { photoCount: 2 })] })).body.data.changed).toBe(1);
  });

  it("queues preview cleanup only for deleted photo records", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("loc", 10), photo("pic", 10)] });
    database.exec("INSERT INTO photo_preview (user_id, event_id, digest) VALUES ('user-1', 'pic', 'd1')");
    database.exec("UPDATE user_sync_state SET preview_count = 1 WHERE user_id = 'user-1'");
    const result = await user.batch({ deletions: [{ id: "loc", deletedAt: 20 }, { id: "pic", deletedAt: 20 }] });
    expect(result.body.data.deleted).toBe(2);
    expect(database.prepare("SELECT prefix FROM photo_cleanup").all()).toEqual([{ prefix: "user-1/pic/" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM photo_preview").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT preview_count FROM user_sync_state").get()).toEqual({ preview_count: 0 });
  });

  it("gives every written row its own increasing sequence value", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("b", 10)] });
    // Simulate a clock step backwards: the sequence is ahead of wall time.
    const future = Date.now() + 60_000;
    database.exec(`UPDATE user_sync_state SET seq = ${future}`);
    database.exec(`UPDATE life_event SET updated_at = ${future} WHERE id = 'b'`);
    const cursor = (await user.sync()).cursor!;

    // "a" sorts before "b"; with wall time alone it would land behind the cursor.
    await user.batch({ events: [photo("a", 10), photo("c", 10), event("loc", 10)] });
    expect((await user.sync(cursor)).ids).toEqual(["a", "c", "loc"]);

    const rows = database.prepare(
      "SELECT id, updated_at FROM life_event UNION ALL SELECT 'chunk', updated_at FROM location_chunk ORDER BY updated_at",
    ).all() as Array<{ id: string; updated_at: number }>;
    expect(rows.map((row) => [row.id, row.updated_at - future])).toEqual([["b", 0], ["a", 1], ["c", 2], ["chunk", 3]]);
    expect(database.prepare("SELECT seq FROM user_sync_state").get()).toEqual({ seq: future + 3 });
  });

  it("merges again when another device wrote the same window first", async () => {
    const { as, database, env } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10)] });
    // Between this request's read and its write, another request adds "b".
    const batch = env.DB.batch.bind(env.DB);
    let interfered = false;
    env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      const results = await batch(statements);
      if (!interfered && statements.length > 1 && (results[1] as any)?.results?.[0]?.payload) {
        interfered = true;
        database.exec(`UPDATE location_chunk SET payload = json_insert(payload, '$[#]', json_array('b', ${T0 + 5}, 1.0, 2.0, NULL, 10, updated_at + 1)), sample_count = 2, updated_at = updated_at + 1`);
        database.exec("UPDATE user_sync_state SET seq = seq + 1");
      }
      return results;
    }) as typeof env.DB.batch;

    expect((await user.batch({ events: [event("c", 10, { startedAt: T0 + 9 })] })).body.data.changed).toBe(1);
    expect(interfered).toBe(true);
    expect((await user.sync()).ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("erases the payload of deleted records", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("p", 10, { photoCount: 2, accuracyMeters: 5 }), event("loc", 10)] });
    await user.batch({ deletions: [{ id: "p", deletedAt: 20 }, { id: "loc", deletedAt: 20 }] });

    expect(database.prepare("SELECT id, started_at, latitude, longitude, accuracy_meters, media_type, photo_count FROM life_event ORDER BY id").all())
      .toEqual(["loc", "p"].map((id) => ({ id, started_at: 0, latitude: null, longitude: null, accuracy_meters: null, media_type: null, photo_count: 0 })));
    expect(database.prepare("SELECT payload FROM location_chunk").get()).toEqual({ payload: "[]" });
    // A later edit still restores the full record.
    await user.batch({ events: [photo("p", 30, { photoCount: 2 })] });
    expect((await user.get("/events")).body.data).toMatchObject([{ id: "p", latitude: 35.6, photoCount: 2, mediaType: "photo" }]);
  });

  it("removes every row on delete-all without telling other devices to delete theirs", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10), photo("p", 10)] });
    await user.putPlaces([{ id: "home", name: "Home", latitude: 35, longitude: 139, updatedAt: 10 }]);
    await as("user-2").batch({ events: [event("other", 10)] });
    // Another device has already synced both records.
    const cursor = (await user.sync()).cursor!;

    expect(await user.deleteAll()).toBe(204);

    for (const table of ["life_event", "location_chunk", "place"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = 'user-1'`).get()).toEqual({ count: 0 });
    }
    expect(database.prepare("SELECT prefix FROM photo_cleanup").all()).toEqual([{ prefix: "user-1/p/" }]);
    // The other device keeps its copy: nothing is announced as deleted.
    const changed = await user.sync(cursor);
    expect(changed).toMatchObject({ ids: [], deletedIds: [], deletions: [] });
    // Records created after the deletion are backed up as usual.
    expect((await user.batch({ events: [event("new", 20)] })).body.data.changed).toBe(1);
    expect((await user.sync(changed.cursor!)).ids).toEqual(["new"]);
    // Other users are untouched.
    expect((await as("user-2").sync()).ids).toEqual(["other"]);
  });

  it("purges tombstones, sessions and verifications past their retention", async () => {
    const { as, database, env } = setup();
    const user = as("user-1");
    await user.batch({ events: [photo("old", 10), photo("recent", 10), photo("active", 10)] });
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

  it("reads through indexes", () => {
    const { database } = setup();
    const plan = (sql: string) => (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" ");
    expect(plan("SELECT user_id, id FROM life_event WHERE deleted_at IS NOT NULL AND deleted_at < 1 LIMIT 10")).toContain("life_event_tombstone_idx");
    expect(plan("SELECT id FROM life_event WHERE user_id = 'u' AND (updated_at, id) > (1, 'a') ORDER BY updated_at, id LIMIT 10")).toContain("life_event_user_sync_idx");
    expect(plan("SELECT bucket FROM location_chunk WHERE user_id = 'u' AND updated_at > 1 ORDER BY updated_at LIMIT 10")).toContain("location_chunk_user_sync_idx");
    expect(plan("SELECT bucket FROM location_chunk WHERE user_id = 'u' AND bucket > 1 ORDER BY bucket LIMIT 10")).not.toContain("SCAN");
    expect(plan("SELECT id FROM life_event WHERE user_id = 'u' AND id > 'a' ORDER BY id LIMIT 10")).not.toContain("SCAN");
  });

  it("pages a full sync and hands later writes to the incremental sync", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001)
      INSERT INTO life_event (user_id, id, started_at, source, updated_at, client_updated_at)
      SELECT 'user-1', printf('e%05d', i), i, 'photo', i, i FROM n`);
    database.exec("INSERT INTO user_sync_state (user_id, seq) VALUES ('user-1', 5001)");
    // 30 windows of one sample each: more than one page of chunks.
    await user.batch({ events: Array.from({ length: 30 }, (_, index) => event(`s${index}`, 10, { startedAt: T0 + index * 6 * HOUR })) });
    const snapshot = (await user.get("/events/head")).body.data.cursor as string;

    const first = await user.get("/events");
    expect(first.body.data).toHaveLength(5000);
    expect(first.body.meta).toMatchObject({ full: true, hasMore: true, cursor: snapshot });

    // A write between pages belongs to a window already read or not: either
    // way it has a later sequence value and arrives after the snapshot cursor.
    await user.batch({ events: [event("late", 10, { startedAt: T0 + 1 })] });
    let page = first.body.meta.nextPage as string | null;
    const ids: string[] = [];
    let pages = 1;
    let cursor = "";
    while (page) {
      const next = await user.get(`/events?page=${encodeURIComponent(page)}`);
      ids.push(...next.body.data.map((row: { id: string }) => row.id));
      page = next.body.meta.nextPage;
      cursor = next.body.meta.cursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(cursor).toBe(snapshot);
    expect(ids.filter((id) => id.startsWith("s"))).toHaveLength(30);
    expect(ids).toContain("e05001");

    expect((await user.sync(cursor)).ids).toEqual(["late"]);
  });

  it("starts a full sync over for a page token it did not issue", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10)] });
    const legacy = await user.get(`/events?page=${encodeURIComponent("5001|5000|e05000")}`);
    expect(legacy.body.data.map((row: { id: string }) => row.id)).toEqual(["a"]);
    expect(legacy.body.meta.full).toBe(true);
  });

  it("pages an incremental sync without resending or skipping samples", async () => {
    const { as } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("before", 10)] });
    const cursor = (await user.sync()).cursor!;
    // 30 windows changed after the cursor, the first one also holding an older sample.
    for (let index = 0; index < 30; index += 1) {
      await user.batch({ events: [event(`n${index}`, 10, { startedAt: T0 + index * 6 * HOUR + 1 })] });
    }
    const changed = await user.sync(cursor);
    expect(changed.pages).toBe(2);
    expect(changed.ids).toEqual(Array.from({ length: 30 }, (_, index) => `n${index}`));
    expect(changed.cursor).toBe((await user.get("/events/head")).body.data.cursor);
  });

  it("turns away samples for a window that is full", async () => {
    const { as, database } = setup();
    const user = as("user-1");
    await user.batch({ events: [event("a", 10)] });
    database.exec(`UPDATE location_chunk SET payload = json_insert(payload, '$[#]', json_array('${"p".repeat(MAX_CHUNK_BYTES)}', ${T0}, 1.0, 1.0, NULL, 1, 1))`);
    const result = await user.batch({ events: [event("b", 10)] });
    expect(result.body.data).toMatchObject({ accepted: 0, changed: 0 });
    expect(result.body.data.rejected).toMatchObject([{ kind: "event", index: 0, id: "b" }]);
  });

  it("syncs place names with last-writer-wins", async () => {
    const { as } = setup();
    const user = as("user-1");
    const home = { id: "home", name: " Home ", latitude: 35.6, longitude: 139.7, updatedAt: 10 };
    expect((await user.putPlaces([home, { id: "bad", name: "", latitude: 0, longitude: 0, updatedAt: 1 }])).body.data).toEqual({ accepted: 1 });
    await user.putPlaces([{ ...home, name: "Old", updatedAt: 5 }]);
    expect((await user.get("/places")).body.data).toEqual([{ id: "home", name: "Home", latitude: 35.6, longitude: 139.7, updatedAt: 10, deleted: false }]);

    await user.putPlaces([{ ...home, updatedAt: 20, deleted: true }]);
    expect((await user.get("/places")).body.data).toEqual([{ id: "home", name: "", latitude: 0, longitude: 0, updatedAt: 20, deleted: true }]);
    expect((await as("user-2").get("/places")).body.data).toEqual([]);
  });

  it("moves existing location rows into chunks and keeps cursors valid", async () => {
    const database = new DatabaseSync(":memory:");
    migrate(database, "", "0018");
    database.exec(`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('user-1', 'One', 'one@example.com', 0, 0)`);
    database.exec(`INSERT INTO life_event (user_id, id, started_at, latitude, longitude, accuracy_meters, source, updated_at, client_updated_at, deleted_at, media_type, photo_count) VALUES
      ('user-1', 'l1', ${T0}, 35.5, 139.5, 12.5, 'location', 100, 90, NULL, NULL, 0),
      ('user-1', 'l2', ${T0 + 0.5}, 35.6, 139.6, NULL, 'location', 101, 91, NULL, NULL, 0),
      ('user-1', 'l3', ${T0 + 6 * HOUR}, 35.7, 139.7, NULL, 'location', 102, 92, NULL, NULL, 0),
      ('user-1', 'p1', ${T0}, 35.8, 139.8, NULL, 'photo', 103, 93, NULL, 'photo', 2),
      ('user-1', 'gone', 0, NULL, NULL, NULL, 'location', 104, 94, 104, NULL, 0)`);
    database.exec("INSERT INTO photo_preview (user_id, event_id, digest) VALUES ('user-1', 'p1', 'd')");
    migrate(database, "0018_photo_preview_index.sql", "9999");

    expect(database.prepare("SELECT bucket, sample_count, updated_at FROM location_chunk ORDER BY bucket").all())
      .toEqual([{ bucket: T0 / (6 * HOUR), sample_count: 2, updated_at: 101 }, { bucket: T0 / (6 * HOUR) + 1, sample_count: 1, updated_at: 102 }]);
    expect(database.prepare("SELECT id FROM life_event ORDER BY id").all()).toEqual([{ id: "gone" }, { id: "p1" }]);
    expect(database.prepare("SELECT seq, chunk_count, preview_count FROM user_sync_state").get()).toEqual({ seq: 104, chunk_count: 2, preview_count: 1 });

    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => { c.set("user", { id: "user-1", email: "", name: "" }); await next(); });
    app.route("/", lifeEventRoutes);
    const get = async (path: string) => await (await app.request(path, {}, { DB: d1(database) })).json() as any;

    const full = await get("/events");
    expect(full.data.find((row: any) => row.id === "l1")).toMatchObject({ startedAt: T0, latitude: 35.5, longitude: 139.5, accuracyMeters: 12.5, updatedAt: 90, source: "location" });
    expect(full.data.map((row: any) => row.id).sort()).toEqual(["l1", "l2", "l3", "p1"]);
    // The old tombstone still stops re-uploads but is not applied to other devices.
    expect(full.meta).toMatchObject({ deletedIds: ["gone"], deletions: [] });
    // A device that had synced up to l1 receives the rest, not l1 again.
    const rest = await get(`/events?cursor=${encodeURIComponent("100|l1")}`);
    expect(rest.data.map((row: any) => row.id).sort()).toEqual(["l2", "l3", "p1"]);
    expect(rest.meta.deletedIds).toEqual(["gone"]);
  });

  it("stores previews once and removes the ones a record no longer contains", async () => {
    const { as, database, env } = setup();
    await as("user-1").batch({ events: [photo("pic", 10)] });
    const stored = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, value: Uint8Array) => { stored.set(key, value); },
      delete: async (keys: string[]) => { keys.forEach((key) => stored.delete(key)); },
    } as unknown as R2Bucket;
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1", email: "user-1@example.com", name: "user-1" });
      await next();
    });
    app.route("/", photoRoutes);
    const bindings = { ...env, PHOTO_PREVIEWS: bucket };
    const upload = async (byte: number) => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, byte]);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
      const response = await app.request(`/photos/pic/${digest}`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: bytes }, bindings);
      expect(response.status).toBe(204);
      return digest;
    };
    const first = await upload(1);
    const second = await upload(2);
    await upload(2);
    expect(database.prepare("SELECT preview_count FROM user_sync_state").get()).toEqual({ preview_count: 2 });

    // The photo behind `first` was deleted from the library.
    const manifest = await app.request("/photos/pic", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digests: [second] }),
    }, bindings);
    expect(await manifest.json()).toEqual({ data: { removed: 1 } });
    expect(database.prepare("SELECT digest FROM photo_preview").all()).toEqual([{ digest: second }]);
    expect([...stored.keys()]).toEqual([`user-1/pic/${second}.jpg`]);
    expect(database.prepare("SELECT preview_count FROM user_sync_state").get()).toEqual({ preview_count: 1 });
    expect(first).not.toBe(second);

    const invalid = await app.request("/photos/pic", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digests: ["nope"] }),
    }, bindings);
    expect(invalid.status).toBe(400);
  });

  it("lists previews from D1 and records legacy R2 objects once", async () => {
    const { as, database, env } = setup();
    await as("user-1").batch({ events: [event("pic", 10, { source: "photo" })] });
    const digest = "a".repeat(64);
    let listCalls = 0;
    const bucket = {
      list: async () => {
        listCalls += 1;
        return { objects: [{ key: `user-1/pic/${digest}.jpg` }], truncated: false };
      },
    } as unknown as R2Bucket;
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1", email: "user-1@example.com", name: "user-1" });
      await next();
    });
    app.route("/", photoRoutes);
    const list = async () => (await (await app.request("/photos/pic", {}, { ...env, PHOTO_PREVIEWS: bucket })).json() as any).data;

    expect(await list()).toEqual([digest]);
    expect(await list()).toEqual([digest]);
    expect(listCalls).toBe(1);
    expect(database.prepare("SELECT digest FROM photo_preview").all()).toEqual([{ digest }]);
  });
});

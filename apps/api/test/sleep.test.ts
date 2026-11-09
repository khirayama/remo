/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/lib/auth";
import { lifeEventRoutes, MAX_CLIENT_CLOCK_SKEW_MS } from "../src/lib/life-events";
import { MAX_SLEEP_BATCH, MAX_SLEEP_SESSIONS, normalizeSleepSession, sleepRoutes } from "../src/lib/sleep";
import { d1, migrate } from "./support/sqlite-d1";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 0, 10, 0, 0, 0);

function setup() {
  const database = new DatabaseSync(":memory:");
  migrate(database, "", "9999");
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
    app.route("/", sleepRoutes);
    const request = async (path: string, init?: RequestInit) => {
      const response = await app.request(path, init, env);
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as any };
    };
    return {
      get: (path: string) => request(path),
      batch: (sessions: unknown) => request("/sleep/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions }),
      }),
      rawBatch: (body: string) => request("/sleep/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      deleteAll: async () => (await app.request("/data", { method: "DELETE" }, env)).status,
    };
  };
  return { database, as };
}

const session = (id: string, startedAt: number, hours = 8, extra: Record<string, unknown> = {}) => ({
  id, startedAt, endedAt: startedAt + hours * HOUR, ...extra,
});

describe("sleep session validation", () => {
  const now = Date.UTC(2026, 5, 1);
  it("accepts a valid session and defaults updatedAt to now", () => {
    expect(normalizeSleepSession({ id: " a ", startedAt: now - 8 * HOUR, endedAt: now }, now).data)
      .toEqual({ id: "a", startedAt: now - 8 * HOUR, endedAt: now, updatedAt: now });
  });

  it("clamps updatedAt to the clock skew allowance", () => {
    expect(normalizeSleepSession({ id: "a", startedAt: now - HOUR, endedAt: now, updatedAt: now + DAY }, now).data?.updatedAt)
      .toBe(now + MAX_CLIENT_CLOCK_SKEW_MS);
  });

  it.each([
    ["non-object", "x"],
    ["empty id", { id: "  ", startedAt: now - HOUR, endedAt: now }],
    ["long id", { id: "a".repeat(121), startedAt: now - HOUR, endedAt: now }],
    ["non-numeric time", { id: "a", startedAt: "1", endedAt: now }],
    ["infinite time", { id: "a", startedAt: now - HOUR, endedAt: Infinity }],
    ["inverted", { id: "a", startedAt: now, endedAt: now - HOUR }],
    ["too short", { id: "a", startedAt: now - 500, endedAt: now }],
    ["too long", { id: "a", startedAt: now - 49 * HOUR, endedAt: now }],
    ["before 1900", { id: "a", startedAt: Date.UTC(1899, 0, 1), endedAt: Date.UTC(1899, 0, 1) + HOUR }],
    ["far future", { id: "a", startedAt: now + 24 * HOUR, endedAt: now + 25 * HOUR + 1 }],
  ])("rejects %s", (_name, input) => {
    expect(normalizeSleepSession(input, now).error).toEqual(expect.any(String));
  });

  it("allows an end up to 24 hours ahead", () => {
    expect(normalizeSleepSession({ id: "a", startedAt: now + 16 * HOUR, endedAt: now + 24 * HOUR }, now).data).toBeDefined();
  });
});

describe("sleep API", () => {
  it("stores sessions and lists them by start time", async () => {
    const { as } = setup();
    const api = as("user-1");
    const result = await api.batch([session("b", BASE + DAY), session("a", BASE)]);
    expect(result).toMatchObject({ status: 200, body: { data: { accepted: 2, changed: 2 } } });
    expect(result.body.data.rejected).toBeUndefined();
    const list = await api.get("/sleep");
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual(["a", "b"]);
    expect(list.body.data[0]).toEqual({ id: "a", startedAt: BASE, endedAt: BASE + 8 * HOUR, updatedAt: expect.any(Number) });
  });

  it("keeps each user's sessions apart", async () => {
    const { as } = setup();
    await as("user-1").batch([session("a", BASE)]);
    await as("user-2").batch([session("a", BASE + DAY)]);
    expect((await as("user-1").get("/sleep")).body.data[0].startedAt).toBe(BASE);
    expect((await as("user-2").get("/sleep")).body.data[0].startedAt).toBe(BASE + DAY);
  });

  it("reports invalid items without stopping the others", async () => {
    const { as } = setup();
    const result = await as("user-1").batch([
      session("ok", BASE),
      { id: "bad", startedAt: BASE, endedAt: BASE },
      "nope",
    ]);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ accepted: 1, changed: 1 });
    expect(result.body.data.rejected).toEqual([
      { index: 1, id: "bad", message: expect.any(String) },
      { index: 2, id: null, message: expect.any(String) },
    ]);
    expect((await as("user-1").get("/sleep")).body.data).toHaveLength(1);
  });

  it("rejects malformed batches as a whole", async () => {
    const { as } = setup();
    const api = as("user-1");
    for (const result of [
      await api.batch([]),
      await api.batch("x"),
      await api.batch(Array.from({ length: MAX_SLEEP_BATCH + 1 }, (_, i) => session(`s${i}`, BASE + i * 9 * HOUR))),
      await api.rawBatch("{"),
    ]) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_batch");
    }
    expect((await api.batch(Array.from({ length: MAX_SLEEP_BATCH }, (_, i) => session(`s${i}`, BASE + i * 9 * HOUR)))).body.data.accepted)
      .toBe(MAX_SLEEP_BATCH);
  });

  it("resolves conflicts as last-writer-wins", async () => {
    const { as } = setup();
    const api = as("user-1");
    const now = Date.now();
    await api.batch([session("a", BASE, 8, { updatedAt: now - 1000 })]);
    // Older copy is ignored.
    expect((await api.batch([session("a", BASE, 6, { updatedAt: now - 2000 })])).body.data).toEqual({ accepted: 1, changed: 0 });
    expect((await api.get("/sleep")).body.data[0].endedAt).toBe(BASE + 8 * HOUR);
    // Newer copy replaces it.
    expect((await api.batch([session("a", BASE, 7, { updatedAt: now - 500 })])).body.data.changed).toBe(1);
    expect((await api.get("/sleep")).body.data[0]).toMatchObject({ endedAt: BASE + 7 * HOUR, updatedAt: now - 500 });
    // An equal timestamp is accepted so a retry is idempotent.
    expect((await api.batch([session("a", BASE, 5, { updatedAt: now - 500 })])).body.data.changed).toBe(1);
    expect((await api.get("/sleep")).body.data[0].endedAt).toBe(BASE + 5 * HOUR);
  });

  it("filters by the day a session ended", async () => {
    const { as } = setup();
    const api = as("user-1");
    // a ends exactly at BASE, b ends at BASE + 8h, c ends exactly at BASE + DAY.
    await api.batch([session("a", BASE - 8 * HOUR), session("b", BASE), session("c", BASE + DAY - 8 * HOUR)]);
    const ids = async (from: number, to: number) =>
      (await api.get(`/sleep?from=${from}&to=${to}`)).body.data.map((row: { id: string }) => row.id);
    expect(await ids(BASE, BASE + DAY)).toEqual(["a", "b"]);
    expect(await ids(BASE - DAY, BASE)).toEqual([]);
    expect(await ids(BASE - DAY, BASE + 1)).toEqual(["a"]);
    expect(await ids(BASE, BASE + DAY + 1)).toEqual(["a", "b", "c"]);
  });

  it.each([
    "/sleep?from=1",
    "/sleep?to=1",
    "/sleep?from=abc&to=10",
    "/sleep?from=1&to=abc",
    "/sleep?from=&to=10",
    "/sleep?from=10&to=10",
    "/sleep?from=10&to=5",
    "/sleep?from=-5&to=10",
    "/sleep?from=1&to=Infinity",
  ])("rejects the range %s", async (path) => {
    const { as } = setup();
    const result = await as("user-1").get(path);
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual({ code: "invalid_range", message: expect.any(String) });
  });

  it("limits the sessions per user but still updates stored ones", async () => {
    const { database, as } = setup();
    const api = as("user-1");
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_SLEEP_SESSIONS - 2})
      INSERT INTO sleep_session (user_id, id, started_at, ended_at, updated_at)
      SELECT 'user-1', 'seed-' || i, ${BASE} + i * 1000, ${BASE} + i * 1000 + 5000, 1 FROM n`);
    // One slot is left: one new id fits, a second does not.
    expect((await api.batch([session("new-1", BASE)])).status).toBe(200);
    const full = await api.batch([session("new-2", BASE), session("seed-0", BASE)]);
    expect(full.status).toBe(507);
    expect(full.body.error.code).toBe("storage_limit");
    // Nothing from the refused batch was written.
    expect(database.prepare("SELECT COUNT(*) AS n FROM sleep_session WHERE user_id = 'user-1'").get()).toEqual({ n: MAX_SLEEP_SESSIONS });
    // Updating a stored session is allowed when full.
    expect((await api.batch([session("seed-0", BASE, 8, { updatedAt: Date.now() })])).body.data).toEqual({ accepted: 1, changed: 1 });
    // Other users are not affected.
    expect((await as("user-2").batch([session("a", BASE)])).status).toBe(200);
  });

  it("is erased with the rest of the data", async () => {
    const { database, as } = setup();
    await as("user-1").batch([session("a", BASE)]);
    await as("user-2").batch([session("a", BASE)]);
    expect(await as("user-1").deleteAll()).toBe(204);
    expect(database.prepare("SELECT user_id FROM sleep_session").all()).toEqual([{ user_id: "user-2" }]);
  });

  it("is removed with the user", async () => {
    const { database, as } = setup();
    await as("user-1").batch([session("a", BASE)]);
    database.exec(`DELETE FROM "user" WHERE id = 'user-1'`);
    expect(database.prepare("SELECT COUNT(*) AS n FROM sleep_session").get()).toEqual({ n: 0 });
  });
});

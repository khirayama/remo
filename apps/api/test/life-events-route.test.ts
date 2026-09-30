import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/lib/auth";
import { lifeEventRoutes } from "../src/lib/life-events";

type SyncRow = Record<string, unknown>;

function testApp(
  rows: SyncRow[],
  onPrepare: (sql: string) => void,
  onBind: (args: unknown[]) => void = () => {},
  firstRow: SyncRow | null = null,
): { app: Hono<AppContext>; env: { DB: D1Database } } {
  const db = {
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
    prepare(sql: string) {
      onPrepare(sql);
      return {
        bind: (...args: unknown[]) => {
          onBind(args);
          return {
            all: async <T>() => ({ results: rows as T[] }),
            run: async () => ({ meta: { changes: 1 } }),
            first: async <T>() => firstRow as T | null,
          };
        },
      };
    },
  } as unknown as D1Database;
  const app = new Hono<AppContext>({ strict: false });
  app.use("*", async (c, next) => {
    c.set("user", { id: "user-1", email: "user@example.com", name: "Test User" });
    await next();
  });
  app.route("/", lifeEventRoutes);
  return { app, env: { DB: db } };
}

const activeRow: SyncRow = {
  id: "active-1",
  started_at: 100,
  latitude: 35.6,
  longitude: 139.7,
  original_latitude: null,
  original_longitude: null,
  location_source: null,
  photo_location_auto_placement_disabled: 0,
  accuracy_meters: 10,
  media_type: null,
  photo_count: 0,
  source: "location",
  updated_at: 200,
  client_updated_at: 190,
  deleted_at: null,
};

const deletedRow: SyncRow = {
  ...activeRow,
  id: "deleted-1",
  updated_at: 300,
  deleted_at: 300,
};

describe("timeline event sync route", () => {
  it("reads only the newest cursor for the lightweight head check", async () => {
    const queries: string[] = [];
    const { app, env } = testApp([], (sql) => queries.push(sql), () => {}, { id: "active-1", updated_at: 200 });
    const response = await app.request("/events/head", {}, env);

    expect(response.status).toBe(200);
    expect(queries[0]).toContain("ORDER BY updated_at DESC, id DESC");
    expect(queries[0]).toContain("LIMIT 1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { cursor: "200|active-1" } });
  });

  it("reads active records and tombstones in one query", async () => {
    const queries: string[] = [];
    const { app, env } = testApp([activeRow, deletedRow], (sql) => queries.push(sql));
    const response = await app.request(
      "/events",
      {},
      env,
    );

    expect(response.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("WHERE user_id = ?");
    expect(queries[0]).not.toContain("deleted_at IS NULL");
    expect(await response.json()).toMatchObject({
      data: [{ id: "active-1" }],
      meta: { deletedIds: ["deleted-1"], cursor: "300|deleted-1", full: true },
    });
  });

  it("uses an exclusive composite cursor for incremental sync", async () => {
    const queries: string[] = [];
    const { app, env } = testApp([activeRow, deletedRow], (sql) => queries.push(sql));
    const response = await app.request(
      "/events?v=2&cursor=200%7Cactive-0",
      {},
      env,
    );

    expect(response.status).toBe(200);
    expect(queries[0]).toContain("(updated_at, id) > (?, ?)");
    expect(queries[0]).not.toContain("updated_at > ? OR");
    expect(queries[0]).toContain("LIMIT ?");
    expect(await response.json()).toMatchObject({
      meta: { full: false, cursor: "300|deleted-1", hasMore: false, nextCursorToken: null },
    });
  });

  it("bounds the full sync to a stable snapshot page", async () => {
    const queries: string[] = [];
    const { app, env } = testApp([activeRow, deletedRow], (sql) => queries.push(sql));
    const response = await app.request("/events?v=2", {}, env);

    expect(response.status).toBe(200);
    expect(queries[0]).toContain("MAX(updated_at)");
    expect(queries[0]).toContain("ORDER BY updated_at ASC, id ASC");
    expect(queries[0]).toContain("LIMIT ?");
    expect(await response.json()).toMatchObject({
      meta: { full: true, cursor: "300|deleted-1", hasMore: false, nextPage: null },
    });
  });

  it("keeps the upsert hot path idempotent without dropping changed fields", async () => {
    const queries: string[] = [];
    const binds: unknown[][] = [];
    const { app, env } = testApp([], (sql) => queries.push(sql), (args) => binds.push(args));
    const response = await app.request("/events/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ id: "event-1", startedAt: 100, source: "location", updatedAt: 200 }] }),
    }, env);

    expect(response.status).toBe(200);
    expect(binds[0]).toHaveLength(14);
    expect(queries[0]).toContain("ON CONFLICT(user_id, id)");
    expect(queries[0]).toContain("excluded.client_updated_at > life_event.client_updated_at");
    expect(queries[0]).toContain("excluded.photo_count IS NOT life_event.photo_count");
  });
});

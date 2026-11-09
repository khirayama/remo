/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import expected20261001 from "../../../fixtures/timeline/remo-timeline-2026-10-01.expected.json";
import fixture20261001 from "../../../fixtures/timeline/remo-timeline-2026-10-01.sample.json";
import { app } from "../src/index";
import fixture20261011 from "../../../fixtures/timeline/remo-timeline-2026-10-11.sample.json";
import { apiTokenRoutes, MAX_API_TOKENS } from "../src/lib/api-tokens";
import type { AppContext } from "../src/lib/auth";
import { correctionRoutes } from "../src/lib/corrections";
import { lifeEventRoutes } from "../src/lib/life-events";
import { formatLocal, localDayStart, MAX_RANGE_DAYS } from "../src/lib/mcp";
import { placeRoutes } from "../src/lib/places";
import { d1, migrate } from "./support/sqlite-d1";

function setup() {
  const database = new DatabaseSync(":memory:");
  migrate(database, "", "9999");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES ('user-1', 'One', 'one@example.com', 0, 0), ('user-2', 'Two', 'two@example.com', 0, 0)`);
  const env = { DB: d1(database), APP_ENV: "development", CORS_ALLOWED_ORIGINS: "" };
  const as = (userId: string) => {
    const routes = new Hono<AppContext>();
    routes.use("*", async (c, next) => {
      c.set("user", { id: userId, email: `${userId}@example.com`, name: userId });
      await next();
    });
    routes.route("/", lifeEventRoutes);
    routes.route("/", placeRoutes);
    routes.route("/", correctionRoutes);
    routes.route("/", apiTokenRoutes);
    const json = async (path: string, method: string, body?: unknown) => {
      const response = await routes.request(path, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }, env);
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
    };
    return {
      json,
      issueToken: async (name = "test", scope: "read" | "write" = "read") => (await json("/api-tokens", "POST", { name, scope })).body.data as { id: string; token: string },
      upload: async (events: Array<Record<string, unknown>>) => {
        for (let index = 0; index < events.length; index += 400) {
          const result = await json("/events/batch", "POST", { events: events.slice(index, index + 400) });
          expect(result.status).toBe(200);
        }
      },
    };
  };
  const mcp = async (token: string | undefined, method: string, params: unknown = {}) => {
    const response = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }, env as never);
    const text = await response.text();
    const payload = text.startsWith("{")
      ? text
      : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("");
    return { status: response.status, headers: response.headers, body: payload ? JSON.parse(payload) : null };
  };
  const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const { status, body } = await mcp(token, "tools/call", { name, arguments: args });
    expect(status).toBe(200);
    const result = body.result;
    return { isError: result.isError === true, text: result.content[0].text as string, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  return { as, mcp, callTool };
}

const uploadable = <T extends { startedAt: string; updatedAt: string }>(events: T[]) => events.map((event) => ({
  ...event,
  startedAt: Date.parse(event.startedAt),
  updatedAt: Date.parse(event.updatedAt),
}));
const fixtureEvents = uploadable(fixture20261001.events);

const READ_TOOLS = ["get_location_samples", "get_timeline", "list_corrections", "list_places", "list_stays", "suggest_corrections"];
const WRITE_TOOLS = ["add_place_anchor", "delete_correction", "delete_place", "exclude_location_samples", "join_stays", "mark_not_stay", "merge_places", "remove_place_anchor", "save_place"];

describe("local time helpers", () => {
  it("finds local midnight, including across a DST change", () => {
    expect(localDayStart("2026-10-01", "Asia/Tokyo")).toBe(Date.parse("2026-09-30T15:00:00Z"));
    expect(localDayStart("2026-03-08", "America/New_York")).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(localDayStart("2026-03-09", "America/New_York")).toBe(Date.parse("2026-03-09T04:00:00Z"));
    expect(formatLocal(Date.parse("2026-09-30T20:30:03.323Z"), "Asia/Tokyo")).toBe("2026-10-01T05:30:03+09:00");
    expect(formatLocal(Date.parse("2026-03-09T12:00:00Z"), "America/New_York")).toBe("2026-03-09T08:00:00-04:00");
  });
});

describe("API tokens", () => {
  it("are listed without the plain token and limited per user", async () => {
    const { as } = setup();
    const user = as("user-1");
    const issued = await user.issueToken("  Claude  ");
    expect(issued.token).toMatch(/^rm_[A-Za-z0-9_-]{43}$/);
    const list = await user.json("/api-tokens", "GET");
    expect(list.body.data).toEqual([{ id: issued.id, name: "Claude", scope: "read", createdAt: expect.any(Number) }]);
    expect(JSON.stringify(list.body)).not.toContain(issued.token);
    expect((await as("user-2").json("/api-tokens", "GET")).body.data).toEqual([]);

    expect((await user.json("/api-tokens", "POST", { name: "x".repeat(51) })).status).toBe(400);
    for (let index = 1; index < MAX_API_TOKENS; index += 1) await user.issueToken();
    expect((await user.json("/api-tokens", "POST", {})).status).toBe(409);
  });
});

describe("MCP endpoint", () => {
  it("rejects missing, malformed, unknown and revoked tokens", async () => {
    const { as, mcp } = setup();
    expect((await mcp(undefined, "tools/list")).status).toBe(401);
    expect((await mcp("not-a-token", "tools/list")).headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await mcp(`rm_${"a".repeat(43)}`, "tools/list")).status).toBe(401);

    const user = as("user-1");
    const issued = await user.issueToken();
    expect((await mcp(issued.token, "tools/list")).status).toBe(200);
    // Another user cannot revoke it.
    await as("user-2").json(`/api-tokens/${issued.id}`, "DELETE");
    expect((await mcp(issued.token, "tools/list")).status).toBe(200);
    expect((await user.json(`/api-tokens/${issued.id}`, "DELETE")).status).toBe(204);
    expect((await mcp(issued.token, "tools/list")).status).toBe(401);
  });

  it("lists read-only tools", async () => {
    const { as, mcp } = setup();
    const { token } = await as("user-1").issueToken();
    const { body } = await mcp(token, "tools/list");
    const tools = body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(READ_TOOLS);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("adds the write tools only for a token with the write scope", async () => {
    const { as, mcp } = setup();
    const user = as("user-1");
    expect((await user.json("/api-tokens", "POST", { name: "x", scope: "admin" })).status).toBe(400);
    const writer = (await user.json("/api-tokens", "POST", { name: "Claude", scope: "write" })).body.data as { token: string; scope: string };
    expect(writer.scope).toBe("write");
    const tools = (await mcp(writer.token, "tools/list")).body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name).sort())
      .toEqual(["delete_correction", "delete_place", "merge_places", "remove_place_anchor"]);
  });

  it("returns the day's timeline the app shows, with named places", async () => {
    const { as, callTool } = setup();
    const user = as("user-1");
    await user.upload(fixtureEvents);
    const firstStay = expected20261001.activities[0]!;
    await user.json("/places", "PUT", { places: [{ id: "home", name: "Home", latitude: firstStay.latitude, longitude: firstStay.longitude, updatedAt: 1 }] });
    const { token } = await user.issueToken();

    const { data } = await callTool(token, "get_timeline", { date: "2026-10-01", timeZone: "Asia/Tokyo" });
    expect(data.locationSamples).toBe(fixtureEvents.filter((event) => event.source === "location").length);
    expect(data.activities.map((activity: any) => ({
      kind: activity.kind,
      startedAt: Date.parse(activity.startedAt),
      endedAt: Date.parse(activity.endedAt),
    }))).toEqual(expected20261001.activities.map((activity) => ({
      kind: activity.kind,
      // Output times are rounded to the second.
      startedAt: Math.floor(activity.startedAt / 1000) * 1000,
      endedAt: Math.floor(activity.endedAt / 1000) * 1000,
    })));
    expect(data.activities[0]).toMatchObject({ kind: "stay", latitude: firstStay.latitude, longitude: firstStay.longitude, place: { id: "home", name: "Home" } });
    expect(data.activities[0].startedAt).toMatch(/\+09:00$/);
    const photos = fixtureEvents.filter((event) => event.source === "photo").reduce((total, event) => total + event.photoCount, 0);
    expect(data.activities.reduce((total: number, activity: any) => total + activity.photoCount + activity.videoCount, 0)).toBe(photos);

    // The same moments fall on another local day in another time zone.
    const utc = await callTool(token, "get_timeline", { date: "2026-10-01", timeZone: "UTC" });
    expect(utc.data.locationSamples).toBeLessThan(data.locationSamples);
  });

  it("lists stays over a range and filters them by place", async () => {
    const { as, callTool } = setup();
    const user = as("user-1");
    await user.upload(fixtureEvents);
    const firstStay = expected20261001.activities[0]!;
    await user.json("/places", "PUT", { places: [{ id: "home", name: "Home", latitude: firstStay.latitude, longitude: firstStay.longitude, updatedAt: 1 }] });
    const { token } = await user.issueToken();

    const all = await callTool(token, "list_stays", { from: "2026-09-30", to: "2026-10-02", timeZone: "Asia/Tokyo" });
    expect(all.data.days.map((day: any) => [day.date, day.recorded])).toEqual([["2026-09-30", false], ["2026-10-01", true], ["2026-10-02", false]]);
    const stayCount = expected20261001.activities.filter((activity) => activity.kind === "stay").length;
    expect(all.data.days[1].stays).toHaveLength(stayCount);

    const home = await callTool(token, "list_stays", { from: "2026-10-01", to: "2026-10-01", timeZone: "Asia/Tokyo", placeId: "home" });
    expect(home.data.place).toEqual({ id: "home", name: "Home" });
    expect(home.data.days[0].stays.length).toBeGreaterThan(0);
    expect(home.data.days[0].stays.every((stay: any) => stay.place?.id === "home")).toBe(true);

    expect((await callTool(token, "list_stays", { from: "2026-10-01", to: "2026-11-30", timeZone: "Asia/Tokyo" })).text)
      .toContain(`${MAX_RANGE_DAYS} days`);
    expect((await callTool(token, "list_stays", { from: "2026-10-01", to: "2026-10-01", timeZone: "Asia/Tokyo", placeId: "nope" })).isError).toBe(true);
    expect((await callTool(token, "get_timeline", { date: "2026-02-30", timeZone: "Asia/Tokyo" })).isError).toBe(true);
    expect((await callTool(token, "get_timeline", { date: "2026-10-01", timeZone: "Mars/Olympus" })).isError).toBe(true);
  });

  it("only reads the token owner's backup", async () => {
    const { as, callTool } = setup();
    await as("user-1").upload(fixtureEvents);
    await as("user-1").json("/places", "PUT", { places: [{ id: "home", name: "Home", latitude: 33.58, longitude: 130.38, updatedAt: 1 }] });
    const { token } = await as("user-2").issueToken();
    const { data } = await callTool(token, "get_timeline", { date: "2026-10-01", timeZone: "Asia/Tokyo" });
    expect(data).toMatchObject({ locationSamples: 0, photoRecords: 0, activities: [] });
    expect((await callTool(token, "list_places")).data).toEqual({ places: [] });
  });
});

describe("places", () => {
  it("keeps the radius and anchors an older client does not send, and erases them on deletion", async () => {
    const { as } = setup();
    const user = as("user-1");
    const anchors = [{ latitude: 33.59, longitude: 130.4, radiusMeters: 60 }];
    await user.json("/places", "PUT", { places: [{ id: "home", name: "Home", latitude: 33.58, longitude: 130.38, radiusMeters: 1000, anchors, updatedAt: 1 }] });
    expect((await user.json("/places", "GET")).body.data).toEqual([
      { id: "home", name: "Home", latitude: 33.58, longitude: 130.38, radiusMeters: 500, anchors, updatedAt: 1, deleted: false },
    ]);
    // An app without anchors renames the place.
    await user.json("/places", "PUT", { places: [{ id: "home", name: "House", latitude: 33.58, longitude: 130.38, updatedAt: 2 }] });
    expect((await user.json("/places", "GET")).body.data[0]).toMatchObject({ name: "House", radiusMeters: 500, anchors });
    // An older write loses.
    await user.json("/places", "PUT", { places: [{ id: "home", name: "Old", latitude: 33.58, longitude: 130.38, anchors: [], updatedAt: 1 }] });
    expect((await user.json("/places", "GET")).body.data[0]).toMatchObject({ name: "House", anchors });

    await user.json("/places", "PUT", { places: [{ id: "home", name: "", latitude: 33.58, longitude: 130.38, deleted: true, mergedInto: "office", updatedAt: 3 }] });
    expect((await user.json("/places", "GET")).body.data).toEqual([
      { id: "home", name: "", latitude: 0, longitude: 0, mergedInto: "office", updatedAt: 3, deleted: true },
    ]);
  });
});

describe("corrections", () => {
  const correction = (id: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "join_stay", startedAt: 1_000, endedAt: 2_000, createdAt: 5, ...extra,
  });

  it("are created once, only ever deleted, and downloaded after a cursor", async () => {
    const { as } = setup();
    const user = as("user-1");
    const first = await user.json("/corrections", "PUT", { corrections: [
      correction("a"),
      correction("b", { kind: "exclude" }),
      correction("too-long", { endedAt: 1_000 + 25 * 60 * 60 * 1000 }),
      correction("bad-kind", { kind: "rename" }),
      correction("a", { source: "mcp" }),
    ] });
    expect(first.body.data.accepted).toBe(2);
    const all = await user.json("/corrections?after=0", "GET");
    expect(all.body.data.hasMore).toBe(false);
    expect(all.body.data.corrections).toEqual([
      { id: "a", kind: "join_stay", startedAt: 1_000, endedAt: 2_000, createdAt: 5, source: "app", deleted: false },
      { id: "b", kind: "exclude", startedAt: 1_000, endedAt: 2_000, createdAt: 5, source: "app", deleted: false },
    ]);
    const cursor = all.body.data.cursor as number;
    expect((await user.json(`/corrections?after=${cursor}`, "GET")).body.data).toEqual({ corrections: [], cursor, hasMore: false });

    // Sending a correction again changes nothing; deleting it is the only change.
    await user.json("/corrections", "PUT", { corrections: [correction("a", { kind: "not_stay", startedAt: 0 })] });
    expect((await user.json(`/corrections?after=${cursor}`, "GET")).body.data.corrections).toEqual([]);
    await user.json("/corrections", "PUT", { corrections: [correction("a", { deleted: true })] });
    const changed = await user.json(`/corrections?after=${cursor}`, "GET");
    expect(changed.body.data.corrections).toEqual([{ ...all.body.data.corrections[0], deleted: true }]);
    await user.json("/corrections", "PUT", { corrections: [correction("a")] });
    expect((await user.json(`/corrections?after=${changed.body.data.cursor}`, "GET")).body.data.corrections).toEqual([]);

    expect((await as("user-2").json("/corrections?after=0", "GET")).body.data.corrections).toEqual([]);
    expect((await user.json("/corrections?after=-1", "GET")).status).toBe(400);
    expect((await user.json("/corrections", "PUT", { corrections: [] })).status).toBe(400);

    expect((await user.json("/data", "DELETE")).status).toBe(204);
    expect((await user.json("/corrections?after=0", "GET")).body.data.corrections).toEqual([]);
  });

  it("pages through many corrections", async () => {
    const { as } = setup();
    const user = as("user-1");
    for (let batch = 0; batch < 6; batch += 1) {
      await user.json("/corrections", "PUT", { corrections: Array.from({ length: 200 }, (_, index) => correction(`c${batch}-${index}`)) });
    }
    let after = 0;
    const seen = new Set<string>();
    for (let page = 0; page < 3; page += 1) {
      const { data } = (await user.json(`/corrections?after=${after}`, "GET")).body;
      data.corrections.forEach((item: { id: string }) => seen.add(item.id));
      after = data.cursor;
      if (!data.hasMore) break;
    }
    expect(seen.size).toBe(1_200);
  });
});

describe("MCP corrections and places", () => {
  const events1011 = uploadable(fixture20261011.events);
  const stays = (day: any) => day.activities.filter((activity: any) => activity.kind === "stay");

  it("cannot write with a read token", async () => {
    const { as, mcp } = setup();
    const user = as("user-1");
    const { token } = await user.issueToken();
    const { body } = await mcp(token, "tools/call", { name: "join_stays", arguments: { startedAt: "2026-10-11T12:30:00+09:00", endedAt: "2026-10-11T13:11:00+09:00", timeZone: "Asia/Tokyo" } });
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect((await user.json("/corrections?after=0", "GET")).body.data.corrections).toEqual([]);
  });

  it("suggests, applies and undoes corrections the apps see", async () => {
    const { as, callTool } = setup();
    const user = as("user-1");
    await user.upload(events1011);
    const { token } = await user.issueToken("Claude", "write");
    const before = await callTool(token, "get_timeline", { date: "2026-10-11", timeZone: "Asia/Tokyo" });
    expect(stays(before.data)).toHaveLength(5);

    const suggested = await callTool(token, "suggest_corrections", { from: "2026-10-11", to: "2026-10-11", timeZone: "Asia/Tokyo" });
    const join = suggested.data.days[0].suggestions.find((suggestion: any) => suggestion.kind === "join_stay");
    expect(join).toMatchObject({ startedAt: stays(before.data)[0].startedAt, endedAt: stays(before.data)[1].endedAt });

    const joined = await callTool(token, "join_stays", { startedAt: join.startedAt, endedAt: join.endedAt, timeZone: "Asia/Tokyo" });
    expect(joined.data.correction).toMatchObject({ kind: "join_stay", createdBy: "ai" });
    expect(stays(joined.data.days[0])).toHaveLength(4);
    expect(stays(joined.data.days[0])[0]).toMatchObject({ startedAt: join.startedAt, endedAt: join.endedAt, corrected: true });
    expect(joined.data.days[0].corrections).toHaveLength(1);

    // The apps download the correction like their own.
    const synced = (await user.json("/corrections?after=0", "GET")).body.data.corrections;
    expect(synced).toEqual([expect.objectContaining({ kind: "join_stay", source: "mcp", deleted: false })]);

    const listed = await callTool(token, "list_corrections", { from: "2026-10-11", to: "2026-10-11", timeZone: "Asia/Tokyo" });
    expect(listed.data.corrections.map((item: any) => item.id)).toEqual([joined.data.correction.id]);
    const stayList = await callTool(token, "list_stays", { from: "2026-10-11", to: "2026-10-11", timeZone: "Asia/Tokyo" });
    expect(stayList.data.days[0].stays).toHaveLength(4);

    const notStay = await callTool(token, "mark_not_stay", { startedAt: stays(joined.data.days[0])[1].startedAt, endedAt: stays(joined.data.days[0])[1].endedAt, timeZone: "Asia/Tokyo" });
    expect(stays(notStay.data.days[0])).toHaveLength(3);

    const undone = await callTool(token, "delete_correction", { correctionId: joined.data.correction.id, timeZone: "Asia/Tokyo" });
    expect(stays(undone.data.days[0])).toHaveLength(4);
    expect((await user.json("/corrections?after=0", "GET")).body.data.corrections.find((item: any) => item.id === joined.data.correction.id).deleted).toBe(true);
    expect((await callTool(token, "delete_correction", { correctionId: "nope", timeZone: "Asia/Tokyo" })).isError).toBe(true);
    expect((await callTool(token, "join_stays", { startedAt: "2026-10-11T00:00:00+09:00", endedAt: "2026-10-12T01:00:00+09:00", timeZone: "Asia/Tokyo" })).isError).toBe(true);
    expect((await callTool(token, "join_stays", { startedAt: "2026-10-11 12:00", endedAt: "2026-10-11T13:00:00+09:00", timeZone: "Asia/Tokyo" })).isError).toBe(true);
  });

  it("excludes location fixes and shows them as excluded", async () => {
    const { as, callTool } = setup();
    const user = as("user-1");
    await user.upload(events1011);
    const { token } = await user.issueToken("Claude", "write");
    const window = { startedAt: "2026-10-11T13:15:00+09:00", endedAt: "2026-10-11T13:18:00+09:00", timeZone: "Asia/Tokyo" };
    const samples = await callTool(token, "get_location_samples", window);
    expect(samples.data.samples.length).toBeGreaterThan(5);
    expect(samples.data.samples.every((sample: any) => !sample.excluded)).toBe(true);
    await callTool(token, "exclude_location_samples", window);
    const after = await callTool(token, "get_location_samples", window);
    expect(after.data.samples.every((sample: any) => sample.excluded)).toBe(true);

    expect((await callTool(token, "get_location_samples", { ...window, endedAt: "2026-10-11T17:00:00+09:00" })).isError).toBe(true);
    expect((await callTool(token, "get_location_samples", { startedAt: "2026-10-11T23:00:00+09:00", endedAt: "2026-10-12T00:30:00+09:00", timeZone: "Asia/Tokyo" })).isError).toBe(true);
  });

  it("names, extends, merges and deletes places", async () => {
    const { as, callTool } = setup();
    const user = as("user-1");
    await user.upload(events1011);
    const { token } = await user.issueToken("Claude", "write");
    const day = (await callTool(token, "get_timeline", { date: "2026-10-11", timeZone: "Asia/Tokyo" })).data;
    const [home, nearby] = stays(day);

    const created = await callTool(token, "save_place", { name: "自宅", latitude: home.latitude, longitude: home.longitude });
    const homeId = created.data.place.id as string;
    expect(created.data.place).toMatchObject({ name: "自宅", radiusMeters: 100, anchors: [] });
    expect((await callTool(token, "save_place", { name: "x" })).isError).toBe(true);
    const other = await callTool(token, "save_place", { name: "近所", latitude: nearby.latitude, longitude: nearby.longitude, radiusMeters: 50 });

    const merged = await callTool(token, "merge_places", { targetPlaceId: homeId, sourcePlaceIds: [other.data.place.id] });
    expect(merged.data.place.anchors).toEqual([{ index: 0, latitude: nearby.latitude, longitude: nearby.longitude, radiusMeters: 50 }]);
    const places = (await callTool(token, "list_places")).data.places;
    expect(places.map((place: any) => place.name)).toEqual(["自宅"]);
    // The merged place's id still finds its stays, now at the place it went into.
    const byOldId = await callTool(token, "list_stays", { from: "2026-10-11", to: "2026-10-11", timeZone: "Asia/Tokyo", placeId: other.data.place.id });
    expect(byOldId.data.place).toEqual({ id: homeId, name: "自宅" });
    expect(byOldId.data.days[0].stays.length).toBeGreaterThanOrEqual(3);
    // The apps receive the merge.
    const synced = (await user.json("/places", "GET")).body.data;
    expect(synced.find((place: any) => place.id === other.data.place.id)).toMatchObject({ deleted: true, mergedInto: homeId });

    const removed = await callTool(token, "remove_place_anchor", { placeId: homeId, anchorIndex: 0 });
    expect(removed.data.place.anchors).toEqual([]);
    expect((await callTool(token, "remove_place_anchor", { placeId: homeId, anchorIndex: 0 })).isError).toBe(true);
    const anchored = await callTool(token, "add_place_anchor", { placeId: homeId, latitude: nearby.latitude, longitude: nearby.longitude, radiusMeters: 80 });
    expect(anchored.data.place.anchors).toHaveLength(1);

    await callTool(token, "delete_place", { placeId: homeId });
    expect((await callTool(token, "list_places")).data.places).toEqual([]);
    expect(stays((await callTool(token, "get_timeline", { date: "2026-10-11", timeZone: "Asia/Tokyo" })).data).every((stay: any) => stay.place === null)).toBe(true);
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizeEvents } from "./life-api";
import { buildExport, claimRecords, clearEvents, countUnsavedEvents, dateKey, forgetAccount, LifeEvent, loadDayEvents, loadUploadedPhotos, migrateLegacyTimeline, ownershipFor, readImport, rememberUploadedPhoto, replaceRecords, sortNewest, sortOldest, storeImported, summarizeRange } from "./life-log";
import { applyRemoteChanges, clearDirtyDays, closeDatabaseForTests, countEvents, deleteLocalEvents, listRecordedDays, loadDirtyDays, loadDirtyEvents, loadEvent, loadEventsInRange, loadPendingDeletes, loadStoredPlaces, loadSyncState, markEventsSynced, putLocalEvents, putLocalPlace, updateSyncState } from "./timeline-db";

const STORAGE = "device:test";

function event(overrides: Partial<LifeEvent> = {}): LifeEvent {
  return {
    id: "event-1",
    startedAt: "2026-08-31T01:00:00.000Z",
    latitude: 35.6812,
    longitude: 139.7671,
    photoCount: 0,
    source: "location",
    updatedAt: "2026-08-31T01:00:00.000Z",
    ...overrides,
  };
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  return values;
}

async function resetDatabase() {
  await closeDatabaseForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("remo-timeline");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(async () => {
  installLocalStorage();
  await resetDatabase();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("timeline storage", () => {
  it("reads a time range through the index, oldest first", async () => {
    await putLocalEvents(STORAGE, [
      event({ id: "b", startedAt: "2026-08-31T02:00:00.000Z" }),
      event({ id: "a", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "later", startedAt: "2026-09-02T01:00:00.000Z" }),
    ]);
    await putLocalEvents("device:other", [event({ id: "other" })]);

    const from = Date.parse("2026-08-31T00:00:00.000Z");
    expect((await loadEventsInRange(STORAGE, from, from + 86_400_000)).map((item) => item.id)).toEqual(["a", "b"]);
    expect(await countEvents(STORAGE)).toBe(3);
    expect((await loadDayEvents(STORAGE, dateKey("2026-09-02T01:00:00.000Z"))).map((item) => item.id)).toEqual(["later"]);
    expect(await listRecordedDays(STORAGE)).toEqual([...new Set(["2026-08-31T01:00:00.000Z", "2026-09-02T01:00:00.000Z"].map((value) => dateKey(value)))]);
  });

  it("remembers which days changed until they were processed", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" })]);
    const first = await loadDirtyDays(STORAGE);
    expect(first.map((entry) => entry.day)).toEqual([dateKey("2026-08-31T01:00:00.000Z")]);

    // A record written while the day was being processed keeps it marked.
    await putLocalEvents(STORAGE, [event({ id: "b" })]);
    await clearDirtyDays(STORAGE, first);
    const second = await loadDirtyDays(STORAGE);
    expect(second).toHaveLength(1);
    await clearDirtyDays(STORAGE, second);
    expect(await loadDirtyDays(STORAGE)).toEqual([]);

    // Moving a record to another day marks the day it left and the day it joined.
    await putLocalEvents(STORAGE, [event({ id: "a", startedAt: "2026-09-05T01:00:00.000Z" })]);
    expect((await loadDirtyDays(STORAGE)).map((entry) => entry.day)).toEqual([dateKey("2026-08-31T01:00:00.000Z"), dateKey("2026-09-05T01:00:00.000Z")]);
  });

  it("keeps a record waiting for upload until the version that was sent is acknowledged", async () => {
    const first = event({ id: "a" });
    await putLocalEvents(STORAGE, [first, event({ id: "b" })]);
    const { epoch } = await loadSyncState(STORAGE);
    expect((await loadDirtyEvents(STORAGE, epoch, 10)).map((item) => item.id).sort()).toEqual(["a", "b"]);

    // "a" is edited while the request is in flight.
    const edited = { ...first, photoCount: 2, updatedAt: "2026-09-01T00:00:00.000Z" };
    await putLocalEvents(STORAGE, [edited]);
    await markEventsSynced(STORAGE, [first, event({ id: "b" })], epoch);
    expect(await loadDirtyEvents(STORAGE, epoch, 10)).toEqual([edited]);
  });

  it("queues deletions only for records that are backed up to an account", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" }), event({ id: "b", source: "photo" })]);
    expect((await deleteLocalEvents(STORAGE, ["a", "missing"])).map((item) => item.id)).toEqual(["a"]);
    expect(await loadPendingDeletes(STORAGE)).toEqual([]);

    await claimRecords(STORAGE, "user-1");
    await deleteLocalEvents(STORAGE, ["b"]);
    expect(await loadPendingDeletes(STORAGE)).toMatchObject([{ id: "b", startedAt: Date.parse("2026-08-31T01:00:00.000Z"), source: "photo" }]);
    // Writing the record again takes the deletion back.
    await putLocalEvents(STORAGE, [event({ id: "b", source: "photo" })]);
    expect(await loadPendingDeletes(STORAGE)).toEqual([]);
  });

  it("takes newer records and deletions from the backup, and keeps newer local edits", async () => {
    await putLocalEvents(STORAGE, [
      event({ id: "older", updatedAt: "2026-09-01T00:00:00.000Z" }),
      event({ id: "newer", updatedAt: "2026-09-03T00:00:00.000Z" }),
      event({ id: "deleted-there", updatedAt: "2026-09-01T00:00:00.000Z" }),
      event({ id: "edited-after-delete", updatedAt: "2026-09-03T00:00:00.000Z" }),
      event({ id: "deleted-here" }),
    ]);
    await claimRecords(STORAGE, "user-1");
    await deleteLocalEvents(STORAGE, ["deleted-here"]);
    const remoteTime = "2026-09-02T00:00:00.000Z";

    const result = await applyRemoteChanges(STORAGE, [
      event({ id: "older", latitude: 36, updatedAt: remoteTime }),
      event({ id: "newer", latitude: 36, updatedAt: remoteTime }),
      event({ id: "restored", updatedAt: remoteTime }),
      event({ id: "deleted-here", updatedAt: remoteTime }),
    ], [
      { id: "deleted-there", deletedAt: Date.parse(remoteTime) },
      { id: "edited-after-delete", deletedAt: Date.parse(remoteTime) },
    ], 1);

    expect(result).toEqual({ changed: true, removedIds: ["deleted-there"] });
    expect((await loadEvent(STORAGE, "older"))?.latitude).toBe(36);
    expect((await loadEvent(STORAGE, "newer"))?.latitude).toBe(35.6812);
    expect(await loadEvent(STORAGE, "restored")).toBeDefined();
    expect(await loadEvent(STORAGE, "deleted-there")).toBeUndefined();
    expect(await loadEvent(STORAGE, "edited-after-delete")).toBeDefined();
    expect(await loadEvent(STORAGE, "deleted-here")).toBeUndefined();
    // What came from the backup is not uploaded again.
    expect((await loadDirtyEvents(STORAGE, 1, 10)).map((item) => item.id).sort()).toEqual(["edited-after-delete", "newer"]);
  });

  it("migrates records kept in localStorage and keeps the stored copy", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a", photoCount: 5 })]);
    const values = installLocalStorage({
      [`remo:timeline:${STORAGE}`]: JSON.stringify([event({ id: "a" }), event({ id: "b" })]),
      "remo:timeline:user-legacy": JSON.stringify([event({ id: "c" })]),
    });
    await migrateLegacyTimeline(STORAGE);
    const loaded = await loadDayEvents(STORAGE, dateKey("2026-08-31T01:00:00.000Z"));
    expect(loaded.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
    expect(loaded.find((item) => item.id === "a")?.photoCount).toBe(5);
    expect(values.size).toBe(0);
  });

  it("migrates photo upload markers", async () => {
    installLocalStorage({ "remo:photo-uploaded:user-1:p1": "1" });
    await rememberUploadedPhoto("user-1", "p2");
    expect([...await loadUploadedPhotos("user-1")].sort()).toEqual(["p1", "p2"]);
  });
});

describe("version 1 storage", () => {
  async function createVersion1(queue: Array<{ userId: string; eventId: string; operation: unknown }>) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("remo-timeline", 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("events", { keyPath: ["storageId", "id"] }).createIndex("storageId", "storageId");
        database.createObjectStore("syncQueue", { keyPath: ["userId", "eventId"] }).createIndex("userId", "userId");
        database.createObjectStore("photoUploads", { keyPath: ["userId", "eventId"] }).createIndex("userId", "userId");
        database.createObjectStore("state");
        const events = request.transaction!.objectStore("events");
        ["synced", "queued"].forEach((id) => events.put({ storageId: STORAGE, id, event: event({ id }) }));
        const store = request.transaction!.objectStore("syncQueue");
        queue.forEach((row) => store.put(row));
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  }

  it("keeps the backup account, its cursor and what was queued for it", async () => {
    installLocalStorage({ "remo:timeline-sync-cursor:user-1": JSON.stringify({ updatedAt: 42, id: "x" }) });
    await createVersion1([
      { userId: "user-1", eventId: "queued", operation: { id: "op-1", kind: "upsert", event: event({ id: "queued" }) } },
      { userId: "user-1", eventId: "gone", operation: { id: "op-2", kind: "delete", eventId: "gone" } },
    ]);

    const state = await loadSyncState(STORAGE);
    expect(state).toMatchObject({ owner: "user-1", epoch: 1, cursors: { "user-1": { updatedAt: 42, id: "x" } } });
    expect((await loadDirtyEvents(STORAGE, state.epoch, 10)).map((item) => item.id)).toEqual(["queued"]);
    expect((await loadPendingDeletes(STORAGE)).map((item) => item.id)).toEqual(["gone"]);
    expect(await ownershipFor(STORAGE, "user-1")).toBe("owned");
    expect((await loadDayEvents(STORAGE, dateKey("2026-08-31T01:00:00.000Z"))).map((item) => item.id).sort()).toEqual(["queued", "synced"]);
  });

  it("uploads everything when the browser was never backed up", async () => {
    await createVersion1([]);
    const state = await loadSyncState(STORAGE);
    expect(state.owner).toBeUndefined();
    expect(await countUnsavedEvents(STORAGE)).toBe(2);
    expect(await ownershipFor(STORAGE, "user-1")).toBe("unclaimed");
  });
});

describe("account ownership", () => {
  it("does not hand one account's records to another without a decision", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" })]);
    expect(await ownershipFor(STORAGE, "user-1")).toBe("unclaimed");
    await claimRecords(STORAGE, "user-1");
    const { epoch } = await loadSyncState(STORAGE);
    await markEventsSynced(STORAGE, [event({ id: "a" })], epoch);
    expect(await countUnsavedEvents(STORAGE)).toBe(0);

    expect(await ownershipFor(STORAGE, "user-1")).toBe("owned");
    expect(await ownershipFor(STORAGE, "user-2")).toBe("other");

    // Keeping the records: the new account has to receive all of them.
    await claimRecords(STORAGE, "user-2");
    expect(await ownershipFor(STORAGE, "user-2")).toBe("owned");
    expect(await countUnsavedEvents(STORAGE)).toBe(1);
  });

  it("starts empty when the records of the other account are replaced", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" })]);
    await putLocalPlace(STORAGE, { id: "home", name: "Home", latitude: 35, longitude: 139, updatedAt: 1, deleted: false });
    await claimRecords(STORAGE, "user-1");
    await replaceRecords(STORAGE, "user-2");
    expect(await countEvents(STORAGE)).toBe(0);
    expect(await loadStoredPlaces(STORAGE)).toEqual([]);
    expect(await ownershipFor(STORAGE, "user-2")).toBe("owned");
  });

  it("uploads everything to a later account after the account was deleted", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" })]);
    await claimRecords(STORAGE, "user-1");
    const { epoch } = await loadSyncState(STORAGE);
    await markEventsSynced(STORAGE, [event({ id: "a" })], epoch);
    await updateSyncState(STORAGE, (state) => { state.cursors["user-1"] = { updatedAt: 1, id: "~" }; });

    await forgetAccount(STORAGE, "user-1");
    expect(await loadSyncState(STORAGE)).toMatchObject({ owner: undefined, cursors: {} });
    expect(await ownershipFor(STORAGE, "user-2")).toBe("unclaimed");
    expect(await countUnsavedEvents(STORAGE)).toBe(1);
  });

  it("forgets the download position with the records", async () => {
    await putLocalEvents(STORAGE, [event({ id: "a" })]);
    await claimRecords(STORAGE, "user-1");
    await updateSyncState(STORAGE, (state) => { state.cursors["user-1"] = { updatedAt: 1, id: "~" }; });
    await clearEvents(STORAGE);
    expect(await countEvents(STORAGE)).toBe(0);
    expect(await loadSyncState(STORAGE)).toMatchObject({ owner: "user-1", cursors: {} });
  });
});

describe("backup sync", () => {
  type Call = { method: string; path: string; body?: any };

  /** A stand-in for the API that records requests and answers from [reply]. */
  function stubApi(reply: (call: Call) => unknown) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const result = reply(call);
      if (typeof result === "number") return new Response(null, { status: result });
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return calls;
  }
  const apiEvent = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
    id, startedAt: Date.parse("2026-08-31T01:00:00.000Z"), latitude: 35, longitude: 139, originalLatitude: null, originalLongitude: null,
    locationSource: null, photoLocationAutoPlacementDisabled: false, accuracyMeters: null, mediaType: null, photoCount: 0, source: "location", updatedAt, ...extra,
  });
  const emptyPage = (cursor: string | null) => ({ data: [], meta: { deletedIds: [], deletions: [], cursor, nextPage: null, nextCursorToken: null, full: false } });

  it("uploads only what is not backed up yet and restores the rest page by page", async () => {
    await putLocalEvents(STORAGE, [event({ id: "local" })]);
    await claimRecords(STORAGE, "user-1");
    await deleteLocalEvents(STORAGE, []);
    const calls = stubApi(({ method, path }) => {
      if (method === "POST") return { data: { accepted: 1 } };
      if (path.startsWith("/api/v1/places")) return { data: [{ id: "home", name: "Home", latitude: 35, longitude: 139, updatedAt: 5, deleted: false }] };
      if (path.includes("page=")) return { data: [apiEvent("remote-2", 20)], meta: { deletions: [], cursor: "100|~", nextPage: null, nextCursorToken: null, full: true } };
      return { data: [apiEvent("remote-1", 10)], meta: { deletions: [], cursor: "100|~", nextPage: "100|1|b5", nextCursorToken: null, full: true } };
    });

    const outcome = await synchronizeEvents(STORAGE, "user-1");

    expect(outcome).toMatchObject({ online: true, unauthorized: false, pending: 0, changed: true });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/events/batch",
      "GET /api/v1/events?v=2",
      "GET /api/v1/events?v=2&page=100%7C1%7Cb5",
      "GET /api/v1/places",
    ]);
    expect(calls[0].body.events.map((item: { id: string }) => item.id)).toEqual(["local"]);
    expect(await countEvents(STORAGE)).toBe(3);
    expect(await loadSyncState(STORAGE)).toMatchObject({ cursors: { "user-1": { updatedAt: 100, id: "~" } }, fullSync: {} });
    expect((await loadStoredPlaces(STORAGE)).map((place) => place.name)).toEqual(["Home"]);

    // Nothing changed since: one head check, no download, nothing uploaded again.
    calls.length = 0;
    stubApi(({ path }) => path.endsWith("/head") ? { data: { cursor: "100|~" } } : { data: [] });
    expect((await synchronizeEvents(STORAGE, "user-1")).changed).toBe(false);
  });

  it("sends deletions with the hints that locate the record and applies remote deletions", async () => {
    await putLocalEvents(STORAGE, [event({ id: "mine" }), event({ id: "theirs", updatedAt: "2026-08-31T01:00:00.000Z" })]);
    await claimRecords(STORAGE, "user-1");
    await updateSyncState(STORAGE, (state) => { state.cursors["user-1"] = { updatedAt: 50, id: "~" }; });
    const { epoch } = await loadSyncState(STORAGE);
    await markEventsSynced(STORAGE, [event({ id: "mine" }), event({ id: "theirs" })], epoch);
    await deleteLocalEvents(STORAGE, ["mine"]);
    const calls = stubApi(({ method, path }) => {
      if (method === "POST") return { data: { deleted: 1 } };
      if (path.endsWith("/head")) return { data: { cursor: "60|~" } };
      if (path.startsWith("/api/v1/places")) return { data: [] };
      return { data: [], meta: { deletions: [{ id: "theirs", deletedAt: Date.parse("2026-09-01T00:00:00.000Z") }], cursor: "60|~", nextPage: null, nextCursorToken: null, full: false } };
    });

    const outcome = await synchronizeEvents(STORAGE, "user-1");

    expect(calls[0].body.deletions).toMatchObject([{ id: "mine", startedAt: Date.parse("2026-08-31T01:00:00.000Z"), source: "location" }]);
    expect(outcome).toMatchObject({ online: true, changed: true, removedIds: ["theirs"], pending: 0 });
    expect(await countEvents(STORAGE)).toBe(0);
    expect(await loadPendingDeletes(STORAGE)).toEqual([]);
  });

  it("keeps changes queued while offline and reports a rejected session", async () => {
    await putLocalEvents(STORAGE, [event({ id: "local" })]);
    await claimRecords(STORAGE, "user-1");
    stubApi(() => 503);
    expect(await synchronizeEvents(STORAGE, "user-1")).toMatchObject({ online: false, unauthorized: false, pending: 1 });
    stubApi(() => 401);
    expect(await synchronizeEvents(STORAGE, "user-1")).toMatchObject({ online: false, unauthorized: true, pending: 1 });
  });

  it("does not sync records that belong to another account", async () => {
    await putLocalEvents(STORAGE, [event({ id: "local" })]);
    await claimRecords(STORAGE, "user-1");
    const calls = stubApi(() => emptyPage(null));
    expect((await synchronizeEvents(STORAGE, "user-2")).online).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("timeline utilities", () => {
  it("sorts records by time", () => {
    const values = [event({ id: "old", startedAt: "2026-08-30T01:00:00.000Z" }), event()];
    expect(values.sort(sortNewest).map((item) => item.id)).toEqual(["event-1", "old"]);
    expect(values.sort(sortOldest).map((item) => item.id)).toEqual(["old", "event-1"]);
  });

  it("uses the local calendar day for date switching", () => {
    expect(dateKey(new Date(2026, 7, 31, 12))).toBe("2026-08-31");
  });
});

describe("timeline export and import", () => {
  it("exports the records of a range of local days and reads them back", async () => {
    const day = (value: string, hour: number) => { const date = new Date(`${value}T00:00:00`); date.setHours(hour); return date.toISOString(); };
    await putLocalEvents(STORAGE, [
      event({ id: "before", startedAt: day("2026-08-30", 14) }),
      event({ id: "location", startedAt: day("2026-08-31", 1) }),
      event({ id: "photo", source: "photo", photoCount: 2, startedAt: day("2026-09-01", 1) }),
      event({ id: "after", startedAt: day("2026-09-02", 1) }),
    ]);
    const range = { from: "2026-08-31", to: "2026-09-01" };

    expect(await summarizeRange(STORAGE, range)).toEqual({ eventCount: 2, photoRecordCount: 1, photoCount: 2, locationCount: 1 });
    const document = JSON.parse(await (await buildExport(STORAGE, range)).text());
    expect(document).toMatchObject({ schemaVersion: 1, range, summary: { eventCount: 2, photoRecordCount: 1, photoCount: 2 } });
    expect(document.events.map((item: LifeEvent) => item.id)).toEqual(["location", "photo"]);

    await clearEvents(STORAGE);
    const imported = await readImport(new Blob([JSON.stringify(document)]));
    await storeImported(STORAGE, imported);
    expect(await countEvents(STORAGE)).toBe(2);
    // Imported records are new local changes: they are uploaded.
    expect(await countUnsavedEvents(STORAGE)).toBe(2);
  });

  it("rejects records without valid dates", async () => {
    const file = { text: async () => JSON.stringify({ schemaVersion: 1, events: [{ id: "broken", startedAt: "not-a-date" }] }) } as File;
    await expect(readImport(file)).rejects.toThrow("読み込めるタイムライン記録がありません");
  });

  it("normalizes coordinates and photo counts", async () => {
    const file = { text: async () => JSON.stringify({ schemaVersion: 1, events: [{ id: " event-1 ", startedAt: "2026-08-31T01:00:00.000Z", source: "photo", photoCount: -3, latitude: 120, longitude: 139.7 }] }) } as File;
    const imported = await readImport(file);
    expect(imported[0]).toMatchObject({ id: "event-1", source: "photo", photoCount: 0, updatedAt: expect.any(String) });
    expect(imported[0]).not.toHaveProperty("longitude");
    expect(imported[0].latitude).toBeUndefined();
  });
});

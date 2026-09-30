import { describe, expect, it } from "vitest";
import { clearSyncPageCursor, dateKey, eventsInRange, LifeEvent, loadSyncPageCursor, loadSyncPageState, readImport, saveEvents, saveSyncPageCursor, saveSyncPageState, sortOldest, sortNewest } from "./life-log";

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

describe("timeline utilities", () => {
  it("persists and clears full-sync page progress", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
    const cursor = { snapshotAt: 1_000, updatedAt: 900, id: "event-900" };
    try {
      saveSyncPageCursor("user-1", cursor);
      expect(loadSyncPageCursor("user-1")).toEqual(cursor);
      clearSyncPageCursor("user-1");
      expect(loadSyncPageCursor("user-1")).toBeUndefined();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("persists fetched records with full-sync page progress", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
    const state = {
      snapshotAt: 1_000,
      updatedAt: 900,
      id: "event-900",
      nextPage: "1000|900|event-900",
      complete: false,
      events: [event()],
      deletedIds: ["deleted-1", "deleted-1"],
    };
    try {
      expect(saveSyncPageState("user-1", state)).toBe(true);
      expect(loadSyncPageState("user-1")).toEqual({ ...state, deletedIds: ["deleted-1"] });
      clearSyncPageCursor("user-1");
      expect(loadSyncPageState("user-1")).toBeUndefined();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("does not throw when the browser storage quota is exceeded", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => { throw new Error("QuotaExceededError"); } },
    });
    try {
      expect(saveEvents("device:test", [event()])).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("sorts records by time", () => {
    const values = [event({ id: "old", startedAt: "2026-08-30T01:00:00.000Z" }), event()];
    expect(values.sort(sortNewest).map((item) => item.id)).toEqual(["event-1", "old"]);
    expect(values.sort(sortOldest).map((item) => item.id)).toEqual(["old", "event-1"]);
  });

  it("uses the local calendar day for date switching", () => {
    expect(dateKey(new Date(2026, 7, 31, 12))).toBe("2026-08-31");
  });

  it("selects location and photo records inside an export range", () => {
    const values = [
      event({ id: "before", startedAt: "2026-08-30T14:00:00.000Z" }),
      event({ id: "location", startedAt: "2026-08-31T01:00:00.000Z" }),
      event({ id: "photo", source: "photo", photoCount: 2, startedAt: "2026-09-01T01:00:00.000Z" }),
      event({ id: "after", startedAt: "2026-09-02T01:00:00.000Z" }),
    ];

    expect(eventsInRange(values, { from: "2026-08-31", to: "2026-09-01" }).map((item) => item.id)).toEqual(["location", "photo"]);
  });
});

describe("timeline import", () => {
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

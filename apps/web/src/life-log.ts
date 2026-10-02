import { dateKey, dayRange } from "./day";
import { clearStoredEvents, clearUploadedPhotoIds, countDirtyEvents, countEvents, loadEventsInRange, loadSyncState, loadUploadedPhotoIds, markPhotoUploaded, migrateLocalStorageValue, putLocalEvents, updateSyncState } from "./timeline-db";

export { dateKey };

export type EventSource = "location" | "photo";
export type MediaType = "photo" | "video";
export type PhotoLocationSource = "exif" | "inferred" | "manual" | "removed";

/** The complete local representation of a timeline record. */
export type LifeEvent = {
  id: string;
  startedAt: string;
  latitude?: number;
  longitude?: number;
  /** The coordinate read from the photo before a user correction. */
  originalLatitude?: number;
  originalLongitude?: number;
  locationSource?: PhotoLocationSource;
  /** Keep an explicitly restored EXIF coordinate out of automatic display placement. */
  photoLocationAutoPlacementDisabled?: boolean;
  accuracyMeters?: number;
  /** The kind of media represented by a photo event. Omitted means photo for old records. */
  mediaType?: MediaType;
  photoCount: number;
  source: EventSource;
  updatedAt: string;
};

/** A name the user gave to a place they stay at. `updatedAt` is in milliseconds. */
export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  updatedAt: number;
  deleted: boolean;
};

export type SyncCursor = {
  updatedAt: number;
  id: string;
};

const EVENT_SOURCES = new Set<EventSource>(["location", "photo"]);
const MEDIA_TYPES = new Set<MediaType>(["photo", "video"]);
const PHOTO_LOCATION_SOURCES = new Set<PhotoLocationSource>(["exif", "inferred", "manual", "removed"]);
const DEVICE_ID_KEY = "remo:device-id";
// localStorage keys of earlier versions, read once to migrate or removed.
const legacyPhotoUploadPrefix = (userId: string) => `remo:photo-uploaded:${userId}:`;
export const lastBackupKey = (userId: string) => `remo:backup:last-success:${userId}`;

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage cleanup is best-effort.
  }
}

/** A browser's local timeline is independent from the account used for backup. */
export function localDeviceStorageId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY)?.trim();
    if (existing) return `device:${existing}`;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return `device:${id}`;
  } catch {
    // localStorage can be unavailable in privacy-restricted browser contexts.
    return "device:temporary";
  }
}

function parseEvents(raw: string | null): LifeEvent[] {
  if (!raw) return [];
  try {
    const values = JSON.parse(raw);
    return Array.isArray(values)
      ? values.flatMap((value) => {
          const event = normalizeEvent(value);
          return event ? [event] : [];
        })
      : [];
  } catch {
    return [];
  }
}

function localStorageKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => key !== null);
  } catch {
    return [];
  }
}

/**
 * Moves records kept in localStorage by the first web client into IndexedDB.
 * A record already in IndexedDB is kept.
 */
export async function migrateLegacyTimeline(storageId: string): Promise<void> {
  const keys = localStorageKeys().filter((key) => key.startsWith("remo:timeline:") && !key.startsWith("remo:timeline-sync"));
  for (const key of keys) {
    await migrateLocalStorageValue(key, async (raw) => {
      const legacy = parseEvents(raw);
      if (!legacy.length) return;
      const times = legacy.map((event) => Date.parse(event.startedAt));
      const stored = new Set((await loadEventsInRange(storageId, Math.min(...times), Math.max(...times) + 1)).map((event) => event.id));
      await putLocalEvents(storageId, legacy.filter((event) => !stored.has(event.id)));
    });
  }
}

/** The records of one local day, oldest first. */
export async function loadDayEvents(storageId: string, day: string): Promise<LifeEvent[]> {
  const { from, to } = dayRange(day);
  return (await loadEventsInRange(storageId, from, to)).flatMap((value) => {
    const event = normalizeEvent(value);
    return event ? [event] : [];
  });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validAccuracy(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

export function normalizeEvent(value: unknown): LifeEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 120) : "";
  const startedAt = validDate(raw.startedAt) ? new Date(raw.startedAt).toISOString() : null;
  const updatedAt = validDate(raw.updatedAt) ? new Date(raw.updatedAt).toISOString() : startedAt;
  const source = EVENT_SOURCES.has(raw.source as EventSource) ? raw.source as EventSource : "location";
  const latitude = validCoordinate(raw.latitude, -90, 90) ? raw.latitude : undefined;
  const longitude = validCoordinate(raw.longitude, -180, 180) ? raw.longitude : undefined;
  const originalLatitude = validCoordinate(raw.originalLatitude, -90, 90) ? raw.originalLatitude : undefined;
  const originalLongitude = validCoordinate(raw.originalLongitude, -180, 180) ? raw.originalLongitude : undefined;
  const locationSource = PHOTO_LOCATION_SOURCES.has(raw.locationSource as PhotoLocationSource)
    ? raw.locationSource as PhotoLocationSource
    : undefined;
  const photoLocationAutoPlacementDisabled = typeof raw.photoLocationAutoPlacementDisabled === "boolean"
    ? raw.photoLocationAutoPlacementDisabled
    : undefined;
  const accuracyMeters = validAccuracy(raw.accuracyMeters) ? raw.accuracyMeters : undefined;
  const mediaType = source === "photo" && MEDIA_TYPES.has(raw.mediaType as MediaType)
    ? raw.mediaType as MediaType
    : source === "photo" ? "photo" : undefined;
  const hasCoordinates = latitude !== undefined && longitude !== undefined && !(latitude === 0 && longitude === 0);

  if (!id || !startedAt || !updatedAt) return null;
  return {
    id,
    startedAt,
    ...(hasCoordinates ? { latitude, longitude } : {}),
    ...(originalLatitude !== undefined && originalLongitude !== undefined ? { originalLatitude, originalLongitude } : {}),
    ...(locationSource !== undefined ? { locationSource } : {}),
    ...(photoLocationAutoPlacementDisabled !== undefined ? { photoLocationAutoPlacementDisabled } : {}),
    ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
    photoCount: Math.max(0, Math.round(typeof raw.photoCount === "number" && Number.isFinite(raw.photoCount)
      ? raw.photoCount
      : source === "photo" ? 1 : 0)),
    source,
    updatedAt,
  };
}

// ---- Which account the records belong to ---------------------------------------

/**
 * The records in this browser are backed up to one account at a time.
 * "unclaimed" records have never been backed up (or their account was
 * deleted); "other" means they belong to a different account than the one
 * signing in, which must not receive them without the user saying so.
 */
export type Ownership = "owned" | "unclaimed" | "other";

export async function ownershipFor(storageId: string, userId: string): Promise<Ownership> {
  const { owner } = await loadSyncState(storageId);
  if (!owner) return "unclaimed";
  if (owner === userId) return "owned";
  // Nothing recorded here: there is nothing that could end up in the wrong account.
  return await countEvents(storageId) === 0 ? "unclaimed" : "other";
}

/** Backs the records in this browser up to [userId] from now on. */
export async function claimRecords(storageId: string, userId: string): Promise<void> {
  await updateSyncState(storageId, (state) => {
    // Records backed up to another account have to be uploaded to this one.
    if (state.owner && state.owner !== userId) state.epoch += 1;
    state.owner = userId;
  });
}

/** Removes the records of another account before [userId] starts using this browser. */
export async function replaceRecords(storageId: string, userId: string): Promise<void> {
  await clearStoredEvents(storageId);
  await updateSyncState(storageId, (state) => {
    state.owner = userId;
    delete state.cursors[userId];
    delete state.fullSync[userId];
  });
}

/** Removes every record in this browser and forgets what was downloaded. */
export async function clearEvents(storageId: string): Promise<void> {
  await clearStoredEvents(storageId);
  await updateSyncState(storageId, (state) => {
    state.cursors = {};
    state.fullSync = {};
  });
}

// Forgets everything kept for backing up to this account after the account was
// deleted: the download position and the photo upload markers. The records
// stay and count as not backed up, so a later account receives all of them.
export async function forgetAccount(storageId: string, userId: string): Promise<void> {
  removeStorage(lastBackupKey(userId));
  await updateSyncState(storageId, (state) => {
    delete state.cursors[userId];
    delete state.fullSync[userId];
    if (state.owner === userId) {
      state.owner = undefined;
      state.epoch += 1;
    }
  });
  await clearUploadedPhotoIds(userId).catch(() => undefined);
}

/** Records in this browser that are not in the backup yet. */
export async function countUnsavedEvents(storageId: string): Promise<number> {
  const state = await loadSyncState(storageId);
  return countDirtyEvents(storageId, state.owner ? state.epoch : Infinity);
}

export async function loadUploadedPhotos(userId: string): Promise<Set<string>> {
  const prefix = legacyPhotoUploadPrefix(userId);
  const legacy = localStorageKeys().filter((key) => key.startsWith(prefix));
  try {
    for (const key of legacy) {
      await migrateLocalStorageValue(key, () => markPhotoUploaded(userId, key.slice(prefix.length)));
    }
    return await loadUploadedPhotoIds(userId);
  } catch {
    return new Set();
  }
}

export async function rememberUploadedPhoto(userId: string, eventId: string): Promise<void> {
  await markPhotoUploaded(userId, eventId).catch(() => undefined);
}

// ---- Export and import ----------------------------------------------------------

export type ExportRange = {
  from: string;
  to: string;
};

export type ExportSummary = { eventCount: number; photoRecordCount: number; photoCount: number; locationCount: number };

function daysOf(range: ExportRange): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.from}T12:00:00`);
  const last = new Date(`${range.to}T12:00:00`);
  while (cursor <= last && days.length < 36_600) {
    days.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** Counts the records of a range one day at a time, without keeping them. */
export async function summarizeRange(storageId: string, range: ExportRange, signal?: AbortSignal): Promise<ExportSummary | undefined> {
  const summary: ExportSummary = { eventCount: 0, photoRecordCount: 0, photoCount: 0, locationCount: 0 };
  for (const day of daysOf(range)) {
    if (signal?.aborted) return undefined;
    for (const event of await loadDayEvents(storageId, day)) {
      summary.eventCount += 1;
      if (event.source === "photo") {
        summary.photoRecordCount += 1;
        summary.photoCount += event.photoCount;
      } else {
        summary.locationCount += 1;
      }
    }
  }
  return summary;
}

/**
 * Writes the records of a range as a Remo JSON document. The file is built a
 * day at a time, so a year of records is never held as one string.
 */
export async function buildExport(storageId: string, range: ExportRange): Promise<Blob> {
  const parts: string[] = [`{\n  "schemaVersion": 1,\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n  "range": ${JSON.stringify(range)},\n  "events": [`];
  const summary = { eventCount: 0, photoRecordCount: 0, photoCount: 0 };
  for (const day of daysOf(range)) {
    const events = await loadDayEvents(storageId, day);
    if (!events.length) continue;
    parts.push((summary.eventCount ? ",\n    " : "\n    ") + events.map((event) => JSON.stringify(event)).join(",\n    "));
    summary.eventCount += events.length;
    for (const event of events) {
      if (event.source !== "photo") continue;
      summary.photoRecordCount += 1;
      summary.photoCount += event.photoCount;
    }
  }
  parts.push(`\n  ],\n  "summary": ${JSON.stringify(summary)}\n}\n`);
  return new Blob(parts, { type: "application/json" });
}

export async function downloadExport(storageId: string, range: ExportRange): Promise<void> {
  const url = URL.createObjectURL(await buildExport(storageId, range));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `remo-timeline-${range.from}-${range.to}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readImport(file: Blob): Promise<LifeEvent[]> {
  const parsed = JSON.parse(await file.text()) as { schemaVersion?: unknown; events?: unknown[] };
  if (parsed.schemaVersion !== 1) throw new Error("RemoのJSONバージョンが対応していません");
  if (!Array.isArray(parsed.events)) throw new Error("RemoのJSONファイルではありません");

  const imported = parsed.events.flatMap((value) => {
    const event = normalizeEvent(value);
    return event ? [event] : [];
  });
  if (!imported.length && parsed.events.length) throw new Error("読み込めるタイムライン記録がありません");
  const importedAt = new Date().toISOString();
  return imported.map((event) => ({ ...event, updatedAt: importedAt }));
}

const IMPORT_BATCH = 2_000;

/** Stores imported records in batches so a large file does not hold one long transaction. */
export async function storeImported(storageId: string, events: LifeEvent[]): Promise<void> {
  for (let index = 0; index < events.length; index += IMPORT_BATCH) {
    await putLocalEvents(storageId, events.slice(index, index + IMPORT_BATCH));
  }
}

export function sortNewest(a: LifeEvent, b: LifeEvent): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

export function sortOldest(a: LifeEvent, b: LifeEvent): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

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

export type SyncOperation =
  | { id: string; kind: "upsert"; event: LifeEvent }
  | { id: string; kind: "delete"; eventId: string };

const EVENT_SOURCES = new Set<EventSource>(["location", "photo"]);
const MEDIA_TYPES = new Set<MediaType>(["photo", "video"]);
const PHOTO_LOCATION_SOURCES = new Set<PhotoLocationSource>(["exif", "inferred", "manual", "removed"]);
const DEVICE_ID_KEY = "remo:device-id";
const storageKey = (storageId: string) => `remo:timeline:${storageId}`;
const queueKey = (userId: string) => `remo:timeline-sync:${userId}`;
const cursorKey = (userId: string) => `remo:timeline-sync-cursor:${userId}`;
const pageCursorKey = (userId: string) => `remo:timeline-sync-page:${userId}`;
const pageStateKey = (userId: string) => `remo:timeline-sync-page-state:${userId}`;

/** Browser storage can be full or unavailable (private browsing, blocked storage, etc.). */
function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage cleanup is best-effort.
  }
}

export type SyncCursor = {
  updatedAt: number;
  id: string;
};

export type SyncPageCursor = SyncCursor & {
  snapshotAt: number;
};

export type SyncPageState = SyncPageCursor & {
  nextPage?: string;
  complete: boolean;
  events: LifeEvent[];
  deletedIds: string[];
};

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

function loadEventsFromKey(key: string): LifeEvent[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const values = JSON.parse(raw);
    return Array.isArray(values)
      ? values.flatMap((value) => {
          const event = normalizeEvent(value);
          return event ? [event] : [];
        }).sort(sortNewest)
      : [];
  } catch {
    return [];
  }
}

/** Move data written by the old auth-scoped web client into device storage. */
export function prepareLocalStorage(): string {
  const storageId = localDeviceStorageId();
  const currentKey = storageKey(storageId);
  const legacyKeys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("remo:timeline:") && !key.startsWith("remo:timeline-sync") && key !== currentKey) legacyKeys.push(key);
    }
  } catch {
    return storageId;
  }
  if (!legacyKeys.length) return storageId;
  const legacyEvents = legacyKeys.flatMap(loadEventsFromKey);
  if (!legacyEvents.length) {
    legacyKeys.forEach((key) => localStorage.removeItem(key));
    return storageId;
  }
  const merged = new Map(loadEventsFromKey(currentKey).map((event) => [event.id, event]));
  legacyEvents.forEach((event) => {
    const current = merged.get(event.id);
    if (!current || Date.parse(event.updatedAt) >= Date.parse(current.updatedAt)) merged.set(event.id, event);
  });
  if (!writeStorage(currentKey, JSON.stringify([...merged.values()].sort(sortNewest)))) return storageId;
  legacyKeys.forEach(removeStorage);
  return storageId;
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

function normalizeEvent(value: unknown): LifeEvent | null {
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

function isSyncOperation(value: unknown): value is SyncOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Record<string, unknown>;
  if (typeof operation.id !== "string") return false;
  if (operation.kind === "delete") return typeof operation.eventId === "string";
  return operation.kind === "upsert" && normalizeEvent(operation.event) !== null;
}

export function loadEvents(storageId: string): LifeEvent[] {
  return loadEventsFromKey(storageKey(storageId));
}

export function saveEvents(storageId: string, events: LifeEvent[]): boolean {
  // setItem is atomic: when quota is exceeded, the previous timeline value
  // remains intact. Never let that browser exception unmount the whole app.
  return writeStorage(storageKey(storageId), JSON.stringify(events));
}

export function clearEvents(storageId: string, syncUserId?: string): void {
  removeStorage(storageKey(storageId));
  if (syncUserId) clearSyncState(syncUserId);
}

// Forgets everything kept for backing up to this account: pending uploads,
// the download cursor and any partial full sync. Local records are untouched.
export function clearSyncState(syncUserId: string): void {
  removeStorage(queueKey(syncUserId));
  removeStorage(cursorKey(syncUserId));
  removeStorage(pageCursorKey(syncUserId));
  removeStorage(pageStateKey(syncUserId));
  removeStorage(`remo:backup:last-success:${syncUserId}`);
}

export function loadSyncCursor(userId: string): SyncCursor | undefined {
  const raw = localStorage.getItem(cursorKey(userId));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncCursor>;
    const updatedAt = parsed.updatedAt;
    const id = parsed.id;
    if (typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0 && typeof id === "string" && id) {
      return { updatedAt, id };
    }
  } catch {
    // A malformed cursor is replaced by the next successful v2 full sync.
  }
  // Older clients stored only a server timestamp. It cannot safely resume the
  // composite cursor, so discard it and let the bounded v2 snapshot rebuild it.
  removeStorage(cursorKey(userId));
  return undefined;
}

export function saveSyncCursor(userId: string, cursor: SyncCursor): void {
  if (Number.isSafeInteger(cursor.updatedAt) && cursor.updatedAt >= 0 && cursor.id) {
    writeStorage(cursorKey(userId), JSON.stringify(cursor));
  }
}

export function loadSyncPageCursor(userId: string): SyncPageCursor | undefined {
  try {
    const raw = localStorage.getItem(pageCursorKey(userId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<SyncPageCursor>;
    const snapshotAt = parsed.snapshotAt;
    const updatedAt = parsed.updatedAt;
    const id = parsed.id;
    if (typeof snapshotAt === "number" && Number.isSafeInteger(snapshotAt) && snapshotAt >= 0
      && typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0
      && typeof id === "string" && id) {
      return { snapshotAt, updatedAt, id };
    }
  } catch {
    // A malformed progress marker is safe to discard; the next sync restarts it.
  }
  removeStorage(pageCursorKey(userId));
  return undefined;
}

export function loadSyncPageState(userId: string): SyncPageState | undefined {
  try {
    const raw = localStorage.getItem(pageStateKey(userId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<SyncPageState>;
    const snapshotAt = parsed.snapshotAt;
    const updatedAt = parsed.updatedAt;
    const id = parsed.id;
    const events = Array.isArray(parsed.events)
      ? parsed.events.flatMap((value) => {
        const event = normalizeEvent(value);
        return event ? [event] : [];
      })
      : [];
    const deletedIds = Array.isArray(parsed.deletedIds)
      ? parsed.deletedIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (typeof snapshotAt !== "number" || !Number.isSafeInteger(snapshotAt) || snapshotAt < 0
      || typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0
      || typeof id !== "string" || !id || typeof parsed.complete !== "boolean") return undefined;
    return {
      snapshotAt,
      updatedAt,
      id,
      nextPage: typeof parsed.nextPage === "string" && parsed.nextPage ? parsed.nextPage : undefined,
      complete: parsed.complete,
      events,
      deletedIds: [...new Set(deletedIds)],
    };
  } catch {
    removeStorage(pageStateKey(userId));
    return undefined;
  }
}

export function saveSyncPageState(userId: string, state: SyncPageState): boolean {
  if (!Number.isSafeInteger(state.snapshotAt) || state.snapshotAt < 0
    || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0
    || !state.id || typeof state.complete !== "boolean") return false;
  return writeStorage(pageStateKey(userId), JSON.stringify(state));
}

export function saveSyncPageCursor(userId: string, cursor: SyncPageCursor): void {
  if (Number.isSafeInteger(cursor.snapshotAt) && cursor.snapshotAt >= 0
    && Number.isSafeInteger(cursor.updatedAt) && cursor.updatedAt >= 0 && cursor.id) {
    writeStorage(pageCursorKey(userId), JSON.stringify(cursor));
  }
}

export function clearSyncPageCursor(userId: string): void {
  removeStorage(pageCursorKey(userId));
  removeStorage(pageStateKey(userId));
}

export function loadSyncQueue(userId: string): SyncOperation[] {
  try {
    const raw = localStorage.getItem(queueKey(userId));
    if (!raw) return [];
    const values = JSON.parse(raw);
    return Array.isArray(values) ? values.filter(isSyncOperation) : [];
  } catch {
    return [];
  }
}

export function enqueueSync(userId: string, operation: SyncOperation): void {
  const eventId = operation.kind === "upsert" ? operation.event.id : operation.eventId;
  const next = loadSyncQueue(userId).filter((current) => {
    const currentEventId = current.kind === "upsert" ? current.event.id : current.eventId;
    return currentEventId !== eventId;
  });
  writeStorage(queueKey(userId), JSON.stringify([...next, operation]));
}

export function saveSyncQueue(userId: string, operations: SyncOperation[]): void {
  if (operations.length) writeStorage(queueKey(userId), JSON.stringify(operations));
  else removeStorage(queueKey(userId));
}

export type ExportRange = {
  from: string;
  to: string;
};

export function eventsInRange(events: LifeEvent[], range: ExportRange): LifeEvent[] {
  return events.filter((event) => {
    const date = dateKey(event.startedAt);
    return date >= range.from && date <= range.to;
  }).sort(sortOldest);
}

export function downloadExport(userId: string, events: LifeEvent[], range: ExportRange): void {
  const selected = eventsInRange(events, range);
  const photoEvents = selected.filter((event) => event.source === "photo");
  const payload = JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    range,
    summary: {
      eventCount: selected.length,
      photoRecordCount: photoEvents.length,
      photoCount: photoEvents.reduce((sum, event) => sum + event.photoCount, 0),
    },
    events: selected,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `remo-timeline-${range.from}-${range.to}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readImport(file: File): Promise<LifeEvent[]> {
  const parsed = JSON.parse(await file.text()) as { schemaVersion?: unknown; events?: unknown[] };
  if (parsed.schemaVersion !== 1) throw new Error("RemoのJSONバージョンが対応していません");
  if (!Array.isArray(parsed.events)) throw new Error("RemoのJSONファイルではありません");

  const imported = parsed.events.flatMap((value) => {
    const event = normalizeEvent(value);
    return event ? [event] : [];
  });
  if (!imported.length && parsed.events.length) throw new Error("読み込めるタイムライン記録がありません");
  return imported.map((event) => ({ ...event, updatedAt: new Date().toISOString() })).sort(sortNewest);
}

export function sortNewest(a: LifeEvent, b: LifeEvent): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

export function sortOldest(a: LifeEvent, b: LifeEvent): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

export function dateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

import { dateKey } from "./day";
import type { EventSource, LifeEvent, Place, SyncCursor } from "./life-log";

// The browser's timeline lives in IndexedDB, one row per record. The app keeps
// only the day on screen in memory and reads everything else through the
// indexes here: by time for a day or an export, and by sync state for the
// records that still have to be uploaded.
const DATABASE_NAME = "remo-timeline";
const DATABASE_VERSION = 2;
const EVENTS = "events";
const PENDING_DELETES = "pendingDeletes";
const DIRTY_DAYS = "dirtyDays";
const PLACES = "places";
const PHOTO_UPLOADS = "photoUploads";
const STATE = "state";
/** Version 1 only: one queued upload or deletion per record and account. */
const LEGACY_SYNC_QUEUE = "syncQueue";

const BY_TIME = "byTime";
const BY_SYNC = "bySync";

/**
 * `t` is the record's start in milliseconds. `s` is the sync epoch the record
 * was last backed up in: 0 after a local change, and anything below the
 * current epoch means the record still has to be uploaded.
 */
type StoredEvent = { storageId: string; id: string; event: LifeEvent; t: number; s: number };
type StoredDeletion = { storageId: string; id: string; deletedAt: number; startedAt?: number; source?: EventSource };
type StoredDirtyDay = { storageId: string; day: string; token: number };
type StoredPlace = { storageId: string; id: string; place: Place; s: number };
type StoredUpload = { userId: string; eventId: string };

export type PendingDeletion = Omit<StoredDeletion, "storageId">;
export type DirtyDay = { day: string; token: number };

/**
 * What this browser knows about backing its records up. The records belong to
 * one account at a time (`owner`); raising `epoch` marks every record as not
 * backed up, which is how the records are handed to another account.
 */
export type SyncState = {
  owner?: string;
  epoch: number;
  /** Download cursor per account. */
  cursors: Record<string, SyncCursor>;
  /** Where an interrupted full download continues, per account. */
  fullSync: Record<string, string>;
};

const emptySyncState = (): SyncState => ({ epoch: 1, cursors: {}, fullSync: {} });
const syncStateKey = (storageId: string) => `sync:${storageId}`;

let databasePromise: Promise<IDBDatabase> | undefined;

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
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
 * Version 1 kept a queue of operations per account and the download cursor in
 * localStorage. The account that was backing this browser up becomes the owner
 * of its records, and a record is marked for upload when that account had it
 * queued. Without such an account nothing was ever uploaded, so every record
 * is.
 */
function migrateFromVersion1(database: IDBDatabase, transaction: IDBTransaction) {
  const cursorPrefix = "remo:timeline-sync-cursor:";
  const accounts = localStorageKeys().filter((key) => key.startsWith(cursorPrefix)).map((key) => key.slice(cursorPrefix.length));
  const lastBackup = (userId: string) => Date.parse(readLocalStorage(`remo:backup:last-success:${userId}`) ?? "") || 0;
  const owner = accounts.sort((first, second) => lastBackup(second) - lastBackup(first))[0];
  const state = emptySyncState();
  if (owner) {
    state.owner = owner;
    try {
      const cursor = JSON.parse(readLocalStorage(cursorPrefix + owner) ?? "null") as Partial<SyncCursor> | null;
      if (cursor && typeof cursor.updatedAt === "number" && typeof cursor.id === "string" && cursor.id) {
        state.cursors[owner] = { updatedAt: cursor.updatedAt, id: cursor.id };
      }
    } catch {
      // Without a cursor the next sync downloads everything again.
    }
  }

  const queue = transaction.objectStore(LEGACY_SYNC_QUEUE).getAll() as IDBRequest<Array<{ userId: string; eventId: string; operation: { kind: string } }>>;
  queue.onsuccess = () => {
    const queued = queue.result.filter((row) => row.userId === owner);
    const dirty = new Set(queued.filter((row) => row.operation.kind === "upsert").map((row) => row.eventId));
    const deleted = queued.filter((row) => row.operation.kind === "delete").map((row) => row.eventId);
    const events = transaction.objectStore(EVENTS);
    const storageIds = new Set<string>();
    const walk = events.openCursor();
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor) {
        const stateStore = transaction.objectStore(STATE);
        const pendingDeletes = transaction.objectStore(PENDING_DELETES);
        storageIds.forEach((storageId) => {
          stateStore.put(state, syncStateKey(storageId));
          deleted.forEach((id) => pendingDeletes.put({ storageId, id, deletedAt: Date.now() } satisfies StoredDeletion));
        });
        database.deleteObjectStore(LEGACY_SYNC_QUEUE);
        return;
      }
      const row = cursor.value as StoredEvent;
      storageIds.add(row.storageId);
      cursor.update({
        ...row,
        t: Date.parse(row.event.startedAt) || 0,
        s: !owner || dirty.has(row.id) ? 0 : state.epoch,
      } satisfies StoredEvent);
      cursor.continue();
    };
  };
}

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (upgrade) => {
      const database = request.result;
      const transaction = request.transaction!;
      const events = upgrade.oldVersion < 1
        ? database.createObjectStore(EVENTS, { keyPath: ["storageId", "id"] })
        : transaction.objectStore(EVENTS);
      if (upgrade.oldVersion < 1) {
        events.createIndex("storageId", "storageId");
        database.createObjectStore(PHOTO_UPLOADS, { keyPath: ["userId", "eventId"] }).createIndex("userId", "userId");
        database.createObjectStore(STATE);
      }
      events.createIndex(BY_TIME, ["storageId", "t"]);
      events.createIndex(BY_SYNC, ["storageId", "s"]);
      database.createObjectStore(PENDING_DELETES, { keyPath: ["storageId", "id"] });
      database.createObjectStore(DIRTY_DAYS, { keyPath: ["storageId", "day"] });
      database.createObjectStore(PLACES, { keyPath: ["storageId", "id"] });
      if (upgrade.oldVersion === 1) migrateFromVersion1(database, transaction);
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading the schema closes this connection; reopen lazily.
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open timeline storage"));
    request.onblocked = () => reject(new Error("Timeline storage is blocked by another tab"));
  }).catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Timeline storage request failed"));
  });
}

async function transact<T>(stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => T | Promise<T>): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Timeline storage transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Timeline storage transaction aborted"));
  });
  const result = await work(transaction);
  await done;
  return result;
}

const everyKeyOf = (owner: string) => IDBKeyRange.bound([owner], [owner, []]);
const timeOf = (event: LifeEvent) => Date.parse(event.startedAt) || 0;
const updatedAtOf = (event: LifeEvent) => Date.parse(event.updatedAt) || 0;

/** A day whose records changed has to have its stays detected again. */
function markDay(transaction: IDBTransaction, storageId: string, time: number, touched: Set<string>) {
  const day = dateKey(time);
  if (touched.has(day)) return;
  touched.add(day);
  transaction.objectStore(DIRTY_DAYS).put({ storageId, day, token: Date.now() + Math.random() } satisfies StoredDirtyDay);
}

// ---- Records -----------------------------------------------------------------

/** Records that start in [from, to), oldest first. */
export async function loadEventsInRange(storageId: string, from: number, to: number): Promise<LifeEvent[]> {
  return transact([EVENTS], "readonly", async (transaction) => {
    const range = IDBKeyRange.bound([storageId, from], [storageId, to], false, true);
    const rows = await requestResult(transaction.objectStore(EVENTS).index(BY_TIME).getAll(range) as IDBRequest<StoredEvent[]>);
    return rows.map((row) => row.event);
  });
}

export async function loadEvent(storageId: string, id: string): Promise<LifeEvent | undefined> {
  return transact([EVENTS], "readonly", async (transaction) => {
    const row = await requestResult(transaction.objectStore(EVENTS).get([storageId, id]) as IDBRequest<StoredEvent | undefined>);
    return row?.event;
  });
}

export async function countEvents(storageId: string): Promise<number> {
  return transact([EVENTS], "readonly", (transaction) =>
    requestResult(transaction.objectStore(EVENTS).index(BY_TIME).count(IDBKeyRange.bound([storageId, -Infinity], [storageId, Infinity]))));
}

/** Every local day that has a record, oldest first. Reads one key per day. */
export async function listRecordedDays(storageId: string): Promise<string[]> {
  return transact([EVENTS], "readonly", (transaction) => new Promise<string[]>((resolve, reject) => {
    const days: string[] = [];
    const walk = transaction.objectStore(EVENTS).index(BY_TIME)
      .openKeyCursor(IDBKeyRange.bound([storageId, -Infinity], [storageId, Infinity]));
    walk.onerror = () => reject(walk.error ?? new Error("Could not list recorded days"));
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor) {
        resolve(days);
        return;
      }
      const time = (cursor.key as [string, number])[1];
      const day = dateKey(time);
      days.push(day);
      const next = new Date(`${day}T00:00:00`);
      next.setDate(next.getDate() + 1);
      cursor.continue([storageId, next.getTime()]);
    };
  }));
}

/** Writes records created or edited on this device; they are uploaded on the next backup. */
export async function putLocalEvents(storageId: string, events: LifeEvent[]): Promise<void> {
  if (!events.length) return;
  await transact([EVENTS, DIRTY_DAYS, PENDING_DELETES], "readwrite", async (transaction) => {
    const store = transaction.objectStore(EVENTS);
    const pendingDeletes = transaction.objectStore(PENDING_DELETES);
    const touched = new Set<string>();
    await Promise.all(events.map(async (event) => {
      const previous = await requestResult(store.get([storageId, event.id]) as IDBRequest<StoredEvent | undefined>);
      if (previous && previous.t !== timeOf(event)) markDay(transaction, storageId, previous.t, touched);
      markDay(transaction, storageId, timeOf(event), touched);
      store.put({ storageId, id: event.id, event, t: timeOf(event), s: 0 } satisfies StoredEvent);
      // Writing a record again takes back a deletion that was not sent yet.
      pendingDeletes.delete([storageId, event.id]);
    }));
  });
}

/**
 * Deletes records on this device. When the records are backed up to an
 * account, the deletions are queued so the backup and the other devices drop
 * them too. Returns the records that existed.
 */
export async function deleteLocalEvents(storageId: string, ids: string[]): Promise<LifeEvent[]> {
  if (!ids.length) return [];
  return transact([EVENTS, DIRTY_DAYS, PENDING_DELETES, STATE], "readwrite", async (transaction) => {
    const store = transaction.objectStore(EVENTS);
    const state = await requestResult(transaction.objectStore(STATE).get(syncStateKey(storageId)) as IDBRequest<SyncState | undefined>);
    const touched = new Set<string>();
    const removed: LifeEvent[] = [];
    const deletedAt = Date.now();
    await Promise.all(ids.map(async (id) => {
      const row = await requestResult(store.get([storageId, id]) as IDBRequest<StoredEvent | undefined>);
      if (!row) return;
      removed.push(row.event);
      store.delete([storageId, id]);
      markDay(transaction, storageId, row.t, touched);
      if (state?.owner) {
        transaction.objectStore(PENDING_DELETES).put({ storageId, id, deletedAt, startedAt: row.t, source: row.event.source } satisfies StoredDeletion);
      }
    }));
    return removed;
  });
}

/**
 * Applies what a download returned. A record from the backup is taken when it
 * is missing here or newer than the local copy; a record deleted on another
 * device is removed unless it was edited here after that deletion. Returns the
 * ids removed and whether anything changed.
 */
export async function applyRemoteChanges(
  storageId: string,
  events: LifeEvent[],
  deletions: Array<{ id: string; deletedAt: number }>,
  epoch: number,
): Promise<{ changed: boolean; removedIds: string[] }> {
  if (!events.length && !deletions.length) return { changed: false, removedIds: [] };
  return transact([EVENTS, DIRTY_DAYS, PENDING_DELETES], "readwrite", async (transaction) => {
    const store = transaction.objectStore(EVENTS);
    const pendingDeletes = transaction.objectStore(PENDING_DELETES);
    const touched = new Set<string>();
    const removedIds: string[] = [];
    let changed = false;
    await Promise.all(events.map(async (event) => {
      const [local, pendingDelete] = await Promise.all([
        requestResult(store.get([storageId, event.id]) as IDBRequest<StoredEvent | undefined>),
        requestResult(pendingDeletes.getKey([storageId, event.id])),
      ]);
      // A record deleted here stays deleted until that deletion has been sent.
      if (pendingDelete !== undefined) return;
      if (local && updatedAtOf(local.event) >= updatedAtOf(event)) return;
      if (local && local.t !== timeOf(event)) markDay(transaction, storageId, local.t, touched);
      markDay(transaction, storageId, timeOf(event), touched);
      store.put({ storageId, id: event.id, event, t: timeOf(event), s: epoch } satisfies StoredEvent);
      changed = true;
    }));
    await Promise.all(deletions.map(async ({ id, deletedAt }) => {
      const local = await requestResult(store.get([storageId, id]) as IDBRequest<StoredEvent | undefined>);
      if (!local || updatedAtOf(local.event) > deletedAt) return;
      store.delete([storageId, id]);
      markDay(transaction, storageId, local.t, touched);
      removedIds.push(id);
      changed = true;
    }));
    return { changed, removedIds };
  });
}

/** Records that have not been backed up in the current epoch. */
export async function loadDirtyEvents(storageId: string, epoch: number, limit: number): Promise<LifeEvent[]> {
  return transact([EVENTS], "readonly", async (transaction) => {
    const range = IDBKeyRange.bound([storageId, -Infinity], [storageId, epoch], false, true);
    const rows = await requestResult(transaction.objectStore(EVENTS).index(BY_SYNC).getAll(range, limit) as IDBRequest<StoredEvent[]>);
    return rows.map((row) => row.event);
  });
}

export async function countDirtyEvents(storageId: string, epoch: number): Promise<number> {
  return transact([EVENTS], "readonly", (transaction) =>
    requestResult(transaction.objectStore(EVENTS).index(BY_SYNC).count(IDBKeyRange.bound([storageId, -Infinity], [storageId, epoch], false, true))));
}

/** Marks sent records as backed up, unless they were edited while the request was in flight. */
export async function markEventsSynced(storageId: string, sent: LifeEvent[], epoch: number): Promise<void> {
  if (!sent.length) return;
  await transact([EVENTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(EVENTS);
    await Promise.all(sent.map(async (event) => {
      const row = await requestResult(store.get([storageId, event.id]) as IDBRequest<StoredEvent | undefined>);
      if (row && row.event.updatedAt === event.updatedAt) store.put({ ...row, s: epoch } satisfies StoredEvent);
    }));
  });
}

export async function loadPendingDeletes(storageId: string, limit?: number): Promise<PendingDeletion[]> {
  return transact([PENDING_DELETES], "readonly", async (transaction) => {
    const rows = await requestResult(transaction.objectStore(PENDING_DELETES).getAll(everyKeyOf(storageId), limit) as IDBRequest<StoredDeletion[]>);
    return rows.map(({ id, deletedAt, startedAt, source }) => ({ id, deletedAt, startedAt, source }));
  });
}

export async function removePendingDeletes(storageId: string, sent: PendingDeletion[]): Promise<void> {
  if (!sent.length) return;
  await transact([PENDING_DELETES], "readwrite", async (transaction) => {
    const store = transaction.objectStore(PENDING_DELETES);
    await Promise.all(sent.map(async (deletion) => {
      const current = await requestResult(store.get([storageId, deletion.id]) as IDBRequest<StoredDeletion | undefined>);
      if (current?.deletedAt === deletion.deletedAt) store.delete([storageId, deletion.id]);
    }));
  });
}

/** Removes this device's records and everything queued for them. The sync state is kept. */
export async function clearStoredEvents(storageId: string): Promise<void> {
  await transact([EVENTS, DIRTY_DAYS, PENDING_DELETES, PLACES], "readwrite", (transaction) => {
    [EVENTS, DIRTY_DAYS, PENDING_DELETES, PLACES].forEach((name) => transaction.objectStore(name).delete(everyKeyOf(storageId)));
  });
}

// ---- Days whose stays are stale -------------------------------------------------

export async function loadDirtyDays(storageId: string): Promise<DirtyDay[]> {
  return transact([DIRTY_DAYS], "readonly", async (transaction) => {
    const rows = await requestResult(transaction.objectStore(DIRTY_DAYS).getAll(everyKeyOf(storageId)) as IDBRequest<StoredDirtyDay[]>);
    return rows.map(({ day, token }) => ({ day, token }));
  });
}

/** Forgets days that were recomputed, unless their records changed again meanwhile. */
export async function clearDirtyDays(storageId: string, days: DirtyDay[]): Promise<void> {
  if (!days.length) return;
  await transact([DIRTY_DAYS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(DIRTY_DAYS);
    await Promise.all(days.map(async ({ day, token }) => {
      const current = await requestResult(store.get([storageId, day]) as IDBRequest<StoredDirtyDay | undefined>);
      if (current?.token === token) store.delete([storageId, day]);
    }));
  });
}

// ---- Sync state ---------------------------------------------------------------

export async function loadSyncState(storageId: string): Promise<SyncState> {
  return transact([STATE], "readonly", async (transaction) => {
    const stored = await requestResult(transaction.objectStore(STATE).get(syncStateKey(storageId)) as IDBRequest<Partial<SyncState> | undefined>);
    return { ...emptySyncState(), ...stored };
  });
}

/** Reads, changes and writes the sync state in one transaction. */
export async function updateSyncState(storageId: string, change: (state: SyncState) => void): Promise<SyncState> {
  return transact([STATE], "readwrite", async (transaction) => {
    const store = transaction.objectStore(STATE);
    const stored = await requestResult(store.get(syncStateKey(storageId)) as IDBRequest<Partial<SyncState> | undefined>);
    const state: SyncState = { ...emptySyncState(), ...stored };
    change(state);
    store.put(state, syncStateKey(storageId));
    return state;
  });
}

// ---- Places -------------------------------------------------------------------

export async function loadStoredPlaces(storageId: string): Promise<Place[]> {
  return transact([PLACES], "readonly", async (transaction) => {
    const rows = await requestResult(transaction.objectStore(PLACES).getAll(everyKeyOf(storageId)) as IDBRequest<StoredPlace[]>);
    return rows.map((row) => row.place);
  });
}

export async function putLocalPlace(storageId: string, place: Place): Promise<void> {
  await transact([PLACES], "readwrite", (transaction) => {
    transaction.objectStore(PLACES).put({ storageId, id: place.id, place, s: 0 } satisfies StoredPlace);
  });
}

export async function loadDirtyPlaces(storageId: string, epoch: number): Promise<Place[]> {
  return transact([PLACES], "readonly", async (transaction) => {
    const rows = await requestResult(transaction.objectStore(PLACES).getAll(everyKeyOf(storageId)) as IDBRequest<StoredPlace[]>);
    return rows.filter((row) => row.s < epoch).map((row) => row.place);
  });
}

export async function markPlacesSynced(storageId: string, sent: Place[], epoch: number): Promise<void> {
  if (!sent.length) return;
  await transact([PLACES], "readwrite", async (transaction) => {
    const store = transaction.objectStore(PLACES);
    await Promise.all(sent.map(async (place) => {
      const row = await requestResult(store.get([storageId, place.id]) as IDBRequest<StoredPlace | undefined>);
      if (row && row.place.updatedAt === place.updatedAt) store.put({ ...row, s: epoch } satisfies StoredPlace);
    }));
  });
}

/** Takes the places from the backup that are newer than the local copy. Returns whether anything changed. */
export async function applyRemotePlaces(storageId: string, places: Place[], epoch: number): Promise<boolean> {
  if (!places.length) return false;
  return transact([PLACES], "readwrite", async (transaction) => {
    const store = transaction.objectStore(PLACES);
    let changed = false;
    await Promise.all(places.map(async (place) => {
      const row = await requestResult(store.get([storageId, place.id]) as IDBRequest<StoredPlace | undefined>);
      if (row && row.place.updatedAt >= place.updatedAt) return;
      store.put({ storageId, id: place.id, place, s: epoch } satisfies StoredPlace);
      changed = true;
    }));
    return changed;
  });
}

// ---- Photo backup markers ----------------------------------------------------

export async function loadUploadedPhotoIds(userId: string): Promise<Set<string>> {
  return transact([PHOTO_UPLOADS], "readonly", async (transaction) => {
    const rows = await requestResult(transaction.objectStore(PHOTO_UPLOADS).index("userId").getAll(userId) as IDBRequest<StoredUpload[]>);
    return new Set(rows.map((row) => row.eventId));
  });
}

export async function markPhotoUploaded(userId: string, eventId: string): Promise<void> {
  await transact([PHOTO_UPLOADS], "readwrite", (transaction) => {
    transaction.objectStore(PHOTO_UPLOADS).put({ userId, eventId } satisfies StoredUpload);
  });
}

export async function clearUploadedPhotoIds(userId: string): Promise<void> {
  await transact([PHOTO_UPLOADS], "readwrite", (transaction) => {
    transaction.objectStore(PHOTO_UPLOADS).delete(everyKeyOf(userId));
  });
}

// ---- Migration from localStorage ----------------------------------------------

/**
 * Moves one localStorage value into IndexedDB. The localStorage copy is removed
 * only after the IndexedDB write committed, so an interrupted migration is
 * simply retried on the next start.
 */
export async function migrateLocalStorageValue(key: string, write: (raw: string) => Promise<void>): Promise<void> {
  const raw = readLocalStorage(key);
  if (raw === null) return;
  await write(raw);
  try {
    localStorage.removeItem(key);
  } catch {
    // Left in place; the next migration rewrites the same rows.
  }
}

/** Asks the browser not to evict the timeline, which may exist only here. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {
    // Best effort: without it the browser may evict data under storage pressure.
  }
}

export type StorageUsage = { usageBytes: number; quotaBytes: number; persisted: boolean };

export async function storageUsage(): Promise<StorageUsage | undefined> {
  try {
    if (!navigator.storage?.estimate) return undefined;
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? Promise.resolve(false),
    ]);
    if (estimate.usage === undefined || estimate.quota === undefined) return undefined;
    return { usageBytes: estimate.usage, quotaBytes: estimate.quota, persisted };
  } catch {
    return undefined;
  }
}

/** Closes the connection so a test can delete or reopen the database. */
export async function closeDatabaseForTests(): Promise<void> {
  const database = await databasePromise?.catch(() => undefined);
  database?.close();
  databasePromise = undefined;
}

// The stay index is one JSON string per device storage. It lives in IndexedDB
// rather than localStorage so it neither competes with the records for the
// localStorage quota nor blocks the main thread while being written.
const DATABASE_NAME = "remo-stay-index";
const STORE_NAME = "caches";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open stay index storage"));
  });
}

async function write(storageId: string, apply: (store: IDBObjectStore) => void): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      apply(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(`Could not update the stay index for ${storageId}`));
      transaction.onabort = () => reject(transaction.error ?? new Error(`Could not update the stay index for ${storageId}`));
    });
  } finally {
    database.close();
  }
}

export async function loadStayIndexCache(storageId: string): Promise<string | undefined> {
  try {
    const database = await openDatabase();
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(storageId);
        request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : undefined);
        request.onerror = () => reject(request.error ?? new Error("Could not load the stay index"));
      });
    } finally {
      database.close();
    }
  } catch {
    // Without a cache every past day is recomputed.
    return undefined;
  }
}

export async function saveStayIndexCache(storageId: string, value: string): Promise<void> {
  try {
    await write(storageId, (store) => store.put(value, storageId));
  } catch {
    // The index is recomputed next time; nothing is lost.
  }
}

export async function deleteStayIndexCache(storageId: string): Promise<void> {
  try {
    await write(storageId, (store) => store.delete(storageId));
  } catch {
    // A stale index is discarded anyway once the records no longer match it.
  }
}

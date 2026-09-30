const DATABASE_NAME = "remo-photo-previews";
const STORE_NAME = "previews";
const DATABASE_VERSION = 1;

type StoredPreview = {
  key: string;
  blob: Blob;
};

function storageKey(userId: string, eventId: string) {
  return `${userId}:${eventId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open photo storage"));
  });
}

export async function savePhotoPreview(userId: string, eventId: string, file: Blob): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key: storageKey(userId, eventId), blob: file } satisfies StoredPreview);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save photo preview"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save photo preview"));
    });
    database.close();
  } catch {
    // A preview is still available from the in-memory object URL for this session.
  }
}

export async function loadPhotoPreview(userId: string, eventId: string): Promise<Blob | undefined> {
  try {
    const database = await openDatabase();
    const preview = await new Promise<StoredPreview | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(storageKey(userId, eventId));
      request.onsuccess = () => resolve(request.result as StoredPreview | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not load photo preview"));
    });
    database.close();
    return preview?.blob;
  } catch {
    return undefined;
  }
}

export async function listLocalPhotoPreviewIds(userId: string): Promise<Set<string>> {
  try {
    const database = await openDatabase();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not list photo previews"));
    });
    database.close();
    const prefix = `${userId}:`;
    return new Set(keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
  } catch { return new Set(); }
}

export async function deletePhotoPreview(userId: string, eventId: string): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(storageKey(userId, eventId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete photo preview"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete photo preview"));
    });
    database.close();
  } catch {
    // Missing browser storage must not prevent deleting the timeline record.
  }
}

export async function deleteAllPhotoPreviews(userId: string): Promise<void> {
  try {
    const database = await openDatabase();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not list photo previews"));
    });
    const prefix = `${userId}:`;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix)).forEach((key) => store.delete(key));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete photo previews"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete photo previews"));
    });
    database.close();
  } catch {
    // Missing browser storage must not prevent deleting the timeline records.
  }
}

/** Preserve previews created by the old auth-scoped web client. */
export async function migratePhotoPreviews(storageId: string): Promise<void> {
  try {
    const database = await openDatabase();
    const previews = await new Promise<StoredPreview[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredPreview[]);
      request.onerror = () => reject(request.error ?? new Error("Could not list photo previews"));
    });
    const prefix = `${storageId}:`;
    const legacy = previews.filter((preview) => !preview.key.startsWith(prefix));
    if (!legacy.length) {
      database.close();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      legacy.forEach((preview) => {
        const eventId = preview.key.slice(preview.key.indexOf(":") + 1);
        if (eventId) store.put({ key: `${storageId}:${eventId}`, blob: preview.blob } satisfies StoredPreview);
        store.delete(preview.key);
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not migrate photo previews"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not migrate photo previews"));
    });
    database.close();
  } catch {
    // Timeline metadata remains usable even when IndexedDB is unavailable.
  }
}

async function makeVideoThumbnail(file: Blob, maxSize: number): Promise<Blob> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Could not read video")), { once: true });
      video.src = url;
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return file;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    return thumbnail ?? file;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

export async function makePhotoThumbnail(file: Blob, maxSize = 640): Promise<Blob> {
  if (typeof document === "undefined") return file;
  if (file.type.startsWith("video/")) {
    try {
      return await makeVideoThumbnail(file, maxSize);
    } catch {
      return file;
    }
  }
  if (typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    return thumbnail ?? file;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

export async function makeBackupThumbnail(file: Blob): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    for (const maxSize of [640, 512, 384]) {
      const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.76, 0.62, 0.48]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= 160_000) return blob;
      }
    }
    return undefined;
  } finally {
    bitmap?.close();
  }
}

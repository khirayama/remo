import { clearSyncPageCursor, enqueueSync, LifeEvent, loadSyncCursor, loadSyncPageState, loadSyncQueue, MediaType, PhotoLocationSource, saveSyncCursor, saveSyncPageState, saveSyncQueue, sortNewest, SyncCursor, SyncPageCursor, SyncPageState } from "./life-log";

const baseURL = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");

type ApiEvent = {
  id: string;
  startedAt: number;
  latitude: number | null;
  longitude: number | null;
  originalLatitude: number | null;
  originalLongitude: number | null;
  locationSource: PhotoLocationSource | null;
  photoLocationAutoPlacementDisabled: boolean | null;
  accuracyMeters: number | null;
  mediaType: MediaType | null;
  photoCount: number;
  source: LifeEvent["source"];
  updatedAt: number;
};

type EventSnapshot = {
  events: LifeEvent[];
  deletedIds: string[];
  cursor?: SyncCursor;
  full: boolean;
};

type EventPage = EventSnapshot & {
  nextPage?: string;
  nextCursorToken?: string;
};

function encodeCursor(cursor: SyncCursor): string {
  return `${cursor.updatedAt}|${cursor.id}`;
}

function decodeCursor(value: unknown): SyncCursor | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("|");
  if (separator <= 0) return undefined;
  const updatedAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  return Number.isSafeInteger(updatedAt) && updatedAt >= 0 && id ? { updatedAt, id } : undefined;
}

function compareCursors(first: SyncCursor, second: SyncCursor): number {
  if (first.updatedAt !== second.updatedAt) return first.updatedAt - second.updatedAt;
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

function decodePageCursor(value: unknown): SyncPageCursor | undefined {
  if (typeof value !== "string") return undefined;
  const firstSeparator = value.indexOf("|");
  const secondSeparator = value.indexOf("|", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return undefined;
  const snapshotAt = Number(value.slice(0, firstSeparator));
  const updatedAt = Number(value.slice(firstSeparator + 1, secondSeparator));
  const id = value.slice(secondSeparator + 1);
  return Number.isSafeInteger(snapshotAt) && snapshotAt >= 0
    && Number.isSafeInteger(updatedAt) && updatedAt >= 0 && id
    ? { snapshotAt, updatedAt, id }
    : undefined;
}

function sameEvent(first: LifeEvent, second: LifeEvent): boolean {
  return first.id === second.id
    && first.startedAt === second.startedAt
    && first.latitude === second.latitude
    && first.longitude === second.longitude
    && first.originalLatitude === second.originalLatitude
    && first.originalLongitude === second.originalLongitude
    && (first.locationSource ?? null) === (second.locationSource ?? null)
    && (first.photoLocationAutoPlacementDisabled ?? false) === (second.photoLocationAutoPlacementDisabled ?? false)
    && (first.accuracyMeters ?? null) === (second.accuracyMeters ?? null)
    && (first.mediaType ?? (first.source === "photo" ? "photo" : null)) === (second.mediaType ?? (second.source === "photo" ? "photo" : null))
    && first.photoCount === second.photoCount
    && first.source === second.source
    && first.updatedAt === second.updatedAt;
}

function fromApi(event: ApiEvent): LifeEvent {
  return {
    id: event.id,
    startedAt: new Date(event.startedAt).toISOString(),
    ...(event.latitude !== null && event.longitude !== null
      ? { latitude: event.latitude, longitude: event.longitude }
      : {}),
    ...(event.originalLatitude !== null && event.originalLongitude !== null
      ? { originalLatitude: event.originalLatitude, originalLongitude: event.originalLongitude }
      : {}),
    ...(event.locationSource !== null && event.locationSource !== undefined ? { locationSource: event.locationSource } : {}),
    ...(event.photoLocationAutoPlacementDisabled !== null && event.photoLocationAutoPlacementDisabled !== undefined
      ? { photoLocationAutoPlacementDisabled: event.photoLocationAutoPlacementDisabled }
      : {}),
    ...(event.accuracyMeters !== null && event.accuracyMeters !== undefined ? { accuracyMeters: event.accuracyMeters } : {}),
    ...(event.mediaType !== null && event.mediaType !== undefined ? { mediaType: event.mediaType } : {}),
    photoCount: event.photoCount,
    source: event.source,
    updatedAt: new Date(event.updatedAt).toISOString(),
  };
}

async function fetchCloudEventPage(options: { cursor?: SyncCursor; page?: string }): Promise<EventPage> {
  const params = new URLSearchParams();
  if (options.page !== undefined) {
    params.set("v", "2");
    params.set("page", options.page);
  } else if (options.cursor) {
    params.set("v", "2");
    params.set("cursor", encodeCursor(options.cursor));
  } else {
    params.set("v", "2");
  }
  const query = `?${params.toString()}`;
  const response = await fetch(`${baseURL}/api/v1/events${query}`, { credentials: "include" });
  if (!response.ok) throw new Error("sync unavailable");
  const payload = await response.json() as {
    data: ApiEvent[];
    meta?: {
      deletedIds?: string[];
      cursor?: string | null;
      nextPage?: string | null;
      nextCursorToken?: string | null;
      full?: boolean;
    };
  };
  return {
    events: payload.data.map(fromApi),
    deletedIds: payload.meta?.deletedIds ?? [],
    cursor: decodeCursor(payload.meta?.cursor),
    nextPage: payload.meta?.nextPage ?? undefined,
    nextCursorToken: payload.meta?.nextCursorToken ?? undefined,
    full: payload.meta?.full !== false,
  };
}

async function fetchCloudEventHead(): Promise<SyncCursor | null> {
  const response = await fetch(`${baseURL}/api/v1/events/head`, { credentials: "include" });
  if (!response.ok) throw new Error("sync unavailable");
  const payload = await response.json() as { data?: { cursor?: string | null } };
  if (payload.data?.cursor == null) return null;
  const cursor = decodeCursor(payload.data.cursor);
  if (!cursor) throw new Error("sync unavailable");
  return cursor;
}

async function fetchCloudEvents(userId: string, cursor?: SyncCursor, pageState?: SyncPageState): Promise<EventSnapshot> {
  let nextPage: string | undefined = pageState?.nextPage;
  let nextCursor: SyncCursor | undefined = cursor;
  let resultCursor = pageState ? { updatedAt: pageState.updatedAt, id: pageState.id } : cursor;
  let full = cursor === undefined || pageState !== undefined;
  let hasNext = true;
  const events: LifeEvent[] = pageState?.events.slice() ?? [];
  const deletedIds = new Set<string>(pageState?.deletedIds ?? []);

  if (pageState?.complete) {
    return { events, deletedIds: [...deletedIds], cursor: resultCursor, full: true };
  }

  if (cursor && pageState === undefined) {
    const head = await fetchCloudEventHead();
    if (!head || compareCursors(head, cursor) <= 0) {
      return { events: [], deletedIds: [], cursor, full: false };
    }
  }

  do {
    const page = await fetchCloudEventPage(nextPage
      ? { page: nextPage }
      : { cursor: nextCursor });
    if (events.length === 0 && pageState === undefined) full = page.full;
    events.push(...page.events);
    page.deletedIds.forEach((id) => deletedIds.add(id));
    resultCursor = page.cursor ?? resultCursor;
    if (page.nextPage) {
      nextPage = page.nextPage;
      if (full) {
        const progress = decodePageCursor(nextPage);
        if (progress) {
          const saved = saveSyncPageState(userId, {
            ...progress,
            nextPage,
            complete: false,
            events,
            deletedIds: [...deletedIds],
          });
          if (!saved) clearSyncPageCursor(userId);
        }
      }
      nextCursor = undefined;
      hasNext = true;
    } else if (page.nextCursorToken) {
      nextPage = undefined;
      nextCursor = decodeCursor(page.nextCursorToken);
      hasNext = nextCursor !== undefined;
    } else {
      nextPage = undefined;
      hasNext = false;
    }
  } while (hasNext);

  if (full && pageState !== undefined && pageState.nextPage !== undefined) {
    const progress = pageState;
    saveSyncPageState(userId, {
      ...progress,
      updatedAt: resultCursor?.updatedAt ?? progress.updatedAt,
      id: resultCursor?.id ?? progress.id,
      nextPage: undefined,
      complete: true,
      events,
      deletedIds: [...deletedIds],
    });
  }
  return { events, deletedIds: [...deletedIds], cursor: resultCursor, full };
}

const BATCH_SIZE = 40;

async function postCloudBatch(body: { events?: unknown[]; deletions?: unknown[] }): Promise<void> {
  const response = await fetch(`${baseURL}/api/v1/events/batch`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("sync unavailable");
}

async function pushCloudEvents(events: LifeEvent[]): Promise<void> {
  await postCloudBatch({ events: events.map((event) => ({
    id: event.id,
    startedAt: Date.parse(event.startedAt),
    latitude: event.latitude ?? null,
    longitude: event.longitude ?? null,
    originalLatitude: event.originalLatitude ?? null,
    originalLongitude: event.originalLongitude ?? null,
    locationSource: event.locationSource ?? null,
    photoLocationAutoPlacementDisabled: event.photoLocationAutoPlacementDisabled ?? null,
    accuracyMeters: event.accuracyMeters ?? null,
    mediaType: event.mediaType ?? (event.source === "photo" ? "photo" : null),
    photoCount: event.photoCount,
    source: event.source,
    updatedAt: Date.parse(event.updatedAt),
  })) });
}

// deletedAt uses this device's clock, like updatedAt on upserts, so the
// server can resolve a deletion against edits from other devices.
async function deleteCloudEvents(eventIds: string[]): Promise<void> {
  const deletedAt = Date.now();
  await postCloudBatch({ deletions: eventIds.map((id) => ({ id, deletedAt })) });
}

async function flushSyncQueue(userId: string): Promise<{ pending: number }> {
  const queue = loadSyncQueue(userId);
  const upserts = queue.filter((operation) => operation.kind === "upsert").map((operation) => operation.event);
  const deletes = queue.filter((operation) => operation.kind === "delete");
  for (let index = 0; index < upserts.length; index += BATCH_SIZE) {
    try {
      await pushCloudEvents(upserts.slice(index, index + BATCH_SIZE));
    } catch {
      const sentIds = new Set(upserts.slice(0, index).map((event) => event.id));
      saveSyncQueue(userId, queue.filter((operation) => {
        const id = operation.kind === "upsert" ? operation.event.id : operation.eventId;
        return !sentIds.has(id);
      }));
      return { pending: loadSyncQueue(userId).length };
    }
  }
  for (let index = 0; index < deletes.length; index += BATCH_SIZE) {
    try {
      await deleteCloudEvents(deletes.slice(index, index + BATCH_SIZE).map((operation) => operation.eventId));
    } catch {
      const sentIds = new Set([
        ...upserts.map((event) => event.id),
        ...deletes.slice(0, index).map((operation) => operation.eventId),
      ]);
      saveSyncQueue(userId, queue.filter((operation) => {
        const id = operation.kind === "upsert" ? operation.event.id : operation.eventId;
        return !sentIds.has(id);
      }));
      return { pending: loadSyncQueue(userId).length };
    }
  }
  saveSyncQueue(userId, []);
  return { pending: 0 };
}

export async function deleteAllCloudData(): Promise<void> {
  const response = await fetch(`${baseURL}/api/v1/data`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) throw new Error("cloud delete unavailable");
}

export type AccountDeletionResult = "deleted" | "invalid_password" | "rate_limited" | "failed";

// Deletes the account together with its cloud backup. The server always asks
// for the password; records stored on this device are left as they are.
export async function deleteAccount(password: string): Promise<AccountDeletionResult> {
  const response = await fetch(`${baseURL}/api/v1/account/delete`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (response.ok) return "deleted";
  if (response.status === 429) return "rate_limited";
  const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
  return payload?.error?.code === "invalid_password" ? "invalid_password" : "failed";
}

export async function synchronizeEvents(userId: string, localEvents: LifeEvent[], options: { pull?: boolean } = {}): Promise<{
  events: LifeEvent[];
  deletedIds: string[];
  pending: number;
  online: boolean;
}> {
  const pull = options.pull ?? true;
  const storedCursor = loadSyncCursor(userId);
  const storedPageState = storedCursor ? undefined : loadSyncPageState(userId);
  const firstFlush = await flushSyncQueue(userId);
  if (!pull) {
    return {
      events: localEvents.slice().sort(sortNewest),
      deletedIds: [],
      pending: firstFlush.pending,
      online: firstFlush.pending === 0,
    };
  }

  let snapshot: EventSnapshot;
  try {
    snapshot = await fetchCloudEvents(userId, storedCursor, storedPageState);
  } catch {
    return { events: localEvents, deletedIds: [], pending: loadSyncQueue(userId).length, online: false };
  }

  const pendingDeletes = new Set(
    loadSyncQueue(userId)
      .filter((operation) => operation.kind === "delete")
      .map((operation) => operation.eventId),
  );
  const localIds = new Set(localEvents.map((event) => event.id));
  const cloudById = new Map(snapshot.events.map((event) => [event.id, event]));

  for (const local of localEvents) {
    if (!snapshot.full && !cloudById.has(local.id)) continue;
    if (pendingDeletes.has(local.id)) continue;
    const cloud = cloudById.get(local.id);
    if (!cloud || (Date.parse(local.updatedAt) >= Date.parse(cloud.updatedAt) && !sameEvent(local, cloud))) {
      enqueueSync(userId, { id: crypto.randomUUID(), kind: "upsert", event: local });
    }
  }

  const secondFlush = await flushSyncQueue(userId);
  // Do not advance the download cursor from a write response. A concurrent
  // device may have written another row with the same server millisecond;
  // only a cursor returned by the read snapshot is safe to checkpoint.
  if (snapshot.cursor) saveSyncCursor(userId, snapshot.cursor);
  if (snapshot.full) clearSyncPageCursor(userId);

  const pendingDeletesAfterPush = new Set(
    loadSyncQueue(userId)
      .filter((operation) => operation.kind === "delete")
      .map((operation) => operation.eventId),
  );
  const deletedAfterPush = new Set([
    ...snapshot.deletedIds.filter((id) => !localIds.has(id)),
    ...pendingDeletesAfterPush,
  ]);
  const merged = new Map(snapshot.full
    ? snapshot.events.map((event) => [event.id, event])
    : localEvents.map((event) => [event.id, event]));
  if (!snapshot.full) {
    snapshot.events.forEach((event) => {
      const local = merged.get(event.id);
      if (!local || Date.parse(event.updatedAt) > Date.parse(local.updatedAt)) merged.set(event.id, event);
    });
  }
  for (const local of localEvents) {
    if (pendingDeletesAfterPush.has(local.id)) continue;
    // The device is the source of truth. Cloud records are only used to
    // restore records that are not present locally.
    merged.set(local.id, local);
  }

  return {
    events: [...merged.values()].sort(sortNewest),
    deletedIds: [...deletedAfterPush],
    pending: Math.max(secondFlush.pending, loadSyncQueue(userId).length),
    online: true,
  };
}

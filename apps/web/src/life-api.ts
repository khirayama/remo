import { LifeEvent, MediaType, PhotoLocationSource, Place, SyncCursor } from "./life-log";
import { applyRemoteChanges, applyRemotePlaces, countDirtyEvents, loadDirtyEvents, loadDirtyPlaces, loadPendingDeletes, loadSyncState, markEventsSynced, markPlacesSynced, PendingDeletion, removePendingDeletes, updateSyncState } from "./timeline-db";

import { apiBaseURL as baseURL } from "./api-base";

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

type EventPage = {
  events: LifeEvent[];
  deletions: Array<{ id: string; deletedAt: number }>;
  cursor?: SyncCursor;
  nextPage?: string;
  nextCursorToken?: string;
};

/** The session is no longer valid: the user has to sign in again. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

/** Sends a request with the session cookie; any failure other than a rejected session is "unavailable". */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseURL}${path}`, { credentials: "include", ...init });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw new Error("sync unavailable");
  return response;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

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
    ...(event.source === "photo" && event.photoLocationAutoPlacementDisabled !== null && event.photoLocationAutoPlacementDisabled !== undefined
      ? { photoLocationAutoPlacementDisabled: event.photoLocationAutoPlacementDisabled }
      : {}),
    ...(event.accuracyMeters !== null && event.accuracyMeters !== undefined ? { accuracyMeters: event.accuracyMeters } : {}),
    ...(event.mediaType !== null && event.mediaType !== undefined ? { mediaType: event.mediaType } : {}),
    photoCount: event.photoCount,
    source: event.source,
    updatedAt: new Date(event.updatedAt).toISOString(),
  };
}

function toApi(event: LifeEvent) {
  return {
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
  };
}

async function fetchEventPage(options: { cursor?: SyncCursor; page?: string }): Promise<EventPage> {
  const params = new URLSearchParams({ v: "2" });
  if (options.page !== undefined) params.set("page", options.page);
  else if (options.cursor) params.set("cursor", encodeCursor(options.cursor));
  const response = await request(`/api/v1/events?${params.toString()}`);
  const payload = await response.json() as {
    data: ApiEvent[];
    meta?: {
      deletions?: Array<{ id: string; deletedAt: number }>;
      cursor?: string | null;
      nextPage?: string | null;
      nextCursorToken?: string | null;
    };
  };
  return {
    events: payload.data.map(fromApi),
    deletions: payload.meta?.deletions ?? [],
    cursor: decodeCursor(payload.meta?.cursor),
    nextPage: payload.meta?.nextPage ?? undefined,
    nextCursorToken: payload.meta?.nextCursorToken ?? undefined,
  };
}

async function fetchEventHead(): Promise<SyncCursor | null> {
  const response = await request("/api/v1/events/head");
  const payload = await response.json() as { data?: { cursor?: string | null } };
  if (payload.data?.cursor == null) return null;
  const cursor = decodeCursor(payload.data.cursor);
  if (!cursor) throw new Error("sync unavailable");
  return cursor;
}

/** The server takes up to 500 records per request. */
const BATCH_SIZE = 400;

// A 2xx response means every item was handled: applied, or rejected by the
// server as invalid (reported in data.rejected). Either way it is done, so one
// malformed record cannot block the rest forever.
async function pushDeletions(storageId: string): Promise<void> {
  for (;;) {
    const batch: PendingDeletion[] = await loadPendingDeletes(storageId, BATCH_SIZE);
    if (!batch.length) return;
    // deletedAt uses this device's clock, like updatedAt on upserts, so the
    // server can resolve a deletion against edits from other devices.
    await request("/api/v1/events/batch", jsonBody("POST", {
      deletions: batch.map(({ id, deletedAt, startedAt, source }) => ({ id, deletedAt, startedAt: startedAt ?? null, source: source ?? null })),
    }));
    await removePendingDeletes(storageId, batch);
  }
}

async function pushEvents(storageId: string, epoch: number): Promise<void> {
  for (;;) {
    const batch = await loadDirtyEvents(storageId, epoch, BATCH_SIZE);
    if (!batch.length) return;
    await request("/api/v1/events/batch", jsonBody("POST", { events: batch.map(toApi) }));
    await markEventsSynced(storageId, batch, epoch);
  }
}

/**
 * Downloads what changed in the backup and applies it page by page, so a
 * restore of years of records is never held in memory and continues where it
 * stopped. What was applied is reported through [outcome] even when a later
 * page fails.
 */
async function pull(storageId: string, userId: string, epoch: number, outcome: SyncOutcome): Promise<void> {
  const state = await loadSyncState(storageId);
  const stored: SyncCursor | undefined = state.cursors[userId];
  let page: string | undefined = stored ? undefined : state.fullSync[userId];
  let cursor: SyncCursor | undefined = stored;
  if (stored) {
    const head = await fetchEventHead();
    if (!head || compareCursors(head, stored) <= 0) return;
  }
  let reached: SyncCursor | undefined;
  for (;;) {
    const result: EventPage = await fetchEventPage(page !== undefined ? { page } : { cursor });
    const applied = await applyRemoteChanges(storageId, result.events, result.deletions, epoch);
    outcome.changed ||= applied.changed;
    outcome.removedIds.push(...applied.removedIds);
    reached = result.cursor ?? reached;
    if (result.nextPage) {
      const resume = result.nextPage;
      page = resume;
      await updateSyncState(storageId, (next) => { next.fullSync[userId] = resume; });
    } else if (result.nextCursorToken && decodeCursor(result.nextCursorToken)) {
      page = undefined;
      cursor = decodeCursor(result.nextCursorToken);
    } else {
      break;
    }
  }
  const final = reached;
  await updateSyncState(storageId, (next) => {
    // Only a cursor returned by a read is safe to keep: a write response says
    // nothing about what other devices committed in between.
    if (final) next.cursors[userId] = final;
    delete next.fullSync[userId];
  });
}

async function syncPlaces(storageId: string, epoch: number): Promise<boolean> {
  const dirty = await loadDirtyPlaces(storageId, epoch);
  for (let index = 0; index < dirty.length; index += 200) {
    const batch = dirty.slice(index, index + 200);
    await request("/api/v1/places", jsonBody("PUT", { places: batch }));
    await markPlacesSynced(storageId, batch, epoch);
  }
  const response = await request("/api/v1/places");
  const payload = await response.json() as { data?: Place[] };
  return applyRemotePlaces(storageId, payload.data ?? [], epoch);
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
    credentials: "include",
    ...jsonBody("POST", { password }),
  });
  if (response.ok) return "deleted";
  if (response.status === 429) return "rate_limited";
  const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
  return payload?.error?.code === "invalid_password" ? "invalid_password" : "failed";
}

export type SyncOutcome = {
  /** False when the API could not be reached; unsent changes stay queued. */
  online: boolean;
  /** The session was rejected: the user has to sign in again. */
  unauthorized: boolean;
  /** Records and deletions that are still waiting to be uploaded. */
  pending: number;
  /** Local records or places changed and the screen should reload them. */
  changed: boolean;
  /** Records another device deleted, removed here by this sync. */
  removedIds: string[];
};

/**
 * Backs this browser's changes up to [userId] and, when [pull] is set, brings
 * in what other devices changed. Only records that are not in the backup yet
 * are uploaded: a record another device deleted from the backup is not sent
 * back by a device that still has its own copy.
 */
export async function synchronizeEvents(storageId: string, userId: string, options: { pull?: boolean } = {}): Promise<SyncOutcome> {
  const { epoch, owner } = await loadSyncState(storageId);
  const outcome: SyncOutcome = { online: true, unauthorized: false, pending: 0, changed: false, removedIds: [] };
  // The records belong to another account until the user decides otherwise.
  if (owner !== userId) return { ...outcome, online: false };
  try {
    await pushDeletions(storageId);
    await pushEvents(storageId, epoch);
    if (options.pull ?? true) {
      await pull(storageId, userId, epoch, outcome);
      if (await syncPlaces(storageId, epoch)) outcome.changed = true;
    }
  } catch (error) {
    outcome.online = false;
    outcome.unauthorized = error instanceof UnauthorizedError;
  }
  outcome.pending = await countDirtyEvents(storageId, epoch) + (await loadPendingDeletes(storageId)).length;
  return outcome;
}

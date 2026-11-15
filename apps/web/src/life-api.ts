import { LifeEvent, MediaType, normalizeCorrection, normalizePlace, PhotoLocationSource, SyncCursor } from "./life-log";
import { applyRemoteChanges, applyRemoteCorrections, applyRemotePlaces, countDirtyEvents, forgetRejectedEvents, loadDirtyCorrections, loadDirtyEvents, loadDirtyPlaces, loadPendingDeletes, loadRejectedEvents, loadSyncState, markCorrectionsSynced, markEventsRejected, markEventsSynced, markPlacesSynced, PendingDeletion, removePendingDeletes, updateSyncState } from "./timeline-db";

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

/** Why a request failed, as the app tells the user apart. */
export type SyncFailure = "rate_limited" | "server" | "permanent";

/** A request the server refused. Only a rate limit or a server fault clears up by itself. */
export class RequestError extends Error {
  constructor(readonly reason: SyncFailure) {
    super(reason);
  }
}

/** Sends a request with the session cookie; any failure other than a rejected session is thrown classified. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseURL}${path}`, { credentials: "include", ...init });
  if (response.status === 401) throw new UnauthorizedError();
  if (response.ok) return response;
  // Too many requests and a server fault go away by themselves; any other 4xx
  // is this request's own problem and fails the same way every time.
  throw new RequestError(response.status === 429 ? "rate_limited" : response.status >= 500 ? "server" : "permanent");
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
// server. A refused deletion is malformed and can never succeed, so it is
// dropped from the queue with the ones that were applied.
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
    const response = await request("/api/v1/events/batch", jsonBody("POST", { events: batch.map(toApi) }));
    const payload = await response.json().catch(() => null) as {
      data?: { rejected?: Array<{ kind?: unknown; id?: unknown; message?: unknown }> };
    } | null;
    // A refused record is kept here with the server's message, so the rest of
    // the queue is not held up by it and the app can say why it is missing
    // from the backup. An entry without an id names no record.
    const messages = new Map<string, string>();
    for (const item of payload?.data?.rejected ?? []) {
      if (item?.kind === "event" && typeof item.id === "string" && item.id) {
        messages.set(item.id, typeof item.message === "string" ? item.message : "rejected");
      }
    }
    const accepted = batch.filter((event) => !messages.has(event.id));
    await markEventsSynced(storageId, accepted, epoch);
    await forgetRejectedEvents(storageId, accepted.map((event) => event.id));
    await markEventsRejected(storageId, batch.filter((event) => messages.has(event.id)), messages, epoch);
  }
}

/**
 * Downloads what changed in the backup and applies it page by page, so a
 * restore of years of records is never held in memory and continues where it
 * stopped. What was applied is reported through [outcome] even when a later
 * page fails. Returns whether a download ran: when the head shows no change
 * there is nothing new to read from the other endpoints either.
 */
async function pull(storageId: string, userId: string, epoch: number, outcome: SyncOutcome): Promise<boolean> {
  const state = await loadSyncState(storageId);
  const stored: SyncCursor | undefined = state.cursors[userId];
  let page: string | undefined = stored ? undefined : state.fullSync[userId];
  let cursor: SyncCursor | undefined = stored;
  if (stored) {
    const head = await fetchEventHead();
    if (!head || compareCursors(head, stored) <= 0) return false;
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
  return true;
}

/**
 * Sends the places changed here. The list is read back only after a download
 * ran: the server moves the sync head for every write, so an unchanged head
 * means nobody wrote a place since the last sync.
 */
async function syncPlaces(storageId: string, epoch: number, download: boolean): Promise<boolean> {
  const dirty = await loadDirtyPlaces(storageId, epoch);
  for (let index = 0; index < dirty.length; index += 200) {
    const batch = dirty.slice(index, index + 200);
    await request("/api/v1/places", jsonBody("PUT", { places: batch }));
    await markPlacesSynced(storageId, batch, epoch);
  }
  if (!download) return false;
  const response = await request("/api/v1/places");
  const payload = await response.json() as { data?: unknown[] };
  return applyRemotePlaces(storageId, (payload.data ?? []).flatMap((place) => normalizePlace(place) ?? []), epoch);
}

const CORRECTION_BATCH = 200;
const MAX_CORRECTION_PAGES = 100;

/**
 * Sends the corrections created or deleted here, then takes the ones written
 * since this account's cursor (docs/CORRECTIONS.md). Returns whether any local
 * correction changed. The list is read back only after a download ran.
 */
async function syncCorrections(storageId: string, userId: string, epoch: number, download: boolean): Promise<boolean> {
  const dirty = await loadDirtyCorrections(storageId, epoch);
  for (let index = 0; index < dirty.length; index += CORRECTION_BATCH) {
    const batch = dirty.slice(index, index + CORRECTION_BATCH);
    await request("/api/v1/corrections", jsonBody("PUT", { corrections: batch }));
    await markCorrectionsSynced(storageId, batch, epoch);
  }
  if (!download) return false;
  let after = (await loadSyncState(storageId)).correctionCursors[userId] ?? 0;
  let changed = false;
  for (let page = 0; page < MAX_CORRECTION_PAGES; page += 1) {
    const response = await request(`/api/v1/corrections?after=${after}`);
    const payload = await response.json() as { data?: { corrections?: unknown[]; cursor?: number; hasMore?: boolean } };
    const corrections = (payload.data?.corrections ?? []).flatMap((correction) => normalizeCorrection(correction) ?? []);
    if (await applyRemoteCorrections(storageId, corrections, epoch)) changed = true;
    const cursor = payload.data?.cursor;
    if (typeof cursor === "number" && cursor !== after) {
      after = cursor;
      await updateSyncState(storageId, (next) => { next.correctionCursors[userId] = cursor; });
    }
    if (!payload.data?.hasMore) break;
  }
  return changed;
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

/** `write` tokens may also change named places and corrections. */
export type ApiTokenScope = "read" | "write";
/** `expiresAt` is missing from an API that predates token expiry. */
export type ApiToken = { id: string; name: string; scope: ApiTokenScope; createdAt: number; expiresAt?: number };

/** Tokens for the external API (MCP). The plain token is only returned when it is issued. */
export async function listApiTokens(): Promise<ApiToken[]> {
  const payload = await (await request("/api/v1/api-tokens")).json() as { data?: ApiToken[] };
  return payload.data ?? [];
}

export type ApiTokenCreation = { created: ApiToken & { token: string } } | { error: "token_limit" | "failed" };

export async function createApiToken(name: string, scope: ApiTokenScope = "read"): Promise<ApiTokenCreation> {
  const response = await fetch(`${baseURL}/api/v1/api-tokens`, { credentials: "include", ...jsonBody("POST", { name, scope }) });
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 409) return { error: "token_limit" };
  if (!response.ok) return { error: "failed" };
  const payload = await response.json() as { data: ApiToken & { token: string } };
  return { created: payload.data };
}

export async function deleteApiToken(id: string): Promise<void> {
  await request(`/api/v1/api-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type SyncOutcome = {
  /** False when the API could not be reached; unsent changes stay queued. */
  online: boolean;
  /** The session was rejected: the user has to sign in again. */
  unauthorized: boolean;
  /** Why the sync stopped, when it did: each reason has its own message. Missing means offline. */
  failure?: SyncFailure | "offline";
  /** Records and deletions that are still waiting to be uploaded. */
  pending: number;
  /** Records the server refused: they are not uploaded again until they change here. */
  rejected: number;
  /** Local records or places changed and the screen should reload them. */
  changed: boolean;
  /** Records another device deleted, removed here by this sync. */
  removedIds: string[];
  /** The records download ran (the head moved), so what other devices wrote was read too. */
  pulled: boolean;
};

/**
 * Backs this browser's changes up to [userId] and, when [pull] is set, brings
 * in what other devices changed. Only records that are not in the backup yet
 * are uploaded: a record another device deleted from the backup is not sent
 * back by a device that still has its own copy.
 */
export async function synchronizeEvents(storageId: string, userId: string, options: { pull?: boolean } = {}): Promise<SyncOutcome> {
  const { epoch, owner } = await loadSyncState(storageId);
  const outcome: SyncOutcome = {
    online: true,
    unauthorized: false,
    pending: 0,
    rejected: 0,
    changed: false,
    removedIds: [],
    pulled: false,
  };
  // The records belong to another account until the user decides otherwise.
  if (owner !== userId) return { ...outcome, online: false };
  // Each part runs on its own: a place or correction the server refuses must
  // not stop the records from being backed up, and a failed part does not hide
  // what the others did. The first failure is what the app reports.
  let failure: unknown;
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    if (failure instanceof UnauthorizedError) return;
    try {
      await work();
    } catch (error) {
      failure ??= error;
    }
  };
  await run(() => pushDeletions(storageId));
  await run(() => pushEvents(storageId, epoch));
  if (options.pull ?? true) {
    await run(async () => {
      outcome.pulled = await pull(storageId, userId, epoch, outcome);
    });
    await run(async () => {
      if (await syncPlaces(storageId, epoch, outcome.pulled)) outcome.changed = true;
    });
    await run(async () => {
      if (await syncCorrections(storageId, userId, epoch, outcome.pulled)) outcome.changed = true;
    });
  }
  if (failure !== undefined) {
    outcome.online = false;
    outcome.unauthorized = failure instanceof UnauthorizedError;
    outcome.failure = failure instanceof RequestError ? failure.reason : "offline";
  }
  outcome.pending = await countDirtyEvents(storageId, epoch) + (await loadPendingDeletes(storageId)).length;
  outcome.rejected = (await loadRejectedEvents(storageId)).size;
  return outcome;
}

import { UnauthorizedError } from "./life-api";
import { loadPhotoPreview, makeBackupThumbnail } from "./photo-storage";

import { apiBaseURL as baseURL } from "./api-base";

/**
 * What became of one preview upload: `uploaded` is done, `skip` is a preview
 * this record cannot upload now (the rest of the pass goes on), and `retry`
 * means this pass should stop and try again later.
 */
export type PreviewUploadResult = "uploaded" | "skip" | "retry";

/** How the upload pass treats a status the server answered with. */
export function previewUploadOutcome(status: number): PreviewUploadResult {
  if (status >= 200 && status < 300) return "uploaded";
  // A rate limit or a server fault affects every upload of this pass. 507 is
  // the account being full, which this one preview cannot change; any other
  // refusal (the record is unknown, the image is too large) is about this one
  // preview too.
  return status === 429 || (status >= 500 && status !== 507) ? "retry" : "skip";
}

export async function uploadPhotoPreview(storageId: string, eventId: string): Promise<PreviewUploadResult> {
  const stored = await loadPhotoPreview(storageId, eventId);
  if (!stored) return "skip";
  // A video whose poster frame could not be drawn kept the video itself as its
  // preview. There is no image to back up, and retrying would leave the backup
  // pending forever, so it counts as done.
  if (stored.type.startsWith("video/")) return "uploaded";
  const blob = await makeBackupThumbnail(stored);
  if (!blob) return "skip";
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(`${baseURL}/api/v1/photos/${encodeURIComponent(eventId)}/${digest}`, {
    method: "PUT", credentials: "include", headers: { "Content-Type": "image/jpeg" }, body: blob,
  });
  if (response.ok) return "uploaded";
  if (response.status === 401) throw new UnauthorizedError();
  return previewUploadOutcome(response.status);
}

export async function loadRemotePhotoPreview(eventId: string): Promise<Blob | undefined> {
  const root = `${baseURL}/api/v1/photos/${encodeURIComponent(eventId)}`;
  const list = await fetch(root, { credentials: "include" });
  if (!list.ok) return undefined;
  const ids = (await list.json() as { data?: string[] }).data;
  if (!ids?.length) return undefined;
  const response = await fetch(`${root}/${ids[0]}`, { credentials: "include" });
  return response.ok ? response.blob() : undefined;
}

export async function loadRemotePhotoPreviews(eventId: string): Promise<Blob[]> {
  const root = `${baseURL}/api/v1/photos/${encodeURIComponent(eventId)}`;
  const list = await fetch(root, { credentials: "include" });
  if (!list.ok) return [];
  const ids = (await list.json() as { data?: string[] }).data;
  const blobs: Blob[] = [];
  for (const id of ids ?? []) {
    const response = await fetch(`${root}/${id}`, { credentials: "include" });
    if (response.ok) blobs.push(await response.blob());
  }
  return blobs;
}

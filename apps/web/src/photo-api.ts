import { loadPhotoPreview, makeBackupThumbnail } from "./photo-storage";

import { apiBaseURL as baseURL } from "./api-base";

export async function uploadPhotoPreview(storageId: string, eventId: string): Promise<boolean> {
  const stored = await loadPhotoPreview(storageId, eventId);
  if (!stored) return false;
  const blob = await makeBackupThumbnail(stored);
  if (!blob) return false;
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(`${baseURL}/api/v1/photos/${encodeURIComponent(eventId)}/${digest}`, {
    method: "PUT", credentials: "include", headers: { "Content-Type": "image/jpeg" }, body: blob,
  });
  return response.ok;
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

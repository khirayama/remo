import { purgeDeletedCorrections } from "./corrections";
import { purgeExpiredTombstones } from "./life-events";
import { purgePhotoCleanup } from "./photos";

export type MaintenanceResult = {
  tombstones: number;
  corrections: number;
  sessions: number;
  verifications: number;
  apiTokens: number;
  photoCleanup?: number;
};

// Runs from the hourly Cron Trigger. Better Auth removes an expired session
// only when that token is presented again, so abandoned sessions, unused
// verification values (password reset links) and expired API tokens are
// removed here.
export async function runMaintenance(db: D1Database, now: number, bucket?: R2Bucket): Promise<MaintenanceResult> {
  const tombstones = await purgeExpiredTombstones(db, now);
  const corrections = await purgeDeletedCorrections(db, now);
  const photoCleanup = bucket ? await purgePhotoCleanup(db, bucket) : undefined;
  const [sessions, verifications, apiTokens] = await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM verification WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM api_token WHERE expires_at <= ?1").bind(now),
  ]);
  return {
    tombstones,
    corrections,
    sessions: sessions?.meta.changes ?? 0,
    verifications: verifications?.meta.changes ?? 0,
    apiTokens: apiTokens?.meta.changes ?? 0,
    ...(photoCleanup === undefined ? {} : { photoCleanup }),
  };
}

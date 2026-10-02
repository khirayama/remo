import { purgeExpiredTombstones } from "./life-events";
import { purgePhotoCleanup } from "./photos";

export type MaintenanceResult = {
  tombstones: number;
  sessions: number;
  verifications: number;
  photoCleanup?: number;
};

// Runs from the hourly Cron Trigger. Better Auth removes an expired session
// only when that token is presented again, so abandoned sessions and unused
// verification values (password reset links) are removed here.
export async function runMaintenance(db: D1Database, now: number, bucket?: R2Bucket): Promise<MaintenanceResult> {
  const tombstones = await purgeExpiredTombstones(db, now);
  const photoCleanup = bucket ? await purgePhotoCleanup(db, bucket) : undefined;
  const [sessions, verifications] = await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM verification WHERE expires_at < ?1").bind(now),
  ]);
  return {
    tombstones,
    sessions: sessions?.meta.changes ?? 0,
    verifications: verifications?.meta.changes ?? 0,
    ...(photoCleanup === undefined ? {} : { photoCleanup }),
  };
}

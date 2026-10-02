import { Hono, type Context } from "hono";
import type { AppContext } from "./auth";

export const photoRoutes = new Hono<AppContext>();
// Record ids are client-generated and may contain any character except the
// R2 key separator, which would let one record's prefix cover another's.
const idPattern = /^[^/]{1,120}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxBytes = 160_000;
// Previews one record can hold, and previews one account can hold in total
// (about 16 GB at the size limit).
const MAX_PREVIEWS_PER_EVENT = 1_000;
export const MAX_PREVIEWS_PER_USER = 100_000;

function key(userId: string, eventId: string, digest: string) {
  return `${userId}/${eventId}/${digest}.jpg`;
}

async function photoEvent(c: Context<AppContext>, eventId: string) {
  if (!idPattern.test(eventId)) return false;
  const row = await c.env.DB.prepare(
    "SELECT 1 FROM life_event WHERE user_id = ?1 AND id = ?2 AND source = 'photo' AND deleted_at IS NULL",
  ).bind(c.get("user").id, eventId).first();
  return row !== null;
}

photoRoutes.get("/photos/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  if (!await photoEvent(c, eventId)) return c.json({ error: { code: "not_found" } }, 404);
  const userId = c.get("user").id;
  const { results } = await c.env.DB.prepare(
    "SELECT digest FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 ORDER BY digest LIMIT 1000",
  ).bind(userId, eventId).all<{ digest: string }>();
  if (results.length) return c.json({ data: results.map((row) => row.digest) });

  // Images uploaded before photo_preview existed: list R2 once and record them.
  const prefix = `${userId}/${eventId}/`;
  const photos: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.PHOTO_PREVIEWS.list({ prefix, cursor, limit: 1000 });
    photos.push(...page.objects.map((object) => object.key.slice(prefix.length, -4)).filter((digest) => digestPattern.test(digest)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && photos.length < 1000);
  if (photos.length) {
    await c.env.DB.batch([
      ...photos.map((digest) => c.env.DB.prepare(
        "INSERT OR IGNORE INTO photo_preview(user_id, event_id, digest) VALUES (?1, ?2, ?3)",
      ).bind(userId, eventId, digest)),
      c.env.DB.prepare(
        `INSERT INTO user_sync_state (user_id, preview_count) VALUES (?1, ?2)
         ON CONFLICT(user_id) DO UPDATE SET preview_count = preview_count + ?2`,
      ).bind(userId, photos.length),
    ]);
  }
  return c.json({ data: photos.sort() });
});

photoRoutes.get("/photos/:eventId/:digest", async (c) => {
  const { eventId, digest } = c.req.param();
  if (!digestPattern.test(digest) || !await photoEvent(c, eventId)) return c.json({ error: { code: "not_found" } }, 404);
  const object = await c.env.PHOTO_PREVIEWS.get(key(c.get("user").id, eventId, digest));
  if (!object) return c.json({ error: { code: "not_found" } }, 404);
  return new Response(object.body, { headers: {
    "Content-Type": "image/jpeg",
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  } });
});

photoRoutes.put("/photos/:eventId/:digest", async (c) => {
  const { eventId, digest } = c.req.param();
  if (!digestPattern.test(digest)) return c.json({ error: { code: "invalid_digest" } }, 400);
  if (!await photoEvent(c, eventId)) return c.json({ error: { code: "not_found" } }, 404);
  if (c.req.header("content-type")?.split(";")[0] !== "image/jpeg") return c.json({ error: { code: "invalid_type" } }, 415);
  const declaredLength = c.req.header("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) return c.json({ error: { code: "invalid_size" } }, 413);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: { code: "invalid_image" } }, 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return c.json({ error: { code: "invalid_size" } }, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (total < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return c.json({ error: { code: "invalid_image" } }, 400);
  }
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== digest) return c.json({ error: { code: "invalid_digest" } }, 400);
  const userId = c.get("user").id;
  const usage = await c.env.DB.prepare(
    `SELECT
       (SELECT preview_count FROM user_sync_state WHERE user_id = ?1) AS total,
       (SELECT COUNT(*) FROM photo_preview WHERE user_id = ?1 AND event_id = ?2) AS event_total,
       EXISTS (SELECT 1 FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 AND digest = ?3) AS stored`,
  ).bind(userId, eventId, digest).first<{ total: number | null; event_total: number; stored: number }>();
  if (usage?.stored) return c.body(null, 204);
  if ((usage?.total ?? 0) >= MAX_PREVIEWS_PER_USER || (usage?.event_total ?? 0) >= MAX_PREVIEWS_PER_EVENT) {
    return c.json({ error: { code: "storage_limit", message: "The photo preview limit has been reached" } }, 507);
  }
  await c.env.PHOTO_PREVIEWS.put(key(userId, eventId, digest), bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO user_sync_state (user_id, preview_count) VALUES (?1, 1)
       ON CONFLICT(user_id) DO UPDATE SET preview_count = preview_count + 1
       WHERE NOT EXISTS (SELECT 1 FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 AND digest = ?3)`,
    ).bind(userId, eventId, digest),
    c.env.DB.prepare("INSERT OR IGNORE INTO photo_preview(user_id, event_id, digest) VALUES (?1, ?2, ?3)")
      .bind(userId, eventId, digest),
  ]);
  return c.body(null, 204);
});

// The device that owns a record sends the previews of the photos it still
// contains. Every other preview of the record belongs to a photo that was
// deleted from the library or moved to another record, and is removed here
// from the list and from R2, so a deleted photo does not stay in the backup.
photoRoutes.put("/photos/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  if (!await photoEvent(c, eventId)) return c.json({ error: { code: "not_found" } }, 404);
  const body = await c.req.json<{ digests?: unknown }>().catch(() => null);
  const digests = body?.digests;
  if (!Array.isArray(digests) || digests.length > MAX_PREVIEWS_PER_EVENT
    || !digests.every((digest): digest is string => typeof digest === "string" && digestPattern.test(digest))) {
    return c.json({ error: { code: "invalid_manifest", message: "digests must be a list of SHA-256 hex digests" } }, 400);
  }
  const userId = c.get("user").id;
  const keep = new Set(digests);
  const { results } = await c.env.DB.prepare(
    "SELECT digest FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 ORDER BY digest LIMIT ?3",
  ).bind(userId, eventId, MAX_PREVIEWS_PER_EVENT + 1).all<{ digest: string }>();
  const stale = results.map((row) => row.digest).filter((digest) => !keep.has(digest));
  for (let index = 0; index < stale.length; index += 50) {
    const group = stale.slice(index, index + 50);
    const placeholders = group.map((_, offset) => `?${offset + 3}`).join(", ");
    // The rows go first: once they are gone the images are no longer listed,
    // and an R2 failure leaves only unreferenced objects.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE user_sync_state SET preview_count = MAX(0, preview_count
           - (SELECT COUNT(*) FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 AND digest IN (${placeholders})))
         WHERE user_id = ?1`,
      ).bind(userId, eventId, ...group),
      c.env.DB.prepare(`DELETE FROM photo_preview WHERE user_id = ?1 AND event_id = ?2 AND digest IN (${placeholders})`)
        .bind(userId, eventId, ...group),
    ]);
    await c.env.PHOTO_PREVIEWS.delete(group.map((digest) => key(userId, eventId, digest)));
  }
  return c.json({ data: { removed: stale.length } });
});

// Prefixes handled per scheduled run. The job runs hourly, so a large deletion
// is cleared within a day instead of accumulating.
const CLEANUP_PREFIXES_PER_RUN = 100;

export async function purgePhotoCleanup(db: D1Database, bucket: R2Bucket): Promise<number> {
  const { results } = await db.prepare("SELECT prefix FROM photo_cleanup LIMIT ?1")
    .bind(CLEANUP_PREFIXES_PER_RUN).all<{ prefix: string }>();
  for (const { prefix } of results) {
    const parts = prefix.split("/");
    if (parts.length === 3 && parts[1]) {
      const active = await db.prepare("SELECT 1 FROM life_event WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL")
        .bind(parts[0], parts[1]).first();
      if (active) {
        await db.prepare("DELETE FROM photo_cleanup WHERE prefix = ?1").bind(prefix).run();
        continue;
      }
    }
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await bucket.list({ prefix, limit: 1000 });
      if (page.objects.length) await bucket.delete(page.objects.map((item) => item.key));
      if (!page.truncated) {
        await db.prepare("DELETE FROM photo_cleanup WHERE prefix = ?1").bind(prefix).run();
        break;
      }
    }
  }
  return results.length;
}

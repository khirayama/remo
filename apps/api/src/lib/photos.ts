import { Hono, type Context } from "hono";
import type { AppContext } from "./auth";

export const photoRoutes = new Hono<AppContext>();
const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxBytes = 160_000;

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
  const prefix = `${c.get("user").id}/${eventId}/`;
  const photos: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.PHOTO_PREVIEWS.list({ prefix, cursor, limit: 1000 });
    photos.push(...page.objects.map((object) => object.key.slice(prefix.length, -4)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && photos.length < 10_000);
  return c.json({ data: photos });
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
  await c.env.PHOTO_PREVIEWS.put(key(c.get("user").id, eventId, digest), bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return c.body(null, 204);
});

export async function purgePhotoCleanup(db: D1Database, bucket: R2Bucket): Promise<number> {
  const { results } = await db.prepare("SELECT prefix FROM photo_cleanup LIMIT 10").all<{ prefix: string }>();
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

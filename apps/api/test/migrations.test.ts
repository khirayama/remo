/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "./support/sqlite-d1";

const postDeploy = readFileSync(fileURLToPath(new URL("../scripts/post-deploy.sql", import.meta.url).href), "utf8");

function before0023() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
    CREATE TABLE location_chunk (
      user_id TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      payload TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, bucket)
    );
    CREATE INDEX location_chunk_user_sync_idx ON location_chunk(user_id, updated_at);
    CREATE TABLE user_sync_state (
      user_id TEXT PRIMARY KEY NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      preview_count INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE life_event (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      source TEXT NOT NULL,
      deleted_at INTEGER,
      client_updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    ) WITHOUT ROWID;
    CREATE TABLE api_token (
      token_hash TEXT PRIMARY KEY NOT NULL,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'read',
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    INSERT INTO "user" (id) VALUES ('user-1');
    INSERT INTO user_sync_state (user_id, seq) VALUES ('user-1', 2);
    INSERT INTO location_chunk (user_id, bucket, payload, sample_count, updated_at)
      VALUES ('user-1', 1, '[["sample-1",1,35.0,139.0,10,1,1],["sample-2",2,35.1,139.1,20,2,2]]', 2, 2);
  `);
  return database;
}

const photoCount = (database: DatabaseSync) =>
  (database.prepare("SELECT photo_count FROM user_sync_state WHERE user_id = 'user-1'").get() as { photo_count: number }).photo_count;

// The production upsert's shape: an older upload leaves the stored row alone.
const upsertPhoto = (database: DatabaseSync, id: string, clientUpdatedAt: number) => database.prepare(
  `INSERT INTO life_event (user_id, id, source, deleted_at, client_updated_at) VALUES ('user-1', ?1, 'photo', NULL, ?2)
   ON CONFLICT(user_id, id) DO UPDATE SET source = excluded.source, deleted_at = NULL, client_updated_at = excluded.client_updated_at
   WHERE excluded.client_updated_at >= life_event.client_updated_at`,
).run(id, clientUpdatedAt);

describe("timeline hardening migration", () => {
  it("backfills the sample index and enforces the live photo quota on insert and revive", () => {
    const database = before0023();
    database.exec(`
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
      INSERT INTO life_event (user_id, id, source, deleted_at)
        SELECT 'user-1', 'photo-' || x, 'photo', NULL FROM n;
      INSERT INTO life_event (user_id, id, source, deleted_at, client_updated_at) VALUES ('user-1', 'gone', 'photo', 10, 10);
    `);

    migrate(database, "0022_sleep_sessions.sql", "0023_timeline_hardening.sql");

    expect(database.prepare("SELECT event_id FROM location_sample_index ORDER BY event_id").all()).toEqual([
      { event_id: "sample-1" },
      { event_id: "sample-2" },
    ]);
    expect(photoCount(database)).toBe(20000);
    expect(() => upsertPhoto(database, "overflow", 1)).toThrow(/photo_event_limit/);
    // Reviving a tombstone needs capacity; an upload older than it changes nothing.
    expect(() => upsertPhoto(database, "gone", 20)).toThrow(/photo_event_limit/);
    expect(Number(upsertPhoto(database, "gone", 5).changes)).toBe(0);
    // Updating a live record takes no capacity.
    expect(Number(upsertPhoto(database, "photo-1", 30).changes)).toBe(1);

    // Deleting frees capacity and the counter follows.
    database.exec("UPDATE life_event SET deleted_at = 40 WHERE id = 'photo-1'");
    expect(photoCount(database)).toBe(19999);
    upsertPhoto(database, "gone", 50);
    expect(photoCount(database)).toBe(20000);
    expect(() => database.exec("UPDATE life_event SET deleted_at = NULL WHERE id = 'photo-1'")).toThrow(/photo_event_limit/);
  });

  it("indexes chunks written by the previous Worker and dates unexpiring tokens after the deploy", () => {
    const database = before0023();
    migrate(database, "0022_sleep_sessions.sql", "0024_api_token_expiry.sql");
    const cutoff = (database.prepare("SELECT cutoff FROM pending_sample_reindex").get() as { cutoff: number }).cutoff;

    // Written by the old Worker after the migration: no index entries, no expiry.
    database.prepare("INSERT INTO location_chunk (user_id, bucket, payload, sample_count, updated_at) VALUES ('user-1', 2, ?1, 1, ?2)")
      .run('[["late",3,35.2,139.2,10,3,3]]', cutoff + 5);
    database.exec("INSERT INTO api_token (token_hash, id, user_id, name, created_at) VALUES ('hash', 'gap', 'user-1', '', 1000)");

    database.exec(postDeploy);
    expect(database.prepare("SELECT event_id, bucket FROM location_sample_index ORDER BY event_id").all()).toEqual([
      { event_id: "late", bucket: 2 },
      { event_id: "sample-1", bucket: 1 },
      { event_id: "sample-2", bucket: 1 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM pending_sample_reindex").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT expires_at FROM api_token").get()).toEqual({ expires_at: 1000 + 180 * 24 * 60 * 60 * 1000 });

    // Every later deploy runs it again without effect.
    database.exec(postDeploy);
    expect(database.prepare("SELECT COUNT(*) AS count FROM location_sample_index").get()).toEqual({ count: 3 });
  });
});

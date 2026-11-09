/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

// Runs the routes against real SQLite with every migration applied, so the
// SQL itself (conflict targets, numbered parameters, LWW guards) is exercised.
// The adapter mirrors the D1 surface the routes use, including D1's
// boolean-to-integer binding and all-or-nothing batches.
export function d1(database: DatabaseSync, onStatement: (sql: string) => void = () => {}): D1Database {
  const toParams = (values: unknown[]) => values.map((value) =>
    typeof value === "boolean" ? Number(value) : value) as Array<string | number | null>;
  const isRead = (sql: string) => /^\s*SELECT/i.test(sql);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => { onStatement(sql); return { results: database.prepare(sql).all(...toParams(params)), meta: { changes: 0 } }; },
    first: async () => { onStatement(sql); return database.prepare(sql).get(...toParams(params)) ?? null; },
    run: async () => { onStatement(sql); return { results: [], meta: { changes: Number(database.prepare(sql).run(...toParams(params)).changes) } }; },
    execute: async () => isRead(sql) ? statement(sql, params).all() : statement(sql, params).run(),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const current of statements) results.push(await current.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const migrations = fileURLToPath(new URL("../../migrations", import.meta.url).href);

export function migrate(database: DatabaseSync, from: string, through: string) {
  for (const file of readdirSync(migrations).sort()) {
    if (file > from && file.slice(0, 4) <= through) database.exec(readFileSync(join(migrations, file), "utf8"));
  }
}

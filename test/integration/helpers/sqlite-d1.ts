/**
 * A D1 binding backed by real SQLite.
 *
 * Every other test in this suite runs against `MockD1Database`, which re-implements the adapter's
 * SQL in JavaScript by matching on statement text. That is fast and precise for policy, but it means
 * the SQL itself has never been parsed or executed: a syntax error, a column the schema does not
 * have, or an `ON CONFLICT` clause SQLite reads differently would all pass.
 *
 * This runs the real statements against real SQLite, over the real migrations, so the schema and the
 * adapter are checked against each other rather than against a hand-written imitation. D1 is SQLite,
 * so the semantics that matter here — upsert conflict targets, the `WHERE` on `DO UPDATE`, `COALESCE`
 * ordering — are the same ones production runs.
 */
import { DatabaseSync } from "node:sqlite"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { StoreKitD1Database, StoreKitPreparedStatement } from "../../../src/cloudflare"

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url))

/** Apply every migration in filename order, the way Wrangler does. */
export function applyStoreKitMigrations(db: DatabaseSync): string[] {
  const applied: string[] = []
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
    applied.push(name)
  }
  return applied
}

class SqlitePreparedStatement implements StoreKitPreparedStatement {
  private bindings: unknown[] = []

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): StoreKitPreparedStatement {
    // node:sqlite rejects booleans and undefined; D1 coerces them, so match D1.
    this.bindings = values.map((value) => {
      if (typeof value === "boolean") return value ? 1 : 0
      return value === undefined ? null : value
    })
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.bindings as never[])) as T) ?? null
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.bindings as never[])) as T[] }
  }

  run(): void {
    this.db.prepare(this.sql).run(...(this.bindings as never[]))
  }
}

export function createSqliteD1(): { d1: StoreKitD1Database; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:")
  applyStoreKitMigrations(db)

  const d1: StoreKitD1Database = {
    prepare: (query: string) => new SqlitePreparedStatement(db, query),
    // D1 runs a batch as one transaction, and the module depends on that: it is what keeps a
    // notification from being recorded as processed when its entitlement write fails.
    batch: async (statements) => {
      db.exec("BEGIN")
      try {
        for (const statement of statements) (statement as SqlitePreparedStatement).run()
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
      return []
    }
  }

  return { d1, db }
}

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as storeKit from "../../src/storekit"

const MODULE_DIR = join(__dirname, "../../src/storekit")

function moduleSourceFiles(): string[] {
  return readdirSync(MODULE_DIR).filter((name) => name.endsWith(".ts"))
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\("([^"]+)"\)/g)].map(
    (match) => match[1] ?? match[2] ?? ""
  )
}

describe("public StoreKit module entrypoint", () => {
  it("exposes the verification, service, policy, and D1 integration surfaces", () => {
    expect(typeof storeKit.verifyStoreKitTransaction).toBe("function")
    expect(typeof storeKit.verifyStoreKitNotification).toBe("function")
    expect(typeof storeKit.syncStoreKitTransaction).toBe("function")
    expect(typeof storeKit.processStoreKitNotification).toBe("function")
    expect(typeof storeKit.getStoreKitEntitlement).toBe("function")
    expect(typeof storeKit.persistStoreKitSubscriptionForInstallation).toBe(
      "function"
    )
    expect(typeof storeKit.resolveStoreKitEntitlementPolicy).toBe("function")
  })

  it("exposes the drop-in handler, config validation and operational Apple calls", () => {
    expect(typeof storeKit.createStoreKitHandler).toBe("function")
    expect(typeof storeKit.describeStoreKitConfig).toBe("function")
    expect(typeof storeKit.assertStoreKitConfig).toBe("function")
    expect(typeof storeKit.requestStoreKitTestNotification).toBe("function")
    expect(typeof storeKit.getStoreKitNotificationHistory).toBe("function")
    expect(typeof storeKit.sendStoreKitConsumptionInformation).toBe("function")
    expect(typeof storeKit.extendStoreKitSubscriptionRenewalDate).toBe(
      "function"
    )
  })

  /**
   * The module is meant to be copied into any Worker as a directory. If a file ever reaches back
   * into this repository's helpers, that stops being true — so the boundary is asserted, not just
   * documented.
   */
  it("imports nothing from outside the module except the Apple SDK", () => {
    const offenders: string[] = []

    for (const file of moduleSourceFiles()) {
      const source = readFileSync(join(MODULE_DIR, file), "utf8")
      for (const specifier of importSpecifiers(source)) {
        const external =
          specifier.startsWith("../") ||
          (!specifier.startsWith("./") &&
            specifier !== "@apple/app-store-server-library" &&
            specifier !== "buffer")
        if (external) offenders.push(`${file} -> ${specifier}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it("ships the D1 schema alongside the code it needs", () => {
    const schema = readFileSync(join(MODULE_DIR, "schema.sql"), "utf8")

    for (const table of [
      "storekit_subscriptions",
      "storekit_transactions",
      "storekit_notifications"
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    // Columns the entitlement and out-of-order guards depend on.
    for (const column of [
      "access_expires_at",
      "latest_signed_date",
      "grace_period_expires_at"
    ]) {
      expect(schema).toContain(column)
    }
  })

  /**
   * The schema exists twice on purpose: `migrations/` for Wrangler's migration workflow, and
   * `src/storekit/schema.sql` for an adopter who vendors the directory into an existing Worker.
   * Only the headers differ; if the SQL itself drifts, one set of adopters gets a broken database.
   */
  it("keeps the migration and the vendored schema in sync", () => {
    const sqlBody = (contents: string): string =>
      contents.slice(contents.indexOf("CREATE TABLE")).trim()

    const migrationsDir = join(__dirname, "../../migrations")
    const migrations = readdirSync(migrationsDir).filter((name) =>
      name.endsWith(".sql")
    )
    expect(migrations).toHaveLength(1)

    expect(
      sqlBody(readFileSync(join(migrationsDir, migrations[0]!), "utf8"))
    ).toBe(sqlBody(readFileSync(join(MODULE_DIR, "schema.sql"), "utf8")))
  })
})

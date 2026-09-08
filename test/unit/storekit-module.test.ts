import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as storeKit from "storekit-cloudflare-workers"

const MODULE_DIR = join(__dirname, "../../src")
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

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
    expect(typeof storeKit.persistStoreKitSubscriptionForInstallation).toBe("function")
    expect(typeof storeKit.resolveStoreKitEntitlementPolicy).toBe("function")
  })

  it("exposes the drop-in handler, config validation and operational Apple calls", () => {
    expect(typeof storeKit.createStoreKitHandler).toBe("function")
    expect(typeof storeKit.describeStoreKitConfig).toBe("function")
    expect(typeof storeKit.assertStoreKitConfig).toBe("function")
    expect(typeof storeKit.requestStoreKitTestNotification).toBe("function")
    expect(typeof storeKit.getStoreKitNotificationHistory).toBe("function")
    expect(typeof storeKit.sendStoreKitConsumptionInformation).toBe("function")
    expect(typeof storeKit.extendStoreKitSubscriptionRenewalDate).toBe("function")
  })

  it("exposes the whole-Worker export", () => {
    expect(typeof storeKit.createStoreKitWorker).toBe("function")
  })

  /**
   * The package must depend on nothing but the Apple SDK. If a file ever reaches into a host's
   * helpers or into `@cloudflare/workers-types`, the published build stops working in Workers that
   * do not have them, so the boundary is asserted, not just documented.
   */
  it("imports nothing from outside the package except the Apple SDK", () => {
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

  it("relative imports carry the .js extension the published ESM build needs", () => {
    const offenders: string[] = []

    for (const file of moduleSourceFiles()) {
      for (const specifier of importSpecifiers(readFileSync(join(MODULE_DIR, file), "utf8"))) {
        if (specifier.startsWith("./") && !specifier.endsWith(".js")) {
          offenders.push(`${file} -> ${specifier}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("ships the D1 schema it needs as ordered Wrangler migrations", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()

    expect(migrations.length).toBeGreaterThan(0)
    // Wrangler applies migrations in filename order, so the numeric prefixes must be unique and
    // gapless. A duplicate prefix is the mistake that silently skips a migration.
    expect(migrations.map((name) => name.slice(0, 4))).toEqual(
      migrations.map((_, index) => String(index + 1).padStart(4, "0"))
    )

    const schema = migrations
      .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
      .join("\n")

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
      "grace_period_expires_at",
      "in_app_ownership_type"
    ]) {
      expect(schema).toContain(column)
    }
  })
})

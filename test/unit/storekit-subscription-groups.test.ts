/**
 * Subscription groups.
 *
 * Apple allows at most one active subscription per group, which makes a group the unit an
 * entitlement resolves within. Two groups are concurrent entitlements, not competing ones, and an
 * app selling "Pro" and "Extra Storage" holds both at once.
 */
import { describe, expect, it } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { entitlementSnapshot } from "../helpers/snapshot"
import {
  getStoreKitEntitlement,
  listStoreKitEntitlements,
  persistStoreKitSubscriptionForInstallation
} from "storekit-cloudflare-workers"
import type { StoreKitEntitlementSnapshot } from "storekit-cloudflare-workers"

const ACCOUNT = "account-groups"
const RESOLVED_AT = new Date("2026-06-03T12:00:00.000Z")
const FUTURE = "2099-06-02T12:00:00.000Z"
const FURTHER = "2099-12-31T12:00:00.000Z"

function d1(db: MockD1Database) {
  return db as unknown as D1Database
}

async function store(db: MockD1Database, overrides: Partial<StoreKitEntitlementSnapshot>) {
  await persistStoreKitSubscriptionForInstallation(
    entitlementSnapshot(overrides),
    ACCOUNT,
    "com.example.app",
    d1(db)
  )
}

function entitlements(db: MockD1Database) {
  return listStoreKitEntitlements(ACCOUNT, ["Sandbox"], { d1: d1(db) }, RESOLVED_AT)
}

describe("StoreKit subscription groups", () => {
  it("returns one entitlement per group, so a second product is not invisible", async () => {
    const db = new MockD1Database()
    await store(db, {
      originalTransactionId: "original-pro",
      latestTransactionId: "transaction-pro",
      productId: "com.example.pro.monthly",
      subscriptionGroupIdentifier: "group-pro"
    })
    await store(db, {
      originalTransactionId: "original-storage",
      latestTransactionId: "transaction-storage",
      productId: "com.example.storage.monthly",
      subscriptionGroupIdentifier: "group-storage"
    })

    const held = await entitlements(db)

    expect(held).toHaveLength(2)
    expect(held.map((entry) => entry.productId).sort()).toEqual([
      "com.example.pro.monthly",
      "com.example.storage.monthly"
    ])
    expect(held.every((entry) => entry.proActive)).toBe(true)
  })

  it("returns only the winner within a single group", async () => {
    const db = new MockD1Database()
    await store(db, {
      originalTransactionId: "original-old",
      latestTransactionId: "transaction-old",
      productId: "com.example.pro.monthly",
      subscriptionGroupIdentifier: "group-pro",
      status: "expired",
      proActive: false,
      accessExpiresAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z"
    })
    await store(db, {
      originalTransactionId: "original-current",
      latestTransactionId: "transaction-current",
      productId: "com.example.pro.annual",
      subscriptionGroupIdentifier: "group-pro",
      accessExpiresAt: FUTURE,
      expiresAt: FUTURE
    })

    const held = await entitlements(db)

    // Apple permits one active subscription per group, so an expired predecessor is history.
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ productId: "com.example.pro.annual", proActive: true })
  })

  it("lets a lifetime unlock coexist with a subscription", async () => {
    const db = new MockD1Database()
    await store(db, {
      originalTransactionId: "original-lifetime",
      latestTransactionId: "transaction-lifetime",
      productId: "com.example.lifetime",
      productType: "Non-Consumable",
      // A non-consumable has no group; keying it by product is what stops it displacing, or being
      // displaced by, the subscription.
      subscriptionGroupIdentifier: null,
      perpetual: true,
      expiresAt: null,
      accessExpiresAt: null
    })
    await store(db, {
      originalTransactionId: "original-pro",
      latestTransactionId: "transaction-pro",
      productId: "com.example.pro.monthly",
      subscriptionGroupIdentifier: "group-pro",
      accessExpiresAt: FUTURE,
      expiresAt: FUTURE
    })

    const held = await entitlements(db)

    expect(held).toHaveLength(2)
    expect(held.find((entry) => entry.perpetual)).toMatchObject({
      productId: "com.example.lifetime",
      proActive: true,
      accessExpiresAt: null
    })
  })

  it("keeps two ungrouped non-consumables apart", async () => {
    const db = new MockD1Database()
    for (const productId of ["com.example.themes", "com.example.export"]) {
      await store(db, {
        originalTransactionId: `original-${productId}`,
        latestTransactionId: `transaction-${productId}`,
        productId,
        productType: "Non-Consumable",
        subscriptionGroupIdentifier: null,
        perpetual: true,
        expiresAt: null,
        accessExpiresAt: null
      })
    }

    // Grouping ungrouped rows under one key would silently drop one of two lifetime purchases.
    expect(await entitlements(db)).toHaveLength(2)
  })

  it("still answers the single-entitlement read with the best one", async () => {
    const db = new MockD1Database()
    await store(db, {
      originalTransactionId: "original-short",
      latestTransactionId: "transaction-short",
      productId: "com.example.pro.monthly",
      subscriptionGroupIdentifier: "group-pro",
      accessExpiresAt: FUTURE,
      expiresAt: FUTURE
    })
    await store(db, {
      originalTransactionId: "original-long",
      latestTransactionId: "transaction-long",
      productId: "com.example.storage.annual",
      subscriptionGroupIdentifier: "group-storage",
      accessExpiresAt: FURTHER,
      expiresAt: FURTHER
    })

    const best = await getStoreKitEntitlement(ACCOUNT, ["Sandbox"], { d1: d1(db) }, RESOLVED_AT)

    // Unchanged behaviour for a one-product app: the longest-lived active entitlement wins.
    expect(best).toMatchObject({
      proActive: true,
      productId: "com.example.storage.annual",
      subscriptionGroupIdentifier: "group-storage"
    })
  })

  it("reports an account with nothing on record as holding nothing", async () => {
    expect(await entitlements(new MockD1Database())).toEqual([])
  })

  it("re-evaluates expiry at read time rather than trusting the stored status", async () => {
    const db = new MockD1Database()
    await store(db, {
      originalTransactionId: "original-lapsed",
      latestTransactionId: "transaction-lapsed",
      subscriptionGroupIdentifier: "group-pro",
      // Written as active, but the window closed before this read.
      status: "active_paid",
      accessExpiresAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z"
    })

    const held = await entitlements(db)

    expect(held).toHaveLength(1)
    expect(held[0]?.proActive).toBe(false)
  })
})

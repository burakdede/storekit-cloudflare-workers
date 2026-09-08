/**
 * The entitlement's account binding.
 *
 * A signed transaction proves a purchase happened, not who owns it. These tests pin the rule that
 * follows from that: the first account to sync a transaction keeps it, and possession of the JWS
 * alone never moves an entitlement off the account holding it.
 */
import {
  Environment,
  Status,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { entitlementSnapshot } from "../helpers/snapshot"
import {
  loadStoreKitSubscriptionByInstallation,
  loadStoreKitSubscriptionOwner,
  persistStoreKitSubscriptionForInstallation,
  StoreKitOwnershipConflictError,
  syncStoreKitTransaction
} from "storekit-cloudflare-workers"
import type * as StoreKitVerification from "../../src/verification"

const transaction: JWSTransactionDecodedPayload = {
  transactionId: "transaction-binding-1",
  originalTransactionId: "original-binding-1",
  bundleId: "com.example.app",
  productId: "com.example.pro.monthly",
  environment: Environment.SANDBOX,
  expiresDate: Date.parse("2099-06-02T12:00:00.000Z")
}

const verifiedTransaction = {
  environment: Environment.SANDBOX,
  transaction,
  statusResponse: { environment: Environment.SANDBOX, bundleId: "com.example.app", data: [] },
  latestSubscription: {
    status: Status.ACTIVE,
    originalTransactionId: transaction.originalTransactionId,
    signedTransactionInfo: "signed-transaction"
  },
  subscriptionTransactions: [],
  verificationSource: "submitted_jws" as const
}

vi.mock("../../src/verification", async () => {
  const actual = await vi.importActual<typeof StoreKitVerification>("../../src/verification")
  return { ...actual, verifyStoreKitTransaction: vi.fn(async () => verifiedTransaction) }
})

const appleConfig = {
  STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
  STOREKIT_BUNDLE_ID: "com.example.app",
  STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly"
}

const snapshot = entitlementSnapshot({
  originalTransactionId: "original-binding-1",
  latestTransactionId: "transaction-binding-1"
})

const RESOLVED_AT = new Date("2026-06-03T12:00:00.000Z")

function d1(db: MockD1Database) {
  return db as unknown as D1Database
}

function syncInput(installationId: string) {
  return {
    signedTransactionJWS: "a".repeat(64),
    installationId,
    appBundleId: "com.example.app"
  }
}

function serviceConfig(db: MockD1Database, overrides: Record<string, unknown> = {}) {
  return { apple: appleConfig, d1: d1(db), ...overrides } as Parameters<
    typeof syncStoreKitTransaction
  >[1]
}

async function entitlementFor(db: MockD1Database, installationId: string) {
  return loadStoreKitSubscriptionByInstallation(installationId, RESOLVED_AT, ["Sandbox"], d1(db))
}

describe("StoreKit entitlement account binding", () => {
  beforeEach(() => vi.clearAllMocks())

  describe("persistence", () => {
    it("keeps the first account's binding when a second account writes the same transaction", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(
        snapshot,
        "victim",
        "com.example.app",
        d1(db)
      )
      await persistStoreKitSubscriptionForInstallation(
        snapshot,
        "attacker",
        "com.example.app",
        d1(db)
      )

      expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({ installation_id: "victim" })
      expect(db.getStoreKitTransactionRows()[0]).toMatchObject({ installation_id: "victim" })
      expect(await entitlementFor(db, "victim")).toMatchObject({ status: "active_paid" })
      expect(await entitlementFor(db, "attacker")).toBeNull()
    })

    it("binds a row a notification created without an account on the first authenticated sync", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(snapshot, null, "com.example.app", d1(db))
      expect(
        await loadStoreKitSubscriptionOwner("original-binding-1", "Sandbox", d1(db))
      ).toBeNull()

      await persistStoreKitSubscriptionForInstallation(snapshot, "owner", "com.example.app", d1(db))

      expect(await loadStoreKitSubscriptionOwner("original-binding-1", "Sandbox", d1(db))).toBe(
        "owner"
      )
    })

    it("moves the binding only when the caller opts into a transfer", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(snapshot, "first", "com.example.app", d1(db))
      await persistStoreKitSubscriptionForInstallation(
        snapshot,
        "second",
        "com.example.app",
        d1(db),
        { allowAccountTransfer: true }
      )

      expect(await entitlementFor(db, "second")).toMatchObject({ status: "active_paid" })
      expect(await entitlementFor(db, "first")).toBeNull()
    })

    it("reports no owner for a transaction nothing has written", async () => {
      const db = new MockD1Database()

      expect(await loadStoreKitSubscriptionOwner("unknown", "Sandbox", d1(db))).toBeNull()
    })
  })

  describe("sync", () => {
    it("refuses a sync for a transaction another account already owns", async () => {
      const db = new MockD1Database()
      await syncStoreKitTransaction(syncInput("victim"), serviceConfig(db))

      await expect(
        syncStoreKitTransaction(syncInput("attacker"), serviceConfig(db))
      ).rejects.toBeInstanceOf(StoreKitOwnershipConflictError)

      // The refusal must leave the victim's entitlement exactly as it was.
      expect(await entitlementFor(db, "victim")).toMatchObject({ status: "active_paid" })
      expect(await entitlementFor(db, "attacker")).toBeNull()
    })

    it("carries the conflicting transaction identity for the host to log", async () => {
      const db = new MockD1Database()
      await syncStoreKitTransaction(syncInput("victim"), serviceConfig(db))

      const error = await syncStoreKitTransaction(syncInput("attacker"), serviceConfig(db)).catch(
        (caught: unknown) => caught as StoreKitOwnershipConflictError
      )

      expect(error).toMatchObject({
        originalTransactionId: "original-binding-1",
        environment: "Sandbox"
      })
    })

    it("lets the owning account re-sync, which is what a restore does", async () => {
      const db = new MockD1Database()
      await syncStoreKitTransaction(syncInput("owner"), serviceConfig(db))

      const result = await syncStoreKitTransaction(syncInput("owner"), serviceConfig(db))

      expect(result.snapshot.proActive).toBe(true)
      expect(await entitlementFor(db, "owner")).toMatchObject({ status: "active_paid" })
    })

    it("transfers when the host explicitly allows it", async () => {
      const db = new MockD1Database()
      await syncStoreKitTransaction(syncInput("previous"), serviceConfig(db))

      const result = await syncStoreKitTransaction(
        syncInput("next"),
        serviceConfig(db, { allowAccountTransfer: true })
      )

      expect(result.snapshot.proActive).toBe(true)
      expect(await entitlementFor(db, "next")).toMatchObject({ status: "active_paid" })
      expect(await entitlementFor(db, "previous")).toBeNull()
    })
  })
})

/**
 * The adapter's SQL, executed by SQLite.
 *
 * The unit suite proves the module's *policy*. This proves its *statements*: that they parse, that
 * every column they write exists in the migrations, and that SQLite reads the upsert guards the way
 * the adapter assumes. None of that is established by a mock that matches on statement text.
 *
 * The three behaviours checked hardest are the ones where being wrong is expensive and silent: the
 * account binding rule (a security control), the out-of-order write guard, and the revocation
 * bypass.
 */
import { describe, expect, it } from "vitest"
import { applyStoreKitMigrations, createSqliteD1 } from "./helpers/sqlite-d1"
import { DatabaseSync } from "node:sqlite"
import { entitlementSnapshot } from "../helpers/snapshot"
import {
  listStoreKitSubscriptionsByInstallation,
  loadStoreKitSubscriptionByInstallation,
  loadStoreKitSubscriptionOwner,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists
} from "../../src/storage"

const NOW = new Date("2026-06-10T12:00:00.000Z")
const FUTURE = "2099-06-02T12:00:00.000Z"

function persist(
  d1: ReturnType<typeof createSqliteD1>["d1"],
  overrides: Parameters<typeof entitlementSnapshot>[0],
  accountId: string | null = "account-1"
) {
  return persistStoreKitSubscriptionForInstallation(
    entitlementSnapshot(overrides),
    accountId,
    "com.example.app",
    d1
  )
}

describe("StoreKit SQL against real SQLite", () => {
  describe("schema", () => {
    it("applies every migration in filename order", () => {
      const db = new DatabaseSync(":memory:")

      const applied = applyStoreKitMigrations(db)

      expect(applied[0]).toBe("0001_storekit.sql")
      expect(applied).toEqual([...applied].sort())
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)
      expect(tables).toContain("storekit_subscriptions")
      expect(tables).toContain("storekit_transactions")
      expect(tables).toContain("storekit_notifications")
    })

    it("writes a complete snapshot, so every column the adapter binds exists", async () => {
      const { d1 } = createSqliteD1()

      // The mock cannot catch a column the schema lacks; SQLite fails the statement outright.
      await persist(d1, { currency: "USD", renewalPrice: 9990 })

      const stored = await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      expect(stored).toMatchObject({
        productId: "com.example.pro.monthly",
        status: "active_paid",
        price: 9990,
        currency: "USD",
        storefront: "USA",
        inAppOwnershipType: "PURCHASED",
        subscriptionGroupIdentifier: "21234567",
        renewalDate: FUTURE
      })
    })
  })

  describe("account binding", () => {
    it("keeps the first account's binding when another account writes the same transaction", async () => {
      const { d1 } = createSqliteD1()

      await persist(d1, {}, "victim")
      await persist(d1, {}, "attacker")

      // The security control, executed by SQLite rather than imitated in JavaScript.
      expect(await loadStoreKitSubscriptionOwner("original-1", "Sandbox", d1)).toBe("victim")
      expect(
        await loadStoreKitSubscriptionByInstallation("attacker", NOW, ["Sandbox"], d1)
      ).toBeNull()
    })

    it("moves the binding when a caller opts into a transfer", async () => {
      const { d1 } = createSqliteD1()

      await persist(d1, {}, "first")
      await persistStoreKitSubscriptionForInstallation(
        entitlementSnapshot({}),
        "second",
        "com.example.app",
        d1,
        { allowAccountTransfer: true }
      )

      expect(await loadStoreKitSubscriptionOwner("original-1", "Sandbox", d1)).toBe("second")
    })

    it("binds a row a notification created without an account", async () => {
      const { d1 } = createSqliteD1()

      await persistStoreKitNotification(
        {
          uuid: "n-1",
          type: "DID_RENEW",
          subtype: null,
          environment: "Sandbox",
          originalTransactionId: "original-1",
          transactionId: "transaction-1"
        },
        entitlementSnapshot({}),
        "com.example.app",
        d1
      )
      expect(await loadStoreKitSubscriptionOwner("original-1", "Sandbox", d1)).toBeNull()

      await persist(d1, {}, "owner")

      expect(await loadStoreKitSubscriptionOwner("original-1", "Sandbox", d1)).toBe("owner")
    })
  })

  describe("out-of-order write guard", () => {
    it("refuses a write Apple signed earlier than the stored one", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, { signedDate: "2026-06-05T00:00:00.000Z" })

      await persist(d1, {
        signedDate: "2026-06-01T00:00:00.000Z",
        status: "expired",
        proActive: false
      })

      // Apple retries for days, so a late delivery carries an older signing time and must not
      // rewind newer state. The `WHERE` on `DO UPDATE` is what enforces it.
      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      ).toMatchObject({ status: "active_paid" })
    })

    it("accepts a write Apple signed later", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, { signedDate: "2026-06-01T00:00:00.000Z" })

      await persist(d1, {
        signedDate: "2026-06-05T00:00:00.000Z",
        status: "expired",
        proActive: false
      })

      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      ).toMatchObject({ status: "expired" })
    })

    it("lets a revocation land even when signed before the state it supersedes", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, { signedDate: "2026-06-05T00:00:00.000Z" })

      await persist(d1, {
        signedDate: "2020-01-01T00:00:00.000Z",
        status: "refunded",
        proActive: false,
        revocationDate: "2026-06-06T00:00:00.000Z",
        revocationType: "REFUND_FULL"
      })

      // A refund is terminal and monotonic; it must bypass the guard or a refunded customer keeps
      // access forever.
      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      ).toMatchObject({ status: "refunded", revocationType: "REFUND_FULL" })
    })
  })

  describe("reads", () => {
    it("returns one row per subscription group", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, {
        originalTransactionId: "otx-pro",
        latestTransactionId: "tx-pro",
        subscriptionGroupIdentifier: "group-pro",
        productId: "com.example.pro"
      })
      await persist(d1, {
        originalTransactionId: "otx-storage",
        latestTransactionId: "tx-storage",
        subscriptionGroupIdentifier: "group-storage",
        productId: "com.example.storage"
      })

      const held = await listStoreKitSubscriptionsByInstallation("account-1", NOW, ["Sandbox"], d1)

      expect(held.map((row) => row.productId).sort()).toEqual([
        "com.example.pro",
        "com.example.storage"
      ])
    })

    it("ranks an active row above a lapsed one", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, {
        originalTransactionId: "otx-old",
        latestTransactionId: "tx-old",
        subscriptionGroupIdentifier: null,
        productId: "com.example.lapsed",
        status: "expired",
        proActive: false,
        accessExpiresAt: "2026-01-01T00:00:00.000Z"
      })
      await persist(d1, {
        originalTransactionId: "otx-new",
        latestTransactionId: "tx-new",
        subscriptionGroupIdentifier: null,
        productId: "com.example.current",
        accessExpiresAt: FUTURE
      })

      // The ORDER BY lives in SQL, so only SQLite can confirm it orders the way the module claims.
      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      ).toMatchObject({ productId: "com.example.current" })
    })

    it("does not read across environments", async () => {
      const { d1 } = createSqliteD1()
      await persist(d1, { environment: "Sandbox" })

      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Production"], d1)
      ).toBeNull()
    })
  })

  describe("notification ledger", () => {
    it("records the notification and the projection in one batch", async () => {
      const { d1 } = createSqliteD1()

      await persistStoreKitNotification(
        {
          uuid: "n-1",
          type: "DID_RENEW",
          subtype: null,
          environment: "Sandbox",
          originalTransactionId: "original-1",
          transactionId: "transaction-1"
        },
        entitlementSnapshot({}),
        "com.example.app",
        d1
      )

      expect(await storeKitNotificationExists("n-1", d1)).toBe(true)
      expect(
        await loadStoreKitSubscriptionByInstallation("account-1", NOW, ["Sandbox"], d1)
      ).toBeNull() // a notification never binds an account
    })

    it("treats the notification uuid as the idempotency key", async () => {
      const { d1 } = createSqliteD1()
      const notification = {
        uuid: "n-dupe",
        type: "DID_RENEW",
        subtype: null,
        environment: "Sandbox",
        originalTransactionId: "original-1",
        transactionId: "transaction-1"
      }

      await persistStoreKitNotification(notification, null, "com.example.app", d1)
      await persistStoreKitNotification(notification, null, "com.example.app", d1)

      // INSERT OR IGNORE, enforced by the primary key rather than by a prior read.
      expect(await storeKitNotificationExists("n-dupe", d1)).toBe(true)
    })
  })
})

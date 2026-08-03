import { describe, expect, it, vi } from "vitest"
import {
  extendStoreKitSubscriptionRenewalDate,
  getStoreKitNotificationHistory,
  getStoreKitTransactionHistory,
  lookUpStoreKitOrderId,
  requestStoreKitTestNotification,
  sendStoreKitConsumptionInformation
} from "../../src/storekit/server-api"
import {
  ConsumptionStatus,
  DeliveryStatus,
  Order,
  Platform,
  RefundPreference,
  UserStatus
} from "@apple/app-store-server-library"
import { StoreKitConfigError } from "../../src/storekit/errors"
import type * as StoreKitVerification from "../../src/storekit/verification"

function client() {
  return {
    requestTestNotification: vi.fn(async () => ({
      testNotificationToken: "token-1"
    })),
    getNotificationHistory: vi.fn(async () => ({ notificationHistory: [] })),
    getTransactionHistory: vi.fn(async () => ({ signedTransactions: [] })),
    getRefundHistory: vi.fn(async () => ({ signedTransactions: [] })),
    lookUpOrderId: vi.fn(async () => ({ status: 0 })),
    extendSubscriptionRenewalDate: vi.fn(async () => ({ effectiveDate: 1 })),
    sendConsumptionInformation: vi.fn(async () => undefined)
  }
}

const sandboxClient = client()
const productionClient = client()

vi.mock("../../src/storekit/verification", async (importOriginal) => {
  const actual = await importOriginal<typeof StoreKitVerification>()
  const { storeKitConfiguredEnvironments } = await import("../../src/storekit/config")
  return {
    ...actual,
    // Mirror the real builder: it constructs one runtime per *configured* environment, which is
    // what makes an unconfigured environment unreachable.
    buildStoreKitRuntimes: vi.fn(async (moduleEnv) =>
      storeKitConfiguredEnvironments(moduleEnv).map((environment) => ({
        environment,
        client: environment === "Sandbox" ? sandboxClient : productionClient
      }))
    )
  }
})

const env = {
  STOREKIT_ALLOWED_ENVIRONMENTS: "Production,Sandbox",
  STOREKIT_BUNDLE_ID: "com.example.app",
  STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly"
}

describe("StoreKit operational Apple calls", () => {
  it("defaults to the first configured environment, which is production", async () => {
    const result = await requestStoreKitTestNotification(env)

    expect(result).toEqual({ testNotificationToken: "token-1" })
    expect(productionClient.requestTestNotification).toHaveBeenCalled()
    expect(sandboxClient.requestTestNotification).not.toHaveBeenCalled()
  })

  it("addresses the explicitly requested environment", async () => {
    await requestStoreKitTestNotification(env, "Sandbox")

    expect(sandboxClient.requestTestNotification).toHaveBeenCalled()
  })

  it("refuses an environment that is not configured", async () => {
    await expect(
      requestStoreKitTestNotification(
        { ...env, STOREKIT_ALLOWED_ENVIRONMENTS: "Production" },
        "Sandbox"
      )
    ).rejects.toBeInstanceOf(StoreKitConfigError)
  })

  it("passes the pagination token through for notification history replay", async () => {
    const request = { startDate: 1, endDate: 2 }

    await getStoreKitNotificationHistory(env, request, "page-2")

    expect(productionClient.getNotificationHistory).toHaveBeenCalledWith("page-2", request)
  })

  it("starts an unpaginated history read with a null token", async () => {
    await getStoreKitTransactionHistory(env, "transaction-1", {
      sort: Order.DESCENDING
    })

    expect(productionClient.getTransactionHistory).toHaveBeenCalledWith("transaction-1", null, {
      sort: Order.DESCENDING
    })
  })

  it("forwards order lookup, renewal extension and consumption information unchanged", async () => {
    const extension = {
      extendByDays: 7,
      extendReasonCode: 1,
      requestIdentifier: "req-1"
    }
    const consumption = {
      customerConsented: true,
      consumptionStatus: ConsumptionStatus.NOT_CONSUMED,
      platform: Platform.APPLE,
      sampleContentProvided: false,
      deliveryStatus: DeliveryStatus.DELIVERED,
      userStatus: UserStatus.ACTIVE,
      refundPreference: RefundPreference.DECLINE
    }

    await lookUpStoreKitOrderId(env, "ORDER-1")
    await extendStoreKitSubscriptionRenewalDate(env, "original-1", extension)
    await sendStoreKitConsumptionInformation(env, "transaction-1", consumption)

    expect(productionClient.lookUpOrderId).toHaveBeenCalledWith("ORDER-1")
    expect(productionClient.extendSubscriptionRenewalDate).toHaveBeenCalledWith(
      "original-1",
      extension
    )
    expect(productionClient.sendConsumptionInformation).toHaveBeenCalledWith(
      "transaction-1",
      consumption
    )
  })
})

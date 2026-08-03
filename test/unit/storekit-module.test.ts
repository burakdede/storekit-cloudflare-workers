import { describe, expect, it } from "vitest"
import * as storeKit from "../../src/storekit-module"

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
})

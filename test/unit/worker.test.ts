import { describe, expect, it } from "vitest"
import worker from "../../src/worker"

const env = {} as Env

describe("reference Worker boundary", () => {
  it("keeps the health endpoint public", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      env
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it("rejects protected routes until the host auth adapter is implemented", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/storekit/entitlement"),
      env
    )
    expect(response.status).toBe(401)
  })

  it("validates the notification envelope before Apple verification", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/storekit/notifications", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" }
      }),
      env
    )
    expect(response.status).toBe(400)
  })
})

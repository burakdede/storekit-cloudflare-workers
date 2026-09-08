/**
 * The documentation tables agree with the code.
 *
 * Wherever prose enumerates something the compiler already knows — every entitlement status, every
 * Worker variable — the two can drift, and a missing row is invisible in review because a reviewer
 * reads what is there rather than noticing what is not. A reader who trusts an incomplete table
 * writes a `switch` that silently mishandles a real status.
 *
 * This caught `upgraded` missing from `http-api.md`: the edit that should have added it used a
 * string anchor that no longer matched after the table was reformatted, so it did nothing and
 * reported success.
 *
 * The assertion is one-directional on purpose. Docs legitimately describe things that are not union
 * members — `http-api.md` documents `perpetual` as a pseudo-status, and `free` comes from the read
 * path rather than the policy — so requiring set equality would fight correct prose.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
}

/** Members of a string-literal union, read from the source rather than duplicated here. */
function unionMembers(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\n`).exec(source)
  expect(declaration, `could not find ${typeName}`).not.toBeNull()
  return [...declaration![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

/**
 * Every backticked value appearing in a Markdown table row.
 *
 * Scoped to tables rather than the whole document on purpose: a status named in passing in prose
 * is not the same as a row telling a reader what to do about it. Any column counts, because the
 * error table keys on the HTTP status and carries the code second.
 */
function documentedInTables(markdown: string): Set<string> {
  const rows = markdown.split("\n").filter((line) => line.trimStart().startsWith("|"))
  return new Set(rows.flatMap((row) => [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)))
}

describe("documentation conformance", () => {
  const types = read("src", "types.ts")

  it("documents every entitlement status in the HTTP API reference", () => {
    const documented = documentedInTables(read("docs", "http-api.md"))
    const undocumented = unionMembers(types, "StoreKitEntitlementStatus").filter(
      (status) => !documented.has(status)
    )

    expect(undocumented, "statuses missing from docs/http-api.md").toEqual([])
  })

  it("documents every entitlement status in the iOS client guide", () => {
    const documented = documentedInTables(read("docs", "ios-client.md"))
    const undocumented = unionMembers(types, "StoreKitEntitlementStatus").filter(
      (status) => !documented.has(status)
    )

    // The iOS guide is where an app author decides what each status shows a customer, so an
    // omission here is the one that reaches an end user.
    expect(undocumented, "statuses missing from docs/ios-client.md").toEqual([])
  })

  it("documents every Worker variable the module reads", () => {
    const documented = documentedInTables(read("docs", "configuration.md"))
    const declared = [...types.matchAll(/^ {2}([A-Z][A-Z0-9_]+)\?: string$/gm)].map(
      (match) => match[1]!
    )

    expect(declared.length).toBeGreaterThan(5)
    expect(
      declared.filter((name) => !documented.has(name)),
      "variables missing from docs/configuration.md"
    ).toEqual([])
  })

  it("documents every error code the router can return", () => {
    const documented = documentedInTables(read("docs", "http-api.md"))
    const codes = [
      ...read("src", "router.ts").matchAll(/errorResponse\(\s*\d+,\s*"([A-Z_]+)"/g)
    ].map((match) => match[1]!)

    expect(codes.length).toBeGreaterThan(3)
    expect(
      [...new Set(codes)].filter((code) => !documented.has(code)),
      "error codes missing from docs/http-api.md"
    ).toEqual([])
  })

  it("documents every function the package exports", () => {
    const api = read("docs", "api.md")
    // A backticked mention counts, with or without a call signature: `storeKitRoutePaths` is a
    // const and still needs somewhere to be read about.
    const documented = new Set(
      [...api.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)[\s(`]/g)].map((match) => match[1]!)
    )
    // Value exports are the actionable API: someone finds one in an editor's autocomplete and needs
    // somewhere to read what it does. Types are covered by the option tables around them, so only
    // values are required here.
    const exported = [
      ...read("src", "index.ts").matchAll(/^ {2}(?!type )([a-z][A-Za-z0-9_]*),$/gm)
    ].map((match) => match[1]!)

    expect(exported.length).toBeGreaterThan(20)
    expect(
      exported.filter((name) => !documented.has(name)),
      "exported functions missing from docs/api.md"
    ).toEqual([])
  })
})

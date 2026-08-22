import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(__dirname, "../..")

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  type: string
  sideEffects: boolean
  files: string[]
  bin: Record<string, string>
  exports: Record<string, string | Record<string, string>>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/**
 * Packaging mistakes only surface at a consumer's install, which is the worst place to find them.
 * These assertions are the cheap version of that feedback.
 */
describe("published package manifest", () => {
  it("is ESM-only and side-effect free, so a Worker bundle can tree-shake it", () => {
    expect(manifest.type).toBe("module")
    expect(manifest.sideEffects).toBe(false)
  })

  it("declares types before the implementation on every export condition", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target === "string") continue
      expect(Object.keys(target)[0], `${subpath} must resolve types first`).toBe("types")
      expect(target.types).toMatch(/^\.\/dist\/.*\.d\.ts$/)
      expect(target.default).toMatch(/^\.\/dist\/.*\.js$/)
    }
  })

  it("maps every export onto a source file the build actually emits", () => {
    for (const target of Object.values(manifest.exports)) {
      if (typeof target === "string") continue
      const source = target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")
      expect(existsSync(join(ROOT, source)), `${source} is missing`).toBe(true)
    }
  })

  it("publishes the migration Wrangler needs and the CLI that installs it", () => {
    expect(manifest.files).toContain("migrations")
    expect(manifest.files).toContain("dist")
    expect(manifest.files).toContain("bin")
    expect(existsSync(join(ROOT, manifest.bin["storekit-cloudflare-workers"]!))).toBe(true)
    expect(existsSync(join(ROOT, "migrations/0001_storekit.sql"))).toBe(true)
  })

  /**
   * The Apple SDK is the only runtime dependency, and it must stay a real dependency rather than a
   * peer: installing this package has to be enough to deploy.
   */
  it("ships exactly one runtime dependency", () => {
    expect(Object.keys(manifest.dependencies)).toEqual(["@apple/app-store-server-library"])
    expect(manifest.devDependencies["@cloudflare/workers-types"]).toBeDefined()
  })
})

/**
 * The `init` CLI.
 *
 * It is the first thing the README tells an adopter to run, and it had no behavioural test at all —
 * which is how it came to generate a standalone Worker for projects that already had one, and tell
 * them to repoint `main` at it. Following that replaces the adopter's application.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const CLI = fileURLToPath(new URL("../../bin/storekit.mjs", import.meta.url))

let projectDir: string

function run(...args: string[]): string {
  return execFileSync("node", [CLI, "init", "--dir", projectDir, ...args], { encoding: "utf8" })
}

function write(relativePath: string, contents: string): void {
  const target = join(projectDir, relativePath)
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, contents)
}

function read(relativePath: string): string {
  return readFileSync(join(projectDir, relativePath), "utf8")
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "storekit-cli-"))
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe("storekit init", () => {
  describe("in a project that already has a Worker", () => {
    beforeEach(() => {
      write("wrangler.jsonc", '{ "name": "app", "main": "src/index.ts" }')
      write("src/index.ts", "export default { async fetch() { return new Response('hi') } }")
    })

    it("generates a mountable handler rather than a second default export", () => {
      const output = run()
      const generated = read("src/storekit.ts")

      // A second `export default` cannot be mounted into an existing entrypoint without being
      // rewritten first, which is the whole problem.
      expect(generated).toContain("createStoreKitHandler")
      expect(generated).toContain("export const storekit")
      expect(generated).not.toContain("export default")
      expect(output).toContain("detected   src/index.ts (wrangler.jsonc)")
    })

    it("shows how to compose it, and never says to repoint main", () => {
      const output = run()

      expect(output).toContain("storekit.fetch(request, env, ctx)")
      // Following this instruction would replace the adopter's entire application.
      expect(output).not.toContain("point your Worker's main")
    })

    it("detects a conventional entrypoint with no wrangler main", () => {
      rmSync(join(projectDir, "wrangler.jsonc"))

      expect(run()).toContain("detected   src/index.ts (convention)")
    })

    it("does not claim to detect a main that points at a missing file", () => {
      rmSync(join(projectDir, "src/index.ts"))
      write("wrangler.jsonc", '{ "name": "app", "main": "src/gone.ts" }')

      expect(run()).toContain("no existing entrypoint found")
    })
  })

  describe("in an empty project", () => {
    it("generates a complete Worker", () => {
      const output = run()
      const generated = read("src/storekit.ts")

      expect(generated).toContain("createStoreKitWorker")
      expect(generated).toContain("export default")
      expect(output).toContain("mode       worker")
      expect(output).toContain("point your Worker's main")
    })
  })

  describe("options", () => {
    it("honours --mode over what it detected", () => {
      write("wrangler.jsonc", '{ "name": "app", "main": "src/index.ts" }')
      write("src/index.ts", "export default {}")

      run("--mode", "worker")

      expect(read("src/storekit.ts")).toContain("createStoreKitWorker")
    })

    it("accepts a space-separated flag value", () => {
      // `--dir build` used to match the bare-flag case and yield `true`, so the CLI resolved its
      // target to a directory literally named "true" and wrote everything there.
      run("--binding", "MY_DB")

      expect(read("src/storekit.ts")).toContain("env.MY_DB")
    })

    it("accepts the --flag=value form too", () => {
      run("--binding=OTHER_DB")

      expect(read("src/storekit.ts")).toContain("env.OTHER_DB")
    })

    it("rejects an unknown --mode instead of guessing", () => {
      expect(() => run("--mode", "sidecar")).toThrow()
    })

    it("copies every migration, in order", () => {
      run()
      const listed = run()

      // Wrangler applies by filename, so a missing later migration is a schema that silently lacks
      // columns the code writes to.
      expect(listed).toContain("migrations already present")
      expect(read("migrations/0001_storekit.sql")).toContain("CREATE TABLE")
      expect(read("migrations/0006_commerce_metadata.sql")).toContain("ALTER TABLE")
    })

    it("never overwrites a mount point that already exists", () => {
      write("src/storekit.ts", "// mine, with a real authenticate() in it")

      const output = run()

      expect(read("src/storekit.ts")).toBe("// mine, with a real authenticate() in it")
      expect(output).toContain("kept       src/storekit.ts (already exists)")
    })
  })
})

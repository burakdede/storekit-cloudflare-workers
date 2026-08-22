#!/usr/bin/env node
/**
 * Install the packed tarball into a scratch Worker and prove an adopter's first hour works.
 *
 * Everything checked here is invisible to the repository's own tests, which import `src/` directly:
 * the export map, the `.js` specifiers the published ESM build needs, whether `bin/` is executable,
 * whether the migration ships, and whether the result bundles for workerd. All of it only breaks at
 * someone else's `npm install`, which is the worst place to find out.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" })
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim()
}

const workspace = mkdtempSync(join(tmpdir(), "storekit-smoke-"))
const consumer = join(workspace, "consumer")

try {
  console.log(`> packing into ${workspace}`)
  const tarball = join(
    workspace,
    capture("npm", ["pack", "--silent", `--pack-destination=${workspace}`], ROOT)
      .split("\n")
      .pop()
  )

  mkdirSync(join(consumer, "src"), { recursive: true })
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "storekit-smoke-consumer", private: true, type: "module" }, null, 2)
  )
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          // Node's own resolution, which is stricter than a bundler's: it will not forgive a
          // missing extension or an export map that does not name its types.
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          skipLibCheck: true
        },
        include: ["src", "worker-configuration.d.ts"]
      },
      null,
      2
    )
  )
  writeFileSync(
    join(consumer, "wrangler.jsonc"),
    JSON.stringify(
      {
        name: "storekit-smoke-consumer",
        main: "src/storekit.ts",
        compatibility_date: "2026-08-03",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          STOREKIT_BUNDLE_ID: "com.example.app",
          STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro"
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "storekit",
            database_id: "00000000-0000-0000-0000-000000000000",
            // Deliberately the copy inside node_modules: adopters are told they can skip vendoring
            // the SQL, so that path has to keep working.
            migrations_dir: "node_modules/storekit-cloudflare-workers/migrations"
          }
        ]
      },
      null,
      2
    )
  )

  console.log("> installing the tarball")
  run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer)
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save-dev", "typescript", "wrangler"],
    consumer
  )

  console.log("> npx storekit-cloudflare-workers init")
  run("npx", ["storekit-cloudflare-workers", "init", "--binding=DB", "--no-migrations"], consumer)

  const migrations = readdirSync(
    join(consumer, "node_modules/storekit-cloudflare-workers/migrations")
  )
  if (!migrations.some((name) => name.endsWith(".sql"))) {
    throw new Error("the tarball ships no D1 migration")
  }

  console.log("> wrangler types")
  run("npx", ["wrangler", "types"], consumer)

  console.log("> tsc --noEmit (nodenext resolution)")
  run("npx", ["tsc", "--noEmit"], consumer)

  console.log("> wrangler deploy --dry-run")
  run("npx", ["wrangler", "deploy", "--dry-run", `--outdir=${join(workspace, "dist")}`], consumer)

  console.log("\nsmoke install passed")
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

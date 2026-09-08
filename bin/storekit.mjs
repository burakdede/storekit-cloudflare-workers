#!/usr/bin/env node
/**
 * Integration helper: everything about adopting the package that is not `npm install`.
 *
 * `init` copies the D1 migration into the host Worker, writes a mount point with the one adapter
 * the package cannot supply, and prints the exact Wrangler configuration and secret commands. It
 * never edits an existing file.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_NAME = "storekit-cloudflare-workers"
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const argv = process.argv.slice(2)
const command = argv[0] ?? "help"

/**
 * Read `--name=value`, `--name value`, or bare `--name`.
 *
 * The space-separated form matters: `--dir build` previously matched the bare case and returned
 * `true`, so the CLI resolved its target to a directory literally named "true" and wrote the
 * migrations there. Silent, and in the wrong place.
 */
function flag(name, fallback = undefined) {
  const index = argv.findIndex((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`))
  if (index === -1) return fallback
  const entry = argv[index]
  if (entry.startsWith(`--${name}=`)) return entry.slice(name.length + 3)
  const next = argv[index + 1]
  return next !== undefined && !next.startsWith("--") ? next : true
}

function log(message = "") {
  process.stdout.write(`${message}\n`)
}

function migrationSources() {
  const dir = join(PACKAGE_ROOT, "migrations")
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, path: join(dir, name) }))
}

function copyMigrations(targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const written = []
  for (const migration of migrationSources()) {
    const target = join(targetDir, migration.name)
    if (existsSync(target)) continue
    cpSync(migration.path, target)
    written.push(migration.name)
  }
  return written
}

const AUTHENTICATE_SOURCE = `/**
 * The one piece the package cannot supply.
 *
 * A StoreKit transaction proves *that a purchase happened*, never *who it belongs to*; only this
 * app knows that. Resolve the caller and return the account the entitlement binds to. Returning
 * null answers 401, which is what this stub does until it is implemented.
 *
 * Never derive identity from a client-supplied header: anyone can send one and claim another
 * customer's subscription.
 */
async function authenticate(
  request: Request,
  env: Env & StoreKitWorkerEnv
): Promise<StoreKitRequestContext | null> {
  void request
  void env
  //   const session = await verifySessionToken(request.headers.get("authorization"), env)
  //   if (!session) return null
  //   return {
  //     accountId: session.userId,
  //     // Pin the token the client passed to Product.purchase(options:), so a signed transaction
  //     // cannot be replayed onto another account.
  //     expectedAppAccountToken: session.appAccountToken
  //   }
  return null
}`

/** For a Worker that is StoreKit and nothing else: one default export, no routing code. */
const WORKER_SOURCE = `import {
  createStoreKitWorker,
  type StoreKitRequestContext,
  type StoreKitWorkerEnv
} from "${PACKAGE_NAME}"

${AUTHENTICATE_SOURCE}

export default createStoreKitWorker<Env & StoreKitWorkerEnv>({
  authenticate,
  database: (env) => env.__BINDING__
})
`

/**
 * For a Worker that already exists.
 *
 * Exports a handler rather than a default export, because the host already has one. `fetch`
 * resolves to null for paths this package does not own, so it drops in front of whatever routing
 * is already there.
 */
const HANDLER_SOURCE = `import {
  createStoreKitHandler,
  type StoreKitRequestContext,
  type StoreKitWorkerEnv
} from "${PACKAGE_NAME}"

${AUTHENTICATE_SOURCE}

export const storekit = createStoreKitHandler<Env & StoreKitWorkerEnv>({
  authenticate,
  // Point this at whatever your D1 binding is called.
  database: (env) => env.__BINDING__
})
`

function wranglerSnippet(binding, migrationsDir) {
  return `{
  // The Apple library needs Node built-ins; without this flag the Worker will not build.
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "STOREKIT_BUNDLE_ID": "com.example.app",
    "STOREKIT_ALLOWED_PRODUCT_IDS": "com.example.app.pro.monthly,com.example.app.pro.annual",
    "STOREKIT_ALLOWED_ENVIRONMENTS": "Production",
    // Numeric App Store app id. Required whenever Production is allowed.
    "APP_STORE_APP_APPLE_ID": "0000000000"
  },
  "d1_databases": [
    {
      "binding": "${binding}",
      "database_name": "storekit",
      "database_id": "<your-d1-database-id>",
      "migrations_dir": "${migrationsDir}"
    }
  ]
}`
}

/**
 * Does this project already have a Worker?
 *
 * If it does, generating a second default export and telling the adopter to repoint `main` would
 * replace their application. Detection reads Wrangler's `main`, then falls back to the conventional
 * entrypoints, and can always be overridden with `--mode`.
 */
function detectExistingWorker(targetRoot) {
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const config = join(targetRoot, name)
    if (!existsSync(config)) continue
    const main = /["']?main["']?\s*[:=]\s*["']([^"']+)["']/.exec(readFileSync(config, "utf8"))
    if (main?.[1] && existsSync(join(targetRoot, main[1]))) {
      return { entrypoint: main[1], via: name }
    }
  }
  for (const candidate of ["src/index.ts", "src/index.js", "src/worker.ts", "src/worker.js"]) {
    if (existsSync(join(targetRoot, candidate))) return { entrypoint: candidate, via: "convention" }
  }
  return null
}

function init() {
  const targetRoot = resolve(String(flag("dir", ".")))
  const binding = String(flag("binding", "STOREKIT_DB"))
  const migrationsDir = String(flag("migrations-dir", "migrations"))

  const existing = detectExistingWorker(targetRoot)
  const requestedMode = flag("mode")
  if (requestedMode !== undefined && requestedMode !== "worker" && requestedMode !== "handler") {
    log(`Unknown --mode ${requestedMode}. Expected "worker" or "handler".`)
    process.exitCode = 1
    return
  }
  const mode = requestedMode ?? (existing ? "handler" : "worker")

  const mountPath = join(targetRoot, String(flag("mount", "src/storekit.ts")))
  const copied = flag("no-migrations") ? [] : copyMigrations(resolve(targetRoot, migrationsDir))

  let mountWritten = false
  if (!existsSync(mountPath)) {
    mkdirSync(dirname(mountPath), { recursive: true })
    const template = mode === "handler" ? HANDLER_SOURCE : WORKER_SOURCE
    writeFileSync(mountPath, template.replaceAll("__BINDING__", binding))
    mountWritten = true
  }

  const mountName = relative(targetRoot, mountPath) || mountPath
  const importPath = `./${mountName.replace(/^src\//, "").replace(/\.tsx?$/, "")}`

  log(`${PACKAGE_NAME} init`)
  log()
  if (existing && requestedMode === undefined) {
    log(`  detected   ${existing.entrypoint} (${existing.via}); generating a mountable handler`)
  } else if (mode === "handler") {
    log(`  mode       handler`)
  } else {
    log(`  mode       worker (no existing entrypoint found)`)
  }
  log(
    copied.length
      ? `  wrote      ${copied.map((name) => join(migrationsDir, name)).join(", ")}`
      : `  migrations already present in ${migrationsDir}/`
  )
  log(mountWritten ? `  wrote      ${mountName}` : `  kept       ${mountName} (already exists)`)
  log()
  log("Add to wrangler.jsonc:")
  log()
  log(wranglerSnippet(binding, migrationsDir))
  log()
  log("Create the database and apply the schema:")
  log()
  log(`  npx wrangler d1 create storekit`)
  log(`  npx wrangler d1 migrations apply ${binding} --local`)
  log(`  npx wrangler d1 migrations apply ${binding} --remote`)
  log()
  log("Set the App Store Connect API credentials (secrets, never vars):")
  log()
  for (const secret of [
    "APP_STORE_CONNECT_ISSUER_ID",
    "APP_STORE_CONNECT_KEY_ID",
    "APP_STORE_CONNECT_PRIVATE_KEY",
    "APPLE_ROOT_CERTIFICATES_PEM"
  ]) {
    log(`  npx wrangler secret put ${secret}`)
  }
  log()

  if (mode === "handler") {
    log(
      `Mount it in ${existing ? existing.entrypoint : "your Worker"}. \`fetch\` resolves to null for`
    )
    log(`paths this package does not own, so it composes with whatever routing you already have:`)
    log()
    log(`  import { storekit } from "${importPath}"`)
    log()
    log(`  export default {`)
    log(`    async fetch(request, env, ctx) {`)
    log(`      return (await storekit.fetch(request, env, ctx)) ?? myRoutes(request, env, ctx)`)
    log(`    }`)
    log(`  }`)
  } else {
    log(`Then point your Worker's main at ${mountName}.`)
  }
  log()
  log(`Implement authenticate() in ${mountName} — until you do, every authenticated route answers`)
  log(`401 — and set Apple's App Store Server Notifications V2 URL to`)
  log(`https://<your-worker>/storekit/notifications.`)
}

function migrations() {
  log(relative(process.cwd(), join(PACKAGE_ROOT, "migrations")))
}

switch (command) {
  case "init":
    init()
    break
  case "migrations-dir":
    migrations()
    break
  default:
    log(`${PACKAGE_NAME}

  init [--dir .] [--binding STOREKIT_DB] [--migrations-dir migrations]
       [--mount src/storekit.ts] [--mode worker|handler] [--no-migrations]
       Copy the D1 migrations, write a mount point, and print the Wrangler configuration.

       An existing Worker is detected and gets a mountable handler; a project with no
       entrypoint gets a complete Worker. Override with --mode.

  migrations-dir
       Print the path of the migration directory inside node_modules, for use as
       "migrations_dir" when you would rather not copy the file into your repository.
`)
    if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1
}

#!/usr/bin/env node
/**
 * Integration helper: everything about adopting the package that is not `npm install`.
 *
 * `init` copies the D1 migration into the host Worker, writes a mount point with the one adapter
 * the package cannot supply, and prints the exact Wrangler configuration and secret commands. It
 * never edits an existing file.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_NAME = "storekit-cloudflare-workers"
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const argv = process.argv.slice(2)
const command = argv[0] ?? "help"

function flag(name, fallback = undefined) {
  const hit = argv.find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`))
  if (!hit) return fallback
  const [, value] = hit.split("=")
  return value ?? true
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

const MOUNT_SOURCE = `import { createStoreKitWorker, type StoreKitRequestContext } from "${PACKAGE_NAME}"

/**
 * The one piece the package cannot supply.
 *
 * A StoreKit transaction proves *that a purchase happened*, never *who it belongs to*; only this
 * app knows that. Resolve the caller and return the account the entitlement binds to. Returning
 * null answers 401, which is what this stub does until it is implemented.
 *
 * Never derive identity from a client-supplied header: anyone can send one and claim another
 * customer's subscription.
 */
async function authenticate(request: Request, env: Env): Promise<StoreKitRequestContext | null> {
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
}

export default createStoreKitWorker<Env>({
  authenticate,
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

function init() {
  const targetRoot = resolve(String(flag("dir", ".")))
  const binding = String(flag("binding", "STOREKIT_DB"))
  const migrationsDir = String(flag("migrations-dir", "migrations"))
  const mountPath = join(targetRoot, String(flag("mount", "src/storekit.ts")))

  const copied = flag("no-migrations") ? [] : copyMigrations(resolve(targetRoot, migrationsDir))

  let mountWritten = false
  if (!existsSync(mountPath)) {
    mkdirSync(dirname(mountPath), { recursive: true })
    writeFileSync(mountPath, MOUNT_SOURCE.replaceAll("__BINDING__", binding))
    mountWritten = true
  }

  log(`${PACKAGE_NAME} init`)
  log()
  log(
    copied.length
      ? `  wrote      ${copied.map((name) => join(migrationsDir, name)).join(", ")}`
      : `  migrations already present in ${migrationsDir}/`
  )
  log(
    mountWritten
      ? `  wrote      ${relative(targetRoot, mountPath) || mountPath}`
      : `  kept       ${relative(targetRoot, mountPath) || mountPath} (already exists)`
  )
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
  log(`Then point your Worker's main at the file above, implement authenticate(), and set Apple's`)
  log(`App Store Server Notifications V2 URL to https://<your-worker>/storekit/notifications.`)
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
       [--mount src/storekit.ts] [--no-migrations]
       Copy the D1 migration, write a mount point, and print the Wrangler configuration.

  migrations-dir
       Print the path of the migration directory inside node_modules, for use as
       "migrations_dir" when you would rather not copy the file into your repository.
`)
    if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1
}

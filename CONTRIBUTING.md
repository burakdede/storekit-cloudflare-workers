# Contributing

Thanks for helping. This project handles other people's money, so the bar for changes is a little
higher than usual and the reasons are written down below.

## Getting set up

```bash
npm install          # Node.js 22 or newer
npm run cf:typegen   # after changing example/wrangler.jsonc
npm test
```

`npm run release:check` runs everything CI runs: format, lint, typecheck, tests, the package build,
a `npm pack` dry run, and a Worker dry-run build. Run it before opening a pull request.

`src/` is the published package, `example/` is a Worker that consumes it by its published name (a
Wrangler alias and a `tsconfig` path resolve that name to `src/` inside this repository), and
`migrations/` ships in the tarball.

You do not need Apple credentials to develop. Tests inject the verifier boundary and use a D1 fake,
so no signed material or private key is ever required.

## Rules that are not negotiable

**Never commit secrets or customer data.** No Apple private keys, no signed transactions or
notification payloads, no bearer tokens, no customer identifiers. This includes test fixtures.

**Keep `src/` self-contained.** It is published and runs inside other people's Workers. It may
import `@apple/app-store-server-library` and nothing else outside itself, and it must not reference
an ambient Cloudflare global such as `D1Database` or `ExecutionContext`: those come from a host's
generated types, and a package that leans on them fails to typecheck wherever they are absent. Use
the structural types in `src/cloudflare.ts` instead. Tests enforce both rules.

**Give every relative import a `.js` extension.** The published build is plain `tsc` output, so
`./service` would not resolve under Node ESM resolution. A test enforces it.

**Keep the policy kernel pure.** `entitlement.ts` must have no Cloudflare, Apple SDK, database, or
HTTP import. It is the piece people copy into other runtimes and test against plain objects.

**Never trust a client claim.** Entitlement may only be derived from a verified Apple signature. If
a change makes a request body, header, or query parameter influence entitlement, it is wrong.

**Ship schema changes as a new migration.** `migrations/` is published, and adopters apply it with
Wrangler either from their repository or straight out of `node_modules`. Editing an applied
migration in place breaks every existing deployment.

## Changes that need tests

Add a test before changing behaviour in any of these areas. They are the ones where a regression
silently costs someone revenue or leaks access:

- Entitlement resolution, especially billing grace period, billing retry, and trial classification.
- The out-of-order write guard and revocation handling.
- Any verification or identity check.
- Notification processing, replay, and the reconciliation path.
- Anything that decides what reaches a log or an HTTP response body.

## The two test layers

`test/unit/` runs against `MockD1Database`, which re-implements the adapter's SQL in JavaScript by
matching on statement text. That is fast and precise for policy, and it is where most tests belong.
It cannot, by construction, tell you whether the SQL is valid.

`test/integration/` runs the real statements against real SQLite (`node:sqlite`, no dependency) over
the real migrations. It is where the schema and the adapter are checked against each other:

- A column the adapter binds that no migration adds.
- An `ON CONFLICT` clause SQLite reads differently from the way the adapter assumes.
- An `ORDER BY` that does not order the way the module claims.

**If you change SQL or a migration, add an integration test.** Line coverage will not move — both
layers exercise the same lines — so the unit suite staying green is not evidence the statement works.
Removing one column from a migration currently fails eleven integration tests and zero unit tests,
which is the difference the layer exists for.

## How we stay correct against Apple's SDK

`test/unit/storekit-apple-sdk-conformance.test.ts` is the guard, because every other test stubs the
verifier boundary and so cannot notice Apple changing underneath us. It covers two kinds of drift:

- **Value drift.** The policy compares against bare literals such as `"FREE_TRIAL"`,
  `"Non-Consumable"`, offer type 1 and status 1 to 5. TypeScript cannot catch a literal that stops
  matching Apple's enum, since both sides remain strings and numbers, so each one is asserted equal
  to the SDK's own exported enum.
- **Shape drift.** Type-level assignments prove Apple's decoded payload types still satisfy our
  structural types, so a renamed or retyped field breaks `npm run typecheck`.

It also runs Apple's real `SignedDataVerifier` under `Environment.LOCAL_TESTING`, which skips
signature and chain checks but performs genuine decoding, schema validation and claim checks. If
you add a field read from an Apple payload, pin it there.

The value assertions are mutation-tested, not assumed. If you add one, confirm it fails when you
break the thing it protects; an assertion that cannot fail is worse than none, because it reads as
coverage.

CI runs on every pull request, on `main`, and weekly on a schedule so a break that lands without
anyone touching this repository still surfaces. A separate advisory job runs the conformance suite
against `@apple/app-store-server-library@latest` rather than the pinned version, so a breaking Apple
release is visible before the Dependabot PR arrives. That job is `continue-on-error` on purpose: it
must never block a pull request on Apple's release timing.

### What CI cannot tell you

CI proves this module still agrees with the Apple SDK. It does not prove the SDK still agrees with
Apple's servers. Certificate chain validation, OCSP, Apple's live API, and real notification
delivery are all outside its reach, for reasons listed in
[docs/apple-contract.md](docs/apple-contract.md#what-is-not-verified-here).

So if your change touches verification or entitlement resolution, a green suite is necessary and
not sufficient. Say in the pull request whether you exercised it in sandbox, and which paths. The
sandbox items in [docs/release-checklist.md](docs/release-checklist.md) are the list.

## Style

Prettier and ESLint are enforced; run `npm run format` to fix. Two conventions the tooling cannot
check:

- **Comments explain why, not what.** The interesting comments in this codebase document Apple
  behaviour that is surprising, such as why `expiresDate` is in the past during a grace period.
  Preserve that when you edit nearby code.
- **ASCII punctuation only.** No em dashes, curly quotes, or arrows in code or docs.

## Pull requests

Explain the behaviour change and why it is correct, ideally citing the Apple documentation it
follows. If it changes the D1 schema, say how existing rows migrate. If it changes the public
surface, update `README.md` and the relevant file in `docs/`.

## Reporting bugs

See the [bug reporting guidance in the README](README.md#reporting-a-bug). For a suspected
vulnerability, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

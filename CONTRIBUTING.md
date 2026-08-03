# Contributing

Thanks for helping. This project handles other people's money, so the bar for changes is a little
higher than usual and the reasons are written down below.

## Getting set up

```bash
npm install          # Node.js 22 or newer
npm run cf:typegen   # after changing wrangler.jsonc
npm test
```

`npm run release:check` runs everything CI runs: format, lint, typecheck, tests, and a Worker
dry-run build. Run it before opening a pull request.

You do not need Apple credentials to develop. Tests inject the verifier boundary and use a D1 fake,
so no signed material or private key is ever required.

## Rules that are not negotiable

**Never commit secrets or customer data.** No Apple private keys, no signed transactions or
notification payloads, no bearer tokens, no customer identifiers. This includes test fixtures.

**Keep `src/storekit/` self-contained.** It is vendored into other people's Workers by copying the
directory. It may import `@apple/app-store-server-library` and nothing else outside itself. A test
enforces this; if you add an import that reaches outside, the suite fails.

**Keep the policy kernel pure.** `entitlement.ts` must have no Cloudflare, Apple SDK, database, or
HTTP import. It is the piece people copy into other runtimes and test against plain objects.

**Never trust a client claim.** Entitlement may only be derived from a verified Apple signature. If
a change makes a request body, header, or query parameter influence entitlement, it is wrong.

**Keep the two schema copies in sync.** `migrations/0001_storekit.sql` and
`src/storekit/schema.sql` must stay byte-identical below their headers, because different adopters
apply different ones. A test enforces this.

## Changes that need tests

Add a test before changing behaviour in any of these areas. They are the ones where a regression
silently costs someone revenue or leaks access:

- Entitlement resolution, especially billing grace period, billing retry, and trial classification.
- The out-of-order write guard and revocation handling.
- Any verification or identity check.
- Notification processing, replay, and the reconciliation path.
- Anything that decides what reaches a log or an HTTP response body.

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

CI runs on every pull request, on `main`, and weekly on a schedule so a break that lands without
anyone touching this repository still surfaces. A separate advisory job runs the conformance suite
against `@apple/app-store-server-library@latest` rather than the pinned version, so a breaking Apple
release is visible before the Dependabot PR arrives. That job is `continue-on-error` on purpose: it
must never block a pull request on Apple's release timing.

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

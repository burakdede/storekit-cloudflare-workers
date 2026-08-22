# Example Worker

A deployable Worker that uses the package exactly as an adopter does: `src/worker.ts` is the whole
integration, and `src/auth.ts` is the one adapter the package cannot supply.

```bash
npm run dev      # wrangler dev -c example/wrangler.jsonc
npm run deploy
```

Inside this repository the package name resolves to `../src` through a Wrangler `alias` and a
`tsconfig` path, so the import lines here are the ones you write after `npm install`. Copying this
directory into your own project therefore needs no edits beyond
`npm install storekit-cloudflare-workers`, your own `wrangler.jsonc` values, and a real
`authenticate`.

The D1 binding, product allow-list, bundle ID and policy flags in `wrangler.jsonc` are placeholders.
`APP_STORE_APP_APPLE_ID` is required whenever `Production` is allowed.

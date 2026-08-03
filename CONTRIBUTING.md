# Contributing

1. Use Node.js 22 or newer.
2. Run `npm install` and `npm run cf:typegen` after changing Wrangler configuration.
3. Keep the policy core free of runtime, HTTP, Apple SDK, and D1 imports.
4. Add tests for security boundaries and notification variants before changing behavior.
5. Run `npm run release:check` before opening a pull request.
6. Never commit Apple keys, signed production transactions, or customer identifiers.

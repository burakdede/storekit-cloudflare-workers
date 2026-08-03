# Release checklist

- [ ] Replace the placeholder repository URL in `README.md`.
- [ ] Review Apple contract links and the pinned Apple server-library version.
- [ ] Confirm the compatibility date and Wrangler version are current for the release.
- [ ] Run `npm ci`, `npm run cf:typegen`, and `npm run release:check`.
- [ ] Confirm no secrets, signed production transactions, or customer identifiers are tracked.
- [ ] Configure separate production and sandbox Worker/D1 environments.
- [ ] Implement and review `src/auth.ts` before deployment.
- [ ] Apply the migration to a disposable D1 database and inspect all indexes.
- [ ] Configure App Store Server Notifications V2 and send Apple’s test notification.
- [ ] Document the first production deployment and reconciliation owner.

-- Revocation detail: Apple's status 5 conflates a refund with Family Sharing ending, and
-- `revocationType` is what separates them.
--
-- REFUND_FULL and REFUND_PRORATED mean money moved; FAMILY_REVOKE means the organiser turned
-- Family Sharing off and nobody was refunded. All three end access to the transaction, so this
-- changes what is reported rather than who has access. `revocation_percentage` is in milliunits.
--
-- Existing rows keep NULL, which is read as "an unspecified revocation" and continues to report
-- `refunded`, exactly as before this migration.

ALTER TABLE storekit_subscriptions ADD COLUMN revocation_type TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN revocation_percentage INTEGER;
ALTER TABLE storekit_transactions ADD COLUMN revocation_type TEXT;
ALTER TABLE storekit_transactions ADD COLUMN revocation_percentage INTEGER;

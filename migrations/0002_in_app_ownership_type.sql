-- Family Sharing: record whether Apple says the customer bought the purchase or received it
-- through Family Sharing.
--
-- Apple sets `inAppOwnershipType` to `PURCHASED` or `FAMILY_SHARED` on every transaction. Existing
-- rows keep NULL, which the policy reads as "not family shared": defaulting the other way would
-- exclude every entitlement recorded before this migration.

ALTER TABLE storekit_subscriptions ADD COLUMN in_app_ownership_type TEXT;
ALTER TABLE storekit_transactions ADD COLUMN in_app_ownership_type TEXT;

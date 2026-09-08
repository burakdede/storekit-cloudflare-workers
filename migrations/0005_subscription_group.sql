-- Subscription groups.
--
-- Apple allows at most one active subscription per group, so a group is the unit an entitlement is
-- resolved within. Two groups — "Pro" and "Extra Storage", say — are concurrent entitlements rather
-- than competing ones, and a customer can hold both at once.
--
-- Existing rows keep NULL, which is read as "ungrouped" and resolved per product, matching how a
-- non-consumable behaves.

ALTER TABLE storekit_subscriptions ADD COLUMN subscription_group_identifier TEXT;
ALTER TABLE storekit_transactions ADD COLUMN subscription_group_identifier TEXT;

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_group
  ON storekit_subscriptions (installation_id, subscription_group_identifier);

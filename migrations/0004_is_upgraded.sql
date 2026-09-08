-- Upgrades: Apple sets `isUpgraded` on the subscription it cancelled to move a customer onto
-- another one.
--
-- A superseded transaction must never be read as the live entitlement, or the projection reports
-- the product the customer upgraded away from. Existing rows default to 0, which is correct for
-- every transaction that was not superseded and is the safe reading for any that was: the
-- replacement outranks it on the next sync or notification either way.

ALTER TABLE storekit_subscriptions ADD COLUMN is_upgraded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storekit_transactions ADD COLUMN is_upgraded INTEGER NOT NULL DEFAULT 0;

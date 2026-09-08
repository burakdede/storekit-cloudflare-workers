-- Commerce and renewal metadata Apple signs but the projection was discarding.
--
-- None of it is needed to gate access, which is why it was reasonable to leave out. All of it is
-- needed to build the screens and reports around access:
--
--   renewal_date        what a UI shows. Not derivable from expires_at, which during a billing
--                       grace period is already in the past -- exactly when a customer looks.
--   price               the only signed revenue figure available without a separate report.
--                       IN MILLIUNITS: 9990 is 9.99.
--   transaction_reason  PURCHASE vs RENEWAL, i.e. new subscriber vs retained subscriber.
--   offer_type          1 introductory, 2 promotional, 3 offer code, 4 win-back.
--   offer_identifier    which specific offer, for attributing a conversion to it.
--   storefront          country, which drives tax, pricing and content availability.
--   eligible_win_back_offer_ids
--                       JSON array; without it win-back offers are unreachable from the server.
--
-- Renewal-derived columns live on the subscription projection only: the transaction table is an
-- audit trail of what Apple signed per transaction, and renewal state is not per transaction.

ALTER TABLE storekit_subscriptions ADD COLUMN offer_type INTEGER;
ALTER TABLE storekit_subscriptions ADD COLUMN offer_identifier TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN offer_period TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN price INTEGER;
ALTER TABLE storekit_subscriptions ADD COLUMN storefront TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN storefront_id TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN transaction_reason TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN quantity INTEGER;
ALTER TABLE storekit_subscriptions ADD COLUMN original_purchase_date TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN app_transaction_id TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN renewal_date TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN recent_subscription_start_date TEXT;
ALTER TABLE storekit_subscriptions ADD COLUMN eligible_win_back_offer_ids TEXT;

ALTER TABLE storekit_transactions ADD COLUMN offer_type INTEGER;
ALTER TABLE storekit_transactions ADD COLUMN offer_identifier TEXT;
ALTER TABLE storekit_transactions ADD COLUMN offer_period TEXT;
ALTER TABLE storekit_transactions ADD COLUMN price INTEGER;
ALTER TABLE storekit_transactions ADD COLUMN storefront TEXT;
ALTER TABLE storekit_transactions ADD COLUMN storefront_id TEXT;
ALTER TABLE storekit_transactions ADD COLUMN transaction_reason TEXT;
ALTER TABLE storekit_transactions ADD COLUMN quantity INTEGER;
ALTER TABLE storekit_transactions ADD COLUMN original_purchase_date TEXT;
ALTER TABLE storekit_transactions ADD COLUMN app_transaction_id TEXT;

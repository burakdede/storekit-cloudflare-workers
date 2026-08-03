-- D1 schema for the drop-in StoreKit 2 module.
--
-- Apply it directly when vendoring the module into an existing Worker:
--   npx wrangler d1 execute <DB_NAME> --remote --file=src/storekit/schema.sql
--
-- This repository also ships it as migrations/0001_storekit.sql for Wrangler's migration
-- workflow. The two files are byte-identical below this header.

-- Current entitlement projection: one row per subscription (or per non-consumable purchase).
CREATE TABLE IF NOT EXISTS storekit_subscriptions (
  original_transaction_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  -- The account the entitlement is bound to. Only an authenticated sync may set this; the Apple
  -- notification webhook never binds an entitlement to an account.
  installation_id TEXT,
  app_account_token TEXT,
  latest_transaction_id TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  -- The subscription's own expiry. Already elapsed during a billing grace period.
  expires_at TEXT,
  -- When access actually lapses. NULL for a perpetual purchase. Judge active access against this.
  access_expires_at TEXT,
  perpetual INTEGER NOT NULL DEFAULT 0,
  grace_period_expires_at TEXT,
  is_trial INTEGER NOT NULL,
  revocation_date TEXT,
  revocation_reason INTEGER,
  product_type TEXT,
  offer_discount_type TEXT,
  -- Apple's signing time for the material behind this row; drives the out-of-order write guard.
  latest_signed_date TEXT,
  auto_renew_status INTEGER,
  auto_renew_product_id TEXT,
  expiration_intent INTEGER,
  is_in_billing_retry INTEGER,
  price_increase_status INTEGER,
  renewal_price INTEGER,
  currency TEXT,
  last_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (original_transaction_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_installation_id
  ON storekit_subscriptions (installation_id);

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_latest_transaction_id
  ON storekit_subscriptions (latest_transaction_id);

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_status
  ON storekit_subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_expires_at
  ON storekit_subscriptions (expires_at);

CREATE INDEX IF NOT EXISTS idx_storekit_subscriptions_access_expires_at
  ON storekit_subscriptions (access_expires_at);

-- Append-mostly audit projection: one row per transaction Apple has signed.
CREATE TABLE IF NOT EXISTS storekit_transactions (
  transaction_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  web_order_line_item_id TEXT,
  installation_id TEXT,
  app_account_token TEXT,
  app_bundle_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  purchase_date TEXT,
  expires_at TEXT,
  access_expires_at TEXT,
  perpetual INTEGER NOT NULL DEFAULT 0,
  revocation_date TEXT,
  revocation_reason INTEGER,
  status TEXT NOT NULL,
  pro_active INTEGER NOT NULL,
  source TEXT NOT NULL,
  product_type TEXT,
  offer_discount_type TEXT,
  latest_signed_date TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (transaction_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_storekit_transactions_original_transaction_id
  ON storekit_transactions (original_transaction_id, environment);

CREATE INDEX IF NOT EXISTS idx_storekit_transactions_installation_id
  ON storekit_transactions (installation_id);

CREATE INDEX IF NOT EXISTS idx_storekit_transactions_status
  ON storekit_transactions (status);

CREATE INDEX IF NOT EXISTS idx_storekit_transactions_expires_at
  ON storekit_transactions (expires_at);

-- Replay ledger. Apple redelivers notifications, so the UUID is the idempotency key.
CREATE TABLE IF NOT EXISTS storekit_notifications (
  notification_uuid TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  environment TEXT NOT NULL,
  original_transaction_id TEXT,
  transaction_id TEXT,
  processed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storekit_notifications_original_transaction_id
  ON storekit_notifications (original_transaction_id);

CREATE INDEX IF NOT EXISTS idx_storekit_notifications_transaction_id
  ON storekit_notifications (transaction_id);

CREATE INDEX IF NOT EXISTS idx_storekit_notifications_created_at
  ON storekit_notifications (created_at);

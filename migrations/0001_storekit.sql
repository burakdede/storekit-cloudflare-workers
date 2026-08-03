-- Initial StoreKit D1 schema for cf-worker-storekit2.
-- Apply this file through Wrangler's D1 migration commands.

CREATE TABLE IF NOT EXISTS storekit_subscriptions (
  original_transaction_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT,
  app_account_token TEXT,
  latest_transaction_id TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  is_trial INTEGER NOT NULL,
  revocation_date TEXT,
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
  revocation_date TEXT,
  status TEXT NOT NULL,
  pro_active INTEGER NOT NULL,
  source TEXT NOT NULL,
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

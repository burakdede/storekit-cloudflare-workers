export class MockD1Database {
  private readonly transactions: Record<string, unknown>[] = []
  private readonly subscriptions: Record<string, unknown>[] = []
  private readonly notifications: Record<string, unknown>[] = []
  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(this, sql)
  }
  async batch(statements: MockD1Statement[]): Promise<unknown[]> {
    for (const statement of statements) await statement.run()
    return statements.map(() => ({ success: true }))
  }
  getStoreKitTransactionRows() {
    return this.transactions
  }
  getStoreKitSubscriptionRows() {
    return this.subscriptions
  }
  getStoreKitNotificationRows() {
    return this.notifications
  }
  insertTransaction(b: unknown[]): void {
    const row = {
      transaction_id: String(b[0]),
      environment: String(b[1]),
      original_transaction_id: String(b[2]),
      web_order_line_item_id: b[3],
      installation_id: b[4],
      app_account_token: b[5],
      app_bundle_id: b[6],
      product_id: b[7],
      purchase_date: b[8],
      expires_at: b[9],
      revocation_date: b[10],
      status: b[11],
      pro_active: b[12],
      source: b[13],
      first_seen_at: b[14],
      last_seen_at: b[15]
    }
    const i = this.transactions.findIndex(
      (x) =>
        x.transaction_id === row.transaction_id &&
        x.environment === row.environment
    )
    if (i < 0) this.transactions.push(row)
    else this.transactions[i] = { ...this.transactions[i], ...row }
  }
  insertSubscription(b: unknown[]): void {
    const row = {
      original_transaction_id: String(b[0]),
      environment: String(b[1]),
      installation_id: b[2],
      app_account_token: b[3],
      latest_transaction_id: String(b[4]),
      app_bundle_id: b[5],
      product_id: b[6],
      status: b[7],
      expires_at: b[8],
      is_trial: b[9],
      revocation_date: b[10],
      last_verified_at: b[11],
      created_at: b[12],
      updated_at: b[13]
    }
    const i = this.subscriptions.findIndex(
      (x) =>
        x.original_transaction_id === row.original_transaction_id &&
        x.environment === row.environment
    )
    if (i < 0) this.subscriptions.push(row)
    else this.subscriptions[i] = { ...this.subscriptions[i], ...row }
  }
  insertNotification(b: unknown[]): void {
    if (this.notifications.some((x) => x.notification_uuid === b[0])) return
    this.notifications.push({
      notification_uuid: b[0],
      notification_type: b[1],
      subtype: b[2],
      environment: b[3],
      original_transaction_id: b[4],
      transaction_id: b[5],
      processed_at: b[6],
      created_at: b[7]
    })
  }
}

export class MockD1Statement {
  private bindings: unknown[] = []
  constructor(
    private readonly db: MockD1Database,
    private readonly sql: string
  ) {}
  bind(...bindings: unknown[]): MockD1Statement {
    this.bindings = bindings
    return this
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM storekit_notifications")) {
      const row = this.db
        .getStoreKitNotificationRows()
        .find((x) => x.notification_uuid === this.bindings[0])
      return (
        row ? { notificationUuid: row.notification_uuid } : null
      ) as T | null
    }
    if (this.sql.includes("FROM storekit_subscriptions")) {
      const [installationId, ...rest] = this.bindings
      const environments = rest.slice(0, -1).map(String)
      const rows = this.db
        .getStoreKitSubscriptionRows()
        .filter(
          (x) =>
            x.installation_id === installationId &&
            environments.includes(String(x.environment))
        )
      rows.sort((a, b) =>
        String(b.expires_at).localeCompare(String(a.expires_at))
      )
      const row = rows[0]
      return (
        row
          ? {
              originalTransactionId: row.original_transaction_id,
              environment: row.environment,
              installationId: row.installation_id,
              appAccountToken: row.app_account_token,
              latestTransactionId: row.latest_transaction_id,
              productId: row.product_id,
              status: row.status,
              expiresAt: row.expires_at,
              isTrial: row.is_trial,
              revocationDate: row.revocation_date,
              lastVerifiedAt: row.last_verified_at
            }
          : null
      ) as T | null
    }
    return null
  }
  async run(): Promise<{ success: true }> {
    if (this.sql.includes("INSERT OR IGNORE INTO storekit_notifications"))
      this.db.insertNotification(this.bindings)
    else if (this.sql.includes("INSERT INTO storekit_transactions"))
      this.db.insertTransaction(this.bindings)
    else if (this.sql.includes("INSERT INTO storekit_subscriptions"))
      this.db.insertSubscription(this.bindings)
    return { success: true }
  }
}

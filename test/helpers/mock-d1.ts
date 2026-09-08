type MobileSessionRow = {
  session_id: string
  installation_id: string
  platform: "ios"
  app_bundle_id: string
  app_version: string
  build_number: string
  tier: "free" | "pro"
  refresh_token_hash: string
  refresh_token_expires_at: string
  created_at: string
  last_refreshed_at: string
  revoked_at: string | null
}

type MobileEntitlementRow = {
  app_transaction_hash: string
  app_transaction_id: string
  installation_id: string | null
  app_store_environment: "sandbox" | "production"
  app_bundle_id: string
  trial_policy_version: string
  trial_duration_days: number
  trial_started_at: string
  trial_ends_at: string
  trial_consumed: number
  first_seen_at: string
  last_seen_at: string
  latest_entitlement_tier: "trial" | "expired" | "pro"
  latest_subscription_status: "none" | "active"
  last_sync_at: string
}

type MobileRateLimitRow = {
  bucket_key: string
  count: number
  expires_at: string
}

type MobileAppAttestChallengeRow = {
  challenge_id: string
  installation_id: string
  app_bundle_id: string
  app_version: string
  build_number: string
  challenge_hash: string
  expires_at: string
  consumed_at: string | null
  created_at: string
}

type MobileAppAttestKeyRow = {
  key_id: string
  installation_id: string
  app_bundle_id: string
  public_key_pem: string
  receipt_base64: string
  sign_count: number
  attested_at: string
  last_seen_at: string
  revoked_at: string | null
}

type StoreKitSubscriptionRow = {
  original_transaction_id: string
  environment: string
  installation_id: string | null
  app_account_token: string | null
  in_app_ownership_type: string | null
  latest_transaction_id: string
  app_bundle_id: string
  product_id: string
  status: string
  expires_at: string | null
  access_expires_at: string | null
  perpetual: number
  grace_period_expires_at: string | null
  is_trial: number
  revocation_date: string | null
  revocation_reason: number | null
  revocation_type: string | null
  revocation_percentage: number | null
  is_upgraded: number
  product_type: string | null
  offer_discount_type: string | null
  latest_signed_date: string | null
  auto_renew_status: number | null
  auto_renew_product_id: string | null
  expiration_intent: number | null
  is_in_billing_retry: number | null
  price_increase_status: number | null
  renewal_price: number | null
  currency: string | null
  last_verified_at: string
  created_at: string
  updated_at: string
}

type StoreKitNotificationRow = {
  notification_uuid: string
  notification_type: string
  subtype: string | null
  environment: string
  original_transaction_id: string | null
  transaction_id: string | null
  processed_at: string
  created_at: string
}

type StoreKitTransactionRow = {
  transaction_id: string
  environment: string
  original_transaction_id: string
  web_order_line_item_id: string | null
  installation_id: string | null
  app_account_token: string | null
  in_app_ownership_type: string | null
  app_bundle_id: string
  product_id: string
  purchase_date: string | null
  expires_at: string | null
  access_expires_at: string | null
  perpetual: number
  revocation_date: string | null
  revocation_reason: number | null
  revocation_type: string | null
  revocation_percentage: number | null
  is_upgraded: number
  status: string
  pro_active: number
  source: string
  product_type: string | null
  offer_discount_type: string | null
  latest_signed_date: string | null
  first_seen_at: string
  last_seen_at: string
}

type RouteLeaseRow = {
  route_key: string
  lease_id: string
  expires_at: string
  created_at: string
}

type RoutePopularityRow = {
  hour_bucket: string
  route_key: string
  from_city_id: number
  from_city_name: string
  from_district_id: number
  from_district_name: string
  to_city_id: number
  to_city_name: string
  to_district_id: number
  to_district_name: string
  count: number
  first_seen_at: string
  last_seen_at: string
}

function countSqlPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length
}

class MockPreparedStatement {
  private bindings: unknown[] = []
  private readonly db: MockD1Database
  private readonly sql: string

  constructor(db: MockD1Database, sql: string) {
    this.db = db
    this.sql = sql
  }

  bind(...bindings: unknown[]) {
    this.bindings = bindings
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.bindings)
  }

  async run(): Promise<{ success: true }> {
    await this.db.run(this.sql, this.bindings)
    return { success: true }
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.bindings)
  }

  getSql(): string {
    return this.sql
  }

  getBindings(): unknown[] {
    return [...this.bindings]
  }
}

export class MockD1Database {
  private readonly mobileSessions = new Map<string, MobileSessionRow>()
  private readonly mobileSessionsByRefreshHash = new Map<string, string>()
  private readonly mobileEntitlements = new Map<string, MobileEntitlementRow>()
  private readonly mobileRateLimits = new Map<string, MobileRateLimitRow>()
  private readonly mobileAppAttestChallenges = new Map<string, MobileAppAttestChallengeRow>()
  private readonly mobileAppAttestKeys = new Map<string, MobileAppAttestKeyRow>()
  private readonly storeKitSubscriptions = new Map<string, StoreKitSubscriptionRow>()
  private readonly storeKitNotifications = new Map<string, StoreKitNotificationRow>()
  private readonly storeKitTransactions = new Map<string, StoreKitTransactionRow>()
  private readonly routeLeases = new Map<string, RouteLeaseRow>()
  private readonly routePopularityRows = new Map<string, RoutePopularityRow>()

  prepare(sql: string): MockPreparedStatement {
    return new MockPreparedStatement(this, sql)
  }

  async batch<T = unknown>(statements: MockPreparedStatement[]): Promise<Array<{ results: T[] }>> {
    const results: Array<{ results: T[] }> = []
    for (const statement of statements) {
      await this.run(statement.getSql(), statement.getBindings())
      results.push({ results: [] as T[] })
    }
    return results
  }

  seedMobileEntitlement(row: MobileEntitlementRow): void {
    this.mobileEntitlements.set(
      this.entitlementKey(row.app_transaction_hash, row.app_store_environment, row.app_bundle_id),
      row
    )
  }

  /**
   * Seed a subscription projection. Columns added after the original schema default the way
   * migration 0009 backfills them, so existing seeds keep describing the same state.
   */
  seedStoreKitSubscription(
    row: Omit<
      StoreKitSubscriptionRow,
      | "in_app_ownership_type"
      | "access_expires_at"
      | "perpetual"
      | "grace_period_expires_at"
      | "revocation_reason"
      | "revocation_type"
      | "revocation_percentage"
      | "is_upgraded"
      | "product_type"
      | "offer_discount_type"
      | "latest_signed_date"
      | "auto_renew_status"
      | "auto_renew_product_id"
      | "expiration_intent"
      | "is_in_billing_retry"
      | "price_increase_status"
      | "renewal_price"
      | "currency"
    > &
      Partial<StoreKitSubscriptionRow>
  ): void {
    const seeded: StoreKitSubscriptionRow = {
      in_app_ownership_type: null,
      access_expires_at: row.expires_at,
      perpetual: 0,
      grace_period_expires_at: null,
      revocation_reason: null,
      revocation_type: null,
      revocation_percentage: null,
      is_upgraded: 0,
      product_type: null,
      offer_discount_type: null,
      latest_signed_date: null,
      auto_renew_status: null,
      auto_renew_product_id: null,
      expiration_intent: null,
      is_in_billing_retry: null,
      price_increase_status: null,
      renewal_price: null,
      currency: null,
      ...row
    }
    this.storeKitSubscriptions.set(
      this.storeKitSubscriptionKey(seeded.original_transaction_id, seeded.environment),
      seeded
    )
  }

  getStoreKitSubscriptionRows(): StoreKitSubscriptionRow[] {
    return Array.from(this.storeKitSubscriptions.values())
  }

  getMobileEntitlementRows(): MobileEntitlementRow[] {
    return Array.from(this.mobileEntitlements.values())
  }

  getMobileAppAttestChallengeRows(): MobileAppAttestChallengeRow[] {
    return Array.from(this.mobileAppAttestChallenges.values())
  }

  getMobileAppAttestKeyRows(): MobileAppAttestKeyRow[] {
    return Array.from(this.mobileAppAttestKeys.values())
  }

  seedMobileAppAttestChallenge(row: MobileAppAttestChallengeRow): void {
    this.mobileAppAttestChallenges.set(row.challenge_id, row)
  }

  getStoreKitNotificationRows(): StoreKitNotificationRow[] {
    return Array.from(this.storeKitNotifications.values())
  }

  getStoreKitTransactionRows(): StoreKitTransactionRow[] {
    return Array.from(this.storeKitTransactions.values())
  }

  /** Seeds an already-attested key so tests can exercise revocation and installation binding. */
  seedAppAttestKey(row: Partial<MobileAppAttestKeyRow> & { key_id: string }): void {
    this.mobileAppAttestKeys.set(row.key_id, {
      installation_id: "seeded-installation",
      app_bundle_id: "com.example.app",
      public_key_pem: "seeded-public-key",
      receipt_base64: "seeded-receipt",
      sign_count: 0,
      attested_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
      ...row
    })
  }

  getRoutePopularityRows(): RoutePopularityRow[] {
    return Array.from(this.routePopularityRows.values())
  }

  seedRouteLease(routeKey: string, expiresAt: string, leaseId = "seeded-lease"): void {
    this.routeLeases.set(routeKey, {
      route_key: routeKey,
      lease_id: leaseId,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    })
  }

  private entitlementKey(hash: string, environment: string, bundleId: string): string {
    return `${hash}:${environment}:${bundleId}`
  }

  /**
   * Zip an INSERT's column list with its bindings.
   *
   * The StoreKit upserts are wide and grow a column whenever Apple's contract does. Reading them
   * positionally means renumbering every index by hand on each change, where an off-by-one
   * silently asserts the wrong column rather than failing. Parsing the column names out of the
   * statement keeps the mock honest for free.
   */
  private insertedColumns(sql: string, bindings: unknown[]): Record<string, unknown> {
    const columnList = /INSERT(?: OR IGNORE)? INTO \w+\s*\(([^)]*)\)/.exec(sql)?.[1]
    if (!columnList) throw new Error(`Could not read column list from SQL: ${sql}`)
    const columns = columnList
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
    if (columns.length !== bindings.length) {
      throw new Error(
        `Column/binding mismatch. columns=${columns.length} bindings=${bindings.length}`
      )
    }
    return Object.fromEntries(columns.map((column, index) => [column, bindings[index]]))
  }

  /**
   * Mirror the production upsert's account-binding rule, which the SQL selects between.
   *
   * Sticky (the default) keeps whichever account bound the row first. Transfer lets an incoming
   * non-null account replace it. Hard-coding either one here would let a binding regression pass.
   */
  private resolveInstallationBinding(
    sql: string,
    table: string,
    incoming: string | null,
    existing: string | null | undefined
  ): string | null {
    const sticky = sql.includes(`COALESCE(${table}.installation_id, excluded.installation_id)`)
    return sticky ? (existing ?? incoming ?? null) : (incoming ?? existing ?? null)
  }

  private storeKitSubscriptionKey(originalTransactionId: string, environment: string): string {
    return `${originalTransactionId}:${environment}`
  }

  private storeKitTransactionKey(transactionId: string, environment: string): string {
    return `${transactionId}:${environment}`
  }

  /**
   * Mirrors the real upsert guard: a write only lands when it is at least as recently signed as
   * the stored row, except for revocations, which are terminal and always apply.
   */
  private storeKitWriteWins(
    revocationDate: string | null,
    latestSignedDate: string | null,
    existing: { latest_signed_date: string | null }
  ): boolean {
    if (revocationDate !== null) return true
    return (latestSignedDate ?? "") >= (existing.latest_signed_date ?? "")
  }

  private storeKitRowActive(row: StoreKitSubscriptionRow, resolvedAt: string): boolean {
    if (
      row.status !== "active_trial" &&
      row.status !== "active_paid" &&
      row.status !== "grace_period"
    ) {
      return false
    }
    if (row.perpetual === 1) return true
    return Boolean(row.access_expires_at && row.access_expires_at > resolvedAt)
  }

  private selectStoreKitSubscriptionByInstallation(
    installationId: string,
    readableEnvironments: string[],
    resolvedAt: string
  ): StoreKitSubscriptionRow | null {
    return (
      Array.from(this.storeKitSubscriptions.values())
        .filter(
          (candidate) =>
            candidate.installation_id === installationId &&
            readableEnvironments.includes(candidate.environment)
        )
        .sort((left, right) => {
          const leftRank = this.storeKitRowActive(left, resolvedAt) ? 0 : 1
          const rightRank = this.storeKitRowActive(right, resolvedAt) ? 0 : 1
          return (
            leftRank - rightRank ||
            (left.environment === "Production" ? 0 : 1) -
              (right.environment === "Production" ? 0 : 1) ||
            right.perpetual - left.perpetual ||
            (right.access_expires_at ?? "").localeCompare(left.access_expires_at ?? "") ||
            right.last_verified_at.localeCompare(left.last_verified_at) ||
            right.latest_transaction_id.localeCompare(left.latest_transaction_id)
          )
        })[0] ?? null
    )
  }

  private selectInstallationEntitlement(
    installationId: string,
    bundleId: string
  ): MobileEntitlementRow | null {
    return (
      Array.from(this.mobileEntitlements.values())
        .filter(
          (candidate) =>
            candidate.installation_id === installationId && candidate.app_bundle_id === bundleId
        )
        .sort((left, right) => {
          const leftRank =
            left.latest_entitlement_tier === "pro" && left.latest_subscription_status === "active"
              ? 0
              : 1
          const rightRank =
            right.latest_entitlement_tier === "pro" && right.latest_subscription_status === "active"
              ? 0
              : 1
          return leftRank - rightRank || left.first_seen_at.localeCompare(right.first_seen_at)
        })[0] ?? null
    )
  }

  async first<T>(sql: string, bindings: unknown[]): Promise<T | null> {
    if (sql.includes("UPDATE mobile_app_attest_challenges")) {
      const consumedAt = String(bindings[0])
      const challengeId = String(bindings[1])
      const now = String(bindings[2])
      const row = this.mobileAppAttestChallenges.get(challengeId)
      if (!row) return null
      if (row.consumed_at) return null
      if (row.expires_at <= now) return null
      row.consumed_at = consumedAt
      return { challengeId } as T
    }
    if (sql.includes("FROM mobile_sessions") && sql.includes("WHERE session_id = ?")) {
      const row = this.mobileSessions.get(String(bindings[0]))
      return (row ? this.sessionResult(row) : null) as T | null
    }
    if (sql.includes("FROM mobile_sessions") && sql.includes("WHERE refresh_token_hash = ?")) {
      const sessionId = this.mobileSessionsByRefreshHash.get(String(bindings[0]))
      const row = sessionId ? this.mobileSessions.get(sessionId) : null
      return (row ? this.sessionResult(row) : null) as T | null
    }
    if (sql.includes("FROM mobile_entitlements")) {
      const row = sql.includes("WHERE installation_id = ?")
        ? this.selectInstallationEntitlement(String(bindings[0]), String(bindings[1]))
        : this.mobileEntitlements.get(
            this.entitlementKey(String(bindings[0]), String(bindings[1]), String(bindings[2]))
          )
      return (row ? this.entitlementResult(row) : null) as T | null
    }
    if (sql.includes("FROM mobile_rate_limits")) {
      const row = this.mobileRateLimits.get(String(bindings[0]))
      if (!row) return null
      return { count: row.count, expiresAt: row.expires_at } as T
    }
    if (sql.includes("FROM mobile_app_attest_challenges")) {
      const row = this.mobileAppAttestChallenges.get(String(bindings[0]))
      return (row ? this.appAttestChallengeResult(row) : null) as T | null
    }

    if (sql.includes("FROM mobile_app_attest_keys")) {
      const row = this.mobileAppAttestKeys.get(String(bindings[0]))
      return (row ? this.appAttestKeyResult(row) : null) as T | null
    }
    if (sql.includes("WHERE original_transaction_id = ? AND environment = ?")) {
      const row = this.storeKitSubscriptions.get(
        this.storeKitSubscriptionKey(String(bindings[0]), String(bindings[1]))
      )
      return (row ? { installationId: row.installation_id } : null) as T | null
    }
    if (sql.includes("FROM storekit_subscriptions")) {
      const row = sql.includes("WHERE installation_id = ?")
        ? this.selectStoreKitSubscriptionByInstallation(
            String(bindings[0]),
            bindings.slice(1, -1).map(String),
            String(bindings[bindings.length - 1])
          )
        : this.storeKitSubscriptions.get(String(bindings[0]))
      return (row ? this.storeKitSubscriptionResult(row) : null) as T | null
    }
    if (sql.includes("FROM storekit_notifications")) {
      const row = this.storeKitNotifications.get(String(bindings[0]))
      return (row ? this.storeKitNotificationResult(row) : null) as T | null
    }
    if (sql.includes("FROM route_inflight_locks")) {
      const row = this.routeLeases.get(String(bindings[0]))
      if (!row) return null
      return { leaseId: row.lease_id, expiresAt: row.expires_at } as T
    }
    if (sql.includes("FROM route_popularity_hourly")) {
      const rows = this.selectRoutePopularityRows(
        String(bindings[0]),
        String(bindings[1]),
        Number(bindings[2])
      )
      return (rows.length > 0 ? rows[0] : null) as T | null
    }

    throw new Error(`Unsupported first() SQL in MockD1Database: ${sql}`)
  }

  async all<T>(sql: string, bindings: unknown[]): Promise<{ results: T[] }> {
    const placeholderCount = countSqlPlaceholders(sql)
    if (placeholderCount !== bindings.length) {
      throw new Error(
        `Binding count mismatch for SQL. expected=${placeholderCount} actual=${bindings.length}`
      )
    }

    if (sql.includes("FROM route_popularity_hourly")) {
      return {
        results: this.selectRoutePopularityRows(
          String(bindings[0]),
          String(bindings[1]),
          Number(bindings[2])
        ) as T[]
      }
    }

    throw new Error(`Unsupported all() SQL in MockD1Database: ${sql}`)
  }

  async run(sql: string, bindings: unknown[]): Promise<void> {
    const placeholderCount = countSqlPlaceholders(sql)
    if (placeholderCount !== bindings.length) {
      throw new Error(
        `Binding count mismatch for SQL. expected=${placeholderCount} actual=${bindings.length}`
      )
    }

    if (sql.includes("INSERT INTO mobile_sessions")) {
      const row: MobileSessionRow = {
        session_id: String(bindings[0]),
        installation_id: String(bindings[1]),
        platform: bindings[2] as "ios",
        app_bundle_id: String(bindings[3]),
        app_version: String(bindings[4]),
        build_number: String(bindings[5]),
        tier: bindings[6] as "free" | "pro",
        refresh_token_hash: String(bindings[7]),
        refresh_token_expires_at: String(bindings[8]),
        created_at: String(bindings[9]),
        last_refreshed_at: String(bindings[10]),
        revoked_at: (bindings[11] as string | null) ?? null
      }
      this.mobileSessions.set(row.session_id, row)
      this.mobileSessionsByRefreshHash.set(row.refresh_token_hash, row.session_id)
      return
    }

    if (sql.includes("UPDATE mobile_sessions")) {
      const session = this.mobileSessions.get(String(bindings[3]))
      if (!session) return
      if (session.refresh_token_hash !== String(bindings[4])) return
      if (session.revoked_at) return
      this.mobileSessionsByRefreshHash.delete(session.refresh_token_hash)
      session.refresh_token_hash = String(bindings[0])
      session.refresh_token_expires_at = String(bindings[1])
      session.last_refreshed_at = String(bindings[2])
      this.mobileSessionsByRefreshHash.set(session.refresh_token_hash, session.session_id)
      return
    }

    if (sql.includes("INSERT OR IGNORE INTO mobile_entitlements")) {
      const installationId = (bindings[2] as string | null) ?? null
      const bundleId = String(bindings[4])
      if (
        installationId &&
        Array.from(this.mobileEntitlements.values()).some(
          (row) => row.installation_id === installationId && row.app_bundle_id === bundleId
        )
      ) {
        return
      }
      const key = this.entitlementKey(String(bindings[0]), String(bindings[3]), bundleId)
      if (this.mobileEntitlements.has(key)) return
      this.mobileEntitlements.set(key, {
        app_transaction_hash: String(bindings[0]),
        app_transaction_id: String(bindings[1]),
        installation_id: installationId,
        app_store_environment: bindings[3] as "sandbox" | "production",
        app_bundle_id: bundleId,
        trial_policy_version: String(bindings[5]),
        trial_duration_days: Number(bindings[6]),
        trial_started_at: String(bindings[7]),
        trial_ends_at: String(bindings[8]),
        trial_consumed: Number(bindings[9]),
        first_seen_at: String(bindings[10]),
        last_seen_at: String(bindings[11]),
        latest_entitlement_tier: bindings[12] as "trial" | "expired" | "pro",
        latest_subscription_status: bindings[13] as "none" | "active",
        last_sync_at: String(bindings[14])
      })
      return
    }

    if (sql.includes("UPDATE mobile_entitlements")) {
      const installationId = String(bindings[7])
      const bundleId = String(bindings[8])
      const existing = this.selectInstallationEntitlement(installationId, bundleId)
      if (!existing) return

      this.mobileEntitlements.delete(
        this.entitlementKey(
          existing.app_transaction_hash,
          existing.app_store_environment,
          existing.app_bundle_id
        )
      )
      existing.app_transaction_hash = String(bindings[0])
      existing.app_transaction_id = String(bindings[1])
      existing.app_store_environment = bindings[2] as "sandbox" | "production"
      existing.latest_entitlement_tier = bindings[3] as "trial" | "expired" | "pro"
      existing.latest_subscription_status = bindings[4] as "none" | "active"
      existing.last_seen_at = String(bindings[5])
      existing.last_sync_at = String(bindings[6])
      this.mobileEntitlements.set(
        this.entitlementKey(
          existing.app_transaction_hash,
          existing.app_store_environment,
          existing.app_bundle_id
        ),
        existing
      )
      return
    }

    if (sql.includes("INSERT INTO mobile_rate_limits")) {
      this.mobileRateLimits.set(String(bindings[0]), {
        bucket_key: String(bindings[0]),
        count: Number(bindings[1]),
        expires_at: String(bindings[2])
      })
      return
    }

    if (sql.includes("INSERT INTO mobile_app_attest_challenges")) {
      this.mobileAppAttestChallenges.set(String(bindings[0]), {
        challenge_id: String(bindings[0]),
        installation_id: String(bindings[1]),
        app_bundle_id: String(bindings[2]),
        app_version: String(bindings[3]),
        build_number: String(bindings[4]),
        challenge_hash: String(bindings[5]),
        expires_at: String(bindings[6]),
        consumed_at: (bindings[7] as string | null) ?? null,
        created_at: String(bindings[8])
      })
      return
    }

    if (sql.includes("INSERT INTO mobile_app_attest_keys")) {
      const keyId = String(bindings[0])
      const existing = this.mobileAppAttestKeys.get(keyId)
      this.mobileAppAttestKeys.set(keyId, {
        key_id: keyId,
        installation_id: String(bindings[1]),
        app_bundle_id: String(bindings[2]),
        public_key_pem: String(bindings[3]),
        receipt_base64: String(bindings[4]),
        sign_count: Number(bindings[5]),
        attested_at: String(bindings[6]),
        last_seen_at: String(bindings[7]),
        // Mirrors the real ON CONFLICT clause, which deliberately leaves revoked_at alone so a
        // bootstrap cannot un-revoke a key.
        revoked_at: existing ? existing.revoked_at : ((bindings[8] as string | null) ?? null)
      })
      return
    }

    if (sql.includes("INSERT INTO storekit_subscriptions")) {
      const values = this.insertedColumns(sql, bindings)
      const key = this.storeKitSubscriptionKey(
        String(values.original_transaction_id),
        String(values.environment)
      )
      const existing = this.storeKitSubscriptions.get(key)
      const revocationDate = (values.revocation_date as string | null) ?? null
      const latestSignedDate = (values.latest_signed_date as string | null) ?? null
      if (existing && !this.storeKitWriteWins(revocationDate, latestSignedDate, existing)) return
      const keep = <T>(incoming: T, previous: T | undefined): T =>
        (incoming ?? previous ?? null) as T
      const row: StoreKitSubscriptionRow = {
        original_transaction_id: String(values.original_transaction_id),
        environment: String(values.environment),
        installation_id: this.resolveInstallationBinding(
          sql,
          "storekit_subscriptions",
          values.installation_id as string | null,
          existing?.installation_id
        ),
        app_account_token: keep(
          values.app_account_token as string | null,
          existing?.app_account_token
        ),
        in_app_ownership_type: keep(
          values.in_app_ownership_type as string | null,
          existing?.in_app_ownership_type
        ),
        latest_transaction_id: String(values.latest_transaction_id),
        app_bundle_id: String(values.app_bundle_id),
        product_id: String(values.product_id),
        status: String(values.status),
        expires_at: (values.expires_at as string | null) ?? null,
        access_expires_at: (values.access_expires_at as string | null) ?? null,
        perpetual: Number(values.perpetual),
        grace_period_expires_at: (values.grace_period_expires_at as string | null) ?? null,
        is_trial: Number(values.is_trial),
        revocation_date: revocationDate,
        revocation_reason: (values.revocation_reason as number | null) ?? null,
        revocation_type: (values.revocation_type as string | null) ?? null,
        revocation_percentage: (values.revocation_percentage as number | null) ?? null,
        is_upgraded: Number(values.is_upgraded),
        product_type: keep(values.product_type as string | null, existing?.product_type),
        offer_discount_type: keep(
          values.offer_discount_type as string | null,
          existing?.offer_discount_type
        ),
        latest_signed_date: latestSignedDate ?? existing?.latest_signed_date ?? null,
        auto_renew_status: keep(
          values.auto_renew_status as number | null,
          existing?.auto_renew_status
        ),
        auto_renew_product_id: keep(
          values.auto_renew_product_id as string | null,
          existing?.auto_renew_product_id
        ),
        expiration_intent: keep(
          values.expiration_intent as number | null,
          existing?.expiration_intent
        ),
        is_in_billing_retry: keep(
          values.is_in_billing_retry as number | null,
          existing?.is_in_billing_retry
        ),
        price_increase_status: keep(
          values.price_increase_status as number | null,
          existing?.price_increase_status
        ),
        renewal_price: keep(values.renewal_price as number | null, existing?.renewal_price),
        currency: keep(values.currency as string | null, existing?.currency),
        last_verified_at: String(values.last_verified_at),
        created_at: existing?.created_at ?? String(values.created_at),
        updated_at: String(values.updated_at)
      }
      this.storeKitSubscriptions.set(key, row)
      return
    }

    if (sql.includes("INSERT INTO storekit_transactions")) {
      const values = this.insertedColumns(sql, bindings)
      const key = this.storeKitTransactionKey(
        String(values.transaction_id),
        String(values.environment)
      )
      const existing = this.storeKitTransactions.get(key)
      const revocationDate = (values.revocation_date as string | null) ?? null
      const latestSignedDate = (values.latest_signed_date as string | null) ?? null
      if (existing && !this.storeKitWriteWins(revocationDate, latestSignedDate, existing)) return
      const keep = <T>(incoming: T, previous: T | undefined): T =>
        (incoming ?? previous ?? null) as T
      const row: StoreKitTransactionRow = {
        transaction_id: String(values.transaction_id),
        environment: String(values.environment),
        original_transaction_id: String(values.original_transaction_id),
        web_order_line_item_id: keep(
          values.web_order_line_item_id as string | null,
          existing?.web_order_line_item_id
        ),
        installation_id: this.resolveInstallationBinding(
          sql,
          "storekit_transactions",
          values.installation_id as string | null,
          existing?.installation_id
        ),
        app_account_token: keep(
          values.app_account_token as string | null,
          existing?.app_account_token
        ),
        in_app_ownership_type: keep(
          values.in_app_ownership_type as string | null,
          existing?.in_app_ownership_type
        ),
        app_bundle_id: String(values.app_bundle_id),
        product_id: String(values.product_id),
        purchase_date: keep(values.purchase_date as string | null, existing?.purchase_date),
        expires_at: (values.expires_at as string | null) ?? null,
        access_expires_at: (values.access_expires_at as string | null) ?? null,
        perpetual: Number(values.perpetual),
        revocation_date: revocationDate,
        revocation_reason: (values.revocation_reason as number | null) ?? null,
        revocation_type: (values.revocation_type as string | null) ?? null,
        revocation_percentage: (values.revocation_percentage as number | null) ?? null,
        status: String(values.status),
        pro_active: Number(values.pro_active),
        source: String(values.source),
        is_upgraded: Number(values.is_upgraded),
        product_type: keep(values.product_type as string | null, existing?.product_type),
        offer_discount_type: keep(
          values.offer_discount_type as string | null,
          existing?.offer_discount_type
        ),
        latest_signed_date: latestSignedDate ?? existing?.latest_signed_date ?? null,
        first_seen_at: existing?.first_seen_at ?? String(values.first_seen_at),
        last_seen_at: String(values.last_seen_at)
      }
      this.storeKitTransactions.set(key, row)
      return
    }

    if (
      sql.includes("INSERT INTO storekit_notifications") ||
      sql.includes("INSERT OR IGNORE INTO storekit_notifications")
    ) {
      if (this.storeKitNotifications.has(String(bindings[0]))) return
      this.storeKitNotifications.set(String(bindings[0]), {
        notification_uuid: String(bindings[0]),
        notification_type: String(bindings[1]),
        subtype: (bindings[2] as string | null) ?? null,
        environment: String(bindings[3]),
        original_transaction_id: (bindings[4] as string | null) ?? null,
        transaction_id: (bindings[5] as string | null) ?? null,
        processed_at: String(bindings[6]),
        created_at: String(bindings[7])
      })
      return
    }

    if (sql.includes("INSERT INTO route_inflight_locks")) {
      this.routeLeases.set(String(bindings[0]), {
        route_key: String(bindings[0]),
        lease_id: String(bindings[1]),
        expires_at: String(bindings[2]),
        created_at: String(bindings[3])
      })
      return
    }

    if (sql.includes("INSERT INTO route_popularity_hourly")) {
      const hourBucket = String(bindings[0])
      const routeKey = String(bindings[1])
      const key = `${hourBucket}:${routeKey}`
      const existing = this.routePopularityRows.get(key)
      if (existing) {
        existing.count += Number(bindings[10])
        existing.last_seen_at = String(bindings[12])
        return
      }
      this.routePopularityRows.set(key, {
        hour_bucket: hourBucket,
        route_key: routeKey,
        from_city_id: Number(bindings[2]),
        from_city_name: String(bindings[3]),
        from_district_id: Number(bindings[4]),
        from_district_name: String(bindings[5]),
        to_city_id: Number(bindings[6]),
        to_city_name: String(bindings[7]),
        to_district_id: Number(bindings[8]),
        to_district_name: String(bindings[9]),
        count: Number(bindings[10]),
        first_seen_at: String(bindings[11]),
        last_seen_at: String(bindings[12])
      })
      return
    }

    if (sql.includes("INSERT OR IGNORE INTO route_inflight_locks")) {
      if (this.routeLeases.has(String(bindings[0]))) return
      this.routeLeases.set(String(bindings[0]), {
        route_key: String(bindings[0]),
        lease_id: String(bindings[1]),
        expires_at: String(bindings[2]),
        created_at: String(bindings[3])
      })
      return
    }

    if (sql.includes("UPDATE route_inflight_locks")) {
      const current = this.routeLeases.get(String(bindings[3]))
      if (!current) return
      if (current.expires_at > String(bindings[4])) return
      this.routeLeases.set(String(bindings[3]), {
        route_key: String(bindings[3]),
        lease_id: String(bindings[0]),
        expires_at: String(bindings[1]),
        created_at: String(bindings[2])
      })
      return
    }

    if (sql.includes("DELETE FROM route_inflight_locks")) {
      const current = this.routeLeases.get(String(bindings[0]))
      if (current?.lease_id === String(bindings[1])) {
        this.routeLeases.delete(String(bindings[0]))
      }
      return
    }

    if (sql.includes("DELETE FROM route_popularity_hourly")) {
      const cutoff = String(bindings[0])
      for (const [key, row] of this.routePopularityRows.entries()) {
        if (row.hour_bucket < cutoff) {
          this.routePopularityRows.delete(key)
        }
      }
      return
    }

    throw new Error(`Unsupported run() SQL in MockD1Database: ${sql}`)
  }

  private selectRoutePopularityRows(
    startBucket: string,
    endBucket: string,
    limit: number
  ): Array<{
    routeKey: string
    count: number
    fromCityId: number
    fromCityName: string
    fromDistrictId: number
    fromDistrictName: string
    toCityId: number
    toCityName: string
    toDistrictId: number
    toDistrictName: string
    firstSeenAt: string
    lastSeenAt: string
  }> {
    const grouped = new Map<
      string,
      {
        routeKey: string
        count: number
        fromCityId: number
        fromCityName: string
        fromDistrictId: number
        fromDistrictName: string
        toCityId: number
        toCityName: string
        toDistrictId: number
        toDistrictName: string
        firstSeenAt: string
        lastSeenAt: string
      }
    >()

    for (const row of this.routePopularityRows.values()) {
      if (row.hour_bucket < startBucket || row.hour_bucket > endBucket) continue
      const existing = grouped.get(row.route_key)
      if (!existing) {
        grouped.set(row.route_key, {
          routeKey: row.route_key,
          count: row.count,
          fromCityId: row.from_city_id,
          fromCityName: row.from_city_name,
          fromDistrictId: row.from_district_id,
          fromDistrictName: row.from_district_name,
          toCityId: row.to_city_id,
          toCityName: row.to_city_name,
          toDistrictId: row.to_district_id,
          toDistrictName: row.to_district_name,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at
        })
        continue
      }
      existing.count += row.count
      if (row.first_seen_at < existing.firstSeenAt) {
        existing.firstSeenAt = row.first_seen_at
      }
      if (row.last_seen_at > existing.lastSeenAt) {
        existing.lastSeenAt = row.last_seen_at
      }
    }

    return Array.from(grouped.values())
      .sort(
        (left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt)
      )
      .slice(0, limit)
  }

  private sessionResult(row: MobileSessionRow) {
    return {
      sessionId: row.session_id,
      installationId: row.installation_id,
      platform: row.platform,
      appBundleId: row.app_bundle_id,
      appVersion: row.app_version,
      buildNumber: row.build_number,
      tier: row.tier,
      refreshTokenHash: row.refresh_token_hash,
      refreshTokenExpiresAt: row.refresh_token_expires_at,
      createdAt: row.created_at,
      lastRefreshedAt: row.last_refreshed_at,
      revokedAt: row.revoked_at
    }
  }

  private entitlementResult(row: MobileEntitlementRow) {
    return {
      version: 1 as const,
      appTransactionId: row.app_transaction_id,
      installationId: row.installation_id,
      appStoreEnvironment: row.app_store_environment,
      appBundleId: row.app_bundle_id,
      trialPolicyVersion: row.trial_policy_version,
      trialDurationDays: row.trial_duration_days,
      trialStartedAt: row.trial_started_at,
      trialEndsAt: row.trial_ends_at,
      trialConsumed: Boolean(row.trial_consumed),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      latestEntitlementTier: row.latest_entitlement_tier,
      latestSubscriptionStatus: row.latest_subscription_status,
      lastSyncAt: row.last_sync_at
    }
  }

  private appAttestKeyResult(row: MobileAppAttestKeyRow) {
    return {
      keyId: row.key_id,
      installationId: row.installation_id,
      appBundleId: row.app_bundle_id,
      publicKeyPem: row.public_key_pem,
      receiptBase64: row.receipt_base64,
      signCount: row.sign_count,
      attestedAt: row.attested_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at
    }
  }

  private appAttestChallengeResult(row: MobileAppAttestChallengeRow) {
    return {
      challengeId: row.challenge_id,
      installationId: row.installation_id,
      appBundleId: row.app_bundle_id,
      appVersion: row.app_version,
      buildNumber: row.build_number,
      challengeHash: row.challenge_hash,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      createdAt: row.created_at
    }
  }

  private storeKitSubscriptionResult(row: StoreKitSubscriptionRow) {
    return {
      originalTransactionId: row.original_transaction_id,
      environment: row.environment,
      installationId: row.installation_id,
      appAccountToken: row.app_account_token,
      inAppOwnershipType: row.in_app_ownership_type,
      latestTransactionId: row.latest_transaction_id,
      appBundleId: row.app_bundle_id,
      productId: row.product_id,
      status: row.status,
      expiresAt: row.expires_at,
      accessExpiresAt: row.access_expires_at,
      perpetual: row.perpetual,
      gracePeriodExpiresAt: row.grace_period_expires_at,
      isTrial: row.is_trial,
      revocationDate: row.revocation_date,
      revocationReason: row.revocation_reason,
      revocationType: row.revocation_type,
      revocationPercentage: row.revocation_percentage,
      isUpgraded: row.is_upgraded,
      productType: row.product_type,
      offerDiscountType: row.offer_discount_type,
      latestSignedDate: row.latest_signed_date,
      autoRenewStatus: row.auto_renew_status,
      autoRenewProductId: row.auto_renew_product_id,
      expirationIntent: row.expiration_intent,
      isInBillingRetry: row.is_in_billing_retry,
      priceIncreaseStatus: row.price_increase_status,
      renewalPrice: row.renewal_price,
      currency: row.currency,
      lastVerifiedAt: row.last_verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private storeKitNotificationResult(row: StoreKitNotificationRow) {
    return {
      notificationUuid: row.notification_uuid,
      notificationType: row.notification_type,
      subtype: row.subtype,
      environment: row.environment,
      originalTransactionId: row.original_transaction_id,
      transactionId: row.transaction_id,
      processedAt: row.processed_at,
      createdAt: row.created_at
    }
  }
}

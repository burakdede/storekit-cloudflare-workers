/**
 * The Cloudflare runtime surface this package actually touches, declared structurally.
 *
 * A published library must not depend on the ambient `D1Database` and `ExecutionContext` globals:
 * those come from a host's generated `worker-configuration.d.ts` or from a particular version of
 * `@cloudflare/workers-types`, and a library that references them fails to typecheck wherever they
 * are absent or differently versioned. The real Cloudflare types are structurally assignable to
 * everything declared here, so a host passes `env.STOREKIT_DB` and `ctx` straight in.
 */

/* eslint-disable no-unused-vars -- Structural method signatures name parameters only for typing. */

export interface StoreKitPreparedStatement {
  bind(..._values: unknown[]): StoreKitPreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

/**
 * The D1 binding, narrowed to the calls this package makes: bound single-row and multi-row reads,
 * and a batch, which D1 runs as one transaction.
 */
export interface StoreKitD1Database {
  prepare(_query: string): StoreKitPreparedStatement
  batch(_statements: StoreKitPreparedStatement[]): Promise<unknown[]>
}

/** The `ctx` a Worker's `fetch` receives, narrowed to the one method used for background work. */
export interface StoreKitExecutionContext {
  waitUntil(_promise: Promise<unknown>): void
}

/**
 * Error taxonomy for the StoreKit module.
 *
 * Each class maps to a distinct host response: configuration problems are operator errors,
 * verification failures are client/Apple errors, and storage failures are transient backend
 * errors. Messages are deliberately generic — diagnostics travel in structured fields so a host
 * can log them without leaking Apple credentials or signed payloads to a client.
 */

export interface StoreKitVerificationDiagnostics {
  sdkErrorName?: string | undefined
  sdkErrorMessage?: string | undefined
  appleHttpStatus?: number | undefined
  appleApiError?: number | undefined
  appleErrorMessage?: string | undefined
}

/** The Worker is missing or misconfiguring the Apple credentials the module needs. */
export class StoreKitConfigError extends Error {
  constructor(message = "StoreKit verification is not configured.") {
    super(message)
    this.name = "StoreKitConfigError"
  }
}

/** Signed Apple material failed signature, identity, or policy verification. */
export class StoreKitVerificationError extends Error {
  readonly stage: string
  readonly sdkErrorName: string | undefined
  readonly sdkErrorMessage: string | undefined
  readonly appleHttpStatus: number | undefined
  readonly appleApiError: number | undefined
  readonly appleErrorMessage: string | undefined

  constructor(
    message = "StoreKit transaction could not be verified.",
    stage = "unknown",
    diagnostics: StoreKitVerificationDiagnostics = {}
  ) {
    super(message)
    this.name = "StoreKitVerificationError"
    this.stage = stage
    this.sdkErrorName = diagnostics.sdkErrorName
    this.sdkErrorMessage = diagnostics.sdkErrorMessage
    this.appleHttpStatus = diagnostics.appleHttpStatus
    this.appleApiError = diagnostics.appleApiError
    this.appleErrorMessage = diagnostics.appleErrorMessage
  }
}

export class StoreKitVerificationStageError extends StoreKitVerificationError {
  constructor(
    stage: string,
    message = "StoreKit transaction could not be verified.",
    diagnostics: StoreKitVerificationDiagnostics = {}
  ) {
    super(message, stage, diagnostics)
  }
}

/**
 * A D1 operation failed, or a snapshot was not persistable.
 *
 * `retryable` is false when the data itself is unusable (the host should answer 4xx) and true for
 * a backend failure the caller may retry (the host should answer 5xx, and Apple will redeliver a
 * notification).
 */
export class StoreKitPersistenceError extends Error {
  readonly operation: string
  readonly retryable: boolean

  constructor(message: string, operation: string, retryable = true) {
    super(message)
    this.name = "StoreKitPersistenceError"
    this.operation = operation
    this.retryable = retryable
  }
}

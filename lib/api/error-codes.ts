/**
 * ============================================================================
 * CareGrid AI — error code catalogue (single source of truth)
 * ============================================================================
 *
 * Docs/16 §1.7 lists roughly ninety codes. Phase 2 needs the authentication and
 * account subset; Phase 3+ adds the incident set. Rather than two sources (this
 * file and the docs), this file is the machine-readable projection of §1.7 and
 * a test asserts that every code it declares exists in the documentation.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATUS MAP IS A TABLE AND NOT A `switch`
 * ---------------------------------------------------------------------------
 * Because the status for a code is a FACT ABOUT THE CATALOGUE, not a decision
 * made at each throw site. If a handler chose its own status, `ROLE_MISMATCH`
 * could be 403 on one route and 500 on another, and the client's retry logic
 * would branch on the wrong thing. One table, one status per code.
 *
 * `403` means **this role can never do this** — retrying is pointless, so the UI
 * must not offer a Retry button. `401` means the token may be refreshable. That
 * distinction is the whole reason the two are not collapsed.
 */

/** Every code Phase 2 can emit, with the status docs/16 §1.7 assigns it. */
export const ERROR_STATUS = {
  /* --- 400 validation / bad request ------------------------------------- */
  VALIDATION_FAILED: 400,
  REASON_REQUIRED: 400,
  SELF_ROLE_CHANGE_FORBIDDEN: 400,
  SELF_DISABLE_FORBIDDEN: 400,
  INVALID_CURSOR: 400,
  CURSOR_COMBINATION_INVALID: 400,
  INVALID_RESOLUTION_CODE: 400,

  /* --- 401 not authenticated ------------------------------------------- */
  AUTH_REQUIRED: 401,
  AUTH_INVALID_TOKEN: 401,
  AUTH_EXPIRED: 401,

  /* --- 403 authenticated but never permitted --------------------------- */
  FORBIDDEN: 403,
  ROLE_MISMATCH: 403,
  ACCOUNT_UNAVAILABLE: 403,
  CSRF_FAILED: 403,
  REAUTH_REQUIRED: 403,
  ROLE_ESCALATION_GUARD: 403,
  UPLOAD_FORBIDDEN_PATH: 403,

  /* --- 404 may exist, caller may not know ------------------------------ */
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  INCIDENT_NOT_FOUND: 404,
  RESPONDER_NOT_FOUND: 404,

  /* --- 409 state conflict ------------------------------------------------ */
  INVALID_STATUS_TRANSITION: 409,
  ALREADY_ROLE: 409,
  ALREADY_VERIFIED: 409,
  ACCOUNT_ALREADY_EXISTS: 409,
  EMAIL_ALREADY_EXISTS: 409,

  /* --- 422 well-formed but semantically rejected ------------------------ */
  EMPTY_REPORT: 422,
  INVALID_CAPABILITY: 422,
  RESOURCE_REQUIRED: 422,
  FEATURE_DISABLED: 422,
  MAINTENANCE_DISABLED: 422,

  /* --- 429 rate limited -------------------------------------------------- */
  RATE_LIMITED: 429,

  /* --- 500 / 503 --------------------------------------------------------- */
  INTERNAL: 500,
  DB_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Every declared code, for validation and documentation coverage tests. */
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

/** `true` when the code means "this role can never do this". */
export function isPermanentDenial(code: string): boolean {
  return ERROR_STATUS[code as ErrorCode] === 403;
}

/**
 * `true` when a 401 may be recovered by refreshing the token exactly once.
 *
 * `AUTH_REQUIRED` is excluded on purpose: there was no token to refresh, so
 * retrying is guaranteed to fail and only adds a round trip.
 */
export function isRefreshable(code: string): boolean {
  return code === 'AUTH_EXPIRED' || code === 'AUTH_INVALID_TOKEN';
}

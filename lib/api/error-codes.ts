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

  /* --- 405 the verb does not exist on this path ------------------------ */
  /**
   * Next.js answers this itself for an unrouted verb, but the code is declared
   * here so a handler that refuses a verb on a path it DOES route (a `GET` on a
   * write-only route, for instance) speaks the same catalogue.
   */
  METHOD_NOT_ALLOWED: 405,

  /* --- 409 state conflict ------------------------------------------------ */
  INVALID_STATUS_TRANSITION: 409,
  ALREADY_ROLE: 409,
  ALREADY_VERIFIED: 409,
  ACCOUNT_ALREADY_EXISTS: 409,
  EMAIL_ALREADY_EXISTS: 409,

  /* --- 413 the request itself is too large ----------------------------- */
  /**
   * A body above the route's `maxBytes`. Deliberately a 413 and not a 400,
   * because the client can act on it: a smaller payload. The Vercel platform
   * cap of 4.5 MB is never the limit we want to hit, so this fires first
   * (docs/17 §10).
   */
  REQUEST_TOO_LARGE: 413,

  /* --- 415 the payload is not a shape this route accepts --------------- */
  UNSUPPORTED_MEDIA_TYPE: 415,

  /* --- 422 well-formed but semantically rejected ------------------------ */
  EMPTY_REPORT: 422,
  /**
   * The caller named a capability that does not exist in the 61-row matrix.
   * `422` per docs/16 §3.3 — the request parsed, and the domain refused the
   * value. Distinct from `forbidden`, which is `403 FORBIDDEN` (a real
   * capability this role may never hold).
   */
  INVALID_CAPABILITY: 422,
  RESOURCE_REQUIRED: 422,
  FEATURE_DISABLED: 422,
  MAINTENANCE_DISABLED: 422,
  /**
   * `PATCH /api/me` was asked to enable SMS or WhatsApp when no provider is
   * configured. Added by Phase 2 and recorded in docs/30.3 §A6.1, but it was
   * MISSING from this table, so `statusForCode()` fell through to 500 and a
   * perfectly ordinary profile edit answered "Something went wrong" instead of
   * naming the field. A catalogue gap is a bug, not a shrug.
   */
  NOTIFICATION_DISABLED: 422,
  /**
   * A capability exists and the caller has it, but the deployment has the
   * corresponding feature switched off (`ENABLE_RISK_ZONES`,
   * `ENABLE_VOICE_REPORTING`). 422 rather than 404: the route is real, the
   * request was understood, and the answer is a refusal rather than a lie.
   */
  CAPABILITY_DISABLED: 422,

  /* --- 429 rate limited -------------------------------------------------- */
  RATE_LIMITED: 429,
  /**
   * The documented name for a rate-limited request (docs/10 §17.1, docs/16
   * §3.10). `RATE_LIMITED` is kept because Phase 2's auth routes already emit
   * it; both are 429 and both carry `Retry-After`, so a client branching on
   * either behaves identically. Collapsed to one name when the auth routes move
   * to the Firestore bucket.
   */
  RATE_LIMIT_EXCEEDED: 429,

  /* --- 500 / 502 / 503 / 504 --------------------------------------------- */
  INTERNAL: 500,
  /**
   * An external provider answered 5xx or the network failed after the
   * documented retries. `502`, not `503`: the request was well-formed and we
   * reached the provider, so the fault is upstream rather than here. The whole
   * application must survive this (docs/16 §3.6) — Gemini being down is a
   * degraded triage path, never a crashed app.
   */
  AI_UNAVAILABLE: 502,
  /** Same shape as AI_UNAVAILABLE: a Maps call failed. Never fatal (docs/16 §3.8). */
  MAPS_UNAVAILABLE: 502,
  DB_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  /**
   * A third-party quota was exhausted, so this is deliberately NOT a 429: a 429
   * invites the client to retry, and retrying a third-party quota makes it
   * worse (docs/16 D-16-8).
   */
  AI_QUOTA: 503,
  /**
   * The model answered, and the answer was not a valid triage record.
   *
   * Added in Phase 4. `422` and not `502`: the upstream provider worked fine, so
   * this is not an availability problem and a client retrying a `502` would get
   * the same invalid record again. It is also deliberately NOT surfaced to a
   * citizen as a failure — `triageIncident()` catches it, runs the keyword
   * fallback, and records `outcome: 'validation_failed'` on `aiRuns`. A citizen
   * whose report reached the model and came back malformed still has their
   * report filed and a human looking at it; the 422 exists so an operator can
   * see the rate in `/api/admin/system/health` without reading model output.
   */
  AI_OUTPUT_INVALID: 422,
  /** The global handler budget in `REQUEST_TIMEOUT_MS` was exceeded (docs/16 §3.11). */
  TIMEOUT: 504,
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

/**
 * The codes that carry a `Retry-After` header. docs/16 §5: every 429 and every
 * retryable 503 must.
 *
 * Used by `lib/server/route.ts` to assert the header is present, because a 429
 * without `Retry-After` tells a well-behaved client to guess a backoff and a
 * hostile one to guess zero.
 */
export const RETRY_AFTER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'DB_UNAVAILABLE',
  'AI_UNAVAILABLE',
  'AI_QUOTA',
  'MAPS_UNAVAILABLE',
  'TIMEOUT',
]);


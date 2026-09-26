import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_STATUS,
  RETRY_AFTER_CODES,
  isPermanentDenial,
  isRefreshable,
  type ErrorCode,
} from '@/lib/api/error-codes';

/**
 * ============================================================================
 * The error-code catalogue is a CONTRACT
 * ============================================================================
 *
 * Every assertion here is about the catalogue rather than about a route, because
 * the catalogue is the single source and a route cannot override it. A throw site
 * names a code; the status comes from `ERROR_STATUS`; the client's retry logic
 * branches on the status. If a code's status is wrong, every route that emits it
 * is wrong, and no per-route test would catch it.
 *
 * The additions in Phase 3 came from real findings, and each is asserted
 * individually rather than as a snapshot:
 *
 *   1. `NOTIFICATION_DISABLED` was MISSING from the table. `PATCH /api/me` threw
 *      it, `statusForCode` fell through to 500, and a user enabling a
 *      notification switch got "Something went wrong" instead of a sentence
 *      naming the field. Documented in docs/30.3 §A6.1; the gap in the code is
 *      what Phase 3 closed.
 *   2. `AI_UNAVAILABLE` was 503. docs/16 §3.6 assigns 502 — the request was
 *      well-formed and we reached a third party, so the fault is upstream. 503
 *      tells a client to back off, which is right for a database and wrong for a
 *      provider whose quota is not the caller's problem. The existing test that
 *      pinned 503 was pinning a value that contradicted the anchor document, and
 *      it was corrected rather than left to fail.
 */

describe('the catalogue is total and self-consistent', () => {
  it('declares every code it exports with a numeric status', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(typeof status, `${code} has no status`).toBe('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('exports exactly the keys it declares', () => {
    // A code present in the array but absent from the record is a code a route
    // could emit and the status lookup could not answer.
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });
});

describe('the 401 / 403 / 404 contract is not collapsed', () => {
  /**
   * Getting 403 and 404 backwards is a real information leak: returning 403 to
   * "a citizen asking for someone else's incident" confirms the incident
   * exists. 403 means "this role can NEVER do this, retrying is pointless"; 404
   * means "it may exist but you may not know that".
   */
  const FORBIDDEN_CODES = [
    'FORBIDDEN',
    'ROLE_MISMATCH',
    'ACCOUNT_UNAVAILABLE',
    'CSRF_FAILED',
    'REAUTH_REQUIRED',
    'ROLE_ESCALATION_GUARD',
    'UPLOAD_FORBIDDEN_PATH',
  ] as const;

  it('every permanent denial is 403', () => {
    for (const code of FORBIDDEN_CODES) {
      expect(ERROR_STATUS[code], `${code} should be 403`).toBe(403);
    }
  });

  it('every not-found code is 404', () => {
    for (const code of ['NOT_FOUND', 'USER_NOT_FOUND', 'INCIDENT_NOT_FOUND', 'RESPONDER_NOT_FOUND'] as const) {
      expect(ERROR_STATUS[code], `${code} should be 404`).toBe(404);
    }
  });

  it('every auth code is 401', () => {
    for (const code of ['AUTH_REQUIRED', 'AUTH_INVALID_TOKEN', 'AUTH_EXPIRED'] as const) {
      expect(ERROR_STATUS[code], `${code} should be 401`).toBe(401);
    }
  });

  it('isPermanentDenial agrees with the table, not with a guess', () => {
    expect(isPermanentDenial('FORBIDDEN')).toBe(true);
    expect(isPermanentDenial('AUTH_REQUIRED')).toBe(false);
    expect(isPermanentDenial('INCIDENT_NOT_FOUND')).toBe(false);
  });
});

describe('the 400 versus 422 discriminator', () => {
  /**
   * docs/16 §1.4: 400 is a MALFORMED request; 422 is a well-formed request the
   * domain refuses. The distinction is what tells a developer whether to fix
   * their code or change their input.
   */
  it('a malformed request is 400', () => {
    for (const code of [
      'VALIDATION_FAILED',
      'REASON_REQUIRED',
      'INVALID_CURSOR',
      'CURSOR_COMBINATION_INVALID',
      'INVALID_RESOLUTION_CODE',
      'SELF_ROLE_CHANGE_FORBIDDEN',
      'SELF_DISABLE_FORBIDDEN',
    ] as const) {
      expect(ERROR_STATUS[code], `${code} should be 400`).toBe(400);
    }
  });

  it('a well-formed but refused request is 422', () => {
    for (const code of [
      'EMPTY_REPORT',
      'RESOURCE_REQUIRED',
      'NOTIFICATION_DISABLED',
      'CAPABILITY_DISABLED',
      'MAINTENANCE_DISABLED',
      // docs/16 §3.3: a capability name that does not exist PARSED, and the domain
      // refused the value. That is 422, not 400 — the request was understood.
      'INVALID_CAPABILITY',
    ] as const) {
      expect(ERROR_STATUS[code], `${code} should be 422`).toBe(422);
    }
  });
});


describe('the codes Phase 3 added', () => {
  it('NOTIFICATION_DISABLED is 422, not 500', () => {
    // The bug this closes: `PATCH /api/me` with `sms: true` threw a code the
    // table did not know, so `statusForCode` defaulted to 500 and a user editing
    // a profile was told "Something went wrong".
    expect(ERROR_STATUS.NOTIFICATION_DISABLED).toBe(422);
  });

  it('REQUEST_TOO_LARGE is 413', () => {
    // 413 and not 400 because the client can act on it: send a smaller payload.
    // The 4.5 MB Vercel cap is never the limit we want to hit, so this fires
    // first at 1 MB.
    expect(ERROR_STATUS.REQUEST_TOO_LARGE).toBe(413);
  });

  it('UNSUPPORTED_MEDIA_TYPE is 415', () => {
    expect(ERROR_STATUS.UNSUPPORTED_MEDIA_TYPE).toBe(415);
  });

  it('METHOD_NOT_ALLOWED is 405', () => {
    expect(ERROR_STATUS.METHOD_NOT_ALLOWED).toBe(405);
  });

  it('AI_UNAVAILABLE is 502, matching docs/16 §3.6', () => {
    // Upstream fault: the request was well-formed and we reached the provider.
    // 503 would tell a client to back off, which is wrong for a third-party
    // quota that is not the caller's problem.
    expect(ERROR_STATUS.AI_UNAVAILABLE).toBe(502);
  });

  it('MAPS_UNAVAILABLE is 502, matching docs/16 §3.8', () => {
    // Never fatal by design. The documented list fallback carries the product.
    expect(ERROR_STATUS.MAPS_UNAVAILABLE).toBe(502);
  });

  it('AI_QUOTA is 503, NOT 429 — docs/16 D-16-8', () => {
    // A 429 invites the client to retry, and retrying a third-party quota makes
    // it worse. This is the one place where "the honest status" and "the status
    // that makes the client behave" disagree, and the client behaves.
    expect(ERROR_STATUS.AI_QUOTA).toBe(503);
    expect(ERROR_STATUS.AI_QUOTA).not.toBe(429);
  });

  it('TIMEOUT is 504', () => {
    expect(ERROR_STATUS.TIMEOUT).toBe(504);
  });

  it('both 429 codes exist, so no route invents a third name', () => {
    // `RATE_LIMITED` is Phase 2's name; `RATE_LIMIT_EXCEEDED` is the documented
    // one. Both are 429 and both carry Retry-After, so a client branching on
    // either behaves identically. Two names, one behaviour — not two
    // behaviours.
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.RATE_LIMIT_EXCEEDED).toBe(429);
  });
});

describe('every rate-limited response can be told to retry', () => {
  it('both 429 codes and the retryable 5xx codes are in RETRY_AFTER_CODES', () => {
    // docs/16 §5: every 429 and every retryable 503 must carry `Retry-After`.
    // A 429 without it tells a well-behaved client to guess a backoff and a
    // hostile one to guess zero.
    for (const code of ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED'] as const) {
      expect(RETRY_AFTER_CODES.has(code), `${code} must carry Retry-After`).toBe(true);
    }
    for (const code of ['DB_UNAVAILABLE', 'AI_QUOTA', 'TIMEOUT'] as const) {
      expect(RETRY_AFTER_CODES.has(code), `${code} must carry Retry-After`).toBe(true);
    }
  });

  it('a permanent denial is NOT retryable, so no Retry button is offered', () => {
    for (const code of ERROR_CODES) {
      if (ERROR_STATUS[code] === 403) {
        expect(RETRY_AFTER_CODES.has(code), `${code} must not be retryable`).toBe(false);
      }
    }
  });
});

describe('isRefreshable', () => {
  it('is true only for the two codes a token refresh can recover', () => {
    expect(isRefreshable('AUTH_EXPIRED')).toBe(true);
    expect(isRefreshable('AUTH_INVALID_TOKEN')).toBe(true);
  });

  it('is FALSE for AUTH_REQUIRED, because there was no token to refresh', () => {
    // Retrying `AUTH_REQUIRED` is guaranteed to fail and only adds a round trip.
    expect(isRefreshable('AUTH_REQUIRED')).toBe(false);
  });

  it('is false for everything else', () => {
    for (const code of ERROR_CODES) {
      if (code === 'AUTH_EXPIRED' || code === 'AUTH_INVALID_TOKEN') continue;
      expect(isRefreshable(code), `${code} must not trigger a refresh`).toBe(false);
    }
  });
});

describe('a 5xx never leaks as a 4xx and a 4xx never leaks as a 5xx', () => {
  it('the two families are disjoint', () => {
    const fiveHundreds = new Set(
      ERROR_CODES.filter((c) => ERROR_STATUS[c] >= 500).map((c) => c as ErrorCode),
    );
    for (const code of ERROR_CODES) {
      const isFive = ERROR_STATUS[code] >= 500;
      expect(isFive).toBe(fiveHundreds.has(code));
    }
  });
});

/**
 * ============================================================================
 * CareGrid AI — the authentication guard
 * ============================================================================
 *
 * THIS IS THE SECURITY BOUNDARY. Everything else in the authorisation stack is
 * a convenience: the UI hides a button, `firestore.rules` blocks a direct
 * client write, the audit log records what happened. None of those can decide
 * whether a REQUEST is allowed. This file can, and it is the only place that
 * runs on every API request.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF CHECKS IS NORMATIVE (docs/10 §6.3)
 * ---------------------------------------------------------------------------
 * The sequence is not arbitrary; each step's failure mode is different and the
 * order decides which message the caller sees and what gets audited.
 *
 *   1. Header present?              → 401 AUTH_REQUIRED      (no audit; anonymous)
 *   2. Token verifies?             → 401 AUTH_INVALID_TOKEN  (no audit; the caller
 *                                                            is not yet identified)
 *   3. Account age (auth_time)?    → 403 REAUTH_REQUIRED    (privileged actions only)
 *   4. `users/{uid}` exists?       → 403 ACCOUNT_UNAVAILABLE (someone has an Auth
 *                                                            account but no profile)
 *                                    EXEMPT for `POST /api/me/bootstrap`, which
 *                                    CREATES that document — see
 *                                    `allowMissingUserDoc`.
 *   5. Account active?             → 403 ACCOUNT_UNAVAILABLE (suspended / pending)
 *   6. Read the AUTHORITATIVE role → `users/{uid}.role`
 *   7. A claim that DISAGREES?     → 403 ROLE_MISMATCH      + AUDIT (drift)
 *                                    An ABSENT claim is not drift and is allowed.
 *   8. Role permits this action?   → 403 FORBIDDEN          + AUDIT for privileged
 *
 * Step 6 before step 7 is the whole design. The claim is a MIRROR used only by
 * `firestore.rules`; the Firestore field is the truth. If the claim were read
 * first, a stale token would grant a stale role — and an admin who has just
 * been demoted would keep admin for an hour.
 *
 * Step 7 is not "fix it and carry on". A mismatch is a 403 and an audit entry,
 * because a mismatch means two systems disagree about who this person is, and
 * silently preferring either one hides a bug that could be an attack.
 *
 * Step 7 fires only when a claim EXISTS and disagrees. Failing closed on a
 * MISSING claim is what made this product entirely unusable: `role` is not a
 * reserved Firebase claim, so it is absent unless something mirrors it, and
 * nothing did. Every authenticated request answered `ROLE_MISMATCH` while the
 * whole test suite stayed green.
 *
 * ---------------------------------------------------------------------------
 * `checkRevoked: true`
 * ---------------------------------------------------------------------------
 * Passed on every verification. Without it, a suspended user's token stays
 * valid until it expires, and suspension would be a suggestion (docs/22 §8.3).
 * It costs one extra lookup per request; the alternative is a documented
 * residual risk that suspension does not actually suspend.
 */

import 'server-only';

import type { DecodedIdToken } from 'firebase-admin/auth';

import { getAdminAuth, getAdminDb } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import { createLogger } from '@/lib/server/http';
import { auditLog } from '@/lib/server/audit';
import { getServerEnv } from '@/lib/env.server';
import { USER_ROLES } from '@/types/enums';
import type { AccountStatus, UserRole } from '@/types/enums';

/** A caller who has passed every step. Nothing downstream re-checks the token. */
export type AuthedUser = {
  readonly uid: string;
  readonly role: UserRole;
  readonly status: AccountStatus;
  readonly displayName: string;
  readonly email: string;
  readonly authTimeSec: number;
  readonly token: DecodedIdToken;
};

export type RequireUserOptions = {
  /**
   * The action name, used to decide whether step 3 (fresh auth_time) applies.
   * docs/10 §3.6.
   */
  action?: string;
  requestId: string;
  /**
   * Skip the `status !== 'active'` gate. ONLY `POST /api/me/bootstrap` and
   * `GET /api/me` may pass this, and only because a suspended or
   * not-yet-bootstrapped user must be able to learn WHY they cannot proceed
   * (docs/22 §1). `POST /api/auth/event` is exempt from the status gate for a
   * different reason: a suspended user must still be able to report a logout.
   */
  allowInactiveAccount?: boolean;
  /**
   * Skip the `users/{uid}` EXISTENCE gate (step 4) as well.
   *
   * ---------------------------------------------------------------------------
   * THIS EXISTS BECAUSE `POST /api/me/bootstrap` WAS UNREACHABLE
   * ---------------------------------------------------------------------------
   * The bootstrap route exists to CREATE `users/{uid}`. Step 4 rejected the
   * request precisely because that document did not exist — so the one route
   * able to repair a missing profile could never be reached. The consequence
   * was total, not partial: sign-up created the Firebase user, `GET /api/me`
   * answered `403 ACCOUNT_UNAVAILABLE`, the session provider correctly tried to
   * bootstrap, bootstrap answered `403 ACCOUNT_UNAVAILABLE` again, and the
   * provider fell through to `authStatus: 'error'`. Every new account — email
   * sign-up and "Continue with Google" alike — was stuck on the form with no way
   * forward. `allowInactiveAccount` could not fix it, because that flag waives
   * step 5 (status), not step 4 (existence).
   *
   * ---------------------------------------------------------------------------
   * WHY DEFAULTS ARE `citizen` / `active`, AND WHY THAT IS NOT A BACKDOOR
   * ---------------------------------------------------------------------------
   * A caller with no document has no role to read, so one must be synthesised
   * for the `AuthedUser` shape. `citizen` is the only role a public sign-up can
   * ever receive (docs/22 §1), so this grants nothing.
   *
   * It is also inert even if it were wrong: `bootstrapUser` writes the role from
   * its own `PUBLIC_ROLE` constant and never reads `ctx.user.role`, so the value
   * this flag invents cannot reach a document. The escalation guards are the
   * `.strict()` schema, `assertNoRoleInBody()`, the constant, and
   * `users: allow write: if false` — none of which are this flag.
   */
  allowMissingUserDoc?: boolean;
};

/**
 * Actions that need a token issued within `REAUTH_WINDOW_SEC`.
 *
 * The purpose is NOT to stop a determined attacker — anyone holding a valid
 * token can refresh it (docs/10 §3.6, honest limitation). The purpose is to
 * make a stolen long-lived session useless for a *second* high-value action
 * after it has been sitting on a device. A role change or a suspension
 * requested from a session that has been open for an hour should require a
 * deliberate re-entry of credentials.
 */
export const REAUTH_ACTIONS: ReadonlySet<string> = new Set([
  'admin.user.role',
  'admin.user.status',
  'admin.config',
  'responder.verify',
  'responder.reject',
  'admin.maintenance',
  'admin.notification.send',
  'admin.audit.export',
]);

/**
 * Steps 1–7. Returns the caller, or throws an `AppError`.
 *
 * Never returns a partially-verified caller. There is no `tryAuthenticate` that
 * yields `{ user, ok: false }`, because a caller that forgets to check `ok` is
 * exactly how an unauthenticated path becomes authenticated by accident.
 */
export async function requireUser(req: Request, options: RequireUserOptions): Promise<AuthedUser> {
  const log = createLogger(options.requestId);

  /* --- 1. header present ------------------------------------------------- */
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    // No audit entry: the caller is anonymous and there is nothing to attribute.
    throw new AppError({ code: 'AUTH_REQUIRED' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (token === '') {
    throw new AppError({ code: 'AUTH_REQUIRED' });
  }

  /* --- 2. signature, audience, expiry, revocation ----------------------- */
  let decoded: DecodedIdToken;
  try {
    decoded = await getAdminAuth().verifyIdToken(token, true);
  } catch (error) {
    // Log the reason server-side; the caller gets the neutral 401. A token
    // verification failure is not something the user can act on beyond signing
    // in again, and the specific reason (wrong audience, revoked, bad
    // signature) is an attacker-facing oracle if it is echoed.
    log.warn({ code: 'AUTH_INVALID_TOKEN', method: req.method, path: pathOf(req) });
    void error;
    throw new AppError({ code: 'AUTH_INVALID_TOKEN' });
  }

  /* --- 3. freshness for privileged actions ------------------------------ */
  if (options.action && REAUTH_ACTIONS.has(options.action)) {
    const ageSec = Date.now() / 1000 - (decoded.auth_time ?? 0);
    if (ageSec > getServerEnv().reauthWindowSec) {
      throw new AppError({ code: 'REAUTH_REQUIRED' });
    }
  }

  /* --- 4/5/6. the user document ----------------------------------------- */
  const snapshot = await getAdminDb().collection('users').doc(decoded.uid).get();
  const doc = snapshot.exists ? snapshot.data() : null;

  if (!doc && !options.allowMissingUserDoc) {
    // An Auth account with no `users/{uid}`: sign-up succeeded but bootstrap
    // never ran, or the document was deleted. Either way the caller is not a
    // CareGrid user yet, and the correct answer is the same one as a suspended
    // account — not a 500 that invites a retry loop.
    throw new AppError({ code: 'ACCOUNT_UNAVAILABLE' });
  }

  /*
   * The three shapes below are the whole of step 4-7. They are spelled out
   * separately rather than collapsed because they have genuinely different
   * answers, and the two exemptions do not overlap.
   */
  if (!doc) {
    // Reachable ONLY via `allowMissingUserDoc`, i.e. ONLY bootstrap. Steps 5, 6
    // and 7 are all about a document that does not exist, so there is nothing to
    // gate on and nothing to compare — in particular there is no role to drift
    // from, so the claim check is skipped rather than answered with a guess.
    log.debug({
      actorUid: decoded.uid,
      code: 'BOOTSTRAP_PENDING',
      method: req.method,
      path: pathOf(req),
    });

    return {
      uid: decoded.uid,
      // The only role a public sign-up can receive; see the option's note.
      role: 'citizen' as UserRole,
      status: 'active' as AccountStatus,
      displayName: typeof decoded.name === 'string' ? decoded.name : '',
      email: typeof decoded.email === 'string' ? decoded.email : '',
      authTimeSec: decoded.auth_time ?? 0,
      token: decoded,
    };
  }

  const status = doc.status as AccountStatus;
  const role = doc.role as UserRole;

  if (!options.allowInactiveAccount && status !== 'active') {
    await auditLog({
      requestId: options.requestId,
      actorUid: decoded.uid,
      action: 'auth.blocked',
      entityType: 'user',
      entityId: decoded.uid,
      summary: `Request refused: account status is ${status}`,
      reason: status,
    });
    throw new AppError({ code: 'ACCOUNT_UNAVAILABLE' });
  }

  /* --- 7. claim drift ---------------------------------------------------- */
  //
  // THE DOCUMENT IS THE AUTHORITY. The claim is a MIRROR, and it is read here
  // only to notice that the mirror has gone stale — never to decide who someone
  // is.
  //
  // An ABSENT claim is therefore not drift, and must not deny the request. It
  // was, and the effect was that authentication was impossible for every user:
  // `role` is not a reserved Firebase claim, so it only exists on a token if
  // something called `setCustomUserClaims({ role })`. Nothing in this codebase
  // ever did — the sole claim write set `displayName` — so `decoded.role` was
  // `undefined` for every caller, the comparison below was
  // `null !== 'citizen'`, and `ROLE_MISMATCH` was returned by every authenticated
  // route in the product. Sign-up was not merely broken; nothing worked.
  //
  // Failing closed on a missing mirror would also be the wrong instinct: the
  // authoritative value is in `doc.role`, read in THIS request from the Admin
  // SDK, so there is no trust gap to close. Denying here would only mean a
  // deployment that never bothered to mirror claims locks out all its users.
  const claimRole = typeof decoded.role === 'string' ? decoded.role : null;

  if (claimRole === null) {
    // Not an error. Debug, not warn: an unmirrored claim is the expected state
    // for most accounts and would drown the real signal in noise.
    log.debug({
      actorUid: decoded.uid,
      actorRole: role,
      code: 'ROLE_CLAIM_UNMIRRORED',
      path: pathOf(req),
    });
  } else if (claimRole !== role) {
    // A claim that EXISTS and disagrees is a real signal — someone changed a
    // role without the mirror step, or a token is being replayed after a role
    // change. Still audited at warn.
    await auditLog({
      requestId: options.requestId,
      actorUid: decoded.uid,
      action: 'auth.role_mismatch',
      entityType: 'user',
      entityId: decoded.uid,
      summary: 'Token role claim does not match users/{uid}.role',
      before: { claimRole },
      after: { docRole: role },
      severity: 'warn',
    });
    log.warn({
      actorUid: decoded.uid,
      code: 'ROLE_MISMATCH',
      claimRole,
      docRole: role,
    });
    throw new AppError({
      code: 'ROLE_MISMATCH',
      // No detail in the message: which value disagreed is not the caller's
      // business, and it is information about the account's authorisation.
    });
  }

  log.debug({ actorUid: decoded.uid, actorRole: role, path: pathOf(req) });

  return {
    uid: decoded.uid,
    role,
    status,
    displayName: typeof doc.displayName === 'string' ? doc.displayName : '',
    email: typeof doc.email === 'string' ? doc.email : '',
    authTimeSec: decoded.auth_time ?? 0,
    token: decoded,
  };
}

/* ========================================================================== */
/* Role and scope assertions                                                   */
/* ========================================================================== */

/**
 * The role gate. `403` when the caller's role is not in `allowed`.
 *
 * `403` rather than `404`: a role gate is a statement about capability, and the
 * caller already knows who they are. The `404` rule applies to RESOURCES
 * (see `assertResourceAccess`) where revealing existence is the leak.
 */
export function assertRole(user: AuthedUser, allowed: readonly UserRole[]): void {
  if (allowed.includes(user.role)) return;
  // Admin is NOT an implicit superuser here. Every check lists `admin`
  // explicitly, because "admin can do everything" is how a permission matrix
  // quietly stops being a matrix (docs/22 §3 rows 52–61 are admin-only, and
  // rows 59 and 61 deny admin too).
  throw new AppError({ code: 'FORBIDDEN' });
}

/**
 * Object-level authorisation. Throws **404**, never 403.
 *
 * A citizen asking for another citizen's incident must get an answer identical
 * to the one for an id that does not exist. Returning 403 says "that exists and
 * you may not have it" (docs/10 §6.4, US-005 AC4).
 *
 * `visibilityCheck` is supplied by the caller because visibility is
 * per-collection: a citizen sees their own reports, a responder sees assigned
 * ones, a dispatcher sees all. This function owns the *shape* of the decision
 * (404 on denial) so no collection can accidentally leak by throwing 403.
 */
export function assertResourceAccess(input: {
  visible: boolean;
  requestId: string;
  entityType: string;
  entityId: string;
}): void {
  if (input.visible) return;
  throw new AppError({
    code: input.entityType === 'user' ? 'USER_NOT_FOUND' : 'NOT_FOUND',
  });
}

/**
 * The hard denials (docs/22 §3 rows 59 and 61).
 *
 * These two are denied to EVERY role including admin, and they are the two
 * checks most likely to be "simplified away" under time pressure, so they live
 * here as named functions rather than as `if` statements inside a handler.
 */
export function assertNotSelfRoleChange(actorUid: string, targetUid: string): void {
  if (actorUid === targetUid) {
    throw new AppError({ code: 'SELF_ROLE_CHANGE_FORBIDDEN' });
  }
}

export function assertNotSelfDisable(actorUid: string, targetUid: string): void {
  if (actorUid === targetUid) {
    throw new AppError({ code: 'SELF_DISABLE_FORBIDDEN' });
  }
}

/**
 * Reject a body that tries to set `role` or `status`.
 *
 * Defence in depth against a specific mistake: a developer writing
 * `POST /api/me/bootstrap` who spreads the request body into the user document
 * would otherwise let a client choose its own role. The rules block the write
 * too, but a route that only reads `displayName` and `timezone` is the
 * difference between "cannot happen" and "cannot happen twice".
 *
 * Called with the raw parsed body, BEFORE any field selection.
 */
export function assertNoRoleInBody(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const record = body as Record<string, unknown>;
  if ('role' in record || 'status' in record || 'disabledReason' in record) {
    throw new AppError({
      code: 'ROLE_ESCALATION_GUARD',
      message:
        'This request cannot set role, account status, or a disabled reason. Those are server-owned.',
    });
  }
}

/** A reason long enough to be useful to whoever reads the audit log in a year. */
export function assertReasonPresent(reason: unknown, minLength = 10): void {
  if (typeof reason !== 'string' || reason.trim().length < minLength) {
    throw new AppError({
      code: 'REASON_REQUIRED',
      details: [{ field: 'reason', issue: `Must be at least ${minLength} characters.` }],
    });
  }
}

/**
 * The fields that record what the MODEL said, as opposed to what a human decided.
 *
 * Phase 14. Every key here is an append-only record of a real prediction. If a
 * reviewer — or a route with a `...body` spread — could set one, then the audit
 * trail would no longer distinguish "the model was wrong" from "somebody
 * back-dated a confident answer", and the entire low-confidence review queue
 * becomes theatre. Nothing downstream can recover that distinction once lost.
 *
 * `reviewedBy`/`reviewedAt` are listed too, even though a review legitimately
 * sets them: they are written by the review service from the AUTHENTICATED
 * caller, never read from a body. A caller-supplied reviewer identity is a
 * forged reviewer identity no matter what the field is called.
 */
const AI_RESULT_FIELDS = [
  'aiConfidence',
  'aiRuns',
  'aiTriage',
  'aiSummary',
  'aiRationale',
  'aiSuggestions',
  'triageSource',
  'aiModel',
  'aiReviewedBy',
  'aiReviewedAt',
  'reviewedBy',
  'reviewedAt',
] as const;

/**
 * Reject a body that tries to write a field recording the AI's own output.
 *
 * Defence in depth in exactly the same shape as `assertNoRoleInBody()`, and for
 * the same reason: the review schemas are `.strict()`, but a strict schema only
 * proves the ROUTE rejects the field. If a future refactor spreads the body into
 * the document, or adds the field to the schema for a legitimate reason and
 * forgets this list, `.strict()` is no longer the thing standing between a
 * caller and the immutable record. This function is.
 *
 * It runs BEFORE schema validation, on the raw body, so the refusal is the
 * specific `403 AI_RESULT_IMMUTABLE` rather than a generic "unrecognised key"
 * that would read to a developer as a typo rather than as a refusal.
 */
export function assertNoAiResultInBody(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const record = body as Record<string, unknown>;
  const attempted = AI_RESULT_FIELDS.filter((field) => field in record);
  if (attempted.length === 0) return;
  throw new AppError({
    code: 'AI_RESULT_IMMUTABLE',
    message:
      'The AI result cannot be changed. Record a review decision instead — the model’s answer is kept as history.',
    details: attempted.map((field) => ({ field, issue: 'Server-owned. Record a review decision instead.' })),
  });
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return 'unknown';
  }
}

/** Narrow an unknown `role` value from Firestore to a real role. */
export function asUserRole(value: unknown): UserRole | null {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
    ? (value as UserRole)
    : null;
}

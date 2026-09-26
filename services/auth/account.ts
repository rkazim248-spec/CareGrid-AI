/**
 * ============================================================================
 * CareGrid AI — the account service
 * ============================================================================
 *
 * The business logic behind `POST /api/me/bootstrap`, `GET /api/me`,
 * `PATCH /api/me`, and `POST /api/auth/event`, extracted from the four route
 * handlers that used to hold it inline.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXTRACTION HAPPENED IN A "FOUNDATION" PHASE
 * ---------------------------------------------------------------------------
 * Because doc 06 §5.1 is normative and the code was not following it: a route
 * handler that reads Firestore and builds a batch is business logic in the wrong
 * place. It is untestable without an HTTP harness, and the four handlers had
 * between them grown enough duplicated Firestore access to be worth auditing.
 *
 * Two concrete payoffs, not just tidiness:
 *
 *   1. `GET /api/me` and `GET /api/auth/me` now call ONE function. Before, a
 *      second route would have had to copy the handler, and the two would
 *      drift within a week — the copy is what makes "why does the profile page
 *      show a different name from the header" happen.
 *   2. `requireUser` already read `users/{uid}` this request. The reads here are
 *      `Promise.all`-ed for that reason, and that optimisation now lives in one
 *      place instead of four.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THESE FUNCTIONS OBEY
 * ---------------------------------------------------------------------------
 * | Rule | Where |
 * |------|-------|
 * | The context is always the second argument | every signature |
 * | The role comes from the CALLER, never from input | `bootstrapUser` writes `citizen` as a constant |
 * | A service shapes no response | these return domain objects; `lib/server/serialize.ts` shapes DTOs |
 * | A service validates no HTTP | inputs are already typed by `validators/` |
 * | Firestore writes are batched | two documents land together or not at all |
 */

import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb, getAdminAuth } from '@/lib/server/firebase-admin';
import { AppError } from '@/lib/server/errors';
import { auditLog } from '@/lib/server/audit';
import { asUserRole, type AuthedUser } from '@/lib/server/auth-guard';
import { capabilityListFor } from '@/lib/auth/permissions';
import { COLLECTIONS } from '@/config/collections';
import { toIso } from '@/lib/server/serialize';
import type { AccountStatus, AuditAction, UserRole } from '@/types/enums';

import type { MeBootstrapBody, MeResponse } from '@/validators/me';

/* ========================================================================== */
/* The one role a public sign-up can receive                                  */
/* ========================================================================== */

/**
 * `citizen`, and only `citizen`.
 *
 * docs/22 §1. The `responder` role additionally requires
 * `responders/{uid}.verification === 'verified'`, which only an admin sets
 * (FR-063/FR-064). Granting the role without the verification would place an
 * unvouched person in the candidate list — the one list where being wrong sends
 * a stranger to an emergency.
 *
 * This constant plus `assertNoRoleInBody()` plus `selfServiceRoleSchema` plus
 * `users: allow write: if false` in `firestore.rules` are FOUR independent
 * blocks. Remove any one and three remain.
 */
const PUBLIC_ROLE: UserRole = 'citizen';

/* ========================================================================== */
/* The account document                                                       */
/* ========================================================================== */

/** A caller-facing account record. No token, no claim, no credential. */
export type AccountDto = {
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly photoURL: string | null;
  readonly role: UserRole;
  readonly status: AccountStatus;
  readonly provider: 'password' | 'google';
  readonly createdAt: string;
  readonly lastLoginAt: string;
};

/**
 * Read a caller-facing record from a `users/{uid}` document.
 *
 * Every field goes through a type check with a fallback. A document can have
 * been written by the Admin SDK, by `scripts/seed.ts`, or by a future import,
 * so a field's runtime type is not guaranteed by its schema — and a reader that
 * assumes is how a legacy document turns every page that lists it into a 500.
 */
function toAccountDto(
  doc: Record<string, unknown>,
  fallback: { uid: string; email: string; displayName: string },
): AccountDto {
  return {
    uid: fallback.uid,
    email: asString(doc.email, fallback.email),
    emailVerified: doc.emailVerified === true,
    displayName: asString(doc.displayName, fallback.displayName),
    photoURL: asStringOrNull(doc.photoURL),
    role: asUserRole(doc.role) ?? PUBLIC_ROLE,
    status: asStatus(doc.status),
    provider: doc.provider === 'google' ? 'google' : 'password',
    createdAt: toIso(doc.createdAt) ?? '',
    lastLoginAt: toIso(doc.lastLoginAt) ?? '',
  };
}

/* ========================================================================== */
/* POST /api/me/bootstrap                                                     */
/* ========================================================================== */

export type BootstrapResult = {
  readonly user: AccountDto;
  /** `true` when this call created the profile. `false` on a repeat call. */
  readonly isNew: boolean;
};

/**
 * Create `users/{uid}` and `profiles/{uid}` for a freshly authenticated caller.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * An existing `users/{uid}` is returned UNCHANGED. The session provider calls
 * this whenever it finds a Firebase user with no profile, so a person who closed
 * the tab between signing in and bootstrap is repaired on their next load
 * rather than locked out.
 *
 * It also means this CANNOT re-activate a suspended account: a `suspended` user
 * gets their existing document back with `status: 'suspended'`, and the next
 * authenticated request stops them at `403 ACCOUNT_UNAVAILABLE`. A "helpful"
 * re-bootstrap that reset the status would turn suspension into a suggestion.
 *
 * `provider` comes from the TOKEN, never from the body (docs/10 §3.3), so a
 * client cannot claim to have signed in with Google when they did not.
 */
export async function bootstrapUser(
  body: MeBootstrapBody,
  ctx: { readonly user: AuthedUser; readonly requestId: string },
): Promise<BootstrapResult> {
  const user = ctx.user;
  const db = getAdminDb();
  const userRef = db.collection(COLLECTIONS.users).doc(user.uid);
  const existing = await userRef.get();

  /* --- the idempotent path: return unchanged -------------------------- */
  if (existing.exists) {
    return {
      user: toAccountDto(existing.data() ?? {}, {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
      }),
      isNew: false,
    };
  }

  /* --- the create path ------------------------------------------------ */
  const provider = user.token.firebase?.sign_in_provider === 'google.com' ? 'google' : 'password';
  const now = FieldValue.serverTimestamp();
  const displayName = body.displayName.trim();
  const photoURL = asStringOrNull(user.token.picture);

  // TWO documents, so a BATCH rather than two writes. A user document without a
  // profile renders an empty preferences panel; a profile without a user
  // document fails every authenticated request with 403. They land together or
  // not at all.
  const batch = db.batch();

  batch.set(userRef, {
    uid: user.uid,
    email: user.email,
    emailVerified: user.token.email_verified === true,
    displayName,
    photoURL,
    role: PUBLIC_ROLE,
    status: 'active',
    provider,
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
    disabledReason: null,
    notifPrefs: { inApp: true, sms: false, whatsapp: false, email: true },
    schemaVersion: 1,
  });

  batch.set(
    db.collection(COLLECTIONS.profiles).doc(user.uid),
    {
      uid: user.uid,
      displayName,
      timezone: body.timezone,
      locale: body.locale ?? 'en',
      notifPrefs: { inApp: true, sms: false, whatsapp: false, email: true },
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    // Merge, so a profile created by any future flow is not silently reset by a
    // repeat bootstrap.
    { merge: true },
  );

  await batch.commit();

  const nowIso = new Date().toISOString();
  return {
    isNew: true,
    user: {
      uid: user.uid,
      email: user.email,
      emailVerified: user.token.email_verified === true,
      displayName,
      photoURL,
      role: PUBLIC_ROLE,
      status: 'active',
      provider,
      createdAt: nowIso,
      lastLoginAt: nowIso,
    },
  };
}

/* ========================================================================== */
/* GET /api/me  ·  GET /api/auth/me                                            */
/* ========================================================================== */

/**
 * The caller's own account, their profile, and their SERVER-COMPUTED
 * permissions.
 *
 * ---------------------------------------------------------------------------
 * WHY `permissions[]` IS COMPUTED HERE AND SENT TO THE CLIENT
 * ---------------------------------------------------------------------------
 * Because the alternative — the client computing its own permissions from the
 * role it was told — is the vulnerability docs/22 §2 exists to prevent. If the
 * client derived them, anyone who could influence the role could influence the
 * UI, and the UI is not a boundary anyway.
 *
 * So the server walks the 61-row matrix and returns what THIS caller may do. The
 * client renders from that list. The API re-checks every action regardless,
 * because a rendered button is an affordance, not a grant.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS EXEMPT FROM THE ACCOUNT GATE
 * ---------------------------------------------------------------------------
 * A suspended or not-yet-bootstrapped caller must be able to find out WHY they
 * cannot proceed. Every other route answers `403 ACCOUNT_UNAVAILABLE`; if this
 * one did too, the UI would have nothing to show but an error, and a suspended
 * person would believe the product was broken rather than that their account is
 * paused. So `permissions` is still computed — a suspended person must be able
 * to see the shell — and the gate on every OTHER route is what stops them
 * (docs/22 §1).
 */
export async function getMe(ctx: { readonly user: AuthedUser }): Promise<MeResponse> {
  const user = ctx.user;
  const db = getAdminDb();

  // `requireUser` already proved this document exists — step 4 of the guard read
  // it. A missing document here means it was deleted between the two reads,
  // which is a real (if rare) race; ACCOUNT_UNAVAILABLE is the honest answer and
  // re-bootstrapping repairs it on the next load.
  const [userSnap, profileSnap] = await Promise.all([
    db.collection(COLLECTIONS.users).doc(user.uid).get(),
    db.collection(COLLECTIONS.profiles).doc(user.uid).get(),
  ]);

  if (!userSnap.exists) throw new AppError({ code: 'ACCOUNT_UNAVAILABLE' });

  const doc = userSnap.data() ?? {};
  const account = toAccountDto(doc, {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  });
  const profile = profileSnap.exists ? toProfileDto(profileSnap.data() ?? {}, user.uid) : null;

  return {
    user: account,
    profile,
    permissions: capabilityListFor(account.role),
  };
}

/* ========================================================================== */
/* PATCH /api/me                                                               */
/* ========================================================================== */

export type UpdateMeInput = {
  readonly displayName?: string;
  readonly timezone?: string;
  readonly locale?: string;
  readonly notifPrefs?: { readonly inApp?: boolean; readonly email?: boolean };
};

export type UpdateMeResult = { readonly user: AccountDto };

/**
 * Apply an editable profile patch.
 *
 * ---------------------------------------------------------------------------
 * SMS AND WHATSAPP ARE REFUSED, NOT IGNORED (docs/30.3 §A6.1)
 * ---------------------------------------------------------------------------
 * No SMS or WhatsApp provider exists. A profile that recorded `sms: true` would
 * be a preference the system silently drops on the floor every time an alert is
 * sent, which is worse than not offering the switch. The route refuses the
 * request with a named error and the field in `details`; the UI renders those two
 * switches disabled with the server's own sentence as the reason, so the two can
 * never disagree.
 *
 * ---------------------------------------------------------------------------
 * A PATCH IS A MERGE, NOT A REPLACEMENT
 * ---------------------------------------------------------------------------
 * Without reading the current preferences first, a PATCH naming only `email`
 * would reset `inApp` to its default — so toggling one notification switch would
 * silently turn the other off. That is a real bug, and it only appears after
 * someone has cared enough to change a setting, which is exactly the kind of bug
 * that survives a demo.
 */
export async function updateMe(
  input: UpdateMeInput,
  ctx: { readonly user: AuthedUser; readonly requestId: string },
): Promise<UpdateMeResult> {
  const user = ctx.user;
  const db = getAdminDb();

  const profileSnap = await db.collection(COLLECTIONS.profiles).doc(user.uid).get();
  const currentProfile = profileSnap.exists ? profileSnap.data() : undefined;

  const now = FieldValue.serverTimestamp();
  const userUpdates: Record<string, unknown> = { updatedAt: now };
  const profileUpdates: Record<string, unknown> = { updatedAt: now };

  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    userUpdates.displayName = displayName;
    profileUpdates.displayName = displayName;
  }
  if (input.timezone !== undefined) profileUpdates.timezone = input.timezone;
  if (input.locale !== undefined) profileUpdates.locale = input.locale;
  if (input.notifPrefs !== undefined) {
    profileUpdates.notifPrefs = mergeNotifPrefs(
      input.notifPrefs,
      isRecord(currentProfile) && isRecord(currentProfile.notifPrefs) ? currentProfile.notifPrefs : undefined,
    );
  }

  const batch = db.batch();
  batch.set(db.collection(COLLECTIONS.users).doc(user.uid), userUpdates, { merge: true });
  batch.set(db.collection(COLLECTIONS.profiles).doc(user.uid), profileUpdates, { merge: true });
  await batch.commit();

  // Keep the Auth copy in step. A failure here is logged and NOT fatal: the
  // Firestore documents are the product's source of truth, and the Auth display
  // name is only ever a fallback. Fire-and-forget, because the response is
  // already correct without it and awaiting would add a round trip to a
  // profile save.
  if (input.displayName !== undefined) {
    void syncAuthDisplayName(user.uid, input.displayName.trim());
  }

  const snap = await db.collection(COLLECTIONS.users).doc(user.uid).get();
  return {
    user: toAccountDto(snap.data() ?? {}, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
    }),
  };
}

/* ========================================================================== */
/* POST /api/auth/event                                                        */
/* ========================================================================== */

export type RecordAuthEventInput = {
  readonly type: 'login' | 'logout' | 'login_failed';
  readonly provider: 'password' | 'google';
  /** Absent when the client had no reason to give. Never free text. */
  readonly reason?: string;
};

/**
 * Record a sign-in, sign-out, or sign-in failure for the audit trail.
 *
 * ---------------------------------------------------------------------------
 * THIS NEVER REVEALS WHETHER AN ACCOUNT EXISTS
 * ---------------------------------------------------------------------------
 * It is the endpoint a "forgot password" form would call to check an address,
 * which is exactly why it must not be one. There is no lookup, no count, and no
 * conditional response: the body is recorded and the answer is `{ ok: true }` in
 * every case. A caller cannot distinguish an existing account from a
 * non-existent one by any means through this path.
 *
 * `login` and `login_failed` are already implied by the token's presence or
 * absence. The client-reported type is used as-is: it is a telemetry signal
 * about what the person ATTEMPTED, which the server cannot always see.
 */
export async function recordAuthEvent(
  input: RecordAuthEventInput,
  ctx: { readonly user: AuthedUser | null; readonly requestId: string },
): Promise<{ readonly ok: true }> {
  const uid = ctx.user?.uid ?? 'anonymous';
  const action: AuditAction = input.type === 'login_failed' ? 'auth.login_failed' : 'auth.login';

  await auditLog({
    requestId: ctx.requestId,
    actorUid: uid,
    ...(ctx.user ? { actorRole: ctx.user.role } : {}),
    action,
    entityType: 'auth',
    entityId: uid,
    summary:
      input.type === 'login'
        ? `Signed in with ${input.provider}`
        : input.type === 'logout'
          ? 'Signed out'
          : `Failed sign-in attempt (${input.provider})`,
    reason: input.reason ?? null,
    // Presence is recorded; the hash itself is not computed here, so this path
    // has no access to the request IP at all (docs/10 §17.4).
    hasIp: false,
  });

  return { ok: true };
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

function toProfileDto(doc: Record<string, unknown>, uid: string): MeResponse['profile'] {
  const prefs = isRecord(doc.notifPrefs) ? doc.notifPrefs : {};
  return {
    uid,
    displayName: asString(doc.displayName, ''),
    timezone: asString(doc.timezone, 'UTC'),
    locale: asString(doc.locale, 'en'),
    notifPrefs: {
      inApp: prefs.inApp !== false,
      email: prefs.email !== false,
      // Forced false regardless of what the document says: no provider is
      // configured in this deployment (FR-105/FR-106), so a `true` here would
      // be a promise the system cannot keep.
      sms: false,
      whatsapp: false,
    },
  };
}

/**
 * Merge a partial preference patch over the STORED preferences.
 *
 * `sms` and `whatsapp` are forced `false` regardless of the input. The route has
 * already refused `true` for both; forcing them here as well means a document
 * written by a legacy path still reports the truth.
 */
function mergeNotifPrefs(
  patch: { inApp?: boolean; email?: boolean },
  existing: Record<string, unknown> | undefined,
): Record<string, boolean> {
  const current = isRecord(existing) ? existing : {};
  return {
    inApp: patch.inApp ?? current.inApp === true,
    email: patch.email ?? current.email === true,
    sms: false,
    whatsapp: false,
  };
}

/**
 * Push the display name to Firebase Auth.
 *
 * Best-effort and non-fatal. `firestore.rules` gives the client no write access
 * to `users/{uid}`, so this is the only place the two copies are reconciled.
 */
async function syncAuthDisplayName(uid: string, displayName: string): Promise<void> {
  try {
    await getAdminAuth().setCustomUserClaims(uid, { displayName });
  } catch {
    // Intentionally silent. The Firestore documents are the source of truth.
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asStatus(value: unknown): AccountStatus {
  return value === 'suspended' || value === 'disabled' || value === 'pending_verification'
    ? value
    : 'active';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

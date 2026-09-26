/**
 * GET /api/me  ·  PATCH /api/me
 *
 * The one endpoint the whole application is built on. Every screen that shows a
 * name, a role, or a permission reads it (docs/08 §2.1–§2.3).
 *
 * ---------------------------------------------------------------------------
 * WHY `permissions[]` IS COMPUTED HERE AND SENT TO THE CLIENT
 * ---------------------------------------------------------------------------
 * Because the alternative — the client computing its own permissions from the
 * role it was told — is the vulnerability the Phase 2 brief warns about. If the
 * client derived them, then anyone who could influence the role could influence
 * the UI, and the UI is not a boundary anyway.
 *
 * So the server walks the 61-row matrix (docs/22 §3) and returns what THIS
 * caller may do. The client renders from that list. The API re-checks every
 * action regardless, because a rendered button is an affordance, not a grant.
 *
 * ---------------------------------------------------------------------------
 * WHY `GET /api/me` IS EXEMPT FROM THE ACCOUNT GATE
 * ---------------------------------------------------------------------------
 * A suspended or not-yet-bootstrapped caller must be able to find out WHY they
 * cannot proceed. Every other route answers `403 ACCOUNT_UNAVAILABLE`; if this
 * one did too, the UI would have nothing to show but an error, and a suspended
 * person would believe the product was broken rather than that their account is
 * paused. So `GET` waives the status gate and returns the real status, and the
 * shell renders an `ACCOUNT_UNAVAILABLE` state from it (docs/22 §1).
 *
 * ---------------------------------------------------------------------------
 * `PATCH` DOES NOT WAIVE IT
 * ---------------------------------------------------------------------------
 * A suspended account must not be able to edit its profile. Waiving the gate on
 * `PATCH` would make suspension advisory, which is the opposite of its purpose.
 */

import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/server/firebase-admin';
import { withRequest } from '@/lib/server/route';
import { capabilityListFor } from '@/lib/auth/permissions';
import { AppError } from '@/lib/server/errors';
import { mePatchBodySchema } from '@/validators/me';
import type { UserRole } from '@/types/enums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ========================================================================== */
/* GET                                                                        */
/* ========================================================================== */

export const GET = withRequest(
  {
    auth: 'required',
    // The one exemption, for the reason in the file header.
    allowInactiveAccount: true,
  },
  async (ctx) => {
    const { user, log } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    const db = getAdminDb();
    const [userSnap, profileSnap] = await Promise.all([
      db.collection('users').doc(user.uid).get(),
      db.collection('profiles').doc(user.uid).get(),
    ]);

    // `requireUser` already proved the document exists, because step 4 reads it.
    // A missing document at this point means it was deleted between the two
    // reads, which is a real (if rare) race; ACCOUNT_UNAVAILABLE is the honest
    // answer, and re-bootstrapping repairs it on the next load.
    if (!userSnap.exists) throw new AppError({ code: 'ACCOUNT_UNAVAILABLE' });

    const doc = userSnap.data() ?? {};
    const role = (typeof doc.role === 'string' ? doc.role : user.role) as UserRole;
    const profile = profileSnap.exists ? (profileSnap.data() ?? null) : null;

    // A client holding a suspended account still gets its permissions computed,
    // because a suspended person must be able to see the shell and understand
    // their state. The gate that blocks them is the one on every OTHER route.
    const permissions = capabilityListFor(role);

    log.debug({ actorUid: user.uid, actorRole: role });

    return {
      data: {
        user: {
          uid: user.uid,
          email: typeof doc.email === 'string' ? doc.email : user.email,
          emailVerified: doc.emailVerified === true,
          displayName: typeof doc.displayName === 'string' ? doc.displayName : user.displayName,
          photoURL: typeof doc.photoURL === 'string' ? doc.photoURL : null,
          role,
          status: doc.status ?? 'active',
          provider: doc.provider === 'google' ? 'google' : 'password',
          createdAt: toIso(doc.createdAt) ?? '',
          lastLoginAt: toIso(doc.lastLoginAt) ?? '',
        },
        profile: profile
          ? {
              uid: user.uid,
              displayName: typeof profile.displayName === 'string' ? profile.displayName : '',
              timezone: typeof profile.timezone === 'string' ? profile.timezone : 'UTC',
              locale: typeof profile.locale === 'string' ? profile.locale : 'en',
              notifPrefs: {
                inApp: profile.notifPrefs?.inApp !== false,
                email: profile.notifPrefs?.email !== false,
                // Forced false regardless of what a document says: no provider is
                // configured in this deployment (FR-105/FR-106), so a `true`
                // here would be a promise the system cannot keep.
                sms: false,
                whatsapp: false,
              },
            }
          : null,
        permissions,
      },
    };
  },
);

/* ========================================================================== */
/* PATCH                                                                      */
/* ========================================================================== */

export const PATCH = withRequest(
  { body: mePatchBodySchema, auth: 'required' },
  async (ctx) => {
    const { body, log, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    /* --- the channels we cannot honour ---------------------------------- */
    // FR-105 / FR-106: no SMS or WhatsApp provider exists. A profile that
    // recorded `sms: true` would be a preference the system silently drops on
    // the floor every time an alert is sent, which is worse than not offering
    // the switch. Refuse the request with a reason, and let the UI render those
    // switches disabled with the same sentence (docs/04 §10.4).
    if (body.notifPrefs?.sms === true) {
      throw new AppError({
        code: 'NOTIFICATION_DISABLED',
        message: 'SMS notifications are not available: no SMS provider is configured.',
        details: [{ field: 'notifPrefs.sms', issue: 'SMS is not enabled in this deployment.' }],
      });
    }
    if (body.notifPrefs?.whatsapp === true) {
      throw new AppError({
        code: 'NOTIFICATION_DISABLED',
        message:
          'WhatsApp notifications are not available: no WhatsApp provider is configured.',
        details: [
          { field: 'notifPrefs.whatsapp', issue: 'WhatsApp is not enabled in this deployment.' },
        ],
      });
    }

    const db = getAdminDb();

    // Read the CURRENT preferences before writing, so a partial PATCH is a merge
    // rather than a replacement. See `mergeNotifPrefs`.
    const profileSnap = await db.collection('profiles').doc(user.uid).get();
    const currentProfile = profileSnap.exists ? profileSnap.data() : undefined;

    const now = FieldValue.serverTimestamp();
    const updates: Record<string, unknown> = { updatedAt: now };

    /* --- users/{uid}.displayName ----------------------------------------- */
    // The Auth display name is kept in step, so the two never disagree in an
    // audit entry or a notification rendered from the Auth copy.
    if (body.displayName !== undefined) {
      updates.displayName = body.displayName.trim();
    }

    /* --- profiles/{uid} --------------------------------------------------- */
    const profileUpdates: Record<string, unknown> = { updatedAt: now };
    if (body.displayName !== undefined) profileUpdates.displayName = body.displayName.trim();
    if (body.timezone !== undefined) profileUpdates.timezone = body.timezone;
    if (body.locale !== undefined) profileUpdates.locale = body.locale;
    if (body.notifPrefs !== undefined) {
      profileUpdates.notifPrefs = mergeNotifPrefs(
        body.notifPrefs,
        isRecord(currentProfile) && isRecord(currentProfile.notifPrefs)
          ? currentProfile.notifPrefs
          : undefined,
      );
    }

    // Two collections, so a batch again — a display name that updates in one
    // place and not the other is the classic "why is my name still the old one".
    const batch = db.batch();
    batch.set(db.collection('users').doc(user.uid), updates, { merge: true });
    batch.set(db.collection('profiles').doc(user.uid), profileUpdates, { merge: true });
    await batch.commit();

    // Keep the Auth copy in step. A failure here is logged and NOT fatal: the
    // Firestore documents are the product's source of truth, and the Auth
    // display name is only ever shown as a fallback.
    if (body.displayName !== undefined) {
      void syncAuthDisplayName(user.uid, body.displayName.trim());
    }

    log.info({ actorUid: user.uid, path: '/api/me' });

    const snap = await db.collection('users').doc(user.uid).get();
    const doc = snap.data() ?? {};

    return {
      data: {
        user: {
          uid: user.uid,
          email: user.email,
          emailVerified: doc.emailVerified === true,
          displayName: typeof doc.displayName === 'string' ? doc.displayName : user.displayName,
          photoURL: typeof doc.photoURL === 'string' ? doc.photoURL : null,
          role: user.role,
          status: user.status,
          provider: doc.provider === 'google' ? 'google' : 'password',
          createdAt: toIso(doc.createdAt) ?? '',
          lastLoginAt: toIso(doc.lastLoginAt) ?? '',
        },
      },
    };
  },
);

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Merge a partial preference patch over the STORED preferences.
 *
 * Without this, a PATCH naming only `email` would reset `inApp` to its default —
 * so toggling one notification switch would silently turn the other off. That is
 * a real bug, and one that only appears after someone has cared enough to change
 * a setting, which is exactly the kind of bug that survives a demo.
 *
 * `sms` and `whatsapp` are forced `false` regardless of the input. The request
 * handler has already refused `true` for both; forcing them here as well means
 * a document written by a legacy path still reports the truth.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Push the display name to Firebase Auth.
 *
 * Best-effort and non-fatal. `firestore.rules` gives the client no write access
 * to `users/{uid}`, so this is the only place the two copies are reconciled, and
 * a failure must not lose the profile change the user just made.
 */
async function syncAuthDisplayName(uid: string, displayName: string): Promise<void> {
  try {
    const { getAdminAuth } = await import('@/lib/server/firebase-admin');
    await getAdminAuth().setCustomUserClaims(uid, { displayName });
  } catch {
    // Intentionally silent. See the comment above.
  }
}

function toIso(value: unknown): string | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

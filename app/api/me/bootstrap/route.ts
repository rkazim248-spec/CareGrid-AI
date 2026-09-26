/**
 * POST /api/me/bootstrap
 *
 * Create the `users/{uid}` and `profiles/{uid}` documents for a freshly
 * authenticated caller (docs/10 §3.2, docs/07 §3).
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * An existing `users/{uid}` is returned UNCHANGED. The session provider calls
 * this whenever it finds a Firebase user with no profile, so a person who
 * closed the tab between signing in and bootstrap is repaired on their next
 * load rather than locked out. It also means the route cannot re-activate a
 * suspended account: a `suspended` user returns the existing document with
 * `status: 'suspended'`, and the next authenticated request stops them at
 * `403 ACCOUNT_UNAVAILABLE`.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE IS WRITTEN HERE, NOT SUPPLIED
 * ---------------------------------------------------------------------------
 * `role: 'citizen'` is a constant in this file. Three independent blocks stop
 * anyone else choosing it:
 *   1. the request body has no role field and the Zod schema is `.strict()`,
 *   2. `assertNoRoleInBody()` catches a future widening of the schema, and
 *   3. `firestore.rules` sets `users: allow write: if false`, so even a bug in
 *      this file cannot be driven from a browser.
 * Removing any one leaves the other two standing. This paragraph is the threat
 * model for the file.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADMIN SDK AND NOT THE CLIENT SDK
 * ---------------------------------------------------------------------------
 * The client has `users: allow write: if false`. Only the Admin SDK can create
 * the document, which is what makes the role server-OWNED rather than merely
 * server-suggested.
 */

import { FieldValue } from 'firebase-admin/firestore';
import type { z } from 'zod';

import { getAdminDb } from '@/lib/server/firebase-admin';
import { withRequest } from '@/lib/server/route';
import { assertNoRoleInBody, asUserRole } from '@/lib/server/auth-guard';
import { meBootstrapBodySchema, userPublicSchema } from '@/validators/me';
import { AppError } from '@/lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The only role a public sign-up can receive (docs/22 §1).
 *
 * A `responder` additionally needs `responders/{uid}.verification = 'verified'`,
 * which only an admin sets (FR-063/FR-064). Granting the role without the
 * verification would place an unvouched person in the candidate list — the one
 * place where being wrong sends a stranger to an emergency.
 */
const PUBLIC_ROLE = 'citizen';

export const POST = withRequest(
  {
    body: meBootstrapBodySchema,
    // Authentication IS required. Only the `status !== 'active'` gate is waived,
    // which docs/22 §1 lists as one of the two exemptions — a pending or
    // suspended caller must be able to discover that they exist.
    auth: 'required',
    allowInactiveAccount: true,
  },
  async (ctx) => {
    const { body, log, user } = ctx;

    if (!user) {
      // Unreachable: `auth: 'required'` authenticates before the handler runs.
      throw new AppError({ code: 'AUTH_REQUIRED' });
    }

    // Belt and braces. The strict schema already rejects an injected `role` with
    // a 400; this catches the refactor that widens it.
    assertNoRoleInBody(body);

    const db = getAdminDb();
    const userRef = db.collection('users').doc(user.uid);
    const existing = await userRef.get();

    /* --- the idempotent path: return unchanged -------------------------- */
    if (existing.exists) {
      const doc = existing.data() ?? {};
      // A hand-edited or legacy document could hold a role outside the enum.
      // `asUserRole` returns null and we fall back to the least-privileged role
      // rather than trusting an unrecognised value.
      const role = asUserRole(doc.role) ?? PUBLIC_ROLE;
      log.info({ actorUid: user.uid, isNew: false, path: '/api/me/bootstrap' });

      return {
        status: 200,
        data: {
          user: userPublicSchema.parse({
            uid: user.uid,
            email: asString(doc.email, user.email),
            emailVerified: doc.emailVerified === true,
            displayName: asString(doc.displayName, user.displayName),
            photoURL: asStringOrNull(doc.photoURL),
            role,
            status: doc.status ?? 'active',
            provider: doc.provider === 'google' ? 'google' : 'password',
            createdAt: toIso(doc.createdAt) ?? new Date().toISOString(),
            lastLoginAt: toIso(doc.lastLoginAt) ?? new Date().toISOString(),
          }),
          isNew: false,
        },
      };
    }

    /* --- the create path ------------------------------------------------ */
    // `provider` comes from the TOKEN, never from the body (docs/10 §3.3), so a
    // client cannot claim to have signed in with Google when they did not.
    const provider =
      user.token.firebase?.sign_in_provider === 'google.com' ? 'google' : 'password';

    const now = FieldValue.serverTimestamp();
    const displayName = body.displayName.trim();
    const photoURL = asStringOrNull(user.token.picture);

    // TWO documents, so a BATCH rather than two writes. A user document without
    // a profile renders an empty preferences panel; a profile without a user
    // document fails every authenticated request with 403. They must land
    // together or not at all.
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
      db.collection('profiles').doc(user.uid),
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

    log.info({ actorUid: user.uid, isNew: true, path: '/api/me/bootstrap' });

    return {
      status: 201,
      data: {
        user: {
          uid: user.uid,
          email: user.email,
          emailVerified: user.token.email_verified === true,
          displayName,
          photoURL,
          role: PUBLIC_ROLE,
          status: 'active',
          provider,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        } satisfies z.infer<typeof userPublicSchema>,
        isNew: true,
      },
    };
  },
);

/* ========================================================================== */
/* Coercion helpers                                                            */
/* ========================================================================== */

/**
 * These exist because a document may have been written by the Admin SDK
 * (`Timestamp`), by a seed script (`Date`), or by a future import (ISO string).
 * Each returns a usable value or a safe default — never throws — because a
 * malformed timestamp on a profile is a display problem, not a reason to fail a
 * sign-in and strand the user in a loop.
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toIso(value: unknown): string | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

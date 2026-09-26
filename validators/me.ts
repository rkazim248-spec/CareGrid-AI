/**
 * ============================================================================
 * CareGrid AI — `/api/me` request and response schemas
 * ============================================================================
 *
 * The boundary schemas for the two account routes. Zod runs BEFORE any I/O
 * (docs/10 §13.1), so a malformed body is rejected with a `400` and a named
 * field rather than reaching Firestore.
 *
 * ---------------------------------------------------------------------------
 * `.strict()` ON EVERY REQUEST SCHEMA — THIS IS A SECURITY CONTROL
 * ---------------------------------------------------------------------------
 * An unknown key in a request body is rejected, not ignored. Three reasons, in
 * order of importance:
 *
 *   1. **`role` cannot ride along.** `assertNoRoleInBody()` also rejects it, but
 *      that is one function someone could forget to call. A strict schema is a
 *      property of the type, not a line in a handler.
 *   2. **Typos fail loudly.** `{ displayname: '…' }` is rejected instead of
 *      silently creating a user with no name, which is the class of bug that
 *      surfaces as "the name field is empty for some users".
 *   3. **It is a version boundary.** Adding a field to a request is an API
 *      change; a strict schema makes an old client fail visibly rather than
 *      half-work.
 *
 * Response schemas use `.strip()`-equivalent behaviour (Zod's default): an
 * unknown key from the server is dropped rather than fatal, because a newer
 * server should not break an older cached client.
 */

import { z } from 'zod';

import {
  accountStatusSchema,
  auditReasonSchema,
  displayNameSchema,
  emailSchema,
  passwordSchema,
  selfServiceRoleSchema,
  timezoneSchema,
  userRoleSchema,
} from '@/validators/enums';

/* ========================================================================== */
/* POST /api/me/bootstrap                                                     */
/* ========================================================================== */

/**
 * The body of `POST /api/me/bootstrap`.
 *
 * Only `displayName` and `timezone`. There is deliberately NO `role` field:
 * the route derives `citizen` on the server. Adding a role here is the single
 * most dangerous edit that could be made to this file, which is why the comment
 * is a threat rather than a description.
 */
export const meBootstrapBodySchema = z
  .object({
    displayName: displayNameSchema,
    timezone: timezoneSchema,
    /**
     * The `Accept-Language` header, recorded so a later translation feature has
     * a starting point. Never used to decide anything in v1.
     */
    locale: z.string().max(35).optional(),
  })
  .strict();

export type MeBootstrapBody = z.infer<typeof meBootstrapBodySchema>;

/* ========================================================================== */
/* GET /api/me                                                                 */
/* ========================================================================== */

export const userPublicSchema = z.object({
  uid: z.string().min(1),
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string(),
  photoURL: z.string().nullable(),
  role: userRoleSchema,
  status: accountStatusSchema,
  provider: z.enum(['password', 'google']),
  createdAt: z.string(),
  lastLoginAt: z.string(),
});

export const profileSchema = z.object({
  uid: z.string().min(1),
  displayName: z.string(),
  timezone: z.string(),
  locale: z.string(),
  notifPrefs: z.object({
    inApp: z.boolean(),
    sms: z.boolean(),
    whatsapp: z.boolean(),
    email: z.boolean(),
  }),
});

/**
 * `permissions` is a list of STABLE STRINGS, server-computed.
 *
 * Not a boolean per capability, and never derived on the client from the role:
 * a client that computed its own permissions would be computing them from a
 * role it chose. The server walks the 61-row matrix (docs/22 §3) and returns
 * what this caller may do; the UI renders from that list and re-checks nothing,
 * because it checks nothing it can enforce.
 */
export const meResponseSchema = z.object({
  user: userPublicSchema,
  profile: profileSchema.nullable(),
  permissions: z.array(z.string()),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
export type UserPublic = z.infer<typeof userPublicSchema>;
export type Profile = z.infer<typeof profileSchema>;

/* ========================================================================== */
/* PATCH /api/me                                                               */
/* ========================================================================== */

/**
 * The editable slice of a profile. Every field optional, so a PATCH touches
 * only what it names.
 *
 * `sms` and `whatsapp` are present in the SCHEMA but are refused by the route:
 * no provider is configured in this deployment (FR-105/FR-106), so enabling
 * them would record a preference that can never be honoured. The route rejects
 * `true` with a named error; the UI renders those switches disabled with that
 * reason as visible text (docs/04 §10.4).
 */
export const mePatchBodySchema = z
  .object({
    displayName: displayNameSchema.optional(),
    timezone: timezoneSchema.optional(),
    locale: z.string().max(35).optional(),
    notifPrefs: z
      .object({
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
        sms: z.boolean().optional(),
        whatsapp: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type MePatchBody = z.infer<typeof mePatchBodySchema>;

/* ========================================================================== */
/* POST /api/auth/event — audit only                                          */
/* ========================================================================== */

/**
 * A client-reported auth event. Used for the login-failure log (FR-135).
 *
 * `reason` is a closed set, so a client cannot use this endpoint to write an
 * arbitrary string into the audit log. It is a telemetry channel, not a
 * general-purpose log.
 */
export const authEventBodySchema = z
  .object({
    type: z.enum(['login', 'logout', 'login_failed']),
    provider: z.enum(['password', 'google']),
    reason: z.enum(['INVALID_PASSWORD', 'USER_NOT_FOUND', 'USER_DISABLED', 'NETWORK']).optional(),
  })
  .strict();

export type AuthEventBody = z.infer<typeof authEventBodySchema>;

/* ========================================================================== */
/* Client-side sign-up form                                                   */
/* ========================================================================== */

/**
 * The signup FORM schema, which includes a password confirmation the API never
 * sees. Split from `meBootstrapBodySchema` on purpose: the confirmation is a UI
 * affordance, and sending it would be sending a second copy of a password to a
 * server for no reason.
 *
 * `role` appears ONLY as a `citizen` literal, so the form literally cannot
 * submit a privileged role. A devious client bypassing the form is stopped by
 * the server schema, and by the rules; this is the first of the three blocks.
 */
export const signUpFormSchema = z
  .object({
    displayName: displayNameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    role: selfServiceRoleSchema.default('citizen'),
    acceptedDemoNotice: z.literal(true, {
      error: 'Acknowledge that this is a demonstration system.',
    }),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  });

export type SignUpForm = z.infer<typeof signUpFormSchema>;

/* ========================================================================== */
/* Client-side sign-in form                                                   */
/* ========================================================================== */

export const signInFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
});

export type SignInForm = z.infer<typeof signInFormSchema>;

/* ========================================================================== */
/* Admin — role change (FR-133)                                               */
/* ========================================================================== */

export const roleChangeBodySchema = z
  .object({
    role: userRoleSchema,
    reason: auditReasonSchema,
  })
  .strict();

export type RoleChangeBody = z.infer<typeof roleChangeBodySchema>;

export const accountStatusChangeBodySchema = z
  .object({
    status: accountStatusSchema,
    reason: auditReasonSchema,
  })
  .strict();

export type AccountStatusChangeBody = z.infer<typeof accountStatusChangeBodySchema>;

/* ========================================================================== */
/* The `next` redirect parameter                                              */
/* ========================================================================== */

/**
 * The post-sign-in redirect target.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN OPEN REDIRECT FIX AND NOT COSMETIC HYGIENE
 * ---------------------------------------------------------------------------
 * `?next=` is attacker-controlled. Without a check, `/login?next=https://evil.example`
 * signs a person in and then sends them to a convincing copy of the login page
 * on someone else's domain, which harvests the password they would re-type.
 * That is the standard phishing-via-redirect, and it is why every framework
 * treats it as a security bug.
 *
 * Three rules, all necessary:
 *   1. MUST start with a single `/` — so `//evil.example` (protocol-relative)
 *      and `https://evil.example` are both rejected.
 *   2. MUST NOT start with `//`.
 *   3. MUST NOT contain `\` — browsers normalise `/\` to `//`, so `/\evil.example`
 *      would pass rule 1 and then resolve off-site.
 *
 * On rejection the caller falls back to the ROLE landing route, which is what
 * the role decides, not the URL.
 */
export function sanitiseNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  // Control characters would allow a header-splitting attempt in a Location
  // header on some proxies.
  if (/[ -]/.test(value)) return null;
  return value;
}

# 10 — Authorization & Security

**Project:** CareGrid AI
**Document type:** Security engineering specification (authoritative for authorization, rules, headers, secrets, rate limits, and security testing)
**Status:** Baseline v1.0 — normative. The Security Rules in §9 and §11 are the deployable source of truth.
**Related:** [22 User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md) · [07 Database Schema §13](./07_DATABASE_SCHEMA.md) · [08 API Specification §1.6, §1.8, §1.9, §12](./08_API_SPECIFICATION.md) · [09 AI Spec §4.3, §10](./09_AI_GEMINI_SPECIFICATION.md) · [21 Environment Variables §6](./21_ENVIRONMENT_VARIABLES.md) · [15 File Storage Specification](./15_FILE_STORAGE_SPECIFICATION.md) · [24 Threat Model](./24_THREAT_MODEL_SECURITY.md)

---

## 0. How to read this document

This document is the implementation contract for *who may do what*. Where it disagrees with prose elsewhere, this document wins for authorization and transport security.

Three rules govern everything below:

1. **The server decides.** No authorization decision is ever made in the browser, in the CDN, in a client component, or from a value the client supplied ([08](./08_API_SPECIFICATION.md) §12, NFR-015).
2. **Role alone is never sufficient.** Every data access passes a role gate *and* a resource gate ([22](./22_USER_ROLES_PERMISSIONS.md) §5).
3. **Absence of a rule is a denial.** Both rules files end with an explicit deny-all catch-all. A collection that is not mentioned is not readable or writable by any client.

Terms used consistently across the project:

| Term | Meaning |
| --- | --- |
| `uid` | Firebase Auth UID; the doc ID of `users/{uid}`, `profiles/{uid}`, `responders/{uid}`, `responderLocations/{uid}` |
| `incidentId` | Firestore auto-ID (20 chars) of `incidents/{id}` |
| `reference` | Human code `CG-XXXXXX` ([07](./07_DATABASE_SCHEMA.md) §4.1) |
| `mediaId` | `med_` + 12 base32 chars ([15](./15_FILE_STORAGE_SPECIFICATION.md) §4) |
| **role gate** | "May this role perform this action *type*?" |
| **resource gate** | "May this user perform it on *this* document?" |
| **redaction** | Omitting a field in the response serialiser (`lib/api/serialize.ts`) |
| **claim mirror** | The `role` Firebase Auth custom claim, used *only* by Security Rules |
| **authoritative role** | `users/{uid}.role`, read from the Admin SDK on every request |

---

## 1. Security model overview

### 1.1 What we are protecting

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| **A dispatcher's authority** | A compromised dispatcher can assign any responder anywhere | `users/{uid}.role`, `dispatches` |
| **An admin's authority** | A compromised admin can grant roles, verify responders, change config | `users/{uid}.role`, `config/app` |
| **Citizen identity** | Disclosure harms the person reporting an emergency | `incidents.reporterUid`, `incidentReports.reporterUid`, `users/{uid}.email` |
| **Citizen precise location** | NFR-027, FR-038, NFR-028 treat it as personal data | `incidents.geo`, `incidentReports.geoOverride` |
| **Responder identity and live location** | Tracking a responder's movement is a safety and privacy harm | `responders`, `responderLocations` |
| **Evidence integrity** | A doctored or replayed photo is worse than no photo | Storage objects, `MediaRef.sha256` |
| **The audit trail** | Without it, no abuse is investigable and no incident is defensible | `auditLogs` (append-only) |
| **Service credentials** | The Admin SDK key bypasses *all* rules | `FIREBASE_PRIVATE_KEY` ([21](./21_ENVIRONMENT_VARIABLES.md) §6) |
| **The Gemini key** | Free-tier quota and cost | `GEMINI_API_KEY` |
| **Free-tier budget** | The $0 constraint is a security property, not a nice-to-have | Google Cloud billing |

### 1.2 Model in one diagram

```
                     UNTRUSTED                    SEMI-TRUSTED              TRUSTED
  ┌──────────────────────────────┐        ┌───────────────────┐   ┌─────────────────────────┐
  │  Browser (citizen, responder,│        │  Vercel CDN +     │   │  Next.js Route Handler  │
  │  dispatcher, admin)          │───────►│  middleware.ts    │──►│  (Vercel function)      │
  │  TB1                        │  TLS   │  TB2              │   │  TB3                    │
  │  - may lie about role        │  + ID  │  - headers only   │   │  - THE boundary         │
  │  - may lie about uid         │  token │  - no data access │   │  - requireUser()        │
  │  - may send arbitrary bytes  │        │  - no authz logic │   │  - assertRole()         │
  └──────────────────────────────┘        └───────────────────┘   │  - assertResourceAccess()│
            │                                        │            └────────────┬────────────┘
            │  direct Firestore listeners           │                         │ Admin SDK
            │  (bounded queries, rules-enforced)    │                         │ (bypasses rules)
            ▼                                        ▼                         ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  MANAGED DATA PLANE  —  TB4  (Firestore, Storage, Firebase Auth)                     │
  │  rules_version = '2' rules are the *second* boundary, not the only one               │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Security principles (binding on implementation)

| # | Principle | Consequence in code |
| --- | --- | --- |
| P1 | **Server-authoritative identity** | Role is read from `users/{uid}.role` per request; the token is only proof of *who*, never *what* |
| P2 | **Two gates, always** | A handler that calls `assertRole` without `assertResourceAccess` is a defect ([08](./08_API_SPECIFICATION.md) §12.4) |
| P3 | **Deny by default** | `match /{document=**} { allow read, write: if false; }` is mandatory and is the last rule in the file |
| P4 | **Validate before I/O** | Zod parse happens *before* any Firestore, Storage, Gemini, or Maps call (FR-142) |
| P5 | **Minimise** | A query that does not need a field must not select it; a response that does not need a field must omit it |
| P6 | **Append-only accountability** | `auditLogs` has no update and no delete path, for any role, including `admin` (FR-131) |
| P7 | **Fail closed** | A missing rule, a claim mismatch, a status other than `active`, an unparsable token, or an unverified resource access is a denial — never a permissive default |
| P8 | **Human decides anything irreversible** | The AI proposes; a `dispatcher`/`admin` disposes (DEC-05) |
| P9 | **No secret in the browser** | NFR-013; enforced by `scripts/check-bundle.ts` + gitleaks |
| P10 | **Audit the refusals that matter** | `auth.role_mismatch`, `auth.login_failed`, `incident.false_alarm`, `user.role_change` — abuse is detected by the log, not by guessing |

---

## 2. The six enforcement layers

These are the layers from [22](./22_USER_ROLES_PERMISSIONS.md) §6. **Layer names are normative** and are used verbatim in [03](./03_SYSTEM_ARCHITECTURE.md) §9 and [24](./24_THREAT_MODEL_SECURITY.md).

| # | Layer name | Mechanism | Where it lives | What it catches | What it does **not** catch |
| --- | --- | --- | --- | --- | --- |
| 1 | **UI affordance** | Buttons rendered from `GET /api/me` `permissions[]` and the per-incident `permissions[]` | `features/**`, `config/nav.ts` | Accidental misuse: a citizen never sees a "Merge" button; a responder never sees "Verify" | Nothing adversarial. It is a hint, not a boundary. A curl client bypasses it entirely |
| 2 | **API route** | `requireUser()` → `assertRole()` → `assertResourceAccess()` → `requireReason()` in **every** handler | `lib/server/auth-guard.ts`, surfaced as `lib/api/auth.ts` | The real boundary. Every horizontal and vertical escalation attempt lands here first (NFR-015) | Nothing that only the *client* can do. It cannot see a listener the client opened directly |
| 3 | **Server-side data shaping** | Field-level redaction in the response serialiser | `lib/api/serialize.ts` | PII leaking from a query that legitimately read the field — e.g. a responder's list row that carried `reporterUid` | Over-fetching that a rule would have stopped. It reduces blast radius; it does not reduce read cost |
| 4 | **Firestore Security Rules** | `role` claim + ownership + field allow-lists | `firestore.rules` (full text §9) | Any client-SDK read/write that bypasses the API: over-broad list queries, a crafted listener, a hand-rolled write from a modified client | Distance/radius visibility, multi-step lookups, "assigned responder may transition this incident", counting/rate limiting, incident state-machine validity (see §12) |
| 5 | **Storage Security Rules** | Path-derived ownership: `staging/{uid}/…` is the uploader's alone; `incidents/**` and `quarantine/**` are not client-writable at all | `storage.rules` (full text §11) | Direct Storage access with the client SDK: writing into another user's `staging/` prefix, reading or overwriting final evidence objects | Content type, magic bytes, pixel dimensions, and anything at all once a **V4 signed URL** is in the caller's hands (§12.4) |
| 6 | **Audit log** | Every privileged mutation recorded; append-only; no delete for any role | `services/**` → `lib/server/audit.ts` → `auditLogs` | Detection and accountability. It does not prevent | Prevention. An unlogged abuse is undetectable, which is why "must write an audit entry" is a code-review item, not a nice-to-have |

> **Defence-in-depth claim, stated precisely:** a bug in layer 1 is caught by layers 2–5. A bug in layer 2 is caught by layers 4–5 *for client-reachable paths*, and by layer 6 for server-only paths. A bug in layers 2 **and** 4 is caught by layer 6, after the fact, not before. **No single layer is trusted**, and layer 6 explicitly does not stop anything — it only tells us it happened.

### 2.1 Which layers apply to which access mode

| Access mode | Layers in the path | Notes |
| --- | --- | --- |
| RSC first paint (Server Component reads Firestore) | 2 → 3 → 4 | Uses the Admin SDK, so rules do not apply; role/resource checks are in `lib/server/require-session.ts` / `require-role.ts` |
| Route Handler (JSON API) | 1 → 2 → 3 (→ 4 only if a client listener also exists) | The canonical path |
| Client SDK Firestore listener | 1 → 4 (+ 3 for shaping) | Bypasses layer 2 entirely. This is the case rules exist for |
| Direct Storage `PUT` via signed URL | 5 **or** signed-URL bearer scope (§12.4) | Never layer 2 |
| Server SDK (Admin) | none of 4/5 | Service account bypasses rules by design; correctness depends on `services/**` |
| Middleware / CDN | headers only | **No** authorization decision ever ([05](./05_FRONTEND_ARCHITECTURE.md) §9.2) |

---

## 3. Authentication

### 3.1 Firebase Auth configuration (normative checklist)

| Setting | Value | Why |
| --- | --- | --- |
| Providers enabled | **Email/Password**, **Google** | [08](./08_API_SPECIFICATION.md) §2 |
| Authorized domains | `NEXT_PUBLIC_APP_URL` host(s) only | Blocks third-party-hosted auth abuse |
| Email/Password | enabled | `users/{uid}.provider = 'password'` ([07](./07_DATABASE_SCHEMA.md) §3) |
| Email link / passwordless | **disabled** | One passwordless flow is enough for v1; more flows = more `provider` enum drift |
| Phone auth | **disabled** | Would require a phone number in `users`, expanding the PII surface beyond the schema |
| Anonymous auth | **disabled** — enforced in code | DEC-10 rejects anonymous reporting; an anonymous uid with no `users/{uid}` doc is rejected by `requireUser()` with `403 ACCOUNT_UNAVAILABLE` |
| Session cookie / custom token | **not used** | §13 explains why |
| Default token lifetime | Firebase default (1 h), force-refresh on role change | `getIdToken(true)` |
| Email enumeration | Firebase Auth returns the same generic error for unknown-user and wrong-password by default; we additionally never call a server route that reveals existence | `POST /api/auth/event` **never** returns whether a user exists ([08](./08_API_SPECIFICATION.md) §2.4) |
| Multi-factor auth | **not enabled** | Documented accepted risk ([24](./24_THREAT_MODEL_SECURITY.md) residual-risk register, RR-08) |

### 3.2 Email/password flow

```
Browser                                     Firebase Auth                Our server
  │ createUserWithEmailAndPassword(…)             │                            │
  ├───────────────────────────────────────────────►│ creates uid                │
  │◄───────────────────────────────────────────────┤ returns user + idToken     │
  │                                               │                            │
  │ user.getIdToken()                             │                            │
  ├──────────────── POST /api/me/bootstrap ──────────────────────────────►│
  │                                               │      creates users/{uid}  │
  │                                               │      + profiles/{uid}     │
  │◄──────────────── 201 { user, isNew:false } ───────────────────────────┤
```

Rules:

- **There is no server-side login route.** The server only *verifies* tokens ([08](./08_API_SPECIFICATION.md) §2). A server login route would put a password in a Vercel function's request path, which is a strictly worse place for it.
- `POST /api/me/bootstrap` is **idempotent**: an existing `users/{uid}` is returned unchanged, never overwritten. It cannot be used to re-activate a `suspended` account (step 3 of the auth flow returns `403 ACCOUNT_UNAVAILABLE` first).
- The first `admin` is **never** created by a route. It is created out of band by `scripts/create-admin.ts` ([22](./22_USER_ROLES_PERMISSIONS.md) §8.1). No endpoint can create the first admin — a chicken-and-egg guard that would otherwise be a privilege-escalation vector.
- Password minimum strength, breach detection, and display-name rules are enforced by Firebase Auth; our `validators/me.ts` mirrors the **profile** bounds only.

### 3.3 Google OAuth flow

```
Browser                    Firebase Auth (popup)          Google            Server
  │ signInWithPopup(GoogleAuthProvider)                        │              │
  ├──────────────────────────────────►│──── accounts.google.com ────►│             │
  │◄─────────────────────────────────┤◄──── id_token (JWT) ─────────┤             │
  │  (no client secret is ever in the browser; the SDK uses      │             │
  │   the API key + authorized-domain check, not a client secret)│             │
  │                                               │             │
  │ POST /api/me/bootstrap with Firebase idToken ───────────────┼─────────────►│
```

Rules:

- `NEXT_PUBLIC_FIREBASE_API_KEY` is **not a secret** ([21](./21_ENVIRONMENT_VARIABLES.md) rule 6) but it is still restricted by HTTP referrer and by API enablement in the Google Cloud console.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` (§16) is **required**, otherwise `signInWithPopup` is broken. This is the one header value that is a direct functional requirement rather than a hardening measure, and it is called out here so nobody "tightens" it.
- The `provider` field on `users/{uid}` is derived from `token.firebase.sign_in_provider` (`'google.com'` → `google`), never from a request body field.
- **Account-linking attack surface:** Firebase links a Google identity to an existing email/password account automatically when the e-mail matches. A citizen who signed up with `a@x.com` and later uses Google with the same address becomes the same uid. This is intended (it prevents a second identity for one person) and is noted as a residual risk in [24](./24_THREAT_MODEL_SECURITY.md) RR-09: a takeover of the Google account silently takes over the CareGrid account.

### 3.4 Password reset

| Step | Who | Detail |
| --- | --- | --- |
| 1 | Browser | `sendPasswordResetEmail(auth, email)` with `actionCodeSettings.url = ${NEXT_PUBLIC_APP_URL}/login?mode=reset&oobCode=…` |
| 2 | Firebase | Sends the email; returns success regardless of whether the account exists |
| 3 | Browser | `/login?mode=reset` → `confirmPasswordReset(auth, oobCode, newPassword)` |
| 4 | Server | None. Reset does **not** change any authorization state |
| 5 | Audit | `auth.password_reset` is **not** an audited action: the server is not involved and cannot observe it. Documented gap; see §23 |

Rules:

- The client **must not** reveal whether an address is registered. The UI shows "If that address has an account, a reset link is on its way" regardless of outcome.
- The Firebase-provided `oobCode` is a one-time, single-use code. It is not a CareGrid token and carries no role information.
- After a reset the old ID tokens remain valid until they expire (1 h). Revocation is via `users/{uid}.tokensValidAfter` (see §4.4).

### 3.5 Account states (`users/{uid}.status`)

`status` is an **account-level gate orthogonal to `role`** ([22](./22_USER_ROLES_PERMISSIONS.md) §1).

| State | Set by | What the user can do | How the gate is enforced |
| --- | --- | --- | --- |
| `active` | default on bootstrap; admin re-enable | Everything their role allows | — |
| `pending_verification` | `POST /api/responders/:id/verify` on reject→approve cycle; set for a brand-new responder awaiting admin review | `POST /api/me/bootstrap`, `GET /api/me` only. **Every other route → `403 ACCOUNT_UNAVAILABLE`** | step 5 of the auth flow |
| `suspended` | `PATCH /api/admin/users/:id/status` (reason required) | Same as above, plus an `account_suspended` in-app notification (best-effort) | step 5 of the auth flow + token revocation (§4.4) |
| `disabled` | Admin (terminal in v1; enable is a separate audited action `user.enable`) | Same as above | step 5 of the auth flow |

```ts
// lib/server/auth-guard.ts — the exact gate
function accountGate(userDoc: UserDoc | null): AuthedUser {
  if (!userDoc) throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');   // no doc ⇒ not bootstrapped
  if (userDoc.status !== 'active') {
    auditLog({ actorUid: userDoc.uid, action: 'auth.blocked', entityType: 'user', entityId: userDoc.uid, reason: userDoc.status });
    throw new HttpError(403, 'ACCOUNT_UNAVAILABLE');
  }
  return { uid: userDoc.uid, role: userDoc.role, status: userDoc.status };
}
```

Only two routes are exempt from the `status !== 'active'` gate, and both are listed in [22](./22_USER_ROLES_PERMISSIONS.md) §1: `POST /api/me/bootstrap` and `GET /api/me`. `POST /api/auth/event` is **not** exempt from authentication but **is** exempt from the status gate, because a suspended user must still be able to report a logout.

### 3.6 Forced re-authentication for privileged actions

A privileged action requires a token issued within the last `REAUTH_WINDOW_SEC` (default **300 s**). The client calls `user.getIdToken(true)` immediately before the action, so `authTime` is fresh.

| Action | Requires re-auth | Re-auth window | Failure code |
| --- | --- | --- | --- |
| `PATCH /api/admin/users/:id/role` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `PATCH /api/admin/users/:id/status` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `POST /api/admin/config` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `POST /api/responders/:id/verify` · `/reject` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `POST /api/admin/maintenance/*` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `POST /api/notifications` (admin send) | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| `GET /api/admin/audit-logs?format=csv` | ✔ | 300 s | `403 REAUTH_REQUIRED` |
| Every other privileged action | ✖ (reason + audit is sufficient) | — | — |

```ts
// lib/api/auth.ts
export function assertReauth(token: DecodedIdToken, action: string): void {
  if (!REAUTH_ACTIONS.has(action)) return;
  const ageSec = (Date.now() / 1000) - (token.auth_time ?? 0);
  if (ageSec > REAUTH_WINDOW_SEC) {
    throw new HttpError(403, 'REAUTH_REQUIRED', { action, reauthWithinSec: REAUTH_WINDOW_SEC });
  }
}
```

> **Honest limitation.** `auth_time` is a *Firebase* claim. `getIdToken(true)` sets it to the current time, so the check is real — but it is only as strong as the client's willingness to call it. An attacker holding a valid token can refresh it. The purpose is therefore **not** to stop a determined attacker; it is to make a *stolen long-lived session* useless for a second, high-value action after it has been sitting around. `REAUTH_WINDOW_SEC` is a config value in `config/app.realtime` and is documented, not hidden.

---

## 4. Session and token lifecycle

### 4.1 There are no server sessions

| Property | Value |
| --- | --- |
| Session store | **none** |
| Session cookie | **none** |
| `SESSION_SECRET` | **not defined** ([21](./21_ENVIRONMENT_VARIABLES.md) §9) |
| Credential presented to the API | `Authorization: Bearer <Firebase ID token>` |
| Statelessness | Every request re-verifies the token and re-reads `users/{uid}` |

Consequence: there is no server-side session to hijack, no session table to leak, and no logout to trust. "Sign out" means "the client discards the token"; an attacker holding a copy of the token keeps access until it expires (≤ 1 h) or is revoked (§4.4).

### 4.2 Token acquisition and refresh

| Moment | Client call | Server |
| --- | --- | --- |
| Page load (session-restoring) | `onAuthStateChanged` → `getIdToken()` | — |
| Every API call | `getIdToken()` (cached by the SDK) | `verifyIdToken(token)` |
| `401 AUTH_EXPIRED` | `getIdToken(true)` then retry **once** | — |
| After a role change (the user is told "Your permissions changed — refresh to apply") | `getIdToken(true)` | claim now present |
| Before a re-auth action (§3.6) | `getIdToken(true)` | `auth_time` now fresh |
| On 403 `ROLE_MISMATCH` | `getIdToken(true)` once, retry once, then show a signed-out state | see §6.4 |

The SDK refreshes an expired token transparently. The explicit `getIdToken(true)` is only needed for a **force** refresh (role/claims change) or for the re-auth gate.

### 4.3 Token verification options

```ts
// lib/server/firebase-admin.ts
const decoded = await admin.auth().verifyIdToken(token, /* checkRevoked = */ true);
```

| Check | Where | Cost | Why |
| --- | --- | --- | --- |
| Signature | `verifyIdToken` | 1 network call (cached by the SDK for the token string) | The token is a signed JWT; the `alg` and `kid` are checked against Google's public keys |
| `aud == FIREBASE_PROJECT_ID` | SDK | included | A token minted for another project is rejected |
| `iss` = `https://securetoken.google.com/<projectId>` | SDK | included | — |
| `exp` | SDK | included | `AUTH_EXPIRED` is surfaced distinctly from `AUTH_INVALID_TOKEN` for a better client message |
| `checkRevoked: true` (reads `users/{uid}.tokensValidAfter`) | SDK | +1 Admin read | Enables instant revocation on suspension ([22](./22_USER_ROLES_PERMISSIONS.md) §8.3) |
| **`users/{uid}` role + status** | our code | +1 Admin read (mandatory, never cached across requests) | NFR-015. The token proves *who*; it does not decide *what* |

> **Caching rule, security-relevant.** `React cache()` may wrap the `users/{uid}` read **within a single request** so that `requireUser()` and two Server Components do not read it three times. It **must never** be cached across requests ([26](./26_PERFORMANCE_REQUIREMENTS.md) C-4): a cross-request cache would let a user suspended at T+1 keep passing the `status` gate until the cache expired. That is a security bug, not a performance bug.

### 4.4 Token revocation — `tokensValidAfter`

| Step | Action | Code |
| --- | --- | --- |
| 1 | Admin sets `status: 'suspended'` with a reason | `PATCH /api/admin/users/:id/status` |
| 2 | In the same transaction: `users/{uid}.status = 'suspended'`, `disabledReason = reason`, `users/{uid}.tokensValidAfter = <server now>` | `lib/server/auth-guard.ts` gate + `services/admin/set-user-status.ts` |
| 3 | `auditLogs` `user.disable` with `before`/`after` | `lib/server/audit.ts` |
| 4 | In-app notification `account_suspended` (best-effort, never fails the request) | `services/notifications/dispatch-notification.ts` |
| 5 | Every later `verifyIdToken(token, true)` for that uid now fails | the SDK compares `auth_time` with `tokensValidAfter` |

**Known residual risk, stated plainly:** revocation is enforced by the **API layer**. Firestore rules still permit an *old* token to read its own `users/{uid}` document until the token expires, because rules cannot read `tokensValidAfter` against `auth_time` in a way that is reliable across Firebase versions. This is exactly why every privileged read in this system is **server-mediated**: an old token can learn almost nothing that matters, because the API will refuse it. Accepted risk RR-01 in [24](./24_THREAT_MODEL_SECURITY.md).

---

## 5. The server-authoritative role model

### 5.1 Restatement

> **The client can never grant, change, or assert a role. Roles live in `users/{uid}.role` and are read on the server from the Admin SDK on every request. The Firebase Auth custom claim is a mirror used only by Security Rules.** ([22](./22_USER_ROLES_PERMISSIONS.md) §2)

### 5.2 Why a claim alone is not enough

A custom claim is a property of the **token**, and the token is a property of the **client**. Consequences:

| Property of a JWT | Why it is unacceptable as the authorization source |
| --- | --- |
| Issued at sign-in, valid 1 h | A role change would take up to 1 h to take effect. An admin demoting a compromised dispatcher would still be dispatching for an hour |
| Client-refreshable | `getIdToken(true)` fetches a *new* token. If the claim is the only copy of the role, then "make this token stop working" requires the claim itself to be revocable |
| Not transactionally bound to Firestore | `setCustomUserClaims` is a separate Admin API call; it cannot participate in a `runTransaction` ([07](./07_DATABASE_SCHEMA.md) §12.7). A claim write can fail after the Firestore write succeeded, leaving two sources of truth disagreeing |
| Opaque to rules-free code | Rules need a value in the token; the API needs a value it can trust. Only one of those can be authoritative |

### 5.3 The resolution: Firestore authoritative, claim mirrored

```
   user.role_change
          |
          v
   +----------------------------------------------------------+
   | runTransaction                                          |
   |   users/{uid}.role          = newRole                   |
   |   users/{uid}.roleChangedAt = now                        |
   |   users/{uid}.roleChangedBy = adminUid                   |
   |   auditLogs user.role_change { before, after, reason }   |
   +----------------------------------------------------------+
          |
          |   NOT atomic with Firebase Auth
          v
   setCustomUserClaims(uid, { role: newRole })      x 3 retries
          |                              |
        success                        failure
          |                              |
          v                              v
   roleChangePending = false       roleChangePending = true
   normal path                     + audit auth.role_mismatch
                                   + admin alert
                                   + 202 { claimsSynchronised: false }
```

And on **every** request:

```
requireUser()
  1. verifyIdToken(token, true)                       → 401 AUTH_INVALID_TOKEN
  2. db.get(users/{uid})                               → 403 ACCOUNT_UNAVAILABLE if absent
  3. role = userDoc.role                               ◄── AUTHORITATIVE
  4. if (token.role !== role) → 403 ROLE_MISMATCH + auditLogs auth.role_mismatch
  5. if (userDoc.status !== 'active') → 403 ACCOUNT_UNAVAILABLE
  6. return { uid, role, status }
```

### 5.4 The claim-drift failure mode, in full

**Drift** is a state where `token.claims.role !== users/{uid}.role`. There are exactly three causes:

| Cause | Direction | What actually happened | Our response |
| --- | --- | --- | --- |
| **D1 — newly granted role, user has not refreshed** | claim is *stale-low* (`citizen` vs `dispatcher` in Firestore) | A dispatcher promoted an hour ago still has a citizen token | `403 ROLE_MISMATCH`. The user sees "Your permissions changed — refresh to apply", calls `getIdToken(true)`, retries once. This is a **false positive for security and the correct behaviour for availability** |
| **D2 — claim write failed** | claim is *stale-low* and `roleChangePending === true` | The Firestore write committed, `setCustomUserClaims` failed 3× | Identical 403, but the admin who performed the change saw `202 { claimsSynchronised: false }`. `roleChangePending` is picked up by the retry job / `POST /api/admin/users/:id/reset-claims` |
| **D3 — claim tampered or forged (rules are the only defence here)** | claim is *stale-high* (`admin` while Firestore says `citizen`) | Somebody wrote an elevated claim directly, or a token was minted for a different context | `403 ROLE_MISMATCH` **plus** an `auth.role_mismatch` audit entry at `warning` severity. The API refuses the request even though the claim would have satisfied the rules |

**Design decision:** drift is a **`403`, never a silent override in either direction.** The obvious alternative — "trust Firestore and ignore the claim" — would silently defeat the claim-drift *detection* signal that protects layer 4. By refusing, a drift becomes both a denial *and* a recorded event, so the population of drifting uids is countable from `auditLogs`.

```
-- Finding drift, from the admin audit UI
SELECT * FROM auditLogs WHERE action = 'auth.role_mismatch' AND createdAt > now() - 24h
GROUP BY actorUid
-- Any uid with > 3 mismatches in 24 h is a bug or an active token-minting attempt.
```

**Pending-marker retry.** `users/{uid}.roleChangePending` is written by `services/admin/change-role.ts` and cleared only on a confirmed `setCustomUserClaims` success. It is retried:

1. inline, up to 3 times, with 1 s / 2 s / 4 s backoff;
2. by the admin pressing **Re-sync claims** → `POST /api/admin/users/:id/reset-claims` (reason required, audited);
3. by a maintenance sweep when `ENABLE_MAINTENANCE_JOBS=true`.

While the marker is set, **the user is more restricted, never less**: the API denies on drift, and rules read the old claim. A half-applied role change therefore fails closed.

### 5.5 What the client may know, and what it may not

| Client-visible | Source | Security weight |
| --- | --- | --- |
| `permissions[]` from `GET /api/me` | Server-computed from the authoritative role | **Zero.** An affordance list |
| `permissions[]` for a specific incident from `GET /api/incidents/:id` | Server-computed from role + resource | **Zero.** An affordance list |
| `role` in a JWT claim | Firebase | Layer-4 only |
| `role` in a request body / query / custom header | — | **None. It has no effect.** There is no code path that reads a role from a request |

Explicit anti-patterns, all of which are lint/review items:

```ts
// ✗ FORBIDDEN — role from the request
const role = body.role;                    // no such field exists in any schema
// ✗ FORBIDDEN — role from a query string
if (role === 'admin') { /* … */ }
// ✗ FORBIDDEN — role from a custom header
if (req.headers['x-role'] === 'admin') { /* … */ }
// ✗ FORBIDDEN — role read from localStorage
const role = localStorage.getItem('role');
// ✓ CORRECT — the only way
const auth = await requireUser(req);       // { uid, role, status } from users/{uid}
```

Every request schema in `validators/*.ts` is `.strict()`. A body containing `role`, `status`, `verification`, `reporterUid`, `assigneeUid`, or `verifiedAt` is a `400 VALIDATION_FAILED`, not a silently-ignored field. This is the first of two independent defences against vertical escalation: the schema rejects it, and even if it did not, the service layer overwrites those fields from the authenticated context.

---

## 6. The API authorization surface

### 6.1 Module layout

| Concern | Implementation file | Public surface |
| --- | --- | --- |
| The whole pipeline | `lib/server/auth-guard.ts` + `lib/server/csrf.ts` + `lib/server/rate-limit.ts` + `lib/server/request-id.ts` | re-exported from `lib/api/auth.ts` — **the only module `app/api/**` imports for authorization** |
| RSC session gate | `lib/server/require-session.ts` | `requireSession()` → `redirect('/login?next=…')` |
| RSC role gate | `lib/server/require-role.ts` | `requireRole(roles)` → renders `<ForbiddenState />` |
| Response shaping | `lib/api/serialize.ts` | `serializeIncident()`, `serializeIncidentRow()`, `serializeResponder()`, `redactForRole()` |
| Audit | `lib/server/audit.ts` | `auditLog(entry)` — always inside the caller's transaction |

> The two `require*` names exist for two different layers and must not be confused. **`assertRole`/`assertResourceAccess` are the API boundary and throw an error envelope. `requireRole` is the RSC/UI-layer gate and renders a `403` state instead of redirecting** ([05](./05_FRONTEND_ARCHITECTURE.md) §9.1: on failure it renders `<ForbiddenState />` in place of `{children}` and returns normally, preserving the URL and avoiding redirect loops).

### 6.2 Signatures

```ts
// lib/api/auth.ts — the complete authorization surface

export type Role = 'citizen' | 'responder' | 'dispatcher' | 'admin';

export type AuthedUser = {
  uid: string;
  role: Role;
  status: 'active';
  email: string;
  displayName: string;
  tokensValidAfterOk: true;   // verified with checkRevoked: true
};

export type ResourceKind = 'incident' | 'report' | 'dispatch' | 'responder' | 'notification' | 'media' | 'user' | 'auditLog';

/** Steps 1–5 of [08](./08_API_SPECIFICATION.md) §1.6. Throws HttpError(401|403). */
export function requireUser(req: Request): Promise<AuthedUser>;

/** Gate 1. Throws 403 FORBIDDEN when the caller's role is not in `roles`. */
export function assertRole(user: AuthedUser, roles: Role | Role[], action: string): void;

/** Gate 2. Returns the loaded document or throws 404 INCIDENT_NOT_FOUND / MEDIA_NOT_FOUND. */
export function assertResourceAccess<K extends ResourceKind>(
  user: AuthedUser,
  kind: K,
  id: string,
  opts?: { write?: boolean; sub?: 'reports' | 'statusHistory' | 'resources' },
): Promise<ResourceDoc<K>>;

/** FR-133. Throws 400 REASON_REQUIRED when the reason is missing or < 10 chars. */
export function requireReason(reason: unknown, opts?: { min?: number; max?: number; field?: string }): string;

/** §3.6. Throws 403 REAUTH_REQUIRED when auth_time is older than the window. */
export function assertReauth(token: DecodedIdToken, action: string): void;

/** Defence in depth. Throws 403 CSRF_FAILED. */
export function assertSameOrigin(req: Request): void;

/** Throws 429 RATE_LIMIT_EXCEEDED with Retry-After. */
export function rateLimit(opts: { subject: string; route: string; limit: number; windowSec: number }): Promise<void>;

/** Computes the client IP. Requires RATE_LIMIT_TRUST_PROXY=true on Vercel. */
export function clientIp(req: Request): string;
```

### 6.3 The exact order of checks (normative)

Order matters. Each step is cheap relative to the one after it, and a failed step must not have touched the database beyond the minimum.

| # | Step | Code | On failure | Why here and not later |
| --- | --- | --- | --- | --- |
| 1 | `requestId` | `lib/server/request-id.ts` | — | FR-141; must exist before any log line |
| 2 | `runtime = 'nodejs'` assertion | module export | build error | Admin SDK + Gemini need Node |
| 3 | `Authorization` header present | `requireUser` | `401 AUTH_REQUIRED` | Cheapest check |
| 4 | `verifyIdToken(token, true)` | `requireUser` | `401 AUTH_INVALID_TOKEN` / `401 AUTH_EXPIRED` | — |
| 5 | `users/{uid}` exists | `requireUser` | `403 ACCOUNT_UNAVAILABLE` | — |
| 6 | Role resolved **from the doc** | `requireUser` | — | NFR-015 |
| 7 | Claim cross-check | `requireUser` | `403 ROLE_MISMATCH` + `auditLogs auth.role_mismatch` | Drift detection (§5.4) |
| 8 | `status === 'active'` | `requireUser` | `403 ACCOUNT_UNAVAILABLE` | — |
| 9 | `assertRole` (Gate 1) | `assertRole` | `403 FORBIDDEN` | Before any resource I/O: a citizen must not learn an incident exists by triggering a Firestore read |
| 10 | `assertReauth` (§3.6, if the action is privileged) | `assertReauth` | `403 REAUTH_REQUIRED` | — |
| 11 | `assertSameOrigin` (non-GET) | `assertSameOrigin` | `403 CSRF_FAILED` | §13 |
| 12 | `rateLimit` | `rateLimit` | `429 RATE_LIMIT_EXCEEDED` | Before validation, so a flood of malformed requests is also rate limited |
| 13 | Zod parse of **body, query, and params** | `validators/*.ts` | `400 VALIDATION_FAILED` with `details[]` | FR-142: *before any database or AI call* |
| 14 | `assertResourceAccess` (Gate 2) | `assertResourceAccess` | `404` for reads, `403 FORBIDDEN` / `409` for writes | Needs the validated `id` from step 13 |
| 15 | `requireReason` (if the action is privileged) | `requireReason` | `400 REASON_REQUIRED` | FR-133 |
| 16 | Domain/service logic | `services/**` | catalogue codes | — |
| 17 | `auditLog` **in the same transaction** | `lib/server/audit.ts` | the whole request fails | FR-130/131: an unaudited privileged write is a failed write |
| 18 | Serialize + redact for the caller's role | `lib/api/serialize.ts` | — | Layer 3 |
| 19 | Envelope + `Cache-Control: no-store` | `lib/api/auth.ts` | — | [08](./08_API_SPECIFICATION.md) §12.12 |

> **Why the role gate precedes the resource gate.** If the resource gate ran first, a `citizen` calling `PATCH /api/incidents/{id}` for someone else's incident would receive `404` (correct) but the handler would still have performed a `get()` on `incidents/{id}` — a free existence oracle and a read-budget cost for an unauthorized caller. Running `assertRole` first means an unauthorized role never reaches the datastore at all.

### 6.4 `401` vs `403` vs `404` — the exact contract

| Code | Status | Meaning | Examples |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No `Authorization` header | Anonymous `GET /api/incidents` |
| `AUTH_INVALID_TOKEN` | 401 | Signature/audience/issuer invalid, or malformed | Tampered token, token from another project |
| `AUTH_EXPIRED` | 401 | `exp` in the past, and the client did not force-refresh | — |
| `ACCOUNT_UNAVAILABLE` | 403 | Valid token, but no `users/{uid}` doc, or `status !== 'active'` | Suspended account; un-bootstrapped uid |
| `ROLE_MISMATCH` | 403 | Claim and Firestore role disagree | §5.4 |
| `FORBIDDEN` | 403 | Gate 1 passed-or-failed for a role-insensitive action; **or** Gate 1 passed and Gate 2 failed on a **write** | Citizen → `POST /dispatch`; responder B → `PATCH` an incident assigned to A |
| `REAUTH_REQUIRED` | 403 | Privileged action without a fresh token | §3.6 |
| `CSRF_FAILED` | 403 | `Origin`/`Referer` mismatch on a non-GET | §13 |
| `UPLOAD_FORBIDDEN_PATH` | 403 | Storage path not matching the pattern, or not issued to this uid | §17 of [08](./08_API_SPECIFICATION.md) |
| `INCIDENT_NOT_FOUND` | 404 | **Either** the document does not exist **or** Gate 2 refused a read | Citizen A reads citizen B's incident |
| `MEDIA_NOT_FOUND` | 404 | Either the object does not exist, or the caller may not see it | Cross-user media reference |
| `NOTIFICATION_NOT_FOUND` | 404 | Either it does not exist, or `recipientUid !== uid` | — |
| `RESPONDER_NOT_FOUND` | 404 | Either no such responder, or a citizen may not enumerate responders | — |
| `USER_NOT_FOUND` | 404 | Admin-only user routes | — |

**Non-existence opacity (US-005).** On a **read**, Gate 2 failure returns the *identical* status, code, and body as a genuinely missing document:

```json
{ "success": false,
  "error": { "code": "INCIDENT_NOT_FOUND",
             "message": "Incident could not be found.",
             "requestId": "req_7Kd2mQ9xL4n" } }
```

Both paths must be byte-identical. `tests/integration/api/incidents/opacity.test.ts` asserts this for the missing / not-mine pair on `GET /api/incidents/:id`, `GET /api/incidents/:id/export`, and `GET /api/uploads/:mediaId/url`.

**Why `404` and not `403` for a refused read:** `403` is an oracle. A caller who can distinguish "exists but not yours" from "does not exist" can enumerate the platform — incident counts, whether a neighbourhood has an active fire, whether a named person reported anything. `403` is reserved for the cases where the *existence of the resource is not the secret*: an action type the role may never perform, and a write the caller was never allowed to attempt.

---

## 7. Authorization decision table

One row per endpoint in [08](./08_API_SPECIFICATION.md). **Role gate** = Gate 1. **Resource gate** = Gate 2. **Redactions** are applied by `lib/api/serialize.ts` after the query.

| # | Endpoint | Role gate | Resource gate | Field-level redactions / notes |
| --- | --- | --- | --- | --- |
| 1 | `POST /api/me/bootstrap` | any authenticated | n/a (self) | Exempt from the `status` gate. Idempotent; never overwrites |
| 2 | `GET /api/me` | any authenticated | self | Exempt from the `status` gate. `permissions[]` is server-computed |
| 3 | `PATCH /api/me` | any authenticated | self | Schema excludes `role`, `status`, `verification`, `email` → `400` if sent |
| 4 | `POST /api/auth/event` | optional token | n/a | Never reveals whether a user exists. Status-gate exempt |
| 5 | `POST /api/incidents` | all four roles | `reporterUid` forced to caller; media paths must be caller's | `reporterAnon` forced `false`. List of items ≤ 3 (3 images / 1 audio) |
| 6 | `GET /api/incidents` | all four | citizen ⇒ **forced** `reporterUid == self`, other filters ignored; responder ⇒ own + assigned + in-radius-unassigned when `available`; dispatcher/admin ⇒ all | Rows omit `originalText`, `requiredResources`, `reporterUid`, `ipHash`, `searchTokens` for non-privileged callers. `includeDeleted` is dispatcher/admin and audited |
| 7 | `GET /api/incidents/:id` | all four | own · assigned · in-radius-unassigned (responder) · any (dispatcher/admin) | Responder on a non-assigned incident: `reporterUid`, `reporter.displayName`, `reporter.email`, `locationText`, `ipHash`, `reports[].text` (non-original), `ai.model`, `ai.promptVersion`, `ai.rawOutputHash` all omitted. Reporter identity never reaches a responder (FR-068, NFR-027) |
| 8 | `PATCH /api/incidents/:id` | dispatcher/admin (any field); reporter (own, pre-verify, `location` only) | own + `status ∈ {new, triaged}` for a reporter | `.strict()`; `reporterUid` and `status` are not settable. `FORBIDDEN` for a responder |
| 9 | `POST /api/incidents/:id/triage` | dispatcher/admin; reporter on own `new`/`triaged` | own or any (dispatcher) | Never changes status beyond `new → triaged`; never verifies; never dispatches |
| 10 | `POST /api/incidents/:id/dispatch` | dispatcher/admin | incident must be in an assignable status | `assigneeUid` derived, not supplied. `409 ALREADY_ASSIGNED` when an active dispatch exists and `replaceExisting` is false |
| 11 | `GET /api/incidents/:id/dispatch/candidates` | dispatcher/admin | incident must be readable | Returns ≤ 10 candidates. No `phone`, no `email`, no `verificationNote` |
| 12 | `PATCH /api/incidents/:id/status` | per the transition table ([07](./07_DATABASE_SCHEMA.md) §4.3) | responder must be the assignee for `en_route`/`on_scene`/`resolved`; dispatcher/admin any | A responder may not skip states (`TRANSITION_NOT_ALLOWED_YET`). Dispatcher skip requires `reason ≥ 10` and records `metadata.skippedStates` |
| 13 | `POST /api/incidents/:id/merge` | dispatcher/admin | both incidents must be readable; secondary must have no active assignment | `reason` 10–280. Audit `incident.merge` with before/after. Never hard-deletes the secondary |
| 14 | `POST /api/incidents/:id/merge/undo` | dispatcher/admin | `mergeUndoUntil > now` | `reason` required; audit `incident.merge_revert` |
| 15 | `POST /api/incidents/:id/duplicates/dismiss` | dispatcher/admin | readable | `reason` required |
| 16 | `DELETE /api/incidents/:id` | dispatcher (reason required), admin (with or without) | not already deleted | Soft delete only. `409 INCIDENT_ALREADY_DELETED` |
| 17 | `POST /api/incidents/:id/restore` | dispatcher/admin | `deletedAt != null` | Audit `incident.restore` |
| 18 | `GET /api/incidents/:id/export` | dispatcher/admin | ids must be readable; ≤ 200 ids | **Never** exports reporter identity, `ipHash`, or free text. `text/csv` with a sanitised filename |
| 19 | `GET /api/responders` | dispatcher/admin full; responder own; citizen `403 FORBIDDEN` | self-only for a responder | `phone` never returned here (only in `GET /api/responders/:id` for dispatcher/admin) |
| 20 | `GET /api/responders/:id` | dispatcher/admin, or self | self or any (dispatcher/admin) | `phone`, `certifications`, `verificationNote`, `homeBase` only for dispatcher/admin |
| 21 | `PATCH /api/responders/:id` | self (`status`, `capabilities`, `serviceRadiusM`, `phone`, `notifPrefs`); dispatcher (`+ homeBase`, `note`); admin (all **except** `verification`) | self or any (dispatcher/admin) | `verification` has its own route. Dispatcher writes to `verification*` ⇒ `403 FORBIDDEN` |
| 22 | `PATCH /api/responders/:id/location` | self only, or dispatcher/admin for manual correction | `uid` must equal the token uid | Writing another responder's `responderUid` ⇒ `403 FORBIDDEN`. `429 HEARTBEAT_TOO_FREQUENT` when `capturedAt` moves < 20 s. Visibility of the collection is dispatcher/admin only |
| 23 | `POST /api/responders/:id/verify` | **admin only** | responder must exist | `note` required. Sets `verification` + flips `users/{uid}.status`. Audit `responder.verify` |
| 24 | `POST /api/responders/:id/reject` | **admin only** | responder must exist | `note` required. Sets `status = suspended`. Audit `responder.reject` |
| 25 | `GET /api/responders/:id/incidents` | responder (own), dispatcher/admin | responder ⇒ only incidents where they are/were the assignee | Rows redacted per row 7 |
| 26 | `GET /api/dispatches` | responder (own), dispatcher/admin | `responderUid == uid` for a responder | Citizen `403`. `note` (dispatcher instruction) is not reporter-authored |
| 27 | `POST /api/dispatches/:id/claim` | responder | dispatch must be `active`, unexpired, responder `verified` + `available` | `409 DISPATCH_EXPIRED` / `DISPATCH_ALREADY_ACCEPTED`. No citizen path at all |
| 28 | `POST /api/dispatches/:id/withdraw` | dispatcher/admin, or the assigned responder pre-acceptance | `reason` required either way | Audit `incident.unassign` |
| 29 | `GET /api/dispatches/summary` | dispatcher/admin | n/a (aggregate) | No per-responder PII beyond `displayName` |
| 30 | `GET /api/notifications` | all four | **always** `where('recipientUid','==',token.uid)` | **Never** accepts a `recipientUid` parameter. `actor.displayName` hidden from a responder when the actor is a citizen |
| 31 | `PATCH /api/notifications/:id` | all four | `recipientUid == uid` | Only `read`/`readAt` are mutable |
| 32 | `POST /api/notifications/read-all` | all four | own only; `writeBatch` ≤ 200 | `422 BATCH_TOO_LARGE` above 200 |
| 33 | `POST /api/notifications` | **admin only** + re-auth | `recipientUid` must exist | Title/body are **plain text only**; `.strict()` and length-capped (90/240). Deduped on `dedupeKey` (FR-108) |
| 34 | `DELETE /api/notifications/:id` | admin, or the recipient | own or admin | Soft-expire (`expiresAt`), never a hard delete |
| 35 | `GET /api/analytics` | dispatcher/admin (FR-117) | n/a (platform aggregate) | Citizen/responder `403 FORBIDDEN`. `responders[]` block is dispatcher/admin only; a responder gets the read-only subset if ever granted |
| 36 | `POST /api/analytics/recompute` | **admin only** | n/a | Rate limited 5/h. Queues a job |
| 37 | `POST /api/uploads/sign` | all four | object path is forced to `staging/{token.uid}/{mediaId}.{ext}` | The client **cannot** choose a path. `intent` must be `report`. Content type must be in the allow-list for `kind` |
| 38 | `POST /api/uploads/finalize` | all four | `mediaId` must resolve to a staging object owned by the caller | Reads the first 4 KiB, compares the sniffed type with the declared type, checks the size delta |
| 39 | `GET /api/uploads/:mediaId/url` | all four | evidence: dispatcher/admin full; assigned responder **evidence but not reporter identity**; reporter own; other citizens **never** | 15-minute signed read URL. `422 MEDIA_NOT_VERIFIED` when `scanStatus !== 'clean'` |
| 40 | `GET /api/resources` | any authenticated | n/a (static catalogue) | Client-cacheable 1 h |
| 41 | `GET /api/config` | any authenticated | n/a | Client-safe subset only. **Never** `retention`, admin keys, or anything from `process.env` |
| 42 | `GET /api/health` | **unauthenticated** (documented exception) | n/a | Cheap 1.5 s pings, cached 30 s. Never reveals credentials, bucket names, project IDs, or stack traces |
| 43 | `GET /api/admin/users` | **admin only** | n/a | Full record includes `email` — never to a dispatcher |
| 44 | `GET /api/admin/users/:id` | **admin only** | user must exist | Includes recent audit for that user |
| 45 | `PATCH /api/admin/users/:id/role` | **admin only** + re-auth + reason | target ≠ self; target must exist | `400 SELF_ROLE_CHANGE_FORBIDDEN`; `403 ROLE_ESCALATION_GUARD`; `409 ALREADY_ROLE`; audit `user.role_change`. Granting `admin` logs at `warning` |
| 46 | `PATCH /api/admin/users/:id/status` | **admin only** + re-auth + reason | target ≠ self | `400 SELF_DISABLE_FORBIDDEN`; sets `tokensValidAfter`; audit `user.disable` |
| 47 | `POST /api/admin/users/:id/reset-claims` | **admin only** + re-auth + reason | user must exist | Clears `roleChangePending`; audit |
| 48 | `GET /api/admin/audit-logs` | admin; dispatcher **read-only** | filters, not documents | CSV export is re-auth gated. Never exposes raw IP (hash only) |
| 49 | `GET /api/admin/config` | **admin only** | n/a | Includes `retention` |
| 50 | `PATCH /api/admin/config` | **admin only** + re-auth + reason | n/a | `400 CONFIG_CHANGE_LOCKED` for env-only keys; range errors carry field-level `details`; audit `config.update` |
| 51 | `GET /api/admin/responders` | **admin only** | n/a | Verification queue |
| 52 | `GET /api/admin/system/health` | **admin only** | n/a | Cost/limit snapshot + AI failure rate |
| 53 | `POST /api/admin/maintenance/*` | **admin only** + re-auth + reason | n/a | `422 MAINTENANCE_DISABLED` unless `config.features.maintenance === true` **and** `ENABLE_MAINTENANCE_JOBS=true` |
| 54 | `GET /api/cron/*` | **bearer `CRON_SECRET`**, not a user token | n/a | `403 FORBIDDEN` without the exact secret. No `users/{uid}`, no role — the only non-user principal in the system |

### 7.1 Hard denials (no role, including `admin`, may ever perform these)

| Denied | Code | Enforced by |
| --- | --- | --- |
| Delete or update an `auditLogs` document | — | Rules: `allow write: if false` (layer 4); no endpoint exists (layer 2) |
| Change your own role | `SELF_ROLE_CHANGE_FORBIDDEN` | `services/admin/change-role.ts` |
| Disable your own account | `SELF_DISABLE_FORBIDDEN` | `services/admin/set-user-status.ts` |
| Hard-delete an incident | — | Soft delete only (FR-123); rules `allow delete: if false` |
| Set a lifecycle status via the client SDK | — | Rules field allow-list (§9) |
| Write `incidents.reporterUid` for another user | — | Rules `create` condition; and the server overwrites it from the token |
| Read another user's `notifications` | `NOTIFICATION_NOT_FOUND` | Rules + server filter + no `recipientUid` parameter |
| Read `responderLocations` as a citizen | — | Rules `allow read: if isDispatch()` |
| Send an in-app notification | `FORBIDDEN` | `POST /api/notifications` is admin-only |
| Read platform analytics | `FORBIDDEN` | FR-117 |

---

## 8. Firestore Security Rules — design

### 8.1 Principles applied

| Principle | Expression in the rules |
| --- | --- |
| Deny by default | `match /{document=**} { allow read, write: if false; }` as the final rule |
| Claim-driven identity | `role()` reads `request.auth.token.role` — the **mirror**, not the authority |
| Ownership on every path | `isSelf(uid)`, `reporter() == request.auth.uid`, `assignee() == request.auth.uid` |
| Field allow-lists on every write | `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])` |
| Append-only where it matters | `statusHistory`, `auditLogs`, `aiRuns` — `allow write: if false` |
| No delete except where a role may | Only `notifications` (soft-expire) and `staging` media |
| Explicitly closed server-owned fields | `allow write: if false` on `users`, `dispatches`, `rateLimits`, `analyticsDaily`, `riskZones` (admin only) |

### 8.2 Refinements over [22](./22_USER_ROLES_PERMISSIONS.md) §7

The helper names and the deny-by-default posture are unchanged. The following are deliberate corrections/clarifications and **do not change any grant**:

| # | Change | Why it is safe |
| --- | --- | --- |
| R-1 | In `incidents/{id}/reports/{rid}` the create condition uses `request.resource.data.reporterUid` (not `resource.data`, which is `null` on create) | The [22](./22_USER_ROLES_PERMISSIONS.md) §7 text as written throws on create. The grant is identical: the caller must be the report's reporter **and** the parent incident's reporter |
| R-2 | `canRead()` for a responder covers `reporter()` or `assignee()` only — **no** in-radius clause, with the reason written in the rule | Rules cannot evaluate distance. An in-radius incident is delivered by the **API** (server read), never by a client listener. Adding a pretend clause would be a lie the tests would not catch |
| R-3 | `incidents` `create` is present but unused in v1 (all writes are server-side per [07](./07_DATABASE_SCHEMA.md) §2) | Kept as belt-and-braces. The server overwrites `reporterUid`, `status`, `category`, `urgency`, `aiRunId`, `createdAt`, `createdByRole` regardless of the body |
| R-4 | `incidents` `update` for a citizen additionally requires `resource.data.status in ['new','triaged']` **and** the affected-key allow-list | Unchanged in effect; the `mutableFields()` helper is kept verbatim |
| R-5 | `responders` `update` for a non-self, non-admin actor is denied outright rather than "dispatcher may update except verification" | Simpler to reason about and to test. The dispatcher surface is `PATCH /api/responders/:id` (server-mediated), so the rule tightening costs nothing |
| R-6 | `rateLimits` is `allow read, write: if false` for **all** clients including admin | [07](./07_DATABASE_SCHEMA.md) §11.6 is server-mediated only; the §13 table's "admin read" cell is not needed by any surface |
| R-7 | Added `unchanged(field)` helper and used it for `notifications` (so `recipientUid` and `type` are provably immutable) | Field allow-lists on a *diff* already imply this; the explicit form documents intent |
| R-8 | `config/{cid}` `read` is `isSignedIn()` but `create` is admin-only and `update` requires `diff().affectedKeys().hasOnly([...])` of known config keys | Prevents a client from inventing a new `config/` document with an unexpected shape |

---

## 9. `firestore.rules` — complete deployable file

```js
rules_version = '2';
service firebase.firestore {
  match /databases/{database}/documents {

    // ================================================================
    // Helpers
    // ================================================================
    function isSignedIn()  { return request.auth != null; }
    function role()        { return request.auth.token.role; }          // claim MIRROR
    function isAdmin()     { return isSignedIn() && role() == 'admin'; }
    function isDispatch()  { return isSignedIn() && (role() == 'dispatcher' || isAdmin()); }
    function isResponder() { return isSignedIn() && role() == 'responder'; }
    function isOps()       { return isDispatch() || isResponder(); }
    function isSelf(uid)   { return isSignedIn() && request.auth.uid == uid; }

    // affected keys of an update, and shortcuts for "this field did not change"
    function diffKeys()     { return request.resource.data.diff(resource.data).affectedKeys(); }
    function unchanged(k)   { return !diffKeys().hasAny([k]); }
    function onlyKeys(list) { return diffKeys().hasOnly(list); }
    function exactKeys(list){ return request.resource.data.keys().hasOnly(list); }

    // ================================================================
    // users — the authoritative role store. Server-write ONLY.
    // ================================================================
    match /users/{uid} {
      allow get, list: if isSelf(uid) || isDispatch();
      allow create, update, delete: if false;   // Admin SDK only; the Admin SDK bypasses rules
    }

    // ================================================================
    // profiles — the one citizen-writable document
    // ================================================================
    match /profiles/{uid} {
      allow get, list: if isSignedIn() && (isSelf(uid) || isDispatch());
      allow create, update: if isSelf(uid)
        && exactKeys(['displayName', 'timezone', 'locale', 'notifPrefs', 'updatedAt']);
      allow delete: if false;
    }

    // ================================================================
    // incidents
    // ================================================================
    match /incidents/{id} {

      function reporter()   { return resource.data.reporterUid; }
      function assignee()   { return resource.data.assigneeUid; }
      function notDeleted() { return resource.data.deletedAt == null; }

      // Gate 2 for reads. In-radius responder visibility is NOT here:
      // rules cannot evaluate distance. Such incidents are served by the
      // API (server read) and never by a direct client listener.
      function canRead() {
        return isDispatch()
          || (isSignedIn() && reporter() == request.auth.uid)
          || (isSignedIn() && assignee() == request.auth.uid);
      }

      // Field allow-list a citizen may adjust on their own unverified incident (FR-039).
      function mutableFields() {
        return onlyKeys(['location', 'locationText', 'geo', 'geoCells', 'placeName', 'placeId',
                         'updatedAt', 'searchTokens', 'locationAccuracyGrade']);
      }

      allow get, list: if canRead() && notDeleted();

      // Present as defence in depth. In v1 the client SDK NEVER creates an
      // incident; POST /api/incidents does, through the Admin SDK, and it
      // overwrites every server-owned field from the validated body + token.
      allow create: if isSignedIn()
        && request.resource.data.reporterUid == request.auth.uid
        && request.resource.data.reporterAnon == false
        && request.resource.data.status == 'new'
        && exactKeys(['incidentId', 'reference', 'schemaVersion', 'status', 'category', 'categoryRaw',
                      'urgency', 'urgencySource', 'summary', 'originalText', 'language',
                      'peopleAffected', 'requiredResources', 'safetyFlags', 'triageSource',
                      'aiConfidence', 'aiRunId', 'triageError', 'reporterUid', 'reporterAnon',
                      'reportCount', 'linkedReportCount', 'geo', 'geoCells', 'locationText',
                      'placeId', 'placeName', 'duplicateStatus', 'duplicateOfIncidentId',
                      'duplicateScore', 'duplicateBreakdown', 'assigneeUid', 'assignmentMode',
                      'slaTargetMin', 'source', 'evidenceCount', 'createdAt', 'updatedAt',
                      'createdByRole', 'searchTokens']);

      allow update: if isDispatch()
        || (isSignedIn() && reporter() == request.auth.uid
            && notDeleted()
            && resource.data.status in ['new', 'triaged']
            && mutableFields());

      allow delete: if false;                     // soft delete only, server-side (FR-123)

      // ---- subcollections ------------------------------------------------
      match /reports/{rid} {
        // R-1: on create, `resource` is null; the reporter is in request.resource.
        allow read: if canRead();
        allow create: if isDispatch()
          || (isSignedIn()
              && request.resource.data.reporterUid == request.auth.uid
              && get(/databases/$(database)/documents/incidents/$(id)).data.reporterUid == request.auth.uid
              && get(/databases/$(database)/documents/incidents/$(id)).data.deletedAt == null);
        allow update, delete: if false;           // FR-003: originalText is never rewritten
      }

      match /statusHistory/{eid} {
        allow read: if canRead();
        allow write: if false;                    // server-only, append-only (FR-052)
      }

      match /resources/{lid} {
        allow read:   if canRead();
        allow write:  if isDispatch();
        allow delete: if isDispatch();
      }
    }

    // ================================================================
    // responders
    // ================================================================
    match /responders/{uid} {
      function selfFields() {
        return onlyKeys(['status', 'capabilities', 'serviceRadiusM', 'phone', 'notifPrefs', 'updatedAt']);
      }
      function adminFields() {
        return onlyKeys(['displayName', 'phone', 'status', 'capabilities', 'certifications',
                         'serviceRadiusM', 'homeBase', 'homeBaseGeoCells', 'notifPrefs',
                         'note', 'photoURL', 'updatedAt',
                         'verification', 'verifiedBy', 'verifiedAt', 'verificationNote',
                         'activeIncidentCount', 'maxConcurrentIncidents', 'totalAssignments',
                         'acceptedAssignments', 'avgResponseSec', 'lastLocationAt',
                         'lastLocationAccuracyGrade']);
      }
      allow get:  if isDispatch() || isSelf(uid);
      allow list: if isDispatch();                // citizens cannot enumerate responders
      allow create, delete: if false;             // server-created / server-removed
      // R-5: verification fields are admin-only; a dispatcher has no client write path at all.
      allow update: if isAdmin() ? adminFields()
                   : (isSelf(uid) ? selfFields() : false);
    }

    // ================================================================
    // responderLocations — client-writable heartbeat (FR-066)
    // ================================================================
    match /responderLocations/{uid} {
      allow read: if isDispatch();                // responders read their own via the API only
      allow write: if isSelf(uid)
        && request.resource.data.uid == uid
        && exactKeys(['uid', 'geo', 'accuracyM', 'accuracyGrade', 'headingDeg', 'speedMps',
                      'source', 'status', 'activeIncidentId', 'capturedAt', 'receivedAt', 'stale'])
        && (resource == null
            ? onlyKeys(['uid', 'geo', 'accuracyM', 'accuracyGrade', 'headingDeg', 'speedMps',
                        'source', 'status', 'activeIncidentId', 'capturedAt', 'receivedAt', 'stale'])
            : onlyKeys(['geo', 'accuracyM', 'accuracyGrade', 'headingDeg', 'speedMps',
                        'status', 'activeIncidentId', 'capturedAt', 'receivedAt', 'stale']));
      // Rate limiting and the >=20s staleness guard are server-side; rules cannot count.
    }

    // ================================================================
    // dispatches — server-mediated only
    // ================================================================
    match /dispatches/{did} {
      allow read: if isDispatch()
        || (isResponder() && resource.data.responderUid == request.auth.uid)
        || (isSignedIn() && resource.data.incidentId != null
            && get(/databases/$(database)/documents/incidents/$(resource.data.incidentId)).data.reporterUid == request.auth.uid);
      allow write: if false;
    }

    // ================================================================
    // notifications — recipient-only (FR-103)
    // ================================================================
    match /notifications/{nid} {
      allow get, list: if isSignedIn() && resource.data.recipientUid == request.auth.uid;
      allow create, delete: if false;             // server-mediated
      allow update: if isSignedIn() && resource.data.recipientUid == request.auth.uid
        && onlyKeys(['read', 'readAt'])
        && unchanged('recipientUid')
        && unchanged('type')
        && unchanged('severity')
        && unchanged('body');
    }

    // ================================================================
    // reference / telemetry / config / limits
    // ================================================================
    match /resources/{rid} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /riskZones/{rid} {
      allow read:  if isOps();
      allow write: if isAdmin();
    }

    match /aiRuns/{rid} {
      allow read:  if isDispatch();
      allow write: if false;                      // Admin SDK only; hashes only, no PII
    }

    match /auditLogs/{lid} {                      // APPEND-ONLY (FR-131)
      allow read:  if isDispatch();
      allow write: if false;                      // no role, including admin, may write a row
    }

    match /analyticsDaily/{d} {
      allow read:  if isDispatch();
      allow write: if false;
    }

    match /rateLimits/{k} {                       // R-6: no client access, any role
      allow read, write: if false;
    }

    match /config/{cid} {
      allow read:   if isSignedIn();
      allow create: if isAdmin();
      allow update: if isAdmin() && onlyKeys(['schemaVersion', 'appName', 'defaultTimezone',
                                             'appTimezone', 'slaMinutes', 'duplicate', 'notifications',
                                             'realtime', 'risk', 'features', 'retention',
                                             'updatedAt', 'updatedBy']);
      allow delete: if false;
    }

    // ================================================================
    // DENY BY DEFAULT — must remain the last rule in this file
    // ================================================================
    match /{document=**} { allow read, write: if false; }
  }
}
```

### 9.1 Rule explanation table

| Rule | Purpose | FR / layer |
| --- | --- | --- |
| `isSignedIn()` | Any authenticated principal | — |
| `role()` | Reads the `role` **custom claim mirror** | DEC-07, layer 4 |
| `isAdmin()` | `role == 'admin'` | [22](./22_USER_ROLES_PERMISSIONS.md) §3 |
| `isDispatch()` | `dispatcher` **or** `admin` — dispatcher powers include admin powers | [22](./22_USER_ROLES_PERMISSIONS.md) §3 rows 14–29 |
| `isResponder()` | `role == 'responder'` | rows 16–18, 31 |
| `isOps()` | `isDispatch() \|\| isResponder()` — used only by `riskZones` | row 49 |
| `isSelf(uid)` | `request.auth.uid == uid` | rows 5, 33, 41, 45, 46 |
| `diffKeys()` / `unchanged(k)` / `onlyKeys(list)` / `exactKeys(list)` | Field allow-lists for `update` and `create` respectively | FR-142, NFR-015 |
| `users` read | Self, or any dispatcher | [22](./22_USER_ROLES_PERMISSIONS.md) §5 |
| `users` write `false` | The role store is **server-only**. A client cannot promote itself by writing `users/{uid}` | FR-133, T-03 |
| `profiles` read | Self or dispatcher | FR-038 |
| `profiles` write (self, 5 keys) | A citizen may edit only display name, timezone, locale, notification prefs, updatedAt. `role`, `status`, `email`, `verification` are not in the list, so sending them is a rules denial | FR-133 |
| `profiles` delete `false` | No profile deletion surface exists | DEC-11 |
| `incidents` `reporter()` / `assignee()` | Ownership helpers used by `canRead()` and the citizen update branch | [22](./22_USER_ROLES_PERMISSIONS.md) §5 |
| `notDeleted()` | Soft-deleted rows are invisible to **every** client | FR-123 |
| `incidents` `canRead()` | Dispatcher/admin any; reporter own; assignee own. **No** in-radius clause — see R-2 and §12.1 | FR-124, FR-088, NFR-027 |
| `incidents` create allow-list | Even if a client could create a row, it could only create a `new` incident whose `reporterUid` is itself, with `reporterAnon == false`, and with no lifecycle/AI/dispatch fields set | FR-001, FR-010 |
| `incidents` `mutableFields()` | A citizen may only adjust **location** on their own unverified incident | FR-039 |
| `incidents` update | Dispatcher/admin any; reporter own + `status ∈ {new, triaged}` + allow-list. A responder has no client update path at all | FR-073, FR-055 |
| `incidents` delete `false` | Hard delete is impossible; soft delete is a server-side field write | FR-123, DEC-11 |
| `incidents/{id}/reports` read | Inherits the parent's `canRead()` | FR-075 |
| `incidents/{id}/reports` create | Caller is the report's reporter **and** the parent incident's reporter, and the parent is not soft-deleted | FR-012 |
| `incidents/{id}/reports` update/delete `false` | FR-003: reporter text is stored verbatim and never rewritten. A correction is a *new* report of `kind: 'correction'` | FR-003, FR-012 |
| `incidents/{id}/statusHistory` write `false` | Server-only, append-only timeline | FR-052, FR-059 |
| `incidents/{id}/resources` write | Dispatcher/admin only — what was *supplied* is not citizen-writable | [07](./07_DATABASE_SCHEMA.md) §11.2 |
| `responders` list `isDispatch()` | A citizen cannot enumerate the responder directory | rows 35, 36 |
| `responders` `selfFields()` | A responder may change availability, capabilities, radius, phone, prefs — never `verification` | FR-061, FR-062, FR-064 |
| `responders` `adminFields()` | R-5: a non-admin non-self update is `false`, so a dispatcher has no client write path | FR-063 |
| `responderLocations` read `isDispatch()` | NFR-027, FR-038: live responder locations are dispatcher/admin only. A responder reads their own through the API | FR-066, FR-081 |
| `responderLocations` write self + key list | Heartbeat can only move *your own* marker and only change location/presence fields. `uid` is pinned to the path owner | FR-066, T-46 |
| `dispatches` read | Dispatcher/admin any; the assigned responder; and the incident's **reporter** (so the citizen sees who was sent) | rows 32, §5 |
| `dispatches` write `false` | Assignment is server-only: a client cannot assign itself to an incident | FR-053, FR-074, T-03 |
| `notifications` read/update recipient-only | FR-103. There is no `?recipientUid=` parameter at any layer | FR-103 |
| `notifications` `unchanged('recipientUid'/'type'/'severity'/'body')` | A recipient may mark read and nothing else; they cannot rewrite the alert | FR-104 |
| `notifications` create/delete `false` | Server-mediated; `POST /api/notifications` is admin-only | FR-107, T-09 |
| `resources` read/write | Static catalogue; admin maintains it | [07](./07_DATABASE_SCHEMA.md) §11.1 |
| `riskZones` read `isOps()` / write `isAdmin()` | FR-114, FR-115 | rows 49, 50 |
| `aiRuns` read `isDispatch()` / write `false` | FR-028 telemetry. Dispatcher/admin see hashes and metrics, never raw model output or prompts | [09](./09_AI_GEMINI_SPECIFICATION.md) §9 |
| `auditLogs` read `isDispatch()` / **write `false`** | **FR-131 append-only. No `update`, no `delete`, no `create` from any client, for any role, including `admin`.** The server writes rows with the Admin SDK | FR-131, rows 59, T-37 |
| `analyticsDaily` read `isDispatch()` / write `false` | FR-116 rollups are server-computed | FR-117 |
| `rateLimits` `false` for all | R-6. A client cannot read or reset its own bucket | FR-015, NFR-016, T-19 |
| `config` read `isSignedIn()` | Every authenticated client needs `slaMinutes`, `features`, `duplicate.radiusM`. The **response** still exposes only the client-safe subset — the rules cannot filter fields | US-033, [08](./08_API_SPECIFICATION.md) §9.2 |
| `config` create admin, update admin + key list, delete `false` | R-8. Every change is audited as `config.update` | FR-132 |
| `match /{document=**} { allow read, write: if false; }` | **The single most important line in the file.** Any collection not named above is unreachable by every client. Removing it is a critical finding | NFR-014, T-33 |

### 9.2 Rules that must exist as automated tests

`tests/integration/firestore-rules.test.ts` (≥ 60 assertions), each named after the permission row it protects:

| Group | Assertions |
| --- | --- |
| Positive | citizen reads own incident; responder reads assigned incident; dispatcher reads any; admin reads any; dispatcher/admin read `auditLogs`; dispatcher reads `aiRuns`; any authenticated reads `config/app` |
| Ownership negatives | citizen B `get` citizen A's incident ⇒ denied; responder B `get` an incident assigned to A ⇒ denied; citizen A `get` citizen B's report ⇒ denied |
| Field allow-list | citizen updates only `location` on own `new` incident ⇒ allowed; same update adding `urgency` ⇒ denied; same update on a `verified` incident ⇒ denied; client writes `status: 'verified'` at create ⇒ denied |
| Dispatch | client writes any `dispatches` doc ⇒ denied; responder B reads responder A's dispatch ⇒ denied; citizen lists `dispatches` ⇒ denied |
| Notifications | recipient marks own read ⇒ allowed; recipient changes `body` ⇒ denied; user B reads user A's notification ⇒ denied; client creates a notification ⇒ denied |
| Responders | citizen lists `responders` ⇒ denied; responder updates own `status` ⇒ allowed; responder updates own `verification` ⇒ denied; dispatcher writes `verification` ⇒ denied; admin writes `verification` ⇒ allowed |
| Locations | citizen reads `responderLocations` ⇒ denied; responder B reads responder A's location ⇒ denied; responder A writes own ⇒ allowed; responder A writes `uid` = B ⇒ denied |
| Audit immutability | **every** role, including `admin`, `update` and `delete` on `auditLogs` ⇒ denied (rows 59, 61) |
| Rate limits | every role reads/writes `rateLimits` ⇒ denied |
| Catch-all | read + write on a collection not named in the rules (`zzz/{id}`) ⇒ denied |
| Drift simulation | a `citizen` context with an `admin` claim is denied on `auditLogs` (proves the rules read the claim and the API refuses the mismatch) |

> A note on that last row: it is a **rules-only** assertion and it is *supposed* to pass, because the rules trust the claim. The API is what refuses drift. The test exists to document which layer is which, so a future reader does not "fix" one layer by loosening the other.

### 9.3 Deploy discipline (NFR-014)

```
NFR-014: "Firestore and Storage rules MUST be deployed and tested, not merely written."

1.  npm run emulators            # Firestore + Storage emulator
2.  npm run test:int              # rules tests MUST pass; CI fails otherwise
3.  firebase deploy --only firestore:rules,firestore:indexes,storage
4.  Post-deploy smoke against the live project (documented, two commands):
      - a citizen SDK context get() on another user's incident  ⇒ PERMISSION_DENIED
      - a citizen SDK context delete() on auditLogs/{id}       ⇒ PERMISSION_DENIED
5.  Rollback is NOT a Vercel rollback. It is:
      firebase deploy --only firestore:rules --config firestore.rules.bak
```

`firebase.json` pins `"rules": "firestore.rules"` and `"storage": { "rules": "storage.rules" }`. A rules change that is not accompanied by a passing rules test is treated as a broken build ([02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7).

---

## 10. Storage Security Rules

### 10.1 Principles

| Principle | Expression |
| --- | --- |
| Staging is a private per-user scratch space | `staging/{uid}/…` readable and writable only by `uid` |
| Final evidence is server-written and server-read | `incidents/**` and `quarantine/**` are `if false` for clients, always |
| Size and content type are checked at the rule level **as well as** the API level | A client bypassed by a modified app still meets the rule |
| Nothing is public | There is no `getPublicUrl` anywhere in the codebase ([15](./15_FILE_STORAGE_SPECIFICATION.md) §12) |

### 10.2 `storage.rules` — complete deployable file

```js
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {

    // ---- helpers (names fixed by [22](./22_USER_ROLES_PERMISSIONS.md) §7.1) ----
    function signedIn() { return request.auth != null; }
    function isOps()    { return signedIn() && (request.auth.token.role in ['dispatcher','admin']); }
    function mine(uid)  { return signedIn() && request.auth.uid == uid; }
    function isAdmin()  { return signedIn() && request.auth.token.role == 'admin'; }

    // request.resource is null on read/delete — only call these from write rules.
    function isImage()      { return request.resource.contentType.matches('image/(jpeg|png|webp)'); }
    function isAudio()      { return request.resource.contentType.matches('audio/(webm|mp4|mpeg)'); }
    function withinSize()   { return request.resource.size <= 15 * 1024 * 1024 && (isImage() || isAudio()); }
    function extMatches()   {
      return (isImage() && request.resource.name.matches('.*\\.(jpg|jpeg|png|webp)$'))
          || (isAudio() && request.resource.name.matches('.*\\.(webm|m4a|mp3)$'));
    }
    function mediaIdOk()    { return request.resource.name.matches('^staging/[^/]+/med_[A-Z2-7]{12}\\.[a-z0-9]+$'); }

    // ---- staging: the uploader's own scratch space ----------------------
    // Path: staging/{uid}/{mediaId}.{ext}   ([15](./15_FILE_STORAGE_SPECIFICATION.md) §3)
    match /staging/{uid}/{file} {
      allow read:  if mine(uid);
      allow write: if mine(uid)
        && mediaIdOk()
        && withinSize()
        && extMatches();
      allow delete: if mine(uid);            // lets a client drop a failed upload
    }

    // ---- final evidence: server-written, server-read --------------------
    // incidents/{incidentId}/reports/{reportId}/{mediaId}.{ext}
    // incidents/{incidentId}/supplements/{reportId}/{mediaId}.{ext}
    match /incidents/{incidentId}/{sub}/{rid}/{file} {
      allow read, write, delete: if false;
    }

    // ---- quarantine: nothing is client-reachable ------------------------
    match /quarantine/{file} {
      allow read, write, delete: if false;
    }

    // ---- deny by default -------------------------------------------------
    match /{allPaths=**} {
      allow read, write, delete: if false;
    }
  }
}
```

### 10.3 Storage rules explanation table

| Rule | Purpose |
| --- | --- |
| `signedIn()` / `isOps()` / `mine(uid)` | Identity + claim-mirror helpers, names fixed by [22](./22_USER_ROLES_PERMISSIONS.md) §7.1 |
| `isAdmin()` | Reserved for the future admin-quarantine-reinspection surface; **unused in v1** and deliberately left in so a future rule does not have to re-invent it |
| `isImage()` / `isAudio()` | Content-type allow-list, mirroring `UPLOAD_MAX_*` and the MIME table in [15](./15_FILE_STORAGE_SPECIFICATION.md) §5 |
| `withinSize()` | 15 MB hard ceiling, which is the audio ceiling; images are additionally capped at 5 MB by the API and by the signed URL's declared `maxSizeBytes` |
| `extMatches()` | The stored extension must agree with the declared content type. A `med_*.png` uploaded as `audio/webm` is denied |
| `mediaIdOk()` | Enforces `staging/{uid}/med_[A-Z2-7]{12}.{ext}` — one level, no nested paths, no traversal, no client-chosen filename ([15](./15_FILE_STORAGE_SPECIFICATION.md) §4) |
| `staging` read/write/delete `mine(uid)` | Cross-user path theft is denied. A modified client cannot write into `staging/{someoneElse}/` |
| `incidents/**` `if false` | Final evidence is unreachable by the client SDK. Reads happen **only** through a 15-minute signed URL issued by the API after a resource-access check; writes happen **only** through the Admin SDK when the server moves the file out of staging |
| `quarantine/**` `if false` | Quarantined media is unreachable to every client, including the uploader. This is deliberate: a quarantined object must not be viewable by the person who uploaded it |
| `match /{allPaths=**} { allow … if false; }` | Deny by default. Any future bucket prefix is unreachable until someone deliberately writes a rule for it |

### 10.4 What Storage rules cannot do, stated honestly

1. **They cannot see the bytes.** A `contentType` is a client-supplied request header. The rule validates a *claim*, not a JPEG. Magic-byte verification happens in `services/uploads/finalize-upload.ts` and again in `POST /api/incidents` ([15](./15_FILE_STORAGE_SPECIFICATION.md) §8). A client that skips the finalize call and posts a forged `contentType` still has its bytes re-sniffed at incident creation, which is where the incident is actually created.
2. **They cannot count requests.** No rate limiting. The 30/hour limit on `POST /api/uploads/sign` and the 20 s heartbeat floor are enforced in `lib/server/rate-limit.ts` and in `services/responders/location-heartbeat.ts` respectively.
3. **A V4 signed URL is a bearer token.** Once `POST /api/uploads/sign` has issued a signed `PUT` URL, or `GET /api/uploads/:mediaId/url` has issued a signed `GET` URL, **the holder of that URL can use it for its TTL without presenting an ID token.** For the `PUT` case that is by design (the browser needs to upload bytes). For the `GET` case it means the entire authorization burden for evidence download sits in the API. The mitigations are: 15-minute TTL (`UPLOAD_SIGNED_URL_TTL_SEC=900`), single-object scope, no wildcard, and a `Cache-Control: private, no-transform` response. `tests/integration/storage-rules.test.ts` asserts both behaviours explicitly so the assumption is tested rather than believed — **if a future platform version starts evaluating rules on signed-URL requests, the test will fail and we will learn about it.**
4. **They cannot express "assigned responder may read this incident's evidence".** The assignment lives in Firestore; Storage rules cannot perform that join cheaply, and a rules `get()` per object read would be a large hidden cost. This is why evidence access is decided in `GET /api/incidents/:id` and `GET /api/uploads/:mediaId/url` and then handed out as a URL.

---

## 11. What Security Rules cannot express — and how the API compensates

This section exists because pretending rules are a complete boundary would be a lie. Firestore Security Rules are a **per-document, per-request expression language** with no arithmetic over collections, no counting, no geospatial predicates, and at most a small fixed number of `get()` lookups per evaluation.

| # | Requirement | Why rules cannot express it | Exact API compensation | Where the compensation lives | Test that proves it |
| --- | --- | --- | --- | --- | --- |
| 1 | **Distance/radius visibility** — "a responder may see unassigned incidents within `serviceRadiusM`" | No `distance()`, no `geoWithin`, no numeric comparison of two `GeoPoint`s, no arithmetic. Reading the caller's own `geo` requires a `get()`, and Firestore has no geohash function at all | The **API** performs the geoCells `array-contains` query, Haversine-filters in code, and returns the rows. Such incidents are **never** pushed by a client listener, so layer 4 never has to know | `GET /api/incidents` (responder branch), `services/incidents/list-incidents.ts`, `lib/geo/haversine.ts` | `tests/integration/api/incidents/list-responder-scope.test.ts` — a responder 6 km away gets 0 in-radius rows; at 300 m gets 1; a citizen gets 0 |
| 2 | **Multi-step lookups across collections** — "only a verified responder inside a radius with a matching capability and free capacity may be ranked" | Rules have no `let`, no loop, no sorting, and each `get()` is a billed document read; a ranked candidate list would need dozens | The API loads ≤ 60 candidates in one query, then filters and ranks in `lib/geo/nearest.ts` | `GET /api/incidents/:id/dispatch/candidates`, `services/dispatch/candidates.ts` | `tests/integration/api/dispatch/candidates.test.ts` — unverified, `offline`, at-capacity, and out-of-radius responders are all absent |
| 3 | **"The assigned responder may transition this incident"** | Requires reading the incident, then the `dispatches` document whose `incidentId` points back at it — a reverse lookup rules cannot perform, plus a comparison against a *different* document's `status` | The transition table is a **pure function** in `lib/incidents/lifecycle.ts`; the assignment is verified inside the same `runTransaction` that performs the write | `PATCH /api/incidents/:id/status`, `services/incidents/change-status.ts` | `tests/integration/api/incidents/status-transitions.test.ts` — every cell of the [07](./07_DATABASE_SCHEMA.md) §4.3 table, plus responder-B-on-A's-incident ⇒ `403` |
| 4 | **Rate limiting / counting** | Rules cannot count prior requests. They see one request in isolation | The Firestore token bucket: one `runTransaction` read-modify-write on `rateLimits/{sha256(subject:route:bucket)}` per limited request | `lib/server/rate-limit.ts`, [07](./07_DATABASE_SCHEMA.md) §11.6 | `tests/integration/api/rate-limit.test.ts` — the 6th incident creation in an hour is `429` with `Retry-After`; a different uid is unaffected |
| 5 | **Lifecycle state-machine validity** (e.g. `resolved` requires `resolutionCode`; `resolved → en_route` is illegal) | A 11×11 transition matrix with side conditions is not expressible as a per-document predicate, and rules cannot know the previous status of a *different* document | `assertTransitionAllowed(current, target, actorRole, isAssignee)` as a pure, exhaustively-tested function; illegal ⇒ `409 INVALID_STATUS_TRANSITION` with `details.allowed` | `lib/incidents/lifecycle.ts` | `tests/unit/lib/incidents/lifecycle.test.ts` — every legal cell allowed, every illegal cell rejected, `RESOLUTION_CODE_REQUIRED` enforced |
| 6 | **One active assignment per incident** (FR-053) | "No other `dispatches` doc with this `incidentId` has `status in [active, accepted]`" is a collection query, not a document read | One `runTransaction` reads the live dispatch set and writes the close + the create atomically | `services/dispatch/assign.ts`, [07](./07_DATABASE_SCHEMA.md) §12.6 | `tests/integration/api/dispatch/assign-concurrency.test.ts` — two parallel assigns ⇒ exactly one `active`; the loser gets `409 ALREADY_ASSIGNED` |
| 7 | **Field-level redaction** (a responder must not see `reporterUid`) | Rules can allow or deny a whole document; they cannot project a subset of fields to a client listener | `lib/api/serialize.ts` builds a role-specific DTO. The **query** may select the field; the **response** never contains it | `lib/api/serialize.ts` | `tests/integration/api/responders/redaction.test.ts` — asserts the JSON body, not the function's return value |
| 8 | **Search-token fan-out, SLA sweep, dedupe scoring, analytics rollups** | Arbitrary aggregation | The API and the `analyticsDaily` rollups | `services/**` | `tests/unit/lib/analytics/*.test.ts` |
| 9 | **Media access decisions** (assigned responder yes, other citizen never) | Same as 3 and 7, plus the §10.4 signed-URL reality | `GET /api/uploads/:mediaId/url` decides, then issues a 15-minute URL | `services/uploads/signed-url.ts` | `tests/integration/api/uploads/url-authorization.test.ts` — a 4×4 matrix of (role × relationship) × expected outcome |
| 10 | **Abuse heuristics** (mass reporting, fake emergencies) | Requires aggregation over time and over many subjects | `services/incidents/create-incident.ts` counts the caller's reports in the window, and `config/app` carries the thresholds; suspicious runs raise an admin-visible flag and a `warning` audit entry | `services/incidents/create-incident.ts` | `tests/integration/api/incidents/spam-signals.test.ts` |

**The honest summary:** rules are a strong second line that is *unforgeable by the client* and *independent of our API's correctness*. They are not a complete policy. The policy lives in `lib/server/auth-guard.ts`, `lib/api/serialize.ts`, `lib/incidents/lifecycle.ts`, and `services/**` — and the rules exist so that a bug in those files is bounded rather than catastrophic.

---

## 12. CSRF protection

### 12.1 Why this is defence in depth, not the primary defence

A CSRF attack requires the victim's browser to attach an ambient credential to an attacker-initiated request. CareGrid AI attaches **no ambient credential**: every API call carries `Authorization: Bearer <Firebase ID token>`, which a cross-origin page cannot read from `localStorage` and cannot cause the browser to attach. There is **no session cookie** and no `SESSION_SECRET` ([21](./21_ENVIRONMENT_VARIABLES.md) §9).

| Ambient credential | Present? | Consequence |
| --- | --- | --- |
| `Authorization` bearer token | Yes, but only if attacker JS can read it — same-origin only | Not CSRF-able |
| Session cookie | **No** | Not CSRF-able |
| `Idempotency-Key` header | Required on `POST /api/incidents` | Not attacker-settable cross-origin |
| Firebase Auth browser persistence | `localStorage`/`indexedDB`, origin-scoped | Not readable cross-origin |

So the classic attack does not apply. The check remains because of a real, different threat:

> **What the origin check does catch.** If an attacker obtains a valid ID token by any other means (XSS on our own origin, a leaked token in a log, a shared device, a malicious extension) and then uses it from an attacker page, the request arrives with a foreign `Origin`. We reject it and log it. That converts a silent compromise into a noisy one.

### 12.2 Implementation

```ts
// lib/server/csrf.ts
export function assertSameOrigin(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const allow = new Set(allowedOrigins());          // from NEXT_PUBLIC_APP_URL
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  if (origin) {
    if (allow.has(origin)) return;                  // exact string match, no prefix match
  } else if (referer) {
    try {
      if (allow.has(new URL(referer).origin)) return;
    } catch { /* malformed referer → fall through */ }
  } else {
    // Neither header. Non-browser clients (curl, Playwright, a native wrapper)
    // legitimately omit them, so this is not a failure — but it IS recorded.
    log.warn('csrf.origin_absent', { requestId: getRequestId(), ua: req.headers.get('user-agent') });
    return;
  }
  auditLog({ actorUid: 'anonymous', action: 'auth.csrf_rejected', entityType: 'auth',
             entityId: origin ?? referer ?? 'none', summary: 'Cross-origin state change rejected' });
  throw new HttpError(403, 'CSRF_FAILED');
}

function allowedOrigins(): string[] {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;    // validated as a URL at boot ([21](./21_ENVIRONMENT_VARIABLES.md) §7)
  const list = [appUrl, new URL(appUrl).origin];
  return [...new Set(list)];
}
```

| Rule | Detail |
| --- | --- |
| Exact match | `'https://caregrid.example.evil.com'.startsWith('https://caregrid.example')` is **never** true — the comparison is `Set.has` on the whole origin string |
| `NEXT_PUBLIC_APP_URL` must be https in production | Enforced by `lib/env.ts`; a production build with an `http://` app URL throws at boot |
| `Origin` wins over `Referer` | `Referer` can be stripped; `Origin` is not settable by a page |
| `null` origin is a failure | Sandboxed iframes send `Origin: null`; `allow.has('null')` is false ⇒ `403` |
| `OPTIONS`/CORS preflight | The API sets **no** `Access-Control-Allow-Origin`; there is no cross-origin API consumer in v1. A cross-origin `fetch` therefore fails at the preflight, before this code runs |
| Test | `tests/integration/api/csrf.test.ts` — mismatched `Origin` ⇒ `403 CSRF_FAILED`; matching ⇒ passes; `Origin: null` ⇒ `403`; `Referer` fallback works; a cross-origin `GET` is not blocked (it is harmless and the CDN should serve it) |

### 12.3 Why session cookies are not used

| Reason | Detail |
| --- | --- |
| CSRF surface | A cookie is attached automatically to every request to our origin. A bearer header is not |
| XSS blast radius | A token in `localStorage`/`indexedDB` is readable only by injected same-origin JS. A `HttpOnly` cookie is not readable **but is automatically sent**, so injected JS can make authenticated requests with it. For a system where the highest-value action is "assign a responder", explicit token handling is easier to reason about and easier to clear on sign-out |
| Sign-out on a shared device | US-042 requires sign-out to clear local cached data. A token store plus an explicit `clearCachedUserData()` on `onAuthStateChanged(auth, null)` is testable; "the cookie is gone but the RSC payload is still in the bfcache" is not |
| Stateless scaling | Firebase Auth is already the identity provider; adding a server session would add a datastore, a session table, a secret, and a revocation list |
| **Accepted cost** | The token is in `localStorage`, so a successful XSS on our origin can exfiltrate it. Mitigations: no `dangerouslySetInnerHTML` anywhere (§15), a strict CSP with a nonce and no `unsafe-inline` for scripts (§16), no third-party script except the Google Maps loader from a pinned origin, and 1-hour token lifetime. **Residual risk RR-02** in [24](./24_THREAT_MODEL_SECURITY.md) |

---

## 13. Input validation and injection defences

### 13.1 Zod first, always, including params

| Rule | Enforcement | Failure code |
| --- | --- | --- |
| Parse the body before any I/O | `withRequest(handler, { body: schema })` in `lib/api/auth.ts`; the wrapper runs before the handler body | `400 VALIDATION_FAILED` |
| Parse **query** parameters | `incidentQuerySchema`, `analyticsQuerySchema`, `adminQuerySchema` | `400 VALIDATION_FAILED` |
| Parse **route params** | `params` is a promise in Next 15 and is awaited and parsed **before** any use — a `params.id` that is not `^[A-Za-z0-9]{20}$` never reaches a Firestore path | `400 VALIDATION_FAILED` |
| Reject unknown keys | every schema is `.strict()` | `400 VALIDATION_FAILED` with the offending key in `details` |
| Reject out-of-range numbers | `.int().min().max()` on `limit`, `radiusM`, `accuracyM`, `serviceRadiusM`, `durationSec`, `sizeBytes`, `quantity` | `400` |
| Reject unknown enum values | `validators/enums.ts` is the single source for the 11 statuses, 4 urgencies, 11 categories, 13 safety flags, 6 resolution codes, 12 notification types, 4 roles, 4 `slaState`s | `400` |
| Bound every list | `.max()` on `searchTokens` (30), `matchedKeywords` (10), `requiredResources` (6), `safetyFlags` (6), `media` (3), `certifications`, `types` | `400` |
| Validate what is *stored* too | Reads re-parse stored enums; "never trust a stored enum" ([07](./07_DATABASE_SCHEMA.md) §2) | a bad stored value degrades to `other`/`medium` + an admin flag, never a crash |

### 13.2 No dynamic field paths

Firestore field paths are the classic injection surface: `db.doc(`users/${uid}/field/${req.body.field}`)` lets an attacker walk a document tree.

```ts
// ✗ FORBIDDEN — user input in a field path
db.collection('users').doc(uid).update({ [body.field]: body.value });

// ✓ CORRECT — a static, enumerated set of assignments
const patch: Record<string, unknown> = {};
if (body.summary !== undefined)     patch.summary = body.summary;
if (body.urgency !== undefined)     patch.urgency = body.urgency;
if (body.category !== undefined)    patch.category = body.category;
if (body.location !== undefined)    patch.location = normaliseGeo(body.location);
await db.collection('incidents').doc(id).update(patch);
```

The rule, as a review item: **no computed property key derived from a request anywhere in `services/**`.** Grep-able as `\[body\.` and `\[input\.`. ESLint: `no-restricted-syntax` on computed member access inside `services/**`.

### 13.3 No string interpolation into Firestore queries

Firestore has no query language to inject into — a query is a builder call with typed parameters. The real risks are different and each is closed:

| Risk | Real form | Control |
| --- | --- | --- |
| Operator injection | Not possible — there is no `$where` | — |
| Collection selection | `db.collection(body.collection)` | Never exists. Collections are string literals in `services/**` |
| Filter-field selection | `query.where(body.field, body.op, body.value)` | Never exists. Every query is hand-written per endpoint; the filter set is fixed by the endpoint and by the role branch |
| Unbounded scan | A query with no `limit()` | `limit()` is mandatory on every query; a static check (`scripts/check-listeners.ts` for listeners, review for server queries) plus [07](./07_DATABASE_SCHEMA.md) §12.5 hard limits |
| Free-text search | `q` in a `where` clause | Never. `searchTokens` `array-contains` per token, max 3 tokens, intersected in code; a raw substring search does not exist |
| Storage path injection | `` `${uid}/${body.filename}` `` | The path is **constructed server-side** from `token.uid` and a server-generated `mediaId`. The client contributes nothing to a path ([15](./15_FILE_STORAGE_SPECIFICATION.md) §4) |
| `orderBy` injection | `orderBy(body.sort)` | Never. `sort` is a validated enum mapped by a static lookup table |
| Storage path traversal | `..` in a path | `mediaIdOk()` in `storage.rules` plus the `^incidents/[A-Za-z0-9]{20}/(reports\|supplements)/[A-Za-z0-9]{2,}/[A-Za-z0-9_.-]+$` API regex plus a server-side `validateMediaPath()` |
| Prompt injection | Untrusted text concatenated into a prompt | `services/ai/sanitize.ts`, 9 documented steps ([09](./09_AI_GEMINI_SPECIFICATION.md) §4.3). This is the highest-consequence injection surface in the project and is treated as such in [24](./24_THREAT_MODEL_SECURITY.md) T-11..T-13 |
| CSV formula injection | `=cmd\|…` in exported cells | A leading `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'` on export ([08](./08_API_SPECIFICATION.md) §3.11 and [24](./24_THREAT_MODEL_SECURITY.md) T-28) |
| Log injection | CRLF in a `reason` | `lib/server/logging.ts` serialises to JSON and strips `\r\n`; `summary` is capped at 200 chars; `userAgent` is capped at 200 and control characters are removed ([24](./24_THREAT_MODEL_SECURITY.md) T-38) |
| HTML injection | — | §15 |

### 13.4 No `dangerouslySetInnerHTML`

`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, and `setTimeout` with a string body are **forbidden by lint** in `app/**`, `features/**`, and `components/**`:

```js
// eslint.config.mjs (excerpt) — the rule that makes §15 enforceable
{
  files: ['app/**/*.{ts,tsx}', 'features/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-properties': ['error', {
      property: 'dangerouslySetInnerHTML',
      message: 'XSS: render untrusted text as a React child. See docs/10_AUTHORIZATION_SECURITY.md §15.',
    }],
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.name=/^(eval|Function)$/]",
      message: 'Dynamic code execution is forbidden (NFR-022, docs/10 §15).',
    }],
  },
}
```

A CI grep for `dangerouslySetInnerHTML` in `features/` and `components/` is a second, independent gate (`scripts/check-bundle.ts` covers the Maps key; add the XSS grep to the same script or to a `check-security` script). **NFR-022 requires zero `any` in `app/`, `features/`, `services/`, and `lib/`,** which removes the escape hatch of typing a bypass.

### 13.5 Error responses

| Rule | Implementation |
| --- | --- |
| Stable machine `code` from a closed catalogue | `lib/server/errors.ts`; an unmapped internal error becomes `INTERNAL_ERROR` |
| Human `message` is safe to display | Hand-written per code; no interpolation of input into messages |
| `details` carries field-level validation info only | Zod issue `path` + `code`; never values, never stack traces |
| No stack traces, no raw exception text, no upstream bodies | A `try/catch` at the boundary logs `error.name` + `error.message` to the server log with `requestId` and returns the catalogue envelope |
| `requestId` on every response including errors | FR-141 |
| Never reflect input | A user-supplied string never appears in an error body, so there is no reflected-XSS surface in JSON responses |

---

## 14. XSS defences

| # | Defence | Where it lives | Notes |
| --- | --- | --- | --- |
| 1 | **React escapes by default** | Every component in `app/`, `features/`, `components/` | `{value}` in JSX becomes a text node. `{}` is *not* markup. There is no template-string-to-JSX path anywhere |
| 2 | **No `dangerouslySetInnerHTML` / `innerHTML` / `eval`** | ESLint `no-restricted-properties` + `no-restricted-syntax` + a CI grep | §13.4. A new violation fails the build |
| 3 | **Plain-text notification bodies** | `validators/notification.ts` (`title` ≤ 90, `body` ≤ 240, `.strict()`), `POST /api/notifications` | FR-102. The body is stored as a string and rendered as a React text child. HTML is neither accepted nor rendered ([08](./08_API_SPECIFICATION.md) §6.4, T-09) |
| 4 | **Reporter text is never markup** | `incidents.originalText`, `incidentReports.text` are stored **verbatim** (FR-003) and rendered as text children | A reporter typing `<script>` produces a visible `<script>` string, not a script |
| 5 | **AI output is never markup** | `summary`, `landmarks`, `location_hint`, `aiSummary` are `.max()`-bounded strings in `aiTriageOutputSchema` and rendered as text children | The model cannot return HTML that React will execute |
| 6 | **`text/plain` never `text/html`** | `services/analytics/export-csv.ts` sets `Content-Type: text/csv; charset=utf-8`; the API never returns `text/html` | A route handler that "returns an error page" with user data in it does not exist |
| 7 | **Downloads are attachments** | `GET /api/incidents/:id/export` sets `Content-Disposition: attachment; filename="caregrid-incidents-<date>.csv"` with a sanitised filename | Even in the impossible case that a cell contained markup, the browser downloads instead of rendering |
| 8 | **URL sanitisation for links** | `lib/format/safe-url.ts` — a single helper used by every `<a href>` and every `window.open` | Allow-list scheme check, see below |
| 9 | **CSP with a nonce** | `middleware.ts` + `vercel.json` | §16. A nonce-based `script-src` means an injected inline script does not execute even if defence 2 were bypassed |
| 10 | **`frame-ancestors 'none'`** | CSP | Clickjacking is dead even if `X-Frame-Options` were stripped by a proxy |
| 11 | **`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`** | CSP | Kills `<object>`/`<embed>` plugin content, `<base>` tag hijacking, and form exfiltration to an attacker's origin |
| 12 | **`nosniff`** | `middleware.ts` | A browser will not execute a response sniffed as something other than its declared type — this is the main defence against an HTML/JS payload served from a same-origin path |
| 13 | **No HTML is generated server-side** | No templating engine; Next renders JSX | [08](./08_API_SPECIFICATION.md) §12.13: "route handlers never return HTML with interpolated data" |
| 14 | **No third-party script except the Maps loader** | `@vis.gl/react-google-maps` loads `maps.googleapis.com` | One vendor, pinned origin, in `script-src` and `frame-src`. No analytics snippet, no tag manager, no chat widget, no CDN-hosted fonts with JS |
| 15 | **Rich text is not supported, and that is the design** | All free text is plain text everywhere | There is no Markdown/HTML surface to sanitise, so there is no sanitiser to get wrong |

### 14.1 URL sanitisation

```ts
// lib/format/safe-url.ts — the only place a URL becomes an href
const SAFE_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

export function safeUrl(raw: string | null | undefined, opts: { allowHttp?: boolean } = {}): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw, 'https://caregrid.invalid'); } catch { return null; }
  if (!SAFE_SCHEMES.has(u.protocol)) return null;         // blocks javascript:, data:, vbscript:, file:, blob:
  if (u.protocol === 'http:' && !opts.allowHttp) return null;
  // No control characters, no backslash tricks, no userinfo confusion
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  if (raw.includes('\\')) return null;
  return u.toString();
}
```

Applied to: `users.photoURL` (a Google avatar URL), `incidents.placeId`-derived map links, `resources.icon` (a **name**, never a path or a URL), `notifications.link` (an internal route, validated with `^/[A-Za-z0-9/_-]*$` before use), and every "open in maps" href built from `geo`.

### 14.2 The residual XSS risk, honestly

| Risk | Status |
| --- | --- |
| Stored XSS via a reporter's text | **Closed** by 1, 2, 4, 9, 12 |
| Stored XSS via a notification body | **Closed** by 1, 2, 3, 9, 12 |
| Reflected XSS via an error message | **Closed** — errors are JSON with catalogue strings, never reflect input (§13.5) |
| XSS via a **crafted CSV cell** opened in Excel/Sheets | **Mitigated** by the `'`-prefix in §13.3; residual risk RR-05 |
| XSS via **SVG upload** | **Excluded** — SVG is not in the allow-list ([15](./15_FILE_STORAGE_SPECIFICATION.md) §6). This is the single most important upload decision |
| XSS via a **polyglot** (valid JPEG magic + HTML/JS payload) | **Mitigated**, not eliminated — see [15](./15_FILE_STORAGE_SPECIFICATION.md) §5.4. The payload is never rendered in our origin: it is served from `firebasestorage.googleapis.com` with `image/jpeg` and `nosniff`, and rendered only through `<img>`, which does not execute script |
| XSS via a compromised CDN/npm supply chain | **Not closed** — a malicious dependency with script execution is inside our origin. Mitigated by minimal dependencies, `package-lock.json`, `npm ci` in CI, and Dependabot. Residual risk RR-06 |

---

## 15. Security headers

Set in **two** places, deliberately: `vercel.json` `headers` covers the static/CDN surface, and `middleware.ts` covers dynamic responses where a per-request nonce is required. Neither is sufficient alone — a header declared in `vercel.json` cannot hold a per-request nonce.

### 15.1 Header table

| Header | Exact value | Set in | Why |
| --- | --- | --- | --- |
| `Content-Security-Policy` | see §15.2 | `middleware.ts` (per request, nonce-bearing) | The primary XSS containment |
| `X-Content-Type-Options` | `nosniff` | both | Stops MIME sniffing; blocks an HTML payload served as an image |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | both | Sends only the origin cross-origin; keeps full referrer same-origin. Prevents an incident reference leaking to a third party via the URL |
| `Permissions-Policy` | `geolocation=(self), microphone=(self), camera=(self), payment=(), usb=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=(), autoplay=(), fullscreen=(self), interest-cohort=()` | both | Grants only the three capabilities the product needs, and only to our own origin. Everything else is denied. `geolocation`/`microphone`/`camera` are `(self)` **because** FR-030/FR-005/FR-006 require them — a `()` value would break the report flow |
| `X-Frame-Options` | `DENY` | both | Legacy backup for `frame-ancestors 'none'` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | both | **Functional requirement** for `signInWithPopup`. Not a hardening measure — do not tighten |
| `Cross-Origin-Resource-Policy` | `same-origin` | both | Blocks a hotlinked cross-origin read of our responses |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | `vercel.json` | 2 years. Only valid once the domain is confirmed HTTPS-only |
| `X-DNS-Prefetch-Control` | `off` | `vercel.json` | Minor hardening |
| `Cache-Control` (API, user-specific) | `no-store` | `lib/api/auth.ts` | [08](./08_API_SPECIFICATION.md) §12.12. Stops a shared cache or the bfcache retaining an incident payload |
| `Cache-Control` (API, public reference data) | `private, max-age=300` | `lib/api/auth.ts` | `GET /api/resources`, `GET /api/config` only |
| `X-Robots-Tag` | `noindex, nofollow` on `/admin/*`, `/dashboard`, `/map` | `middleware.ts` | Keeps operational URLs out of search indexes |
| `Vary` | `Origin, Authorization` | `lib/api/auth.ts` | Correct cache behaviour; also blocks a CDN from serving one user's response to another |

### 15.2 The CSP

```ts
// middleware.ts (Edge) — nonce per request, so the CSP is per response
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isStaticAsset = req.nextUrl.pathname.startsWith('/_next/static/');

  // Next.js needs to read the nonce during the RSC render.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://maps.googleapis.com https://maps.gstatic.com`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' blob: data: https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com https://firebasestorage.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' blob: https://firebasestorage.googleapis.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebasestorage.googleapis.com https://maps.googleapis.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://maps.googleapis.com",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    `report-uri /api/cron/csp-report`,
  ].join('; ');

  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (isAdminSurface(req.nextUrl.pathname)) res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}

export const config = {
  // app/api/** is excluded: the API must never be affected by a redirect or a header failure
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
```

| Directive decision | Rationale |
| --- | --- |
| `'nonce-…'` **plus** `'strict-dynamic'` | With `strict-dynamic`, a nonce-bearing script may load further scripts, so a `script-src` host allow-list is unnecessary and `'unsafe-inline'` is impossible. The Maps loader is reached through our nonce-bearing bundle loader |
| **No** `'unsafe-inline'` in `script-src` | This is the whole point. Tailwind and the design system need inline *styles*, which is why `style-src` has `'unsafe-inline'` — styles cannot carry a nonce meaningfully in this stack, and CSS injection is a far smaller surface than script injection |
| No `script-src-attr` inline handlers | `onclick=` attributes are forbidden; all handlers are React props |
| `object-src 'none'` | No `<object>`, `<embed>`, `<applet>` |
| `base-uri 'self'` | A `<base href>` cannot redirect every relative URL to an attacker |
| `form-action 'self'` | A form cannot post to an attacker's origin — this is the CSP half of CSRF defence (§12) |
| `frame-ancestors 'none'` | Clickjacking defence, independent of `X-Frame-Options` |
| `connect-src` limited to Google/Firebase origins | XHR/fetch/WebSocket egress is allow-listed. The exact set must cover: Firestore REST + realtime (`*.googleapis.com`, `*.firebaseio.com` incl. `wss://`), Auth (`identitytoolkit`, `securetoken`), Storage (`firebasestorage.googleapis.com`), Maps (`maps.googleapis.com`), and AI Studio is **server-side only so it is not needed here** |
| `report-uri` | `POST /api/cron/csp-report` is `CRON_SECRET`-gated. CSP reports carry the violating URI; they are treated as untrusted input, capped at 4 KiB, and never rendered anywhere |
| `upgrade-insecure-requests` | Any `http://` subresource is upgraded. Staging-only; harmless in production |

**Testing the CSP is mandatory, not optional.** `tests/e2e/security-headers.spec.ts` asserts, in a real browser, that (a) every response carries each header, (b) an injected inline `<script>` does **not** execute, (c) `document.domain` clickjacking is blocked, and (c) no console CSP violation fires on `/report`, `/dashboard`, `/map`, and `/admin/audit-logs`. A missing header is a test failure, not a warning.

---

## 16. Secrets management

### 16.1 Referenced policy

The full policy is [21](./21_ENVIRONMENT_VARIABLES.md) §1 (rules), §5 (Google Cloud key restrictions), §6 (handling and rotation), §7 (boot validation). This section adds only the enforcement mechanics and the leak runbook.

### 16.2 Classification

| Class | Members | Browser-visible | Handling |
| --- | --- | --- | --- |
| **A — Credential with total authority** | `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` | Never | Server-only. Bypasses all Security Rules. Treat a leak as a full compromise |
| **B — Paid/quota credential** | `GEMINI_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | B3 is public but **restricted** | Server-only for B1/B2. B3 must be restricted by referrer + API and by IP |
| **C — Operational secret** | `CRON_SECRET`, `IP_HASH_SALT` | Never | Server-only. `IP_HASH_SALT` rotates **daily** |
| **D — Not a secret** | `NEXT_PUBLIC_FIREBASE_*` web config, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_MAP_*` | Yes | Documented as public ([21](./21_ENVIRONMENT_VARIABLES.md) rule 6). Still environment-specific |
| **E — Never allowed anywhere** | `SESSION_SECRET`, `AUTH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `SENTRY_AUTH_TOKEN` | — | Do not exist ([21](./21_ENVIRONMENT_VARIABLES.md) §9). A PR adding one is rejected |

### 16.3 Enforcement chain

| # | Control | Mechanism | Fails the build? |
| --- | --- | --- | --- |
| 1 | Git ignore | `.env`, `.env.local`, `.env.*.local` in `.gitignore`; only `.env.example` is committed and it contains placeholders only | `git add -f` bypasses this, hence 2 |
| 2 | Pre-commit scan | `.husky/pre-commit` runs a `git diff --cached` grep for `-----BEGIN`, `AIza`, `"private_key"`, `GEMINI_API_KEY=`, and a non-empty `NEXT_PUBLIC_FIREBASE_API_KEY=` | ✔ |
| 3 | CI secret scan | `gitleaks detect --no-git` on the full working tree, plus `gitleaks protect --staged` on the commit range | ✔ |
| 4 | Server-secret pattern in the client bundle | The build fails if any `NEXT_PUBLIC_*` value matches a server-secret pattern; a production guard in `lib/env.ts` throws if a `NEXT_PUBLIC_*` value contains a `-----BEGIN` block | ✔ |
| 5 | Server-only import lint | Importing `lib/env.ts` (or any `lib/server/**`, `services/**`, `lib/api/**`) from a `"use client"` file is a build error via a custom ESLint rule | ✔ |
| 6 | Bundle assertion | `scripts/check-bundle.ts` asserts the Maps loader config and the absence of any key-shaped string in the emitted JS chunks, especially `/dashboard` | ✔ |
| 7 | Admin surface inventory | `GET /api/admin/system/health` reports which secret *names* are configured (never values) so a missing variable is visible without reading one | ✖ (observability) |
| 8 | Secret-free errors | `lib/env.ts` errors name the **variable**, never its value ([21](./21_ENVIRONMENT_VARIABLES.md) rule 4) | ✔ |
| 9 | No secrets in logs | `lib/server/logging.ts` redacts any key whose name matches `/KEY|SECRET|TOKEN|PASSWORD|PRIVATE/i` before serialising | ✔ |
| 10 | No secrets in audit rows | `auditLogs.before/after` are field allow-lists that exclude `email`, `phone`, `ipHash`, and every evidence URL ([07](./07_DATABASE_SCHEMA.md) §11.5) | review |

### 16.4 Rotation cadence

| Secret | Cadence | Mechanism | Documented in |
| --- | --- | --- | --- |
| `FIREBASE_PRIVATE_KEY` | **90 days** | Delete the key in GCP, create a new one, redeploy. Requires a redeploy, so it is a scheduled maintenance item, not a hot rotation | [21](./21_ENVIRONMENT_VARIABLES.md) §6 |
| `GEMINI_API_KEY` | On suspicion | Revoke in AI Studio, issue a new key, redeploy | §6 |
| `GOOGLE_MAPS_SERVER_KEY` | 90 days | Revoke, issue, redeploy, re-apply the IP restriction | §6 |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | 90 days | Tighten referrers; redeploy | §6 |
| `CRON_SECRET` | 180 days | Regenerate; no redeploy needed for the secret itself | §6 |
| `IP_HASH_SALT` | **Daily** | A scheduled rotation (Vercel cron `0 3 * * *`) writing the new value into Vercel env, or rotate-on-deploy. Historic hashes stay pseudonymous by design and are deliberately **not** re-salted | §6 |

> **Honest note on daily `IP_HASH_SALT`:** rotating daily means a hash from yesterday cannot be correlated with today's hash for the same IP. That is a privacy win and an investigative loss. We accept the privacy win because the audit trail's purpose is *accountability for a specific action*, not *long-term IP tracking*. Both `users` and `incidentReports` store the hash; correlating them requires the same-day salt.

### 16.5 On leak: the 30-minute runbook

```
0 min   STOP THE BLEED
        - Firebase:  GCP → IAM → Service Accounts → the key → DELETE  (not disable)
          A deleted key stops working immediately, everywhere.
        - Gemini:   AI Studio → API keys → REVOKE
        - Maps:     Google Cloud → Credentials → RESTRICT or DELETE
        - Cron:     regenerate CRON_SECRET

+5 min  ASSESS
        - Was it in git?  git log -S '<fingerprint>' --all
        - If yes: treat the key as compromised even if the commit was reverted.
          Git history is permanent. Rotation is the only fix.

+10 min FORCE ROTATION
        - Create the replacement, set it in Vercel (all three environments),
          redeploy production, then redeploy preview.
        - Verify with GET /api/health (200 with checks.firestore = ok).

+15 min CHECK BLAST RADIUS
        - Firestore: look for writes with no matching application behaviour.
          Specifically: any users/{uid}.role change, any responder verification,
          any incidents row with a reporterUid the reporter could not have used.
        - auditLogs: SELECT * WHERE action IN ('user.role_change','responder.verify',
          'user.enable','user.disable','config.update') AND createdAt > <exposure start>
          - Any row you cannot explain is an incident.
        - aiRuns: outcome = 'success' count far above the demo baseline = a key misuse
          or a quota-exhaustion attempt.

+30 min DOCUMENT
        - auditLogs entry action 'config.update', entityType 'auth', reason 'key rotation'
        - Note the exposure window in the incident record. Do not delete evidence.

+1h    CLOSE THE HOLE
        - Add the pattern to gitleaks allowlist ONLY if it is a genuine false positive,
          with a comment explaining why. Never blanket-allow.
        - Add a regression test asserting the secret's absence from the bundle.
```

**`FIREBASE_PRIVATE_KEY` leak is a total compromise.** The service account bypasses every rule in §9 and §10: it can promote any `users/{uid}` to `admin`, write or delete anything, read every document, and read every object. There is no partial mitigation. Rotation plus an audit-log review is the entire response, and if the exposure window cannot be bounded, the correct action is to **assume the data was read** and follow the incident's disclosure process. Recorded as residual risk RR-03 in [24](./24_THREAT_MODEL_SECURITY.md).

---

## 17. Rate limiting and abuse prevention

### 17.1 The Firestore token bucket

`rateLimits/{sha256(subject + ':' + route + ':' + windowBucket)}` ([07](./07_DATABASE_SCHEMA.md) §11.6). The doc ID is hashed so the document ID does not leak a uid; `subjectUid` is stored as a field for admin visibility only.

```ts
// lib/server/rate-limit.ts
export async function rateLimit(o: {
  subject: string;                 // uid, or a hashed IP for unauthenticated routes
  route: string;                   // route class, e.g. 'POST /api/incidents'
  limit: number;
  windowSec: number;
}): Promise<void> {
  const bucket  = Math.floor(Date.now() / 1000 / o.windowSec);
  const docId   = sha256Hex(`${o.subject}:${o.route}:${bucket}`);   // deterministic
  const ref     = db.collection('rateLimits').doc(docId);

  const count = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now  = Timestamp.now();
    const prev = snap.exists ? snap.data()! : null;
    // A stale bucket (process restart, clock skew) resets rather than blocks.
    const windowStart = prev ? prev.windowStart : now;
    if (windowStart.toMillis() <= now.toMillis() - o.windowSec * 1000) {
      tx.set(ref, { key: docId, count: 1, windowStart: now,
                     expiresAt: Timestamp.fromMillis(now.toMillis() + o.windowSec * 1000),
                     subjectUid: o.subject, route: o.route, updatedAt: now });
      return 1;
    }
    const next = (prev?.count ?? 0) + 1;
    tx.update(ref, { count: next, updatedAt: now });
    return next;
  });

  if (count > o.limit) {
    const retryAfterSec = o.windowSec - (Math.floor(Date.now() / 1000) % o.windowSec);
    res.headers.set('Retry-After', String(retryAfterSec));
    throw new HttpError(429, 'RATE_LIMIT_EXCEEDED', { retryAfterSec, limit: o.limit, windowSec: o.windowSec });
  }
}
```

| Property | Value | Why |
| --- | --- | --- |
| Store | `RATE_LIMIT_STORE=firestore` | An in-memory map is **unsafe on Vercel**: functions are stateless and concurrent, so a per-instance counter is multiplied by the instance count and resets on every cold start ([21](./21_ENVIRONMENT_VARIABLES.md) §2) |
| Cost | 1 read + 1 write per limited request | Accepted. The same request is going to cost more in Firestore anyway ([07](./07_DATABASE_SCHEMA.md) §15) |
| `expiresAt` | set to the end of the window | Firestore TTL deletes the doc; hygiene only, never correctness ([07](./07_DATABASE_SCHEMA.md) §12.7) |
| Transaction | required | A plain read-then-write races and under-counts under concurrency |
| Client IP | `x-forwarded-for` **first hop** when `RATE_LIMIT_TRUST_PROXY=true` (Vercel), else `''` | Trusting any hop lets an attacker spoof. `RATE_LIMIT_TRUST_PROXY` is `true` on Vercel and `false` locally |
| Order | **before** Zod validation, after the auth gate | So a flood of malformed requests is also limited; and so an unauthenticated flood is limited before `users/{uid}` is read |

### 17.2 Per-route limits ([08](./08_API_SPECIFICATION.md) §1.9)

| Route class | Limit | Window | Over-limit | Notes |
| --- | --- | --- | --- | --- |
| `POST /api/incidents` | 5 / 20 | 1 h / 24 h | `429 RATE_LIMIT_EXCEEDED` | FR-015. Two buckets, both enforced |
| `POST /api/incidents/:id/triage` | 20 | 1 h | `429` | Protects the Gemini quota (T-21) |
| `PATCH /api/incidents/:id/status` | 60 | 1 h | `429` | The responder's most-used write |
| `POST /api/incidents/:id/dispatch` | 30 | 1 h | `429` | — |
| `POST /api/incidents/:id/merge` | 20 | 1 h | `429` | — |
| `POST /api/uploads/sign` | 30 | 1 h | `429` | Prevents signed-URL minting at volume (T-05) |
| `PATCH /api/responders/:id/location` | 120 | 1 h | `429 HEARTBEAT_TOO_FREQUENT` | Plus a hard `capturedAt` floor of 20 s → effective ≈ 30 s; client backs off to 60 s |
| `GET /api/incidents` | 120 | 1 min | `429` | Read amplification (T-20) |
| `GET /api/analytics` | 30 | 1 min | `429` | Rollup reads are 1/day each |
| `POST /api/notifications` | 10 | 1 min | `429` | Admin-only anyway; double-gated |
| `POST /api/auth/login-failed` | **10 / IP** | 1 h | `429` | **FR-135** |
| `POST /api/me/bootstrap` | 10 | 1 h | `429` | — |
| `POST /api/auth/event` | 30 | 1 h | `429` | — |
| `GET /api/admin/audit-logs` | 30 | 1 min | `429` | Audit reads are paged at 50 |
| `GET /api/uploads/:mediaId/url` | 120 | 1 min | `429` | Prevents signed-URL minting for a known `mediaId` |
| `POST /api/analytics/recompute` | 5 | 1 h | `429` | — |
| `POST /api/admin/maintenance/*` | 5 | 1 h | `429` | — |

Every `429` carries `Retry-After` in seconds and the code `RATE_LIMIT_EXCEEDED`. The body never says *which* bucket was hit or what the limit is, so a prober cannot tune.

### 17.3 IP-based limits

| Route | Subject | Why IP and not uid |
| --- | --- | --- |
| `POST /api/auth/login-failed` | First hop of `x-forwarded-for` | The caller has no valid token. uid is unavailable. FR-135: **rate-limited to 10 per IP per hour to prevent log flooding** |
| `GET /api/health` | 60 / min per IP | An unauthenticated endpoint; must not be a free amplification vector |

`GET /api/health` is the only other unauthenticated route. `GET /api/cron/*` is authenticated by `CRON_SECRET`, not by uid, and is not IP-limited because its caller is a single known scheduler.

### 17.4 The 10/IP/hour login-failure log rule (FR-135)

```
POST /api/auth/event  { "type": "login_failed", "provider": "password",
                        "reason": "INVALID_PASSWORD" | "USER_NOT_FOUND" |
                                  "USER_DISABLED" | "NETWORK" }
  → rate limit 30/h per uid-or-IP on the endpoint
  → for type = login_failed ONLY: 10 per IP per hour on the *audit write*
  → over-limit ⇒ 429 RATE_LIMIT_EXCEEDED and NO audit row written
```

| Rule | Detail |
| --- | --- |
| Why a second, tighter limit | The endpoint's own 30/h protects the endpoint. FR-135's 10/IP/h protects the **log**. Without it, an attacker can write 30 attacker-chosen `login_failed` rows per hour per IP, from many IPs, and bury the real signal |
| What is recorded | `actorUid: 'anonymous'`, `entityType: 'auth'`, `entityId: sha256(ip)[:16]`, `summary: 'login_failed: INVALID_PASSWORD'`, `ipHash`, `userAgent` ≤ 200 chars, `requestId` |
| What is **not** recorded | The submitted email address, the submitted password (obviously), and any hint of whether the account exists |
| Response | Always `200 { "ok": true }` regardless of outcome. Never reveals existence ([08](./08_API_SPECIFICATION.md) §2.4) |
| Detection | `SELECT count(*) FROM auditLogs WHERE action='auth.login_failed' GROUP BY ipHash HAVING count > 3` — more than 3 from one IP in an hour is a credential-stuffing signal, and it is one of the four heuristics in §18.3 |
| Honest weakness | Rate limiting an audit write by IP does nothing against a distributed, low-and-slow campaign. The detection heuristic in §18.3 is the real control; the rate limit is a flood *volume* control, not a campaign detector |

### 17.5 Report spam controls

| Control | Value | Where |
| --- | --- | --- |
| Hard creation limits | 5 / hour, 20 / day per uid | FR-015, `POST /api/incidents` |
| Evidence requirement | ≥ 20 chars of text **or** ≥ 1 verified media item | FR-002, `EMPTY_REPORT` 422. Blocks `POST` bodies of `{"text":"help"}` |
| Media cost | ≤ 3 items, ≤ 3 images + 1 audio, 5 MB / 15 MB | FR-005, FR-006 |
| Duplicate dampening | `potential_duplicate` surfaces a "link your report" prompt; FR-018 | Does not block creation |
| Account age | An account younger than 5 minutes with no verified media is flagged `newAccount: true` on the incident (an **advisory** flag, never a block — a real emergency from a brand-new account must not be rejected) | `services/incidents/create-incident.ts` |
| Per-cell rate | > 3 reports from one uid inside one geohash-6 cell in 10 minutes ⇒ `spamCluster` flag | Same |
| Cross-signal | > 5 incidents in 24 h that are all later marked `false_alarm` ⇒ the uid is added to an admin review list; a repeat offender is `suspended` by an admin with a reason | `GET /api/admin/users?status=*` + a `spam` badge |

**There is no CAPTCHA and there is no IP reputation service.** Both cost money or require a third party. This is an accepted trade-off with a documented consequence: a determined attacker with fresh accounts can submit up to 5 reports per account per hour. The control that actually protects the *system* is not the per-account limit but (a) the duplicate engine collapsing repeats, (b) the dispatcher's `false_alarm` workflow, and (c) the mass-report heuristic in §18.3. Recorded as residual risk RR-07.

### 17.6 "Fake emergency report" detection signals

None of these blocks anything. They exist to make a campaign **visible** to an admin and to raise a `warning` audit entry.

| # | Signal | Computation | Where the data lives | Visible where |
| --- | --- | --- | --- | --- |
| S1 | Report volume spike by user | > 5 incidents in 24 h **and** > 3 in 1 h | `incidents` where `reporterUid == uid` | Admin user list badge + `warning` audit |
| S2 | Geographic clustering | > 3 reports from one uid in one geohash-6 cell within 10 min | `incidents.geoCells` | Incident detail flag |
| S3 | Post-hoc false-alarm ratio | `false_alarm` / total > 0.6 for a uid with ≥ 3 incidents | `incidents.status` | Admin review list |
| S4 | Evidence-free reports | text-only, short, template-like; the top-20 token Jaccard against the account's own previous reports > 0.8 | `incidents.originalText` | Admin review list |
| S5 | Prompt-injection suspicion | `sanitize.ts` `suspicionScore ≥ 3` | `aiRuns` metadata + the incident's `low_confidence` flag | Dispatcher AI panel; `warning` audit ([09](./09_AI_GEMINI_SPECIFICATION.md) R7) |
| S6 | Unverified responder reporting | `role == 'responder'` with `responders.verification != 'verified'` submits incidents | `users` + `responders` | Admin verification queue |
| S7 | Brand-new account + high urgency | account age < 10 min **and** `urgency == critical` | `users.createdAt` + `incidents.urgency` | Dispatcher queue row highlight |
| S8 | Urgency inflation | ≥ 3 consecutive `critical` reports from one uid that a dispatcher subsequently downgraded | `incidents.urgency` + `urgencySource` history | Admin review list |
| S9 | Duplicate farming | ≥ 3 incidents from one uid that were later merged away | `incidents.mergedIntoId` | Admin review list |
| S10 | Location-less critical reports | `urgency == critical` **and** `geo == null` | `incidents.geo` | Dispatcher queue; FR-034 already forces these to sort high |

The "suspicion score" referenced in S5 is the same counter documented in `services/ai/sanitize.ts` step 8: patterns `disregard the above`, `act as`, `new instructions`, `output json`, `set urgency to critical`, `mark as false alarm` each increment it; `≥ 3` forces `aiConfidence ≤ 0.4`, adds `low_confidence`, and logs the score. It is a **heuristic on untrusted input**, so it is attacker-satisfiable: anyone can write "set urgency to critical" to make their own report look suspicious. That is an acceptable trade — the cost of a false positive is one "needs review" badge; the benefit is that the most obvious injection attempts are tagged.

---

## 18. Privacy controls

### 18.1 Data minimisation

| Data | Who can read it | Never | Enforcement |
| --- | --- | --- | --- |
| `users/{uid}.email` | self, dispatcher, admin | responder, other citizens | `users` rules; `serialize.ts` |
| `users/{uid}.displayName` | self, dispatcher, admin | a responder viewing a **reported** incident | FR-068, NFR-027 — a responder sees the incident, not the person |
| `incidentReports[].ipHash` | admin (audit view) | responder, dispatcher queue | Redacted from every responder payload |
| `incidents.originalText` | reporter (own), dispatcher, admin | responder (replaced with `summary`) | FR-068; `redactForRole()` |
| `incidents.locationText` | reporter (own), dispatcher, admin | responder | FR-068 |
| `responders.phone` | dispatcher, admin | citizen, responder of another profile | Not in `GET /api/responders` at all; only `GET /api/responders/:id` for dispatcher/admin |
| `responders.verificationNote` | admin | dispatcher, self | Redacted for a self-read |
| `responders` performance stats | admin (FR-069); dispatcher read-only per [22](./22_USER_ROLES_PERMISSIONS.md) row 39 | citizen, responder | `serializeResponder()` gates the `stats` block |
| `responderLocations/*` | dispatcher, admin | citizen, **other responders** | Rules `allow read: if isDispatch()`; a responder reads their own through the API |
| `aiRuns` | dispatcher, admin | citizen, responder | Rules; hashes only, no raw output |
| `auditLogs` | admin; dispatcher read-only | citizen, responder | Rules; `ipHash` only, never a raw IP |
| `config.retention` | admin | everyone | `GET /api/config` returns the client-safe subset only |
| Anything from `process.env` | nobody via HTTP | everyone | No route reads env into a response; `check-bundle.ts` asserts absence in chunks |
| Reporter's street-level address from geocoding | dispatcher, admin, the assigned responder (as coordinates) | other citizens | FR-035: the reporter's street address is **not persisted** unless the reporter supplied it as text |

### 18.2 PII redaction before the AI sees anything

`services/ai/sanitize.ts` step 6 replaces emails, international phone numbers, and digit runs ≥ 7 with `[email]`, `[phone]`, `[number]` **in the text sent to the model only**. `incidents.originalText` is untouched (FR-003 and evidence integrity). Additional minimisation for the model call:

| Sent to Gemini | Never sent |
| --- | --- |
| Sanitised reporter text (≤ 2 000 chars) | Raw reporter text |
| Verified images, base64, capped | Street-level `placeName`; only the **district-level** `coarseArea` label is sent ([09](./09_AI_GEMINI_SPECIFICATION.md) §4.1) |
| Verified audio, ≤ 120 s | Anything under `quarantine/` |
| The 12-item `resourceId` catalogue, SLA minutes, `hasLocation` boolean | Coordinates. The model has **no** location output field except a bounded `location_hint` |
| | The system prompt itself, and any prompt example containing a real user string |
| | Anything identifiable: `users/{uid}`, `responders/{uid}`, emails, phones |

This is a **mitigation, not a guarantee** ([09](./09_AI_GEMINI_SPECIFICATION.md) §13): the free Gemini tier's data-handling terms still apply.

### 18.3 Location visibility matrix (FR-038, NFR-066, NFR-027)

| Observer | Citizen report location of an incident they do not own | Responder last-known location | Own location |
| --- | --- | --- | --- |
| Citizen (other) | **never** — FR-088; the map shows counts only | never | own only |
| Citizen (owner) | own incident, until the retention purge | never | own only |
| Responder (assigned) | **yes** — this is the point of the dispatch; `geo` + `placeName` | **own only** | own only |
| Responder (in-radius, unassigned, `available`) | **yes** — a 500 m-accurate pin is required to decide to self-claim; `summary` replaces the original text, reporter identity omitted | **own only** | own only |
| Responder (not assigned, not in radius) | never — 404 | **own only** | own only |
| Dispatcher | **yes** | **yes** | own only |
| Admin | **yes** | **yes** | own only |
| Nobody else | — | — | — |

| Control | Mechanism |
| --- | --- |
| Citizen map is counts-only | `GET /api/incidents` for a citizen forces `reporterUid == self`; the map component for a citizen renders aggregate cells, not pins (FR-088) |
| Responder location is not readable by other responders | Rules `allow read: if isDispatch()`; the API never exposes a list of responder locations to a responder |
| Offline responders are not tracked | FR-066: the client stops the heartbeat when `status == 'offline'`; the server forces `stale: true` on the stored doc |
| Stale locations are labelled, not hidden | `stale = true` when `receivedAt` is older than `STALE_LOCATION_MIN` (15); the candidate list sorts stale responders last and badges them |
| Accuracy is always shown | `accuracyGrade` is mandatory on every geo field (FR-032); the UI must display "approximate" for `low`/`unknown` |
| A responder's heartbeat can be corrected, not faked | `PATCH /api/responders/:id/location` rejects a `capturedAt` less than 20 s after the stored one and clamps `capturedAt ≤ now + 60 s`; `receivedAt` is **server** time and is what staleness is computed from |

### 18.4 Retention

| Data | Retention | Mechanism |
| --- | --- | --- |
| **Precise citizen location** (`geo`, `geoCells`, `placeId`) after incident closure | **90 days** (NFR-028) | The `purge-closed-locations` maintenance job sets `geo = null`, `geoCells = []`, `placeId = null` on incidents where `deletedAt`/`closedAt` is older than `config.app.retention.locationPurgeDays`. **The purge is audited** (`incident.update` with `reason: 'retention purge'`) and a `locationPurgedAt` timestamp is set so the job is idempotent. An admin may extend retention per-incident; the extension is itself audited |
| `locationText` supplied by the reporter | 90 days, same job | Same — it is street-level personal data by the reporter's own act |
| `responderLocations` when `status == 'offline'` | 15 min | `stale: true`; the candidate list ignores stale responders. The document is overwritten on the next heartbeat, so there is no history to retain |
| `rateLimits` docs | end of the window | `expiresAt` + Firestore TTL |
| `notifications` | `expiresAt` | Hidden, not deleted |
| `aiRuns` | 365 days (aligned with audit) | No raw prompt, no raw output, no PII — only hashes, counts, latencies |
| **`auditLogs`** | **≥ 365 days** (FR-136) | No hard delete exists. Firestore TTL is **not** applied to `auditLogs`; a TTL policy would be a policy violation. Documented in the privacy notice |
| Soft-deleted incidents | indefinite | FR-123, DEC-11. Restorable by an admin |
| `statusHistory` | lifetime of the incident | FR-059 |
| Evidence in `quarantine/` | 30 days | The purge job ([15](./15_FILE_STORAGE_SPECIFICATION.md) §14). `DECISION REQUIRED`: `purge-quarantine-media` is not yet in the `POST /api/admin/maintenance/*` list in [08](./08_API_SPECIFICATION.md) §10 — it must be added |
| Evidence on a live incident | lifetime of the incident | Never auto-purged. An open incident's evidence is the operational record |

### 18.5 Audit-log privacy

| Field | Stored | Never stored |
| --- | --- | --- |
| `ipHash` | SHA-256 of the IP + the daily-rotating `IP_HASH_SALT` | The raw IP |
| `userAgent` | ≤ 200 chars, control characters stripped | — |
| `before` / `after` | a per-action field allow-list: `{ status }`, `{ role }`, `{ verification }`, `{ duplicateRadiusM }`, `{ status }` | `email`, `phone`, `ipHash`, evidence URLs, reporter text, `originalText`, `resolutionNote` |
| `summary` | ≤ 200 chars, hand-written per action | Free text from a user field |
| `reason` | required for privileged actions, 10–280 chars | — |
| `requestId` | correlation with server logs (FR-141) | — |
| Raw request/response bodies | — | **Never** in any log or audit row |
| API keys, tokens, env values | — | **Never.** `lib/server/logging.ts` redacts by key name |

`GET /api/admin/audit-logs` is `admin` (full) or `dispatcher` (read-only), paged at 50, filterable by actor, action, entity type, entity id, and date range, and exportable as CSV (re-auth gated). A `dispatcher` reading the audit log is itself recorded — the read is a `GET`, so it is not in the FR-132 list, but `?format=csv` writes a `notification.sent`-style informational row. `DECISION REQUIRED`: whether audit *reads* should be audited.

---

## 19. Security logging and alerting

### 19.1 What is audited (FR-130 … FR-132)

Every entry: `actorUid`, `actorRole`, `action`, `entityType`, `entityId`, `incidentRef`, `summary` (≤ 200), `before`, `after`, `reason`, `requestId`, `ipHash`, `userAgent` (≤ 200), `createdAt`.

| Action | Emitted by | `reason` required | Extra |
| --- | --- | --- | --- |
| `incident.create` | `services/incidents/create-incident.ts` | — | `before: null` |
| `incident.update` | `services/incidents/update-incident.ts` | dispatcher edits: yes | `before`/`after` on whitelisted fields only |
| `incident.status_change` | `services/incidents/change-status.ts` | for `false_alarm`, `cancelled`, forced override | `metadata.skippedStates` on a jump |
| `incident.assign` | `services/dispatch/assign.ts` | — | `before`/`after` assignee |
| `incident.unassign` | `services/dispatch/withdraw.ts` | yes | — |
| `incident.merge` | `services/duplicates/merge.ts` | yes | Both `incidentId`s |
| `incident.merge_revert` | `services/duplicates/undo-merge.ts` | yes | — |
| `incident.false_alarm` | `services/incidents/change-status.ts` | yes | — |
| `incident.delete` | `services/incidents/delete-incident.ts` | yes | `metadata.quarantinedMedia: n` |
| `incident.restore` | `services/incidents/restore-incident.ts` | yes | — |
| `responder.verify` | `services/responders/verify.ts` | yes (`note`) | `before`/`after` `verification` |
| `responder.reject` | `services/responders/reject.ts` | yes | — |
| `responder.update` | `services/responders/update.ts` | — | whitelisted fields |
| `responder.location_opt_out` | `services/responders/update.ts` | yes | On `status → offline` |
| `user.role_change` | `services/admin/change-role.ts` | yes | `before`/`after` `role`; `severity: warning` when granting `admin` |
| `user.disable` | `services/admin/set-user-status.ts` | yes | — |
| `user.enable` | `services/admin/set-user-status.ts` | yes | — |
| `config.update` | `services/admin/config.ts` | yes | `before`/`after` of the changed keys |
| `auth.login` | `services/auth/auth-event.ts` | — | — |
| `auth.login_failed` | `services/auth/auth-event.ts` | — | FR-135, 10/IP/h |
| `auth.logout` | `services/auth/auth-event.ts` | — | — |
| `auth.role_mismatch` | `requireUser()` | — | §5.4 drift detection. `severity: warning` |
| `auth.csrf_rejected` | `assertSameOrigin()` | — | §12 |
| `auth.blocked` | `requireUser()` status gate | — | Suspended/disabled account hitting a route |
| `notification.sent` | `services/notifications/dispatch-notification.ts` | — | Includes the `dedupeKey` |

### 19.2 What produces an admin notification

In-app notifications ([07](./07_DATABASE_SCHEMA.md) §10.2) and a `warning`/`critical` audit `severity`:

| Event | Recipients | Severity | Why |
| --- | --- | --- | --- |
| `user.role_change` | the affected user (`role_changed`) | `warning` | A privilege change must be visible to its subject |
| `account_suspended` | the affected user | `warning` | Same |
| `responder_verified` | the affected responder | `warning` | — |
| Any `auth.role_mismatch` | **all admins** (a synthetic `critical_incident_alert`-style row, deduped per uid per hour) | `warning` | Drift is either a bug or an attack (§5.4) |
| Any `auth.csrf_rejected` | **all admins**, deduped per IP per hour | `warning` | An attack signature, not a user error |
| Any `auth.login_failed` burst (§18.4 heuristic) | **all admins**, deduped per IP per hour | `warning` | Credential stuffing |
| `config.update` touching `duplicate.*`, `slaMinutes.*`, or `retention.*` | **all admins** | `warning` | These three change what responders and citizens see |
| `incident.merge` on an incident with `evidenceCount > 0` | **all admins**, deduped per merge | `warning` | Merging moves evidence between incidents |
| `MAINTENANCE_DISABLED` attempt | all admins | `warning` | Someone poking at jobs |
| `claimsSynchronised: false` (D2) | the acting admin (inline) + **all admins** (deduped) | `warning` | Half-applied role change |
| `aiRuns.outcome == 'blocked'` rate > 10% in 1 h | **all admins** | `warning` | Either a content problem or an abuse campaign |

Everything else is visible in `/admin/audit-logs` and `/admin/system/health` but does not page anyone. In-app notification fan-out is non-blocking and retried at most twice; a notification failure **never fails the originating request** (FR-107).

### 19.3 Suspicious-pattern detection

Four detectors, all computable from existing indexed fields, all runnable in the admin UI as a saved filter. They are **queries**, not a detection service, because a detection service costs money and would need its own credentials.

| Detector | Query over | Threshold | Why it matters |
| --- | --- | --- | --- |
| **D-MASS** — mass report rate by user | `incidents` grouped by `reporterUid`, `createdAt > now − 24 h` | > 5 created **and** > 3 in the trailing hour | T-39. The single most operationally damaging abuse pattern: it can bury a real critical incident under 20 false ones |
| **D-ROLE** — role-change anomalies | `auditLogs` where `action = 'user.role_change'` | (a) ≥ 3 grants of `dispatcher`/`admin` by one actor in 1 h; (b) any grant to an account created < 24 h ago; (c) any grant where the target had a `suspended` history; (d) any `admin` grant not made by the bootstrap admin | T-40. A compromised admin creating a second admin is the classic persistence move |
| **D-AUTH** — login-failure spikes | `auditLogs` where `action = 'auth.login_failed'` grouped by `ipHash` | > 3 in 1 h, or > 20 across distinct IPs in 15 min (distributed) | T-25. The distributed variant is why the per-IP rate limit alone is not a defence (§17.4) |
| **D-INJ** — injection suspicion | `aiRuns` where `suspicionScore >= 3` grouped by `reporterUid` | ≥ 2 runs in 24 h | T-11..T-13. Attacker-satisfiable by design, so the threshold is on **repetition**, not on a single hit |
| **D-DRIFT** — claim drift | `auditLogs` where `action = 'auth.role_mismatch'` grouped by `actorUid` | ≥ 3 in 24 h | §5.4. Either a real bug in the claim-mirror retry or a token-minting attempt |
| **D-QUOTA** — AI cost/abuse | `aiRuns` counts grouped by hour | > `GEMINI_RPM_LIMIT` or > `GEMINI_RPD_LIMIT` in a window | T-21. Exhausting the free tier during a live demo is a *product* failure |
| **D-EXPORT** — bulk export | `auditLogs` where `action = 'incident.update'` on `includeDeleted=1` reads, or a `GET /api/incidents/:id/export?format=csv` | any single dispatcher exporting > 200 rows/day | Bulk data exfiltration by a compromised dispatcher |

Each detector is a documented query in `/admin/audit-logs` **saved filter**, so an admin can run it with no new code and no new credential. `DECISION REQUIRED`: whether to add a scheduled digest (a Vercel cron writing one `notifications` row per admin per day) or to leave detection entirely pull-based. For a hackathon MVP, pull-based is the right answer, and saying so is more honest than shipping a half-built alerting service.

---

## 20. Security testing

### 20.1 Test classes and locations

| # | Class | Location | Count | Runner | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | **Firestore rules** | `tests/integration/firestore-rules.test.ts` | ≥ 60 assertions, named per permission row | Vitest + `@firebase/rules-unit-testing` + emulator | PR must be 100% green (NFR-014) |
| 2 | **Storage rules** | `tests/integration/storage-rules.test.ts` | ≥ 24 assertions | same | same |
| 3 | **API auth pipeline** | `tests/integration/api/auth.test.ts` | ~20 | Vitest + mocked Admin SDK | PR |
| 4 | **API role denial** | `tests/integration/api/roles/*.test.ts` | 1 per `—` row of [22](./22_USER_ROLES_PERMISSIONS.md) §3 (≈ 25) | Vitest | PR |
| 5 | **API scope denial** | `tests/integration/api/scope/*.test.ts` | 1 per `◐` row | Vitest | PR |
| 6 | **Cross-user leakage** | `tests/integration/api/leakage/*.test.ts` | 1 per "not mine" resource | Vitest | PR |
| 7 | **Non-existence opacity** | `tests/integration/api/opacity.test.ts` | 2 (incident, media) — asserts **byte-identical** bodies | Vitest | PR |
| 8 | **Claim drift** | `tests/integration/api/claim-drift.test.ts` | 1 per drift cause D1/D2/D3 | Vitest | PR |
| 9 | **Suspension / revocation** | `tests/integration/api/suspension.test.ts` | 2 (API denial + `tokensValidAfter` written) | Vitest + emulator | PR |
| 10 | **Re-auth gate** | `tests/integration/api/reauth.test.ts` | 1 per privileged action in §3.6 | Vitest | PR |
| 11 | **CSRF** | `tests/integration/api/csrf.test.ts` | 6 | Vitest | PR |
| 12 | **Rate limiting** | `tests/integration/api/rate-limit.test.ts` | 1 per route class in §17.2 (≥ 14) + `Retry-After` + cross-uid isolation | Vitest + emulator | PR |
| 13 | **Zod-before-I/O** | `tests/integration/api/validation-order.test.ts` | 1 per route: assert **zero** Firestore calls for an invalid body | Vitest + call-counting mock | PR. This is the FR-142 proof |
| 14 | **Injection / traversal** | `tests/integration/api/injection.test.ts` | ≥ 12: `__proto__`, `constructor`, `../`, `admin` in the body, `role` in the body, `recipientUid` in the query, 21-char `incidentId`, `javascript:` URL, CRLF in `reason`, `array-contains` in `q` | Vitest | PR |
| 15 | **Redaction** | `tests/integration/api/responders/redaction.test.ts` | The full [22](./22_USER_ROLES_PERMISSIONS.md) §4.1 matrix | Vitest | PR |
| 16 | **Lifecycle matrix** | `tests/unit/lib/incidents/lifecycle.test.ts` | Every legal and illegal cell of [07](./07_DATABASE_SCHEMA.md) §4.3 | Vitest (pure) | PR |
| 17 | **AI sanitiser** | `tests/unit/services/ai/sanitize.test.ts` | ≥ 40: zero-width, bidi override, NUL, fence, `ignore previous`, `system:`, `<citizen_report>` injection, repeated 8-gram flood, PII redaction, length caps | Vitest (pure) | PR |
| 18 | **AI adversarial** | `tests/fixtures/ai/*.test.ts` over ≥ 40 fixtures | [09](./09_AI_GEMINI_SPECIFICATION.md) §10 | Vitest, network to Gemini (skipped in CI by default, run pre-demo) | Pre-demo manual gate |
| 19 | **AI output validation** | `tests/unit/services/ai/rules.test.ts` | R1–R10 individually, including the diagnosis filter and `urgency` never lowered by code | Vitest (pure) | PR |
| 20 | **Upload validation** | `tests/integration/api/uploads/*.test.ts` | See [15](./15_FILE_STORAGE_SPECIFICATION.md) §17 | Vitest + emulator | PR |
| 21 | **Security headers** | `tests/e2e/security-headers.spec.ts` | Real browser: every header present; injected inline script does not execute; clickjacking blocked; no CSP violation on 4 routes | Playwright | PR |
| 22 | **Bundle secret scan** | `scripts/check-bundle.ts` | No server-secret pattern in any emitted chunk; no `FIREBASE_PRIVATE_KEY`; the Maps key is present but restricted-format | Node script | PR |
| 23 | **Lint XSS** | ESLint `no-restricted-properties` + CI grep | Zero occurrences of `dangerouslySetInnerHTML` in `app/`, `features/`, `components/` | ESLint | PR |
| 24 | **gitleaks** | `.github/workflows/ci.yml` | Full-tree scan + staged scan | CI | PR |
| 25 | **Env validation** | `tests/unit/lib/env.test.ts` | Missing var throws naming the var; `ALLOW_SEED=true` + production throws; `CRON_SECRET` missing in production throws; `-----BEGIN` in a `NEXT_PUBLIC_*` value throws | Vitest | PR |
| 26 | **Audit completeness** | `tests/integration/api/audit-completeness.test.ts` | 1 per privileged action: exactly one `auditLogs` row, and a rolled-back transaction leaves none | Vitest | PR |
| 27 | **Transaction atomicity** | `tests/integration/api/atomicity.test.ts` | Simulated mid-transaction failure ⇒ no partial `statusHistory`, no partial assignment | emulator | PR |
| 28 | **E2E role journeys** | `tests/e2e/{citizen,responder,dispatcher,admin}.spec.ts` | The happy path per role, plus a direct-URL access to a forbidden page rendering a 403 state | Playwright | PR |

### 20.2 Pre-demo security smoke (run by hand, ~10 minutes)

```
1.  gitleaks detect --no-git
2.  npm run check:bundle                     # no secret in any chunk
3.  npm run test:int                          # 100% of rules tests pass (NFR-014)
4.  npm run test:unit
5.  npm run build                             # the production guard in lib/env.ts runs here
6.  curl -sI https://<prod>/ | grep -iE 'content-security-policy|x-content-type|permissions-policy|referrer-policy'
7.  A citizen SDK context cannot read another user's incident      → PERMISSION_DENIED
8.  A citizen SDK context cannot delete auditLogs/{id}            → PERMISSION_DENIED
9.  A client PUT to incidents/{id}/reports/{rid}/med_x.jpg        → PERMISSION_DENIED
10. GET /api/incidents with a stolen incidentId as another user   → 404, identical body
11. POST /api/incidents with role:"admin" in the body             → 400 VALIDATION_FAILED
12. POST /api/incidents 6 times in an hour                      → 429 RATE_LIMIT_EXCEEDED
13. Inspect the browser console on /report and /dashboard        → zero CSP violations
```

---

## 21. Incident response runbook

### 21.1 Suspected account takeover

```
TRIGGER  an admin sees D-AUTH, a dispatcher sees an impossible action, or a user
         reports "someone used my account".

0 min  FREEZE
       PATCH /api/admin/users/{uid}/status { "status":"suspended", "reason":"ATO suspected" }
       → sets users/{uid}.tokensValidAfter = now, so every existing token dies
       → writes auditLogs user.disable
       → in-app account_suspended (best-effort)

5 min  SCOPE
       - auditLogs WHERE actorUid = uid AND createdAt > first-unknown-time
         Read it as a timeline. The FIRST unexpected row is the compromise point.
       - dispatches WHERE responderUid = uid (if the victim is a responder)
       - incidents WHERE assigneeUid = uid AND status NOT IN ('resolved','closed')
       - Look specifically for: incident.false_alarm, incident.merge, incident.delete,
         user.role_change (if the victim is an admin), config.update

15 min CONTAIN THE ACTIONS, NOT JUST THE ACCOUNT
       - Undo dispatcher mistakes: re-dispatch, restore soft-deleted incidents
         (POST /api/incidents/:id/restore, reason "ATO response"),
         re-verify any responder the account verified.
       - config.update rows are NOT rolled back automatically — review each key
         against its audit before/after and restore by hand with a reason.

30 min CREDENTIAL HYGIENE
       - If the provider was Google: the ATO is a Google account problem.
         Reset the password, check Google account sessions, revoke third-party access.
       - If the provider was password: force sendPasswordResetEmail; check for
         credential stuffing in auth.login_failed for that ipHash.

2h    DOCUMENT
       - auditLogs entry: action user.disable, reason "ATO response",
         with the scope summary in the summary field (≤ 200 chars).
       - Notify the affected user. Record the incident window.

NEVER  - delete any auditLogs row
       - silently re-enable without a reason
       - tell the user "there was no breach" without checking auth.login_failed
```

### 21.2 Leaked key

See §16.5. The short form, by credential:

| Credential | Immediate action | Then |
| --- | --- | --- |
| `FIREBASE_PRIVATE_KEY` | **Delete** the key in GCP IAM | New key, redeploy, audit `user.role_change` / `responder.verify` / `config.update` over the exposure window. Assume data read. RR-03 |
| `GEMINI_API_KEY` | Revoke in AI Studio | New key, redeploy, check the usage dashboard for volume, check `aiRuns` for runs you did not initiate |
| `GOOGLE_MAPS_SERVER_KEY` | Restrict, then replace | Check the Google Cloud billing dashboard **immediately** — an unrestricted server key with Geocoding enabled is a direct cost exposure |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Tighten referrer restrictions | Not confidential, but an unrestricted key is T-14. Check billing |
| `CRON_SECRET` | Regenerate | Nothing to review; nobody should have been using it |
| `IP_HASH_SALT` | Rotate | No incident. The salt is not a credential |

### 21.3 Malicious report campaign

```
TRIGGER  D-MASS fires, or a dispatcher reports a wave of identical reports.

0 min  Triage the signal, not the content
       - GET /api/incidents?urgency=critical&from=<1h>  and  ?category=...
       - Group by geoCells[0] (geohash-6) and by text similarity.
       - Identify the single most likely primary incident.

10 min CONTAIN THE NOISE
       - Admin/dispatcher marks the copies false_alarm WITH a reason
         (POST /api/incidents/:id/merge into the primary is usually the right move —
         it collapses them without losing the reports).
       - Suspend the driving accounts individually, with a reason each.
         NEVER mass-update without per-user reasons: FR-133 exists for this.

30 min PRESERVE THE EVIDENCE
       - Do NOT hard-delete. Soft delete, which moves media to quarantine/.
       - Export the audit slice (dispatcher/admin) and store it with the incident record.
       - aiRuns for the window gives you the suspicionScore distribution and the
         rawOutputHashes — enough to prove the campaign without storing the text.

2h    ASSESS HARM
       - Did any false report cause a responder to be dispatched and travel?
         Those dispatches are real cost and real risk to the responder.
       - Did a real incident get buried and go unverified for longer than its SLA?
         Compare slaBreachedAt across the window.

AFTER  Adjust thresholds with a reason (config.update, audited):
       duplicatePotentialThreshold, textSimilarityConfirm, and — if the campaign
       came from many accounts — the decision on CAPTCHA is DECISION REQUIRED.
```

### 21.4 Prompt-injection campaign

```
TRIGGER  D-INJ fires, or a dispatcher notices urgency fields that contradict the text.

0 min  STOP THE MODEL FROM BEING A DECISION
       - This is already true by construction: the AI cannot dispatch, verify,
         assign, resolve, or close (DEC-05, [09](./09_AI_GEMINI_SPECIFICATION.md) §1.2).
         Confirm no code path changed: grep for 'tools' in services/ai/gemini.ts
         must return nothing.

10 min MEASURE
       - aiRuns WHERE outcome='success' AND suspicionScore>=3, grouped by hour
       - Incidents where urgencySource='ai' and a human downgraded urgency within
         10 minutes of creation  ← this is the injection-success metric
       - Compare against the honest baseline. If the downgraded-after-AI rate
         jumps, the campaign worked on the model, even though it did not work
         on the system.

30 min MITIGATE
       - services/ai/sanitize.ts step 5 already neutralises the classic markers.
         If the campaign uses a new pattern, add it to step 5 AND to
         tests/fixtures/ai/ with the exact text used.
       - Consider lowering AI_CONFIDENCE_REVIEW_THRESHOLD for the window
         (a config/env change, not a code change) so more incidents show
         "needs review" and more human eyes land on them.
       - If the campaign is contaminating the model's context persistently,
         rotate GEMINI_MODEL to the other model. This is a config change.

AFTER  Bump PROMPT_VERSION in services/ai/prompts.ts and add a fixture.
       aiRuns.promptVersion keeps history interpretable, which is precisely why
       it is stored ([09](./09_AI_GEMINI_SPECIFICATION.md) §6).
```

### 21.5 Rules misconfiguration (discovered in production)

```
1.  firebase deploy --only firestore:rules --config firestore.rules.bak   # roll back
2.  npm run test:int                                                   # prove the rolled-back file is green
3.  npm run test:int                                                   # prove the NEW file fails the specific test
4.  Fix the rules; re-run; deploy.
5.  If the rules file is *too permissive*: treat it as a potential incident.
    Audit the affected collections over the exposure window
    (users.role changes, dispatches created, auditLogs writes attempted).
    Firestore rules denials are NOT logged server-side, so assume the window is
    unbounded unless you have deployment timestamps.
6.  If the rules file is *too restrictive*: the blast radius is availability, not
    confidentiality. Check: can users sign in? can the dispatcher queue load?
    can a responder heartbeat? T+0 diagnosis, T+15 fix, T+30 redeploy.
```

---

## 22. Known limitations and accepted residual risk

Every row is real. Nothing here is a hypothetical, and nothing here is hidden in a different document.

| ID | Risk | Likelihood | Impact | Why it is accepted | What would close it | FR / threat |
| --- | --- | --- | --- | --- | --- | --- |
| RR-01 | **Token revocation lag.** `tokensValidAfter` is enforced by the API only. Firestore rules still let an old token read its own `users/{uid}` until it expires (≤ 1 h) | Possible | Minor | All privileged reads are server-mediated, so an old token can learn nothing that matters. Making rules revocation-aware is not reliably expressible | Moving the revocation check into a custom-claims reset loop, or accepting a ≤ 1 h exposure window as the design | [22](./22_USER_ROLES_PERMISSIONS.md) §8.3, FR-136 |
| RR-02 | **Token in browser storage.** A successful XSS on our origin can exfiltrate the Firebase ID token | Unlikely | Major | 1-hour lifetime; no `dangerouslySetInnerHTML`; strict nonce CSP; no third-party script but the Maps loader; sign-out clears cached data (US-042) | Move the token to a `HttpOnly` cookie (which reintroduces CSRF surface) or to Firebase Auth's iframe-based persistence; both are worse trade-offs for this system | T-24, NFR-013 |
| RR-03 | **Service-account key compromise = total compromise.** The Admin SDK bypasses every rule in §9 and §10 | Unlikely | Severe | It is the standard Firebase server architecture; a second identity system would be worse. Mitigated by gitleaks, pre-commit, boot-time env validation, 90-day rotation, and the documented 30-minute runbook | Workload Identity Federation / default credentials on a Google-managed runtime instead of a long-lived key. Not available on Vercel | T-14 in [24](./24_THREAT_MODEL_SECURITY.md) |
| RR-04 | **No WAF or rate limiting at the CDN edge.** Vercel's built-in firewall is not a rate limiter; an attacker can reach a function directly | Likely | Moderate | All meaningful limits are per-uid or per-IP **in the API**, which is the correct place anyway (a uid limit cannot be enforced at the edge). The exposure is a higher volume of *rejected* requests, each costing one function invocation and one Firestore read | Vercel WAF / Cloud Armor, or a `firewall.toml`-equivalent. Both cost money, which the $0 constraint forbids | T-19, NFR-016 |
| RR-05 | **CSV formula injection.** A crafted field could become a live formula when an exported CSV is opened in Excel or Sheets | Possible | Minor | Cells are prefixed with `'` when they begin with `=`, `+`, `-`, `@`, tab, or CR; exports never include reporter identity or free text (FR-118, [08](./08_API_SPECIFICATION.md) §3.11) | Generating XLSX with a strict cell-type, or an in-app viewer instead of a file download | T-28 |
| RR-06 | **Supply chain.** A malicious or compromised npm package runs inside our origin with our CSP permissions | Unlikely | Major | Minimal dependency set; exact version pinning in `package-lock.json`; `npm ci` in CI (never `npm install`); Dependabot; one vendor script only | Vendoring, a private registry mirror, or a build-time allow-list of package hashes | T-43 |
| RR-07 | **No CAPTCHA, no IP reputation.** A distributed campaign with fresh accounts can still submit ~5 reports per account per hour | Likely | Moderate | The per-account limit plus the duplicate engine plus D-MASS detection plus the dispatcher's `false_alarm` workflow are the real controls. A CAPTCHA costs money and hurts the accessibility target (NFR-017) in exactly the emergency flow that matters most | A Cloudflare Turnstile free tier, or an email-verification gate on the *reporting* flow only. `DECISION REQUIRED` — the product must choose between abuse resistance and one-handed reporting under duress | T-39, FR-015 |
| RR-08 | **No second factor.** A stolen password is a full account takeover, and an ATO of a dispatcher or admin is high impact | Possible | Major | 1-hour tokens, audit on every privileged action, no self-service role change, reasons required everywhere, revocation is instant at the API | Firebase Auth MFA (TOTP) enabled for `dispatcher` and `admin` roles. `DECISION REQUIRED` — it is a real product cost: responders on shared phones will object | T-25, T-40 |
| RR-09 | **Google account linking.** A takeover of a linked Google identity silently takes over the CareGrid account | Possible | Major | Firebase links on matching verified email by design, preventing one person holding two identities | Disabling automatic linking and requiring an explicit merge with a re-authentication step. Costs UX and adds a support burden | T-25 |
| RR-10 | **Magic-byte verification is necessary but not sufficient.** A polyglot can satisfy the signature check | Possible | Low | The payload is never rendered in our origin: it is served from a different origin with a fixed `image/jpeg` type and `nosniff`, and is displayed only through `<img>`, which does not execute script. SVG/HTML are not in the allow-list at all | A real image decoder (re-encode with `sharp`, or Cloud Run + libvips) that discards non-pixel data. `sharp` is deliberately absent from the stack ([09](./09_AI_GEMINI_SPECIFICATION.md) §4.2) | T-06, T-07 |
| RR-11 | **No virus scanning.** ClamAV is not available at $0 | Possible | Major (in principle) | Magic-byte allow-list, no server-side rendering of untrusted content, quarantine path, `scanStatus` on every `MediaRef`, retention bounds. A malicious *polyglot* that is also a *valid* image is the residual case, and it is only ever displayed, never executed | Cloud Functions + Cloud Run with ClamAV and a synchronous scan before `scanStatus: 'clean'`. The upgrade path is documented in [15](./15_FILE_STORAGE_SPECIFICATION.md) §11 | T-06 |
| RR-12 | **EXIF GPS survives a non-compliant client.** `sharp` is absent, so the server cannot strip metadata | Likely (by default) | Moderate | Recommend-and-verify: the client re-draws to a `<canvas>` before upload, which drops all metadata. The step is **untrusted-but-useful** — a modified client can skip it. Stored EXIF is never surfaced in any UI and is downloadable only by the roles already entitled to the evidence | `sharp` server-side strip, or a server-side re-encode. `DECISION REQUIRED` on whether location-bearing EXIF is acceptable to retain at all | T-29, NFR-028 |
| RR-13 | **Server-side audio duration is not verifiable** without a decoder, so the 120 s limit is client-enforced | Likely | Low | Byte size (15 MB) is a real bound; the client auto-stops at 120 s; Gemini's own input cap bounds what is processed. A longer file is stored but only ever transcribed up to the model limit | `ffprobe` in Cloud Run, or a client-signed duration plus a spot-check | T-05 |
| RR-14 | **The Gemini free tier's data-handling terms apply.** Citizen content reaches a third-party processor | Certain | Moderate | PII is redacted before the call, only a district-level label is sent, only hashes are logged. This is a mitigation, not a control | A paid tier with a data-governance agreement, or Vertex AI with a data policy. Both cost money | T-11, [09](./09_AI_GEMINI_SPECIFICATION.md) §13 |
| RR-15 | **Audit-log *reads* are not audited.** A dispatcher with read access can browse the log without leaving a trace | Likely | Low | The log is admin-focused; a dispatcher's read is bounded to dispatcher-visible rows; writes are all audited, and a read cannot alter anything | Audit `GET /api/admin/audit-logs` as `audit.read`. Costs one write per page view, which is 1 write per 50 rows — cheap. `DECISION REQUIRED` | T-37 |
| RR-16 | **`POST /api/auth/event` is unauthenticated in practice** and its own `reason` field is attacker-controlled | Likely | Low | It writes one of three fixed actions, is IP+uid rate limited, never returns whether a user exists, and `summary` is generated server-side from the action and a validated enum — the caller's `reason` string is **not** copied into `summary` | Server-side login instrumentation via Firebase Auth blocking functions, which is a plan change | T-38 |
| RR-17 | **Staging orphans.** An interrupted upload leaves bytes in `staging/{uid}/` for up to `STAGING_UPLOAD_SWEEP_MIN` (30 min) | Likely | Low | The staging prefix is reachable only by its owner, costs pennies, and the `sweep-staging-uploads` maintenance job removes it | Nothing needed. Accepted as the cost of not having the incident ID at upload time | T-05 |
| RR-18 | **Free-tier revocation is not instant at the platform level.** Firebase Auth may keep accepting a token for a short window after `tokensValidAfter` is set | Possible | Minor | The API performs its own `users/{uid}.status` check, which is immediate and does not depend on the platform's revocation timing | Nothing in our control. Documented, not hidden | FR-136, [22](./22_USER_ROLES_PERMISSIONS.md) §8.3 |
| RR-19 | **Version skew in `@google/genai`.** An SDK major bump could change `responseSchema` or safety-setting semantics, silently weakening validation | Possible | High | `.strict()` Zod validation happens **after** the model call, so a schema change can only produce a validation failure and a fallback — never an unvalidated field reaching `incidents.*` | Pin the resolved version in `package-lock.json` and assert the shape in a contract test. `DECISION REQUIRED`: who is allowed to bump it | T-15, T-17 |
| RR-20 | **The CDN is inside the trust boundary for static assets only.** A cache poisoning of a *static* asset would persist across users | Unlikely | Moderate | `/api/**` responses are `no-store` and `Vary: Origin, Authorization`. Static assets are content-hashed by Next.js and contain no user data | Nothing further without a WAF | T-42 |

### 22.1 `DECISION REQUIRED` items in this document

| # | Decision | Why it needs a product decision, not an engineering one | Blocks |
| --- | --- | --- | --- |
| D-1 | Should the `POST /api/incidents` `media[].storagePath` regex accept **both** `staging/{uid}/{mediaId}.{ext}` and the final `incidents/{id}/(reports\|supplements)/{rid}/{mediaId}.{ext}` form? [08](./08_API_SPECIFICATION.md) §3.1 states only the latter; §8.1 states the client posts the staging path. The permissive union is what the implementation does ([15](./15_FILE_STORAGE_SPECIFICATION.md) §3) | Whether the body carries the staging path or the final path changes the contract and the test fixtures | `validators/incident.ts`, the finalize flow, and the storage doc's regex |
| D-2 | Is MFA mandatory for `dispatcher` and `admin`? (RR-08) | It is a real cost for volunteer responders on shared phones | The sign-in UX and the Firebase Auth console |
| D-3 | Is a CAPTCHA or email-verification gate acceptable on the reporting flow? (RR-07) | It trades the 30-second one-handed report (US-001) against abuse resistance | The `/report` flow and the abuse posture |
| D-4 | Is location-bearing EXIF acceptable to retain on evidence? (RR-12) | A privacy judgement, not a technical one | The client strip step, and any future `sharp` work |
| D-5 | Should audit-log *reads* be audited? (RR-15) | One extra write per page view; a product call about visibility vs cost | `GET /api/admin/audit-logs` |
| D-6 | Should `purge-quarantine-media` be added to the `POST /api/admin/maintenance/*` job list? | It is an operational gap with a privacy dimension | `services/admin/maintenance.ts` |
| D-7 | Should a scheduled security digest replace pull-based detection? (§19.3) | A daily notification row per admin is a UX commitment | The cron config and `services/notifications` |
| D-8 | Is `REAUTH_WINDOW_SEC` (300 s) the right re-auth window? | It is a security/usability trade-off with no obvious right answer | The admin UX and §3.6's list |
| D-9 | Should the media path regex reject any `..` path segment explicitly, even though `mediaIdOk()` and the character classes already prevent one? | Defence in depth versus a redundant pattern that a reviewer must reason about | `validators/upload.ts` |
| D-10 | Does the product accept that a `V4` signed Storage URL bypasses Security Rules for its TTL (§10.4)? | It is a platform behaviour, not a choice — but the *reliance* on it is a choice, and the alternative is proxying every download through a function, which costs bandwidth | The evidence-serving design |
| D-11 | Should `POST /api/auth/event` `reason` accept a free string for future providers, or stay a closed enum? | A closed enum is safer and does not scale | `validators/auth.ts` |

---

## 23. Cross-reference index

| Concern | Authoritative location |
| --- | --- |
| Role definition, permission matrix, scoped-permission detail | [22](./22_USER_ROLES_PERMISSIONS.md) §1–§5 |
| Field names, collections, indexes, transactions | [07](./07_DATABASE_SCHEMA.md) |
| Endpoint contracts, envelopes, rate-limit table, security checklist | [08](./08_API_SPECIFICATION.md) §1–§3, §12 |
| AI sanitisation, prohibitions, adversarial tests | [09](./09_AI_GEMINI_SPECIFICATION.md) §1.2, §4.3, §10 |
| Env var names, restrictions, rotation | [21](./21_ENVIRONMENT_VARIABLES.md) |
| Uploads, MIME allow-list, magic bytes, quarantine, cost | [15](./15_FILE_STORAGE_SPECIFICATION.md) |
| Threat IDs, risk rubric, attack paths, control coverage | [24](./24_THREAT_MODEL_SECURITY.md) |
| Trust boundaries TB1..TB5 | [03](./03_SYSTEM_ARCHITECTURE.md) §7 |
| `middleware.ts` scope limits | [05](./05_FRONTEND_ARCHITECTURE.md) §9 |
| Folder paths for every file named here | [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2 |

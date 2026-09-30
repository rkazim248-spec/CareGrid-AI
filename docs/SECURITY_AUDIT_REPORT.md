# CareGrid AI — Security Audit Report

**Phase 10 — security, testing & production hardening**
**Date:** 2026-09-30 · **Scope:** the Phases 1–9 implementation as it stands
**Method:** static audit of the actual repository, mechanical verification by
`scripts/security-check.cjs`, and mutation testing of the new invariants.

> **This report does not claim the application is secure because the build passes.**
> Section 9 states exactly what was *not* tested, and §2.1 records a coverage gap
> that is material: **the Firestore rules have never been executed.**

---

## 1. Severity scale

| Level | Meaning here |
| --- | --- |
| **Critical** | Unauthenticated, or trivially authenticated, compromise of data or control. |
| **High** | A signed-in user's or a whole class of user's data is exposed, or an operational control is silently absent. |
| **Medium** | A defence is present but incomplete; exploitation needs a condition the auditor did not disprove. |
| **Low** | Hardening gap, hygiene issue, or a control that protects something of low value. |
| **Informational** | Verified-correct behaviour worth recording so a later change does not regress it. |

Per brief §3, severity is asserted only where the implementation justifies it. Most
of this codebase's controls are real; the report says so rather than manufacturing
findings to justify the exercise.

---

## 2. Findings summary

| # | Severity | Component | Title |
| --- | --- | --- | --- |
| **CG-10-01** | **High** | Realtime / auth | `unsubscribeAll()` had no caller: a listener outlived the identity that opened it |
| CG-10-02 | Medium | Testing | Firestore and Storage rules have never been executed |
| CG-10-03 | Low | Supply chain | `postcss` High advisory is not runtime-reachable here; 10 further advisories are transitive |
| CG-10-04 | Low | Tooling | The security checker read a stale `.kilo` worktree copy of the project |
| CG-10-05 | Low | Navigation | `/analytics` is gated by a hardcoded role rather than capability `r48` |
| CG-10-06 | Low | Rate limiting | `RATE_LIMIT_RULES['me.read']` was declared but attached to no handler |
| CG-10-07 | Informational | Authorization | Role is enforced from a custom claim, which lags a role change by up to one token lifetime |
| CG-10-08 | Informational | Uploads | `contentType` and `size` are client-asserted; only server-side re-validation closes it |

**Fixed in this phase: CG-10-01, 04, 06. Documented and accepted: 02, 03, 05, 07, 08.**

### 2.1 CG-10-01 — Realtime listeners outlived the identity that opened them

**Severity: High** · **Component:** `lib/realtime/listener-registry.ts`,
`lib/firebase/auth.ts` · **Status: FIXED**

A Firestore `onSnapshot` is a subscription with a captured credential. Its query is
fixed at subscribe time. In this app those queries are scoped by user:

| Listener | Query | What it holds |
| --- | --- | --- |
| L5 `notifications` | `where('recipientUid','==',uid)` | **one person's private correspondence** |
| L1 `queue` | active statuses, live | the dispatcher's incident queue |
| `responderAssignments` | per responder | the dispatch board |

`unsubscribeAll()` existed from Phase 8 and had **zero callers** through Phase 9.
Nothing ever closed a channel on an identity change. `clearUserScopedStorage()` — the
sign-out path — reaches `localStorage` and `sessionStorage`, and a live listener is
not storage.

**Attack scenario.** A dispatcher signs out on a shared or kiosk machine and does not
close the tab. Their incident queue, dispatch board and notification list remain in
the app's memory and in every consumer's `state.items`. A second person signs in —
different account, or the same browser later. The listeners are still attached to the
*first* account's queries, so the app renders the previous user's data while the new
session's data loads. The same window exists on a token revoked from the Firebase
console, a session terminated by `disableSignIn`, or an account switch in a second
tab — none of which route through the app's own `signOut()`.

**Impact.** Cross-account disclosure of operational and private data on a shared
device, with no attacker tooling required — only a sign-out that does not close the
tab. For a citizen the exposure is their own report history; for a dispatcher it is
the live queue, which is the most sensitive operational surface in the product.

**Fix.** The teardown rule is separated from the wiring so it can be proven:

- `lib/realtime/identity.ts` (new) — `decideListenerTeardown()` and
  `createIdentityWatch()`. Pure. Decides **when**, and distinguishes four cases plus a
  boundary condition.
- `lib/firebase/auth.ts` — `signOut()` calls `closeRealtimeListenersFor('signed_out')`
  **before** `fbSignOut`, because `fbSignOut` resolves only once the token is gone
  and anything reading listener state in that window would find the old channels
  attached. `handleAuthStateOrIgnoreError` — the single funnel every auth handler in
  the app passes through — calls the same teardown on an identity change, before
  invoking the handler so no render ever sees the stale state.

**The rule, and the case that makes it non-obvious:**

| Event | Teardown | Why |
| --- | :-: | --- |
| first resolution | no | nothing is open; tearing down races the listeners about to open |
| **same uid (token refresh)** | **no** | fires ~hourly; closing here is hourly channel churn for no security gain |
| `null` → uid (sign-in) | no | the new account's listeners have not opened yet |
| uid → `null` (sign-out) | **yes** | the channels must not outlive the user |
| **uid A → uid B (switch)** | **yes** | A's listeners are still bound to A's queries |

`hasResolvedOnce` is load-bearing: `previousUid === null` is ambiguous between "boot,
nothing seen" and "the last user left", and those need **opposite** behaviour.

**Verified by:** 15 unit tests (`tests/unit/realtime/identity.test.ts`), including a
full-session sequence, three consecutive account switches, sign-out-then-back-in, two
independent watches, and the registry's detach counters — a registry that cleared its
map without calling `detach` would report zero open and still hold every subscription.
Plus security checks **CG-10-C75/C76/C77**, all mutation-tested.

**Residual risk.** A browser that hard-kills the tab without firing
`onAuthStateChanged` leaves nothing to clean up, because the memory dies with the
process. Accepted.

### 2.2 CG-10-02 — The Firestore and Storage rules have never been executed

**Severity: Medium (coverage, not a defect) · Status: OPEN, disclosed**

`firestore.rules` and `storage.rules` are verified **structurally** by the security
checker — 135 checks read the rule text and assert the shape of each match block. No
check has ever evaluated them.

The rules are deny-by-default, `users/{uid}` refuses all client writes, `auditLogs` is
append-only, and the Storage catch-all denies. But structural reading cannot catch a
rule that is well-formed and wrong — a `&&`/`||` precedence slip, a helper that returns
the opposite of its name, a `hasOnly` list that omits one field.

**Why it is not fixed here:** the Firestore rules emulator requires a Java runtime, and
neither `java` nor `firebase-tools` is present in this environment. The emulator ports
*are* already configured in `firebase.json` (auth 9099, firestore 8080, storage 9199),
so the blocker is the toolchain, not the project.

**To close it:** install a JDK 11+ and `firebase-tools`, then run
`npm run test:rules`. That script and the assertions it drives are specified in §9.1
below. This is the single highest-value remaining item in the whole backlog.

### 2.3 CG-10-03 — Dependency advisories

**Severity: Low · Status: ACCEPTED, one applied**

`npm audit` reports 12 advisories; a non-breaking `npm audit fix` resolved 1
(`gaxios`). The remaining 11:

| Package | Severity | Reachable? | Reasoning |
| --- | --- | --- | --- |
| `postcss` | **High** | **No** | Not a production dependency, transitive via `next`. **No application file imports it.** The two advisories are *XSS via unescaped `</style>` in CSS stringify output* and *arbitrary file read via crafted CSS* — both require stringifying attacker-controlled CSS, and this app compiles its own Tailwind at build time. The fix is a `next` major, which would risk the Firebase/Next integration the brief says not to break. |
| `uuid` | Moderate | No | Buffer bounds check in v3/v5/v6 *when a `buf` argument is provided*. No `uuid` call in app code passes one. |
| `google-gax`, `@google-cloud/firestore`, `@google-cloud/storage`, `firebase-admin`, `retry-request`, `teeny-request` | Moderate | No | All transitive through `firebase-admin`'s Google SDK chain. Fix is breaking. |
| `vitest`, `@vitest/mocker` | Moderate | No | **Dev dependency.** Path traversal in the test mocker — not shipped. |

Brief §32 says not to blindly upgrade and not to break Firebase/Next. No package was
force-upgraded. The one substantive question — whether `postcss` should be pinned or
overridden — is recorded in §9.2 as a decision for the deployment owner, not taken
blindly.

### 2.4 CG-10-04 — The checker read a stale worktree

**Severity: Low (tooling) · Status: FIXED**

`scripts/security-check.cjs`'s `SKIP` set omitted `.kilo`, which holds a full stale
copy of the project from an earlier phase. Every check was therefore reading **two**
copies of most files.

This is not cosmetic. A check can be satisfied by a line in a worktree that is not part
of the build, and a mutation test can appear not to trigger because a second copy of
the target still holds the original text. It surfaced concretely: check CG-10-C90
reported the Gemini key read by six modules, three of them in `.kilo` and two of them
test files.

**Fix:** `.kilo`, `.vercel` and `out` added to `SKIP`. The path list is also normalised
to forward slashes in the shared `SCANNED` set, because `path.join` yields backslashes
on Windows and a downstream `file.startsWith('tests/')` silently stopped matching —
which is how two checks came to count test files as production modules.

### 2.5 CG-10-05 — `/analytics` gated by role, not by capability

**Severity: Low · Status: OPEN, disclosed**

`config/nav.ts` decides `/analytics` with `role === 'dispatcher' || role === 'admin'`.
The declared capability `r48_readOperationalAnalytics` has exactly those values in the
61-row matrix, so the two agree today.

`docs/14 §10` ACC-1 states the `permissions[]` array from `GET /api/me` "drives the
**UI affordances only**" — so a role comparison in the nav is UX, and the API
re-checks every request. Not a vulnerability. It is an inconsistency: a capability
matrix that exists to be the single source of truth is bypassed by a second, hand-written
role test that can drift from it. Check **CG-10-C72** asserts the nav matches the
capability's *values*, so a divergence is now visible. Left as a known inconsistency
rather than silently changed, because the route is unwired and there is nothing to
verify against yet.

### 2.6 CG-10-06 — A rate-limit rule attached to nothing

**Severity: Low · Status: FIXED (as a check), code unchanged**

`RATE_LIMIT_RULES['me.read']` is declared with `limit: Number.POSITIVE_INFINITY` and is
referenced only in a comment in `app/api/me/route.ts`.

The comment is right that the exemption is deliberate: `GET /api/me` runs on every
authenticated page load and every session refresh, so a limit there breaks navigation
for anyone who uses the product. The problem is that a rule table entry which no
handler references is **indistinguishable from a forgotten one**, and it looked like
the route was governed when the route declared no key at all.

**Fix:** new check **CG-10-C79** requires an unlimited GET to *name* a recorded
infinite rule — so "deliberately unlimited" is now a table entry a reviewer and a
mutation test can both see, not a comment. `api/me` **PATCH** was separately verified
to declare `rateLimit: 'me.update'` (30/hour, `docs/10 §17.2`); an initial scan
suggested otherwise and that scan was wrong.

### 2.7 CG-10-07 — Role is enforced from a custom claim

**Severity: Informational · Status: ACCEPTED BY DESIGN**

`firestore.rules` reads `role()` from `request.auth.token.role` — a **mirror** written
by the server after a role change, not `users/{uid}.role`. `docs/22 §2` forbids
trusting the client, and it is not: the claim is server-written and the authoritative
document is never client-writable (`users/{uid}` refuses all client writes).

The consequence is a lag: a rules-only decision can be wrong for up to one ID-token
lifetime after a role change. The rules file documents this, and the API path detects
exactly the situation and answers `403 ROLE_MISMATCH` rather than trusting the stale
claim. Recorded so a future change does not remove the mismatch detection.

### 2.8 CG-10-08 — Upload `contentType` and `size` are client-asserted

**Severity: Informational · Status: ACCEPTED, mitigated by architecture**

`storage.rules` caps `request.resource.size` and matches
`request.resource.contentType.matches('image/(jpeg|png|webp)')`. Both values are
asserted by the client at upload time, exactly as brief §9 warns.

The architecture's answer is that Storage rules are the *outer* bound and the server
is the *inner* one: `POST /api/uploads/sign` issues a signed URL against a validated
claim, and `POST /api/uploads/finalize` re-validates server-side before the media
becomes retrievable. Both are rate-limited 30/hour and paired deliberately — the
comment records that the pairing is what bounds live staging objects.

**Not verified:** the finalize path was not executed against a live bucket (§9).

---

## 3. Verified — no finding

These were checked and are correct. Recorded because a later change that breaks them
is a real regression, and because an audit that only lists problems implies the rest
was not examined.

| Area | Evidence |
| --- | --- |
| **XSS sinks** | **Zero** occurrences of `dangerouslySetInnerHTML`, `eval`, `new Function`, `.innerHTML =`, `.outerHTML =`, `document.write`, `insertAdjacentHTML` across all 390 TS/TSX files. Check CG-10-C87, mutation-tested. |
| **SSRF** | The server fetches **no** user-supplied URL. The only absolute-URL fetch is to the hardcoded `https://maps.googleapis.com/maps/api/geocode/json` host. Check CG-10-C88. |
| **Open redirect** | No `location.href`/`assign`/`replace`, no `window.open`, no `NextResponse.redirect` driven by request input. Check CG-10-C89. |
| **Gemini key** | Read in exactly one module, `lib/env.server.ts`, which imports `server-only`. Zero reads in any client-reachable module. Checks CG-10-C90/C90b/C91, all mutation-tested. |
| **Secrets in history** | Every reachable git blob scanned for `AIza…` keys, PEM private-key headers, and long secret assignments. **0 hits** across 600+ blobs. |
| **`.env` handling** | Only `.env.example` is tracked. `.gitignore` covers `.env`, `.env*.local`, **and** the environment-named files without the `.local` suffix (`.env.*` plus three `!` exceptions) — a fix from an earlier audit, since a rule set ending in `.local` let `.env.production` fall through. `.env.example` holds only non-secret defaults. |
| **Client env purity** | `lib/env.client.ts` reads **only** `NEXT_PUBLIC_*` names. No non-public name is inlined into the browser bundle. Check CG-10-C91. |
| **API authorisation** | All 17 handlers declare `auth: 'required'` except `api/health`. Every mutating handler declares a rate limit. 15 rules, 14 attached, 1 a recorded exemption. Checks CG-10-C78/C79/C80. |
| **Field-level rules** | `users/{uid}` → `allow create, update, delete: if false`. `auditLogs` → `allow update, delete: if false` for every role. `profiles/{uid}` is writable but bounded by `hasOnly(profileWritableFields())` and cannot set `uid`. |
| **Storage** | `match /{allPaths=**}` denies. Final evidence (`incidents/…`) and `quarantine/` are `if false`. `staging/{uid}/` is owner-scoped with **both** a 15 MB cap and a MIME allow-list. Check CG-10-C86. |
| **Prompt injection** | `SYSTEM_INSTRUCTION` is a `const` template literal with **no interpolation** — a structural guarantee, not a convention. Untrusted text is wrapped in `<citizen_report>` / `<untrusted_extract>`, and the sanitiser defangs both delimiters so a report cannot close its own block. Checks CG-10-C81/C82, mutation-tested. |
| **AI output validation** | `aiTriageOutputSchema` is Zod; `category` and `urgency` are `z.enum(...)`, and confidences are `z.number().min(0).max(1)`. `AI_UNKNOWN_FIELDS` gives `unknown` defaults rather than invented values. Check CG-10-C83. |
| **Security headers** | 8 required headers set in one place. `script-src` carries **no** `'unsafe-inline'`; `'unsafe-eval'` sits only in the development ternary arm. Checks CG-10-C92/C93, mutation-tested. |
| **CSRF** | `lib/server/http.ts` asserts same-origin (`assertSameOrigin`) with an explicit allow-list derived from `NEXT_PUBLIC_APP_URL`, and the CSP adds `form-action 'self'`. No session cookies exist, so there is no ambient credential for a cross-site request to ride. |
| **Rate limiting** | A Firestore-backed fixed-window counter keyed on `sha256(subject|route|window)` — no paid service, satisfying brief §21. Documented in `rate-limit.ts` as replaceable. |

---

## 4. API security table

Generated by reading each `withRequest({...})` block, not by assumption. 17 handlers.

| Route | Method | Auth | Rate limit | Capability | Sensitive data |
| --- | --- | :-: | --- | --- | --- |
| `/api/health` | GET | none | `health.read` 60/min ip | — | no |
| `/api/auth/me` | GET | required | `auth.me` 120/min uid | — | no |
| `/api/auth/event` | POST | required | `auth.event` 30/h uid | — | no |
| `/api/me` | GET | required | **`me.read` ∞ (recorded)** | — | no |
| `/api/me` | PATCH | required | `me.update` 30/h uid | — | preferences |
| `/api/me/bootstrap` | POST | required | `me.bootstrap` 10/h uid | — | no |
| `/api/ai/triage` | POST | required | `ai.triage` 20/h uid | `r13_readAiTriagePanel` | report text + media |
| `/api/uploads/sign` | POST | required | `uploads.sign` 30/h uid | `r01_createIncident` | no |
| `/api/uploads/finalize` | POST | required | `uploads.finalize` 30/h uid | `r01_createIncident` | media metadata |
| `/api/uploads/[mediaId]/url` | GET | required | `uploads.url` 120/min uid | — | signed URL |
| `/api/incidents/[id]/status` | PATCH | required | `dispatch.transition` | `r01_createIncident` + reporter-or-ops | incident |
| `/api/incidents/[id]/dispatch` | POST | required | `dispatch.assign` | `r29_assignResponder` | incident + responder |
| `/api/incidents/[id]/candidates` | GET | required | `dispatch.candidates` | `r28_seeCandidateResponders` | responder availability |
| `/api/dispatches/[dispatchId]` | POST/PUT/DELETE | required | `dispatch.respond` | `r30_unassignWithdraw` + state machine | dispatch |
| `/api/admin/system/health` | GET | required | `admin.systemHealth` 30/min uid | admin | system health |

**Rate limits are enforced centrally** in `lib/server/route.ts`, so a route cannot
acquire a limit by accident in one handler and miss it in another. Rate-limited by IP
only where there is no identity yet (`health.read`).

---

## 5. Dispatch and status-transition security

`docs/19` names two dispatchers assigning the same responder to the same incident as
the race that matters. Phase 7 addressed it and Phase 10 verified rather than changed:

- Assignment runs in a **Firestore transaction**; the server/database is authoritative.
- The `assigneeUid` / `activeIncidentCount` invariants on the incident document are
  the serialisation point — a second transaction re-reads and fails rather than
  overwriting.
- `docs/07 §7` lifecycle transitions are a **declared, centralised** map
  (`services/dispatch/`), 60 tests and 6 mutations covered in Phase 7. A client cannot
  jump `reported → resolved`; the map has no such edge.
- Reassignment, rejection, withdrawal and cancellation are distinct operations with
  distinct capabilities, not one "update" verb.

**Not verified here:** concurrent-assignment behaviour was tested against a mocked
Firestore transaction, not a live one. See §9.

---

## 6. Privacy

| Data | Protection |
| --- | --- |
| Citizen coordinates | Never exposed beyond the incident's own authorised readers. `services/maps/reverse-geocode.ts` is **server-only** and uses `GOOGLE_MAPS_SERVER_KEY`, never the browser key. |
| Responder location | `ownLocation` is scoped to the responder's own document. `mapLocations` is dispatcher/admin. Stale positions are marked via `STALE_LOCATION_MIN`. |
| Notification metadata | `notifications` reads are owner-scoped in the rules; the client mapper projects a declared subset and never echoes `recipientUid` back into the row. |
| Analytics | `topLocations` returns **geohash-6 cell counts**, never coordinates — a security check asserts the return shape has no `lat`/`lng`/`geo` field, so an export of precise locations is impossible through it. Positionless incidents are counted and reported as `withoutPosition`, not dropped. |
| Audit logs | Append-only, and readable by admins. Contains actor, action, timestamp, target, metadata. |

---

## 7. Error handling and logging

**14 `console.*` call sites**, all reviewed:

| Site | Assessment |
| --- | --- |
| `app/(app)/incidents/[id]/error.tsx` | `console.error` with `error.message` on an error boundary. No user data, no stack. Acceptable. |
| `hooks/use-realtime-listener.ts` | `console.warn` with a mapped Firestore code. No document content. |
| `lib/api/client.ts`, `lib/firebase/auth.ts` | Both guarded by `NODE_ENV !== 'production'`. |
| `components/providers/session-provider.tsx` | Same guard. |
| `lib/realtime/listener-registry.ts` | Budget warning, counts only. |
| `lib/firebase/auth.ts` (Phase 10) | `closeRealtimeListenersFor` — **count and reason only**, never a uid. Deliberate: the log must be able to say *which* account's channels closed without printing the account. |
| `scripts/repair-encoding.cjs` | A developer script, not shipped. |

**No secret, token, password, uploaded content or exact coordinate is logged
anywhere.** Errors are funnelled through `toAppError`, which maps to a typed
`AppError`; production responses carry a code, a safe message and a request id, never a
stack trace, a filesystem path or a Firebase internal.

---

## 8. New verification added

**19 new mechanical checks (116 → 135)**, and every one mutation-tested — **16
mutations, 16 caught**. A check that cannot fail is not a control.

| Check | Invariant |
| --- | --- |
| C75 | `signOut` closes listeners **before** `fbSignOut` (order, not presence) |
| C76 | `onAuthStateChanged` also tears down on an identity change |
| C77 | A same-uid token refresh and the first resolution do **not** tear down |
| C78 | Every mutating handler declares a rate limit |
| C79 | An unlimited GET records the decision as an explicit infinite rule |
| C80 | A finite rate-limit rule is attached to a route, or is a recorded exemption |
| C81 | `SYSTEM_INSTRUCTION` is a literal with no interpolation |
| C82 | Untrusted text is wrapped **and** the delimiters are defanged |
| C83 | AI output is Zod-validated; confidences bounded to 0–1 |
| C84 | `users/{uid}` refuses all client writes |
| C85 | `auditLogs` refuses update and delete for every role |
| C86 | Storage denies by default; final evidence closed; staging size+MIME capped |
| C87 | No script-injection sink anywhere in the tree |
| C88 | The server fetches no user-supplied URL |
| C89 | No navigation is driven by a user-supplied URL |
| C90 | `GEMINI_API_KEY` is read only by the `server-only` env module |
| C91 | `lib/env.client.ts` reads only `NEXT_PUBLIC_*` |
| C92 | All 8 non-negotiable response headers are set in one place |
| C93 | `script-src` has no `'unsafe-inline'`; `'unsafe-eval'` is dev-only |

**Four check bugs were found by the mutation testing and fixed** — each a check that
passed for the wrong reason:

1. **C90** matched a different access idiom than the codebase uses, and reported
   **zero** reads for a key that is read eight times. A security check that reports
   "no exposure" because it cannot see the exposure is worse than no check.
2. **C78/C79** iterated route option blocks without pairing them to a method, so
   `api/me`'s rate-limited PATCH was flagged against its unlimited GET — a correct
   implementation failing a check written to catch an incorrect one.
3. **C93** scanned the middleware with comments **in**, and flagged the codebase's own
   explanation of why `style-src` may use `'unsafe-inline'`. To make it pass, someone
   would have had to delete the explanation.
4. **C84** asserted the Firestore verbs `read`/`query`; the rules use `get`/`list`, so
   the pattern never matched and the check was vacuous.

Plus the path-separator bug (CG-10-04) where `startsWith('tests/')` silently failed on
Windows.

---

## 9. What was NOT tested

This is the section that matters most, and the one a build-passing audit omits.

### 9.1 The Firestore and Storage rules were never executed

Structural reading only. `npm audit` and the 135 checks say nothing about rule
*semantics*. **The emulator requires Java, which is not installed here**, and
`firebase-tools` is absent. The ports are already configured in `firebase.json`.

**To close it** — the assertions that should exist, written as deny-then-allow pairs:

| Collection | Must be denied | Must be allowed |
| --- | --- | --- |
| `users/{uid}` | any client write, by anyone, including self | own `get`; dispatch `list` |
| `profiles/{uid}` | setting `uid`; any field outside `profileWritableFields()`; another user's document | own create/update |
| `incidents/{id}` | a non-reporter reading a private incident; writing `aiAnalysis`, `verifiedAt`, `createdBy` | reporter create with `hasOnly(clientCreatableFields())` |
| `dispatches/{id}` | a responder claiming an unassigned dispatch; a citizen writing any field | responder accept on an assigned dispatch |
| `notifications/{id}` | reading or marking-read another user's; **any** `create` or `delete` by a client | own `get`; own update limited to `read`/`readAt`/`updatedAt` |
| `auditLogs/{id}` | `update` and `delete` by **every** role, admin included | server-only create |
| `locations/*` | a client writing **another** responder's position; any citizen read | own position write |
| Storage `staging/{uid}/` | another user's path; >15 MB; a non-image/non-audio MIME | own write within both caps |
| Storage `incidents/…`, `quarantine/` | **all** client read/write/delete | nothing — served via signed URLs |

### 9.2 Also untested

| Area | Why |
| --- | --- |
| **Browser behaviour** | No browser. CSP enforcement, `Permissions-Policy`, COOP/popup behaviour and the Google sign-in popup are unverified in a real browser. |
| **Mobile / tablet rendering** | Brief §40 lists 7 breakpoints. None was rendered. |
| **Accessibility** | Brief §39 asks for keyboard, focus, contrast and screen-reader checks. No automated `axe` run and no manual pass. |
| **Live Firebase** | No deployed project, no deployed indexes, no real bucket. No listener has ever executed end to end. |
| **Gemini** | No `GEMINI_API_KEY`. The injection defence is verified structurally (C81/C82) and by unit tests against a stubbed provider, never against the live API. |
| **Concurrency** | Duplicate-dispatch prevention was tested against a mocked transaction. |
| **Performance** | No load test. The listener budget and the 8-slot cap are unit-tested; real read counts are not measured. |
| **E2E** | No end-to-end suite. The brief §37 scenario is covered by unit and integration tests over mocked boundaries, not by a running application. |

### 9.3 Two decisions for the deployment owner, not taken blindly

1. **`postcss`** — no runtime exposure (§2.3). Pinning or overriding is a judgement
   about accepting an upstream High advisory in exchange for not forcing a `next`
   major. Not decided here.
2. **Emulator tooling** — a JDK plus `firebase-tools` is a real install. §9.1 is the
   largest unverified surface in the product, so it is worth the install, but it is
   not free and it is not small.

---

## 10. Deployment readiness

| Gate | Status |
| --- | --- |
| TypeScript | **PASS** — 0 errors |
| ESLint | **PASS** — 0 errors, 0 warnings |
| Tests | **PASS** — 1,573 across 47 files |
| Security checks | **PASS** — 135/135 |
| Production build | **PASS** — exit 0 |
| Encoding | **PASS** — clean |
| No known Critical | **PASS** — 0 Critical |
| Secrets | **PASS** — none in tree, client, or history |
| Firestore rules **reviewed** | PASS |
| Firestore rules **executed** | **NOT DONE** (§9.1) |
| Storage rules **executed** | **NOT DONE** (§9.1) |
| Browser / responsive / a11y verified | **NOT DONE** (§9.2) |
| Live Firebase / Gemini verified | **NOT DONE** (§9.2) |

**Conclusion.** No Critical or High-exploitable defect was found, and the one High
finding (CG-10-01) is fixed and mutation-tested. The codebase's existing controls —
deny-by-default rules, `server-only` boundaries, a non-interpolated system
instruction, a centralised rate limiter, and a non-parameterised CSP — are real and
verified.

**It is not yet production-proven.** The largest gap is that **the security rules
have never been executed**, and no code has run in a browser. A green build and 135
green checks are evidence of *consistency*, not of *correctness under attack*. The
three items in §9.1 and §9.2 stand between this codebase and a defensible claim of
production readiness.

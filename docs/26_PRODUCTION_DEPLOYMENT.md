# 26 — Production Deployment Runbook

Phase 16. Target: **Vercel**.

This document is the operational half of Phase 16. It is written to be followed
top to bottom by someone who has never deployed this application before.

> **Read this first.** Nothing in this repository can deploy itself. Every step in
> sections 1–4 needs a credential or a console that only an operator has: a Vercel
> account, a Firebase project, API keys from three vendors. What the repository
> does provide is the full gate, the configuration, and the checklists — so that
> the human part is mechanical rather than exploratory.

---

## 0. What is already done, and what is not

**Done in the repository (verified this phase):**

| Artifact | State |
|---|---|
| `vercel.json` | Created. Framework pin, `buildCommand: npm run verify`, `installCommand: npm ci`. |
| `.nvmrc` | Created. `22.11.0`, matching `engines.node` in `package.json`. |
| `next build` | Passes. Exit 0, 33 routes. |
| `tsc --noEmit` | Passes. Exit 0. |
| `npx vitest run` | 1702 tests / 54 files pass. |
| `security:check` | 133/136 — the 3 failures are all "git is not installed", see §5.2. |
| `.env.example` | Reconciled against the code. 12 undocumented variables added, 6 dead ones flagged. |
| Security headers | `middleware.ts` sets CSP/HSTS/etc. Deliberately **not** duplicated in `vercel.json`. |

**Not done, and cannot be done from here:**

1. **No deployment.** There is no Vercel account, no `vercel` login, and no
   production Firebase project in this environment. Sections 1–4 are therefore
   checklists, not confirmations.
2. **No smoke test.** §6 cannot run against a URL that does not exist. Worse,
   two of the twelve flows it names **cannot pass** — see §6.1, which is the most
   important section in this document.
3. **No production security review.** Phase 15 is still open, including the
   5 high / 10 moderate `npm audit` findings. Those are triaged in Phase 16 but
   not remediated; see §9.

---

## 1. Production environment checklist

Set these in the **Vercel project settings → Environment Variables**, not in a
file. Mark each one **Sensitive** in the Vercel UI; that masks the value in build
logs and in the deployment log view.

`NEXT_PUBLIC_*` values are **inlined into the JavaScript bundle at build time**.
Changing one requires a **redeploy**, not a server restart. This is the single
most common source of "I changed the map token and nothing happened".

### 1.1 Required — the app does not work without these

| Variable | Sensitive | Source | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | no | your domain | **Must be `https://`** in production. `lib/env.client.ts` `requiredUrl()` throws on a non-https app URL when `NODE_ENV=production`, and this URL is the CSRF allow-list — an http value makes the origin check bypassable. |
| `NEXT_PUBLIC_APP_ENV` | no | literal `production` | Drives `isProduction()` in the client. Distinct from `NODE_ENV`, which Next sets itself. |
| `IP_HASH_SALT` | **yes** | `openssl rand -hex 32` | Pseudonymises stored IPs. Unset ⇒ `hashIp()` returns `null` ⇒ unauthenticated routes fall back to a **global** rate-limit bucket. Not fatal, but it turns a per-IP limit into a shared one. |
| `FIREBASE_PROJECT_ID` | **yes** | Firebase console | Server Admin SDK. |
| `FIREBASE_CLIENT_EMAIL` | **yes** | Firebase console | Server Admin SDK. |
| `FIREBASE_PRIVATE_KEY` | **yes** | Firebase console | **Paste with literal `\n`, not real newlines.** `lib/env.server.ts` restores them with `.replace(/\\n/g, '\n')`, which is the documented Firebase fix. A real newline in the Vercel field usually still works; escaped is safer. |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | no | Firebase console → SDK setup | Not a secret. Protected by §3.2 restrictions. |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | no | " | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | no | " | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | no | " | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | no | " | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | no | " | |

> **If `isAdminConfigured()` is false, every API route except `/api/health`
> answers 503.** That is by design. `GET /api/admin/system/health` names the three
> missing variables.

### 1.2 Required for the flows in §6

Each provider degrades independently — the app runs with any of them absent, and
the affected feature reports the missing variable by name. Configure all five;
they are all needed for the smoke test.

| Variable | Sensitive | Provider | Needed for |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | Google AI Studio | text triage |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | no | Mapbox account | map, risk zones |
| `NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY` | no | ImageKit | image evidence |
| `IMAGEKIT_PRIVATE_KEY` | **yes** | ImageKit | image evidence (upload signing) |
| `IMAGEKIT_URL_ENDPOINT` | no | ImageKit | image evidence |
| `ASSEMBLYAI_API_KEY` | **yes** | AssemblyAI | voice evidence |

### 1.3 Do NOT set these

`security:check` greps for key-shaped literals; `.env.example` is the contract.
Phase 16 reconciled every variable in it against the code and found **six with no
consumer at all**:

`FIREBASE_AUTH_PROVIDERS` · `RESPONDER_HEARTBEAT_SEC` · `DISPATCH_EXPIRY_SEC` ·
`SLA_BREACH_SWEEP` · `SEED_DEMO_PASSWORD` · `SENTRY_DSN`

And two more that exist but protect nothing yet, because **no cron or
maintenance route exists**:

`CRON_SECRET` · `ENABLE_MAINTENANCE_JOBS`

Leave all eight empty. Setting them implies controls that are not deployed.

Twilio (`TWILIO_*`) is for a future SMS/WhatsApp phase. Leave empty; they incur
cost if misconfigured.

### 1.4 Optional, with safe defaults

`LOG_LEVEL=info` · `REAUTH_WINDOW_SEC=300` · `REQUEST_TIMEOUT_MS=15000` ·
`GEMINI_MODEL=gemini-2.5-flash` · `GEMINI_TIMEOUT_MS` · `GEMINI_MAX_RETRIES=3` ·
`GEMINI_RPM_LIMIT=8` · `GEMINI_RPD_LIMIT=200` · `AI_CONFIDENCE_REVIEW_THRESHOLD=0.6` ·
`UPLOAD_MAX_IMAGE_BYTES` · `UPLOAD_MAX_AUDIO_BYTES` · `UPLOAD_SIGNED_URL_TTL_SEC` ·
`DUPLICATE_*` · `RATE_LIMIT_WINDOW_SEC=3600` · `RATE_LIMIT_TRUST_PROXY=true` ·
`ASSEMBLYAI_TIMEOUT_MS` · `UPLOAD_SNIFF_BYTES`

> **`RATE_LIMIT_TRUST_PROXY=true` is correct on Vercel** and wrong everywhere
> else. It makes the limiter read `x-forwarded-for`. On a platform that does not
> strip that header, any caller can forge an IP and get a fresh rate-limit bucket
> per request. On Vercel the header is set by the platform.

---

## 2. Firebase production

### 2.1 Create and isolate the project

1. Create a **production** Firebase project. Do not promote a development
   project: `firestore.rules` differ per environment and promoting a dev project
   carries dev data and dev rule history with it.
2. Keep **three** projects: dev, staging, prod. `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   is what selects between them.
3. Billing: set a budget alert. Gemini, ImageKit and AssemblyAI all bill per call,
   and the AI triage endpoint is reachable by any authenticated citizen.

### 2.2 Authentication providers

Enable in **Authentication → Sign-in method**:

- **Email/Password** — required (citizen and responder sign-up).
- **Google** — required ("Continue with Google").
- Leave **Phone** and **Anonymous** disabled. Anonymous auth would let anyone
  obtain a valid ID token without an account, and `requireUser` only checks that
  `users/{uid}` exists and is active.

### 2.3 Authorized domains

**Authentication → Settings → Authorized domains.** Add the production domain
exactly as served, e.g. `your-app.vercel.app`. Add the custom domain too.

This is what blocks a hostile site from completing an OAuth popup against your
project. A missing entry produces a confusing `auth/operation-not-allowed` rather
than an obvious failure, so set it *before* testing Google sign-in.

### 2.4 Deploy rules and indexes

```
npx firebase-tools login
npx firebase-tools use --add <PRODUCTION_PROJECT_ID>
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
```

- **Always pass `--only`.** `firebase.json` still contains a `hosting` block
  pointing at `out/`, a directory that does not exist. A bare `firebase deploy`
  fails on hosting even when the rules deploy fine.
- **Rules are the client-side boundary.** The Admin SDK bypasses them entirely, so
  this project relies on rules for every browser write. Deploy them before the
  first request reaches production.
- `firestore.indexes.json` declares 19 composite indexes. Deploy them in the same
  command; a missing index surfaces as a runtime `FAILED_PRECONDITION` on the
  first analytics or duplicate-detection query, not at build time.

### 2.5 Service account

1. Project settings → Service accounts → **Generate new private key**.
2. Copy the three values into Vercel (§1.1).
3. **Delete the downloaded JSON** from your machine when done.

The Admin SDK can read and write every document and bypass every rule. Treat the
key as the most sensitive credential in the system.

### 2.6 Production security — do these in the console

- **App Check.** Enable for Firestore and Realtime Database. It is the control
  that makes the browser API key safe to ship. See §3.2.
- **Firestore rules**: confirm `users` is `allow write: if false` and `auditLogs`
  is append-only. Both are asserted by `security:check` against the *file*; the
  deployed rules must be the deployed version of that file.
- **Budget alerts** on all three metered providers.
- **Auth → Settings → authorised domains** as in §2.3.
- Remove any developer account or test key from the production project.

---

## 3. API restrictions

A browser cannot hold a secret. Every credential that reaches the browser is
public by construction, and the controls that make that acceptable are
**restrictions configured at the provider**, not in this codebase.

### 3.1 Mapbox — `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`

This is a **public** token (`pk.*`), which is correct; Mapbox public tokens are
designed for browsers and carry no write access. It still must be restricted:

| Restriction | Value |
|---|---|
| **URL restriction** | `https://your-app.vercel.app/*` and `https://your-domain/*` |
| Non-matching referrers | **Blocked** (not "allow") |
| Public token scopes | Only the APIs the map actually calls: **Styles, Fonts, Tiles** |

- Turn **off** any Mapbox scope the app does not use, especially **Tokens: read**
  and **Uploads/Downloads APIs**.
- Never use a Mapbox **secret** token (`sk.*`) in `NEXT_PUBLIC_`. The
  `NEXT_PUBLIC_` prefix inlines the value into the shipped bundle.
- `isMapboxConfigured()` returning false is a safe state: risk zones render as a
  list.

### 3.2 Firebase browser key — `NEXT_PUBLIC_FIREBASE_API_KEY`

The Firebase web config is **not a secret**. It ships in every page by design.
What protects it:

- **Google Cloud → APIs & Services → Credentials → *API key* → Restrict key**
  - **API restrictions**: only *Identity Toolkit API* (Auth), *Cloud Firestore
    API*, *Firebase Realtime Database API* (if used), *Firebase Storage API*.
  - **Application restrictions → HTTP referrers**: `https://your-app.vercel.app/*`,
    `https://your-domain/*`. Block everything else.
- **Enable App Check** (Authentication → App Check). This is the control that
  actually stops a stolen web config from being used from someone else's server.
  Referrer restriction alone does not: an attacker can send any `Referer` header
  they like from a script.

Until App Check is enforced, treat the Firebase web config as *restricted but not
secret*, and do not treat referrer restriction as sufficient.

### 3.3 Google Maps (optional, unused by the current map)

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — HTTP referrer restriction + API restriction
  to Maps JavaScript API only.
- `GOOGLE_MAPS_SERVER_KEY` — **IP restriction** to Vercel's egress ranges, and API
  restriction to Geocoding/Places only. Never `NEXT_PUBLIC_`.

### 3.4 Server secrets stay server-side — how this is enforced

| Control | Where | Status |
|---|---|---|
| `import 'server-only'` poison pill on every secret-reading module | `lib/server/*`, `lib/env.server.ts` | asserted by `security:check` |
| No `process.env` outside the env modules | `lib/server/*` | asserted by `security:check` |
| `GEMINI_API_KEY` readable only by `lib/env.server.ts` | — | asserted by `security:check` |
| `lib/env.client.ts` reads only `NEXT_PUBLIC_*` | — | asserted by `security:check` |
| No secret read by any API route handler | `app/api/**` | asserted by `security:check` |

If you add a secret, add it to `lib/env.server.ts` and re-run
`npm run security:check`. Do not read `process.env` in a route.

### 3.5 Provider health output

`services/admin/providers.ts` reports `configured: boolean` plus the **variable
names** that are missing. It never reports a value. Keep it that way: a variable
name is not a secret, a value is.

---

## 4. Vercel

### 4.1 Node version

`.nvmrc` = `22.11.0`, matching `engines.node: ">=22.11.0"`. Vercel reads
`.nvmrc`; it does **not** read `engines` for the runtime pin. Keep the two files
in agreement — they are read by different tools.

### 4.2 Build command

`vercel.json` sets `"buildCommand": "npm run verify"`, which is
`typecheck && lint && test && security:check && build`.

- A deploy therefore runs the full gate and ends by invoking `next build` itself,
  so tests run once and `.next` is produced by the last step. No double build.
- **Trade-off**: a deploy takes several minutes instead of one. That is the
  intended trade — a failing test or an unverified secret control cannot reach
  production.
- `security:check` **fails closed** if git is unavailable. Vercel clones the
  repository, so git is present. If that ever changes, deploys stop rather than
  proceeding on an unchecked control.

### 4.3 Install

`"installCommand": "npm ci"` — installs exactly `package-lock.json` and fails if
the lockfile is out of sync. `npm install` would resolve newer versions inside the
`package.json` ranges, so two deploys of one commit could differ.

### 4.4 Project settings

| Setting | Value | Why |
|---|---|---|
| Framework preset | Next.js | |
| Node version | `22.11.0` | from `.nvmrc` |
| Install command | `npm ci` | from `vercel.json` |
| Build command | `npm run verify` | from `vercel.json` |
| Output directory | `.next` (default) | |
| Include files outside root | **No** | only the repo root is needed |
| Node 22 "Automatically include files" | No | nothing in `outputFileTracingIncludes` is required |

### 4.5 Do not expose secrets in build logs

- Mark every server secret **Sensitive** in the Vercel UI (§1).
- Do not `echo` an env var in a build script, and do not add one to
  `next.config.ts`.
- `poweredByHeader: false` is already set; it is not a secret control, but it
  removes the `X-Powered-By: Next.js` fingerprint.
- Do not use `NEXT_PUBLIC_` on anything secret. It is inlined into the client
  bundle by design — that is the definition of the prefix.
- On the **first** production deploy, confirm the deployment log contains no key
  material before promoting the URL.

---

## 5. Pre-deploy verification

### 5.1 Run it

```
npm run verify
npm run build
```

Expected: `verify` exits 0 and `build` exits 0.

### 5.2 The one thing that will fail on a fresh machine

`security:check` reports **133/136** where git is not installed. All three
failures are honest and share one cause:

```
[FAIL] .env.local is not committed to git
[FAIL] .env.local is excluded from the tracked file set
[FAIL] Ignore and tracking status are actually verifiable (git must be installed)
```

Phase 16 fixed the logic behind this. Previously both git helpers swallowed every
error and returned `false`, which produced **two opposite lies**:

- `.env.local is not committed to git` **PASSED VACUOUSLY** — an absent `git`
  executable was reported as proof that no secret is tracked.
- The coverage check **FAILED** with `not ignored: .env, .env.local, ...` — an
  unverified claim about this repository.

Both now fail closed, because a security gate that cannot run must fail rather
than pass. **Install git** (<https://git-scm.com/downloads>) and all three pass.

This is a real constraint, not a formality: without git, nothing in the toolchain
can prove `.env.local` is untracked, and that is the control protecting every
production credential.

---

## 6. Production smoke test

Run against the deployed URL, **after** §1–4, in this order. Frontend flows depend
on ones before them.

| # | Flow | Expected | Blocker |
|---|---|---|---|
| 1 | Homepage | Renders. No "not configured" notice. | — |
| 2 | Sign up (email) | `users/{uid}` created with `role: citizen`, `status: active`. | — |
| 3 | Sign in (Google) | Same. Confirm `/api/me/bootstrap` ran. | §2.2, §2.3 |
| 4 | Citizen report | **CANNOT PASS — see §6.1** | missing route |
| 5 | Text triage | `POST /api/ai/triage` returns a schema-valid result. | — |
| 6 | Image report | Upload signs, finalizes, and attaches. | — |
| 7 | Voice report | **CANNOT PASS — see §6.1** | unwired service |
| 8 | Map | Mapbox renders; risk zones list as fallback. | §3.1 |
| 9 | Duplicate detection | **CANNOT PASS — see §6.1** | no caller |
| 10 | Responder workflow | Accept/decline via `PUT /api/dispatches/:id`. | — |
| 11 | Incident resolution | `PATCH /api/incidents/:id/status`. | needs #4 |
| 12 | Analytics | `GET /api/analytics`, dispatcher/admin only. | needs #4 data |
| 13 | Admin dashboard | **CANNOT PASS — see §6.1** | mock-backed views |

For each failure, capture the `requestId` from the error envelope. It appears in
`meta.requestId` on **both** the success and the failure path, and it is the join
key between a user report and the server log line.

### 6.1 The four flows that cannot pass, and why

**These are unimplemented, not misconfigured. No amount of deployment fixes them,
and none of them should be reported as passing.**

1. **Citizen report (#4).** There is no `POST /api/incidents` route. The report
   form runs AI triage and uploads, then calls
   `await new Promise((resolve) => setTimeout(resolve, 1000))` and invokes
   `onSubmitted()`. **The incident is never persisted.** The user sees a success
   screen for a report that does not exist. This is the most serious finding in
   Phase 16: it is a faked success on the product's primary action.

2. **Voice report (#7).** `services/speech/speech-to-text.ts` is complete, but no
   API route imports it. Phase 16 confirmed zero references from `app/api/**`.
   `ASSEMBLYAI_API_KEY` would be configured and unused.

3. **Duplicate detection (#9).** `services/geo/find-duplicates.ts` exists and is
   tested, but nothing calls it. No route imports it.

4. **Admin dashboard (#13).** The only admin route is
   `GET /api/admin/system/health`. `features/admin/admin-views.tsx` and
   `admin-overview-view.tsx` render hardcoded mock data. Separately, the admin
   page gate (`app/(ops)/admin/(admin-gated)/layout.tsx`) is **client-side only** —
   there is no server-readable session cookie, so the pages are not protected on a
   direct URL request. That is a Phase 15 finding still open.

The consequence: flows #11 and #12 also cannot pass, because there is no incident
data to resolve or analyse.

---

## 7. Observability

### 7.1 Where events go

All server logging is structured JSON on **stdout**, one object per line
(`lib/server/http.ts`). Vercel captures stdout in the deployment log view. There
is **no** APM, error tracker or alerting wired up — `SENTRY_DSN` has no consumer.

| Event | Level | Where it is emitted |
|---|---|---|
| Every request outcome | `info` | `lib/server/route.ts` — method, path, status, durationMs, actorUid, actorRole |
| Token verification failure | `warn` | `auth-guard.ts` |
| Account suspended / pending refusal | `warn` + audit row | `auth-guard.ts` |
| Role claim drift | `warn` + audit row | `auth-guard.ts` |
| CSRF rejection | `warn` | `lib/server/route.ts` |
| Rate limit 429 | `warn` | `rate-limit.ts` |
| Illegal transition (IDOR attempt) | `warn` | `services/dispatch/lifecycle.ts` |
| Audit write failure | `error` | `lib/server/audit.ts` |
| Provider misconfiguration | `error` | `lib/server/firebase-admin.ts` |
| Every privileged action | Firestore `auditLogs` | `lib/server/audit.ts` |

The structured log line and the `auditLogs` collection are **different stores**
with different purposes: logs are operational and short-lived; `auditLogs` is the
durable record. `auditLog()` deliberately swallows its own write failure so an
audit outage cannot roll back the action it describes — so a missing audit row
with no matching error is possible, and is itself worth alerting on.

### 7.2 What must never appear in a log

The audit document builder redacts by allow-list, so a new field is not logged
until someone adds it. Do not bypass it.

Never log: `FIREBASE_PRIVATE_KEY`, `GEMINI_API_KEY`, `IMAGEKIT_PRIVATE_KEY`,
`ASSEMBLYAI_API_KEY`, `CRON_SECRET`, `IP_HASH_SALT`, bearer tokens, or raw IP
addresses (store only the salted hash).

Personal data: `auditLogs` stores `actorUid` — an opaque identifier, not a name,
email or phone. Keep it that way. `GET /api/incidents/:id/candidates` returns
responder phone numbers **only** to `r36_readResponderPhone`; that is the one
route where personal data legitimately crosses the boundary.

### 7.3 First 24 hours

1. `GET /api/health` and `GET /api/admin/system/health` — both 200.
2. Deployment log: zero occurrences of `AUTH_INVALID_TOKEN` at volume (a burst
   means a client with a stale or wrong token — often a cached bundle after a
   deploy).
3. Zero `AUDIT_WRITE_FAILED`.
4. Every `warn` with `code: CSRF_FAILED` is either a hostile request or a
   misconfigured `NEXT_PUBLIC_APP_URL`. Confirm the latter first: it is the
   benign explanation and it breaks every write.
5. Count `429`s per route. A single route dominating means either abuse or a
   limit set too low for real traffic.

---

## 8. Rollback

### 8.1 Redeploy a previous version — 30 seconds

Vercel keeps every deployment. **Deployments → ⋯ → Promote to Production** on the
last known-good one.

- Instant, no build. Use this first.
- Note: `NEXT_PUBLIC_*` values are baked into the *build*, so promoting an older
  deployment also restores its older public config. If the fix was an env-var
  change, a promote will **not** help — redeploy instead.

### 8.2 Recover from a failed deploy

A failed `npm run verify` never produces a new deployment, so production is
untouched. The previous deployment is still serving.

1. Read the build log — the failing stage names itself.
2. Fix, push, let the new build run.
3. If it passed locally but failed on Vercel, the usual cause is
   `npm ci` lockfile drift: run `npm ci` locally and commit the updated lockfile.

### 8.3 Disable a feature without redeploying

Set the flag and redeploy. `NEXT_PUBLIC_*` flags require a rebuild, because they
are inlined at build time.

| Flag | Effect when `false` |
|---|---|
| `ENABLE_RISK_ZONES` | Risk-zone layer off; zones still listed. (`GET /api/analytics` reads this.) |
| `ENABLE_VOICE_REPORTING` | Voice reporting hidden. |
| `ENABLE_SMS_NOTIFICATIONS` | SMS channel off. |
| `ENABLE_WHATSAPP_NOTIFICATIONS` | WhatsApp channel off. |
| `GEMINI_AUDIO_ENABLED` | Audio sent to Gemini disabled. |
| `ENABLE_MAINTENANCE_JOBS` | No effect yet — no maintenance routes exist (§1.3). |

### 8.4 Disable a provider integration — the safest lever

**Unset the provider's key and redeploy.** Each integration is optional by design:
it reports `configured: false` and the affected feature degrades to a named
message rather than failing.

| Provider | Unset | Result |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Text triage falls back to the deterministic rule engine (`services/ai/rules.ts`) with a visible "no AI" state. **Incidents are still recorded.** |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | Voice reporting unavailable. (Already non-functional — §6.1.) |
| Mapbox | `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | Map renders the list fallback; nothing breaks. |
| ImageKit | `IMAGEKIT_*` | Image evidence unavailable; text reporting unaffected. |

> **Do not** disable Firebase this way. With the Admin SDK unconfigured, every
> route except `/api/health` returns **503** — auth, everything. It is not a
> graceful degradation; it is a total outage. There is no partial mode.

### 8.5 Emergency: revoke a leaked credential

1. **Gemini / ImageKit / AssemblyAI** — revoke the key in the vendor console, then
   unset it in Vercel and redeploy. Order matters: revoke first.
2. **Firebase service account** — disable the key in Google Cloud IAM, create a
   replacement, update all three Vercel variables, redeploy. Rotating this invalidates
   every Admin SDK session, so expect a brief 503 burst during the swap.
3. **Mapbox public token** — revoke in the Mapbox dashboard, then redeploy. The
   §3.1 URL restriction limits the blast radius to your origins.
4. **If a secret reached git** — rotation is the *only* remedy. Removing the file
   does not un-write history. Treat every value in it as compromised.

---

## 9. Open items carried into production

Phase 16 triaged these; it did not clear them.

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Citizen report never persists (§6.1) | **Critical** | Unimplemented. Faked success screen. |
| 2 | Admin pages have no server-side authorization | **High** | Client-only gate; direct URL reachable. |
| 3 | Voice reporting unwired | High | Service exists, no route. |
| 4 | Duplicate detection never invoked | High | Service exists, no caller. |
| 5 | `npm audit`: 5 high, 10 moderate | High | Direct: `firebase`, `firebase-admin`, `next`, `vitest`. Not yet triaged. |
| 6 | Phase 15 open: upload abuse, AI prompt-injection, rate-limit abuse, Firestore rules, provider failure modes | High | Only the auth/IDOR matrix is now covered by runtime tests. |
| 7 | `CRON_SECRET` / `ENABLE_MAINTENANCE_JOBS` protect nothing | Low | No consumer. Do not set (§1.3). |
| 8 | Request-id generator used base64url, ~32% of ids failed the project's own schema | Low | Fixed in `lib/server/http.ts`, mutation-verified. |

**Items 1–4 are why this application should not be presented as production-ready.**
Item 1 alone means the product's primary action does nothing while reporting that
it succeeded.
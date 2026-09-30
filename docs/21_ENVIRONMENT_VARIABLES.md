# 21 — Environment Variables

**Project:** CareGrid AI
**Status:** Baseline v1.0
**Related:** [02 Technical Requirements](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md), [19 Deployment & DevOps](./19_DEPLOYMENT_DEVOPS.md), [09 AI Spec §12](./09_AI_GEMINI_SPECIFICATION.md)

---

## 1. Rules (non-negotiable)

| # | Rule |
| --- | --- |
| 1 | **Never commit a real secret.** `.env`, `.env.local`, `.env.*.local` are git-ignored. Only `.env.example` (this document's `FIRMWARE` block) is committed, and it contains **no real values** |
| 2 | **Any variable starting with `NEXT_PUBLIC_` is shipped to the browser.** If it starts with `NEXT_PUBLIC_`, it is public. Never put a private key, service account, or admin credential behind that prefix |
| 3 | Server-only variables are read exclusively in Route Handlers, Server Components, and `lib/server/**`. Importing `process.env.SECRET` from a `"use client"` file is a build error enforced by a lint rule |
| 4 | Every secret is validated for presence at boot (`lib/env.ts`) with a **helpful error naming the variable**, never its value |
| 5 | Secrets live in the Vercel project environment (and locally in `.env.local`). They are never in code, never in a comment, never in a screenshot for the demo, never in a GitHub issue |
| 6 | The Firebase web config is **not a secret** (it is designed for the browser) but is still environment-specific, so it is in env vars rather than hard-coded |
| 7 | The Firebase **service account** JSON is the single most dangerous credential in the project — it bypasses Security Rules entirely. It is server-only, never in a `NEXT_PUBLIC_` var, and rotated if it is ever committed |
| 8 | `.env.example` must never gain a real-looking value. Placeholders only: `""`, `your-project-id`, `xxxxxxxx` |

---

## 2. Environment matrix

| Variable | Visibility | Required | Where used | Notes |
| --- | --- | :-: | --- | --- |
| **Application** | | | | |
| `NEXT_PUBLIC_APP_URL` | public | ✔ | CSRF origin check, canonical links, OAuth redirect | e.g. `http://localhost:3000` dev |
| `NEXT_PUBLIC_APP_ENV` | public | ✔ | Client branching (dev/staging/prod banners) | `development` \| `staging` \| `production` |
| `APP_TIMEZONE` | server | ✔ | Rollup day buckets, SLA display | IANA, e.g. `Asia/Kolkata` |
| `LOG_LEVEL` | server | | Structured log verbosity | `debug`\|`info`\|`warn`\|`error`; default `info` |
| `IP_HASH_SALT` | server | ✔ | `auditLogs.ipHash` and `incidentReports.ipHash` | Rotating daily; generated per environment. **Not** a substitute for a real privacy policy |
| `REQUEST_TIMEOUT_MS` | server | | Global handler timeout | default `15000` |
| **Firebase — public (web config, not secret)** | | | | |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | public | ✔ | Firebase Web SDK | Web API keys are not confidential, but rate-limit/quotas apply |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | public | ✔ | Auth | `<project>.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | public | ✔ | Auth/Firestore/Storage | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | public | ✔ | Storage | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | public | ✔ | (unused in v1) | Present because the web config expects it |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | public | ✔ | Firebase web app | |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | public | | Analytics (optional) | Omit if not used |
| `NEXT_PUBLIC_FIREBASE_USE_EMULATORS` | public | | Dev-only emulator switch | `true` in dev, **must be absent/false** in prod |
| **Firebase — server only (secrets)** | | | | |
| `FIREBASE_PROJECT_ID` | server | ✔ | Admin SDK | Can fall back to the `NEXT_PUBLIC_` value in dev; explicit in prod |
| `FIREBASE_CLIENT_EMAIL` | server | ✔ | Admin SDK service account | `xxx@xxx.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | server | ✔ | Admin SDK service account | **Multiline, quoted, `\n` escaped** in `.env` |
| `FIREBASE_DATABASE_URL` | server | | Not used in v1 (Firestore, not RTDB) | Omit |
| `GEMINI** | | | | |
| `GEMINI_API_KEY` | **server secret** | ✔ | `services/ai/gemini.ts` | Never `NEXT_PUBLIC_`. Free-tier key |
| `GEMINI_MODEL` | server | | Default `gemini-2.5-flash` | Change = config change, not code |
| `GEMINI_TIMEOUT_MS` | server | | `20000` (FR-029) | Hard timeout |
| `GEMINI_MAX_RETRIES` | server | | `3` — **only** for 429/503 | |
| `GEMINI_RPM_LIMIT` | server | | `8` local per-minute guard | Below the real quota to preserve headroom |
| `GEMINI_RPD_LIMIT` | server | | `200` local per-day guard | Demo needs ≈ 30 |
| `GEMINI_AUDIO_ENABLED` | server | | `true`; set `false` to disable audio (P1 flag) | Mirrors `config.features.voice` |
| `AI_REPAIR_ATTEMPTS` | server | | `1` | |
| `AI_CONFIDENCE_REVIEW_THRESHOLD` | server | | `0.6` | FR-024 |
| `AI_ENABLE_LOCAL_QUOTA_GUARD` | server | | `true` | Prevents exhausting the free tier |
| **Google Maps** | | | | |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | public | ✔ | Maps JS API, Places, Geocoding (client) | **Must be restricted** by HTTP referrer + API in the Cloud Console |
| `GOOGLE_MAPS_SERVER_KEY` | **server secret** | ✔ | Geocoding + Places server-side, `/api/analytics` risk geocoding | **Must be restricted by IP** (Vercel egress ranges) + API. A different key from the browser key |
| `GOOGLE_MAPS_REGION` | server | | e.g. `IN` | Biases results |
| `GOOGLE_MAPS_DEFAULT_CENTER` | server | | `17.4478,78.4874` | Dev/demo fallback when no location |
| `GEOCODING_RPM_LOCAL` | server | | `30` | Local per-minute guard on the **server** Geocoding/Places key, so a typing user or a re-render loop can never exhaust the Google quota. Added by API amendment A-1 |
| `NEXT_PUBLIC_MAP_STYLE` | public | | `roadmap` \| `satellite` \| `hybrid` \| `dark` | Operational default `dark` |
| `NEXT_PUBLIC_MAP_ZOOM_DEFAULT` | public | | `13` | |
| `NEXT_PUBLIC_MAP_ZOOM_MAX` | public | | `18` | |
| **Features / behaviour** | | | | |
| `ENABLE_VOICE_REPORTING` | public | | `false` → true when P1 ships | Gates the record button |
| `ENABLE_RISK_ZONES` | server | | `false` in MVP | P1 |
| `ENABLE_SMS_NOTIFICATIONS` | server | | `false` | P1; a free provider must be confirmed first |
| `ENABLE_WHATSAPP_NOTIFICATIONS` | server | | `false` | P2; needs a Meta business account |
| `NOTIFICATION_RETRY_LIMIT` | server | | `2` | FR-107 |
| `DISPATCH_EXPIRY_SEC` | server | | `120` | Unaccepted assignment expiry |
| `RESPONDER_HEARTBEAT_SEC` | server | | `60` | FR-066 |
| `STALE_LOCATION_MIN` | server | | `15` | US-022 |
| `UPLOAD_MAX_IMAGE_BYTES` | server | | `5242880` | FR-005 |
| `UPLOAD_MAX_AUDIO_BYTES` | server | | `15728640` | FR-006 |
| `UPLOAD_SIGNED_URL_TTL_SEC` | server | | `900` | Write and read URLs |
| `STAGING_UPLOAD_SWEEP_MIN` | server | | `30` | Unclaimed staging file lifetime |
| `SLA_BREACH_SWEEP` | server | | `on_write` | v1: computed on read/write; a cron is P1 |
| **Rate limiting** | | | | |
| `RATE_LIMIT_STORE` | server | | `firestore` (v1) | `memory` is unsafe on Vercel — documented |
| `RATE_LIMIT_WINDOW_SEC` | server | | `3600` | |
| `RATE_LIMIT_TRUST_PROXY` | server | | `true` on Vercel | Read `x-forwarded-for` for the client IP |
| **Ops** | | | | |
| `CRON_SECRET` | **server secret** | ✔ (prod) | Guards `GET /api/cron/*` | Compared against an `Authorization: Bearer` header |
| `ALLOW_SEED` | server | | `false` | FR-147; must be `true` **and** non-production to seed |
| `ENABLE_MAINTENANCE_JOBS` | server | | `false` | `/api/admin/maintenance/*` |
| `VERCEL_GIT_COMMIT_SHA` | server | | auto | Build info for `/api/health` |
| `SENTRY_DSN` | server | | optional | Error reporting; disabled by default ($0) |

---

## 3. `.env.example` (copy to `.env.local`)

```dotenv
# ============================================================
# CareGrid AI — environment template
# COPY TO .env.local AND FILL IN. NEVER COMMIT .env.local
# NEVER put a real secret in THIS file.
# Anything prefixed NEXT_PUBLIC_ is visible in the browser.
# ============================================================

# ---------- Application ----------
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_ENV=development          # development | staging | production
APP_TIMEZONE=Asia/Kolkata
LOG_LEVEL=info                           # debug | info | warn | error
IP_HASH_SALT=replace-me-rotating-daily
REQUEST_TIMEOUT_MS=15000

# ---------- Firebase (public web config — not a secret) ----------
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
# NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=
# NEXT_PUBLIC_FIREBASE_USE_EMULATORS=true      # local emulator suite only

# ---------- Firebase (server only — SECRETS) ----------
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace-me\n-----END PRIVATE KEY-----\n"
# FIREBASE_DATABASE_URL=                     # not used (Firestore, not RTDB)

# ---------- Gemini (server only — SECRET) ----------
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_TIMEOUT_MS=20000
GEMINI_MAX_RETRIES=3                       # 429/503 only
GEMINI_RPM_LIMIT=8
GEMINI_RPD_LIMIT=200
GEMINI_AUDIO_ENABLED=true
AI_REPAIR_ATTEMPTS=1
AI_CONFIDENCE_REVIEW_THRESHOLD=0.6
AI_ENABLE_LOCAL_QUOTA_GUARD=true

# ---------- Google Maps ----------
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=            # restrict by HTTP referrer + Maps JS API
GOOGLE_MAPS_SERVER_KEY=                    # restrict by IP + Geocoding/Places API
GOOGLE_MAPS_REGION=IN
GOOGLE_MAPS_DEFAULT_CENTER=17.4478,78.4874
GEOCODING_RPM_LOCAL=30
NEXT_PUBLIC_MAP_STYLE=dark
NEXT_PUBLIC_MAP_ZOOM_DEFAULT=13
NEXT_PUBLIC_MAP_ZOOM_MAX=18

# ---------- Feature flags ----------
ENABLE_VOICE_REPORTING=false
ENABLE_RISK_ZONES=false
ENABLE_SMS_NOTIFICATIONS=false
ENABLE_WHATSAPP_NOTIFICATIONS=false
NOTIFICATION_RETRY_LIMIT=2
DISPATCH_EXPIRY_SEC=120
RESPONDER_HEARTBEAT_SEC=60
STALE_LOCATION_MIN=15
UPLOAD_MAX_IMAGE_BYTES=5242880
UPLOAD_MAX_AUDIO_BYTES=15728640
UPLOAD_SIGNED_URL_TTL_SEC=900
STAGING_UPLOAD_SWEEP_MIN=30
SLA_BREACH_SWEEP=on_write

# ---------- Rate limiting ----------
RATE_LIMIT_STORE=firestore
RATE_LIMIT_WINDOW_SEC=3600
RATE_LIMIT_TRUST_PROXY=true

# ---------- Ops ----------
CRON_SECRET=                              # required in production
ALLOW_SEED=false                          # true AND non-production to run scripts/seed.ts
SEED_DEMO_PASSWORD=                     # demo seeding only; NEVER committed (see 07 §14)
ENABLE_MAINTENANCE_JOBS=false
# SENTRY_DSN=
```

---

## 4. Per-environment configuration

| Group | `development` | `staging` | `production` |
| --- | --- | --- | --- |
| Firebase project | `caregrid-ai-dev` | `caregrid-ai-staging` | `caregrid-ai-prod` |
| Firebase project ID | `caregrid-ai-dev` | `caregrid-ai-staging` | `caregrid-ai-prod` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | `https://staging.<domain>` | `https://<domain>` |
| Emulators | `NEXT_PUBLIC_FIREBASE_USE_EMULATORS=true` | off | off |
| Gemini key | developer key (free tier) | staging key | production key (free tier) |
| Maps browser key | unrestricted localhost referrer | staging + prod referrers | prod referrer only |
| Maps server key | unrestricted, quota-limited | IP-restricted | IP-restricted |
| Seed data | allowed with `ALLOW_SEED=true` | allowed with `ALLOW_SEED=true` | **blocked in code** |
| `LOG_LEVEL` | `debug` | `info` | `warn` |
| Rate limits | 5× the production values (comfortable testing) | production values | production values |
| `CRON_SECRET` | not needed | set | set |

**Never share a Firebase project between environments.** Emulator support is included for local development, but the default local path uses the dev project's real Firestore (documented trade-off in [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §4.3).

---

## 5. Google Cloud API key restrictions (required before the demo)

| Key | Restrict by | APIs |
| --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | **HTTP referrers**: `localhost:3000/*`, `https://<staging-domain>/*`, `https://<prod-domain>/*` | Maps JavaScript API, Places API (Autocomplete/Geometry) |
| `GOOGLE_MAPS_SERVER_KEY` | **IP addresses**: Vercel egress ranges (from the Vercel dashboard) + the local machine for dev | Geocoding API, Places API |

Both keys must have **Application restrictions** set; a key with no restrictions is a finding in the threat model ([24](./24_THREAT_MODEL_SECURITY.md) T-14). Billing must be enabled on the Google Cloud project **with a hard budget alert**; the Maps JavaScript API free monthly credit is consumed by loads, and an unauthenticated billing account can run up a bill. This is the single highest-cost-risk item in the project, which is why it has an explicit budget alert and a documented fallback ([12](./12_MAP_LOCATION_SYSTEM.md) §9).

---

## 6. Secret handling and rotation

| Secret | Storage | Rotation | If leaked |
| --- | --- | --- | --- |
| `FIREBASE_PRIVATE_KEY` | Vercel env + local `.env.local` | Every 90 days | Immediately: revoke the service-account key in GCP, create a new one, redeploy, audit `auth.role_mismatch` events for the exposure window |
| `GEMINI_API_KEY` | Vercel env + local | On suspicion | Revoke in AI Studio, create a new key; check the usage dashboard for abuse |
| `GOOGLE_MAPS_SERVER_KEY` | Vercel env + local | 90 days | Restrict/delete, review usage |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Vercel env (public) | 90 days | Tighten referrer restrictions; the key is not confidential, but it must be restricted |
| `CRON_SECRET` | Vercel env | 180 days | Regenerate |
| `IP_HASH_SALT` | Vercel env | **Daily** (a scheduled rotation, or rotate-on-deploy) | Historic hashes remain pseudonymous by design |

**Pre-commit / CI guard** (`.husky/pre-commit` + GitHub Actions):
1. `git diff --cached` scanned for `-----BEGIN`, `AIza`, `private_key`, `GEMINI_API_KEY=`, and `NEXT_PUBLIC_FIREBASE_API_KEY=` with a non-empty value.
2. `gitleaks detect --no-git` (free, self-hosted) in CI.
3. The build fails if any `NEXT_PUBLIC_*` value matches a server-secret pattern.

---

## 7. Validation at boot (`lib/env.ts`)

```ts
// Parsed with Zod at import time. Fails fast with a named error.
const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(100).transform(v => v.replace(/\\n/g, '\n')),
  GEMINI_API_KEY: z.string().min(20),
  GOOGLE_MAPS_SERVER_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  IP_HASH_SALT: z.string().min(8),
  CRON_SECRET: z.string().min(16).optional(),
  ALLOW_SEED: z.string().optional(),
});
```

| Rule | Behaviour |
| --- | --- |
| Missing required var | Throws `MissingEnv: GEMINI_API_KEY is required. Add it to .env.local (see docs/21_ENVIRONMENT_VARIABLES.md).` |
| Production guard | If `NODE_ENV === 'production'` and `ALLOW_SEED === 'true'` ⇒ throw on startup |
| Production guard | If `NODE_ENV === 'production'` and `CRON_SECRET` is missing ⇒ throw |
| Production guard | If any `NEXT_PUBLIC_*` value contains a `-----BEGIN` block ⇒ throw |
| Test env | `process.env` is seeded in `tests/setup.ts` with dummy values; no network call is made at import time |
| Client bundle | `lib/env.ts` is **never** imported from a client component; `lib/env.client.ts` holds the public subset with its own schema |

---

## 8. Vercel configuration mapping

| Vercel setting | Source |
| --- | --- |
| Environment variables (Production / Preview / Development) | This document, per the §4 matrix |
| Build command | `npm run build` |
| Install command | `npm ci` |
| Node version | `NODE_VERSION` in `package.json` (`engines`) — or the project setting; both must match |
| Regions | Default region + `preferredRegion: 'bom1'` (Mumbai) for Firestore latency. **Verify** the Firestore region before setting this |
| Cron | `crons` in `vercel.json` — **Vercel Hobby allows cron jobs only once per day**, so the daily analytics rollup is scheduled at `0 3 * * *` and risk recomputation is a manual admin action (P1) |
| Headers | `headers` in `vercel.json` for CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ([24](./24_THREAT_MODEL_SECURITY.md)) |
| Function memory | 1024 MB default; the Gemini route may need 1024 MB with 3 images inlined |
| Function max duration | 30 s default; the triage route uses 25 s (Hobby max 10 s for Fluid compute on some plans — **`DECISION REQUIRED`**: if the 10 s Hobby cap makes AI triage impossible, the triage call must move to a client-triggered route with a longer budget or the AI step must be fire-and-forget after incident creation. Verify the plan's max duration before the demo) |

---

## 9. Variables intentionally NOT defined

| Not defined | Why |
| --- | --- |
| `DATABASE_URL` | No SQL database |
| `REDIS_URL` | No Redis; rate limiting uses Firestore |
| `SESSION_SECRET` | No server sessions; Firebase ID tokens are stateless |
| `SENTRY_AUTH_TOKEN` | Optional tooling only |
| `WHATSAPP_TOKEN`, `SMS_API_KEY` | Optional channels behind a `NotificationChannel` interface with no provider implemented. If added later, they are **server-only** and default-disabled |
| `SENTRY_DSN` is defined but optional | Zero-cost posture; no error-reporting SaaS is required |
| `AUTH_SECRET` | No NextAuth; Firebase Auth is used |

---

## Phase 10 secrets verification (2026-09-30)

### What was checked, and how

| Check | Result |
| --- | --- |
| `GEMINI_API_KEY` in a browser bundle | **None.** Read only by `lib/env.server.ts`, which imports `server-only`. Enforced by checks C90, C90b, C91 — all mutation-tested. |
| A non-`NEXT_PUBLIC_*` name read by `lib/env.client.ts` | **None.** The client env module reads only `NEXT_PUBLIC_*`. |
| A `NEXT_PUBLIC_` name that is a secret | **None.** |
| Tracked `.env` files | **None.** Only `.env.example`. |
| `.gitignore` coverage | Covers `.env`, `.env*.local`, **and** environment-named files without the `.local` suffix — `.env.*` plus three `!…example` exceptions. |
| Secrets in **git history** | **Zero.** Every reachable blob scanned for `AIza…` keys, PEM private-key headers, and long secret assignments. |
| `.env.example` contents | 47 non-empty values, **all non-secret defaults** (URLs, model names, limits, timeouts, coordinates). |

### The one file that reads a provider secret

`lib/env.server.ts` — the only module permitted to read a provider key, and it is
`server-only`. This was already the stated design in `services/ai/contracts.ts`
("that is why `GEMINI_API_KEY` appears in exactly one file in this repository"); Phase
10 made the claim **true and enforced** rather than aspirational, by asserting the
property mechanically.

**If a real secret is ever found in source or history, it must be rotated** — removing
it from the working tree does not remove it from the objects, and a compromised key
stays compromised. No such secret was found.

### A gap worth naming

**A missing `GEMINI_API_KEY` fails quietly.** The keyword fallback engages, triage
degrades to a local classifier, and the product appears healthy while a headline
feature is absent. A deployment check should assert the variable is **present** in the
production environment, not merely documented. Already recorded in
`docs/19`'s pre-deployment gate.

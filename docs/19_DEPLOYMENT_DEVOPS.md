# 19 — Deployment & DevOps

**Project:** CareGrid AI
**Document type:** Deployment topology, environment provisioning, CI/CD, monitoring, backup, and operational runbooks
**Status:** Baseline v1.0 — normative for every command, every environment variable name, and every operational procedure in this document
**Related documents:** [02 Technical Requirements §11](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) · [03 System Architecture §11](./03_SYSTEM_ARCHITECTURE.md) · [07 Database Schema §15](./07_DATABASE_SCHEMA.md) · [08 API Specification](./08_API_SPECIFICATION.md) · [10 Authorization & Security §9, §15](./10_AUTHORIZATION_SECURITY.md) · [18 Testing & QA Plan §16–§18](./18_TESTING_QA_PLAN.md) · [20 Project Folder Structure §6](./20_PROJECT_FOLDER_STRUCTURE.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [26 Performance Requirements §10, §11](./26_PERFORMANCE_REQUIREMENTS.md) · [29 Demo Scenario](./29_DEMO_SCENARIO.md) · [30 Development Phase Plan](./30_DEVELOPMENT_PHASE_PLAN.md)

> **Anchor rule.** Every environment variable name, endpoint, script name, collection name, and file path in this document is taken verbatim from [21](./21_ENVIRONMENT_VARIABLES.md), [08](./08_API_SPECIFICATION.md), [07](./07_DATABASE_SCHEMA.md), and [20](./20_PROJECT_FOLDER_STRUCTURE.md). This document invents no new env var, no new endpoint, and no new script. Where a value is a provider-specific figure that changes without notice, it is marked **VERIFY** and the authoritative check is the provider's own console.

---

## 0. How to use this document

| You are | Read | Then |
| --- | --- | --- |
| Setting up the project for the first time | §5 (runbook), in order | Do not skip step 3; the region decision blocks everything after it |
| Preparing a release | §6 (checklist), §7 (rollback) | `npm run verify` must be green first |
| Debugging a failure | §12 (troubleshooting) | Start from the symptom column |
| Watching cost | §9, §10 | The Maps budget alert is the one item that can produce a bill |
| Rehearsing before a demo | §5.4, §11 | The integration-verification commands in §5.4 are the same ones used in [29](./29_DEMO_SCENARIO.md) |
| Deciding the open items | §14 | `DEC-01` through `DEC-06` |

---

## 1. Deployment topology

### 1.1 The shape

```
  GitHub (main, protected)
        │  CI: verify → gated Vercel deploy
        ▼
  ┌───────────────────────┐        ┌──────────────────────────────────────┐
  │ Vercel (Hobby)        │        │ Firebase projects (one per env)      │
  │  Next.js 15 App Router│        │  caregrid-ai-dev                     │
  │  UI + /api route      │───────►│  caregrid-ai-staging                 │
  │  handlers, one deploy │  HTTPS │  caregrid-ai-prod                    │
  │  unit, instant rollback│       │   Auth · Firestore · Storage         │
  └───────────┬───────────┘        └──────────────────────────────────────┘
              │                                ▲
              │                                │ firebase deploy
              │  signed HTTPS                   │ (rules + indexes +
              ▼                                │  storage rules)
  ┌───────────────────────┐                    │
  │ Gemini (free tier)    │        ┌───────────┴───────────┐
  │ @google/genai         │        │ Google Cloud project  │
  └───────────────────────┘        │  Maps JS API          │
  ┌───────────────────────┐        │  Geocoding API        │
  │ Google Maps Platform  │───────►│  Places API           │
  └───────────────────────┘  HTTPS │  + HARD BUDGET ALERT  │
                                        └───────────────────────┘
```

### 1.2 Deployment unit inventory

| Artefact | Owner | Rollback mechanism | Covered by the Vercel rollback? |
| --- | --- | --- | --- |
| Next.js application (UI + API) | Vercel | **Instant** — promote the previous deployment | ✔ |
| `firestore.rules` | Firebase | `firebase deploy --only firestore:rules` with the previous file | ✖ |
| `storage.rules` | Firebase | `firebase deploy --only storage` with the previous file | ✖ |
| `firestore.indexes.json` | Firebase | Redeploy the previous index file; **deleting an index is asynchronous and slow** | ✖ |
| Firestore TTL policies | `gcloud firestore fields ttls` | Re-issue the previous TTL config | ✖ |
| Firestore/Storage **data** | Nobody (declarative only) | Restore from an export | ✖ |
| Environment variables | Vercel project settings | Re-enter the previous values; redeploy | ✖ |
| Google Cloud API key restrictions | Google Cloud console | Re-apply the previous restriction set | ✖ |

> **The one-line rule that follows from this table:** the app can be rolled back in one click; rules and indexes cannot. Deploy them **before** the app, never after. ([03 §11.2](./03_SYSTEM_ARCHITECTURE.md), [10 §9.3](./10_AUTHORIZATION_SECURITY.md).)

---

## 2. Environments

### 2.1 The environment table

| | **development** | **staging** | **production** |
| --- | --- | --- | --- |
| **Firebase project id** | `caregrid-ai-dev` | `caregrid-ai-staging` | `caregrid-ai-prod` |
| **`.firebaserc` alias** | `dev` | `staging` | `prod` |
| **Firestore region** | Same as production (see §4) | Same as production (see §4) | **`DECISION REQUIRED` — §4.1** |
| **Vercel project** | Local `next dev` (or the Vercel *Development* environment) | Vercel project, **Preview** deployments | Vercel project, **Production** deployments |
| **URL** | `http://localhost:3000` | `https://staging.<domain>` or the staging `*.vercel.app` URL | `https://<domain>` or the production `*.vercel.app` URL (**`DECISION REQUIRED` — §4.2**) |
| **Git branch** | any local branch | `develop` (or any `feat/*` push) | `main` |
| **Emulators** | `NEXT_PUBLIC_FIREBASE_USE_EMULATORS=true` (optional; the default local path uses the dev project's real Firestore — [02 §4.3](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) | off | **must be absent/false** |
| **Gemini key** | developer free-tier key | staging key | production free-tier key |
| **Maps browser key** | `localhost:3000/*` referrer | staging + prod referrers | prod referrer only |
| **Maps server key** | unrestricted (quota-limited), dev IP | IP-restricted to Vercel staging egress | IP-restricted to Vercel production egress |
| **Seed data** | allowed with `ALLOW_SEED=true` | allowed with `ALLOW_SEED=true` | **blocked in code** (FR-147) |
| `LOG_LEVEL` | `debug` | `info` | `warn` |
| Rate limits | documented as 5× production values for comfortable testing | production values | production values |
| `CRON_SECRET` | not needed | set | **set (required — `lib/env.ts` throws at boot without it)** |
| `ENABLE_MAINTENANCE_JOBS` | `true` (so [18 §18.1 Script E9](./18_TESTING_QA_PLAN.md) can be rehearsed) | `true` | `false` |
| `ALLOW_SEED` | `true` for a demo day | `true` for a staging rehearsal | **`false`** |
| Deployment protection | n/a | **on** (see §5.6) | on |

> **Never share a Firebase project between environments.** ([21 §4](./21_ENVIRONMENT_VARIABLES.md), [02 §11.1](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). A shared project means a staging rules test can mutate production, and a production `ALLOW_SEED` slip can overwrite real data.

### 2.2 Env var sets per environment

The **authoritative** list is [21 §2](./21_ENVIRONMENT_VARIABLES.md) and the authoritative matrix is [21 §4](./21_ENVIRONMENT_VARIABLES.md). This section records only the *grouping* used when entering them in the Vercel dashboard, and which groups differ per environment.

| Group | Variables | dev | staging | prod |
| --- | --- | :-: | :-: | :-: |
| Application | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_ENV`, `APP_TIMEZONE`, `LOG_LEVEL`, `IP_HASH_SALT`, `REQUEST_TIMEOUT_MS` | set | set | set |
| Firebase public | `NEXT_PUBLIC_FIREBASE_API_KEY`, `…_AUTH_DOMAIN`, `…_PROJECT_ID`, `…_STORAGE_BUCKET`, `…_MESSAGING_SENDER_ID`, `…_APP_ID`, (`…_MEASUREMENT_ID`), `NEXT_PUBLIC_FIREBASE_USE_EMULATORS` | set | set | set, **emulators unset** |
| Firebase server | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | set | set | set |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`, `GEMINI_RPM_LIMIT`, `GEMINI_RPD_LIMIT`, `GEMINI_AUDIO_ENABLED`, `AI_REPAIR_ATTEMPTS`, `AI_CONFIDENCE_REVIEW_THRESHOLD`, `AI_ENABLE_LOCAL_QUOTA_GUARD` | set | set | set |
| Maps | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_MAPS_REGION`, `GOOGLE_MAPS_DEFAULT_CENTER`, `NEXT_PUBLIC_MAP_STYLE`, `NEXT_PUBLIC_MAP_ZOOM_DEFAULT`, `NEXT_PUBLIC_MAP_ZOOM_MAX` | set | set | set |
| Feature flags | `ENABLE_VOICE_REPORTING`, `ENABLE_RISK_ZONES`, `ENABLE_SMS_NOTIFICATIONS`, `ENABLE_WHATSAPP_NOTIFICATIONS`, `NOTIFICATION_RETRY_LIMIT`, `DISPATCH_EXPIRY_SEC`, `RESPONDER_HEARTBEAT_SEC`, `STALE_LOCATION_MIN`, `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_AUDIO_BYTES`, `UPLOAD_SIGNED_URL_TTL_SEC`, `STAGING_UPLOAD_SWEEP_MIN`, `SLA_BREACH_SWEEP` | set | set | set |
| Rate limiting | `RATE_LIMIT_STORE`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_TRUST_PROXY` | set | set | set (`firestore`, `3600`, `true`) |
| Ops | `CRON_SECRET`, `ALLOW_SEED`, `ENABLE_MAINTENANCE_JOBS`, `VERCEL_GIT_COMMIT_SHA` (auto), `SENTRY_DSN` (optional, unset) | `CRON_SECRET` blank | set | **set** |

**Entry order in Vercel (Production → Preview → Development).** Enter Production last for any secret, so a mistyped key is caught by the production deploy rather than a preview. Then:

1. Production: every group above, `ALLOW_SEED=false`, `ENABLE_MAINTENANCE_JOBS=false`, `CRON_SECRET` set.
2. Preview: the same set with the **staging** Firebase project and staging Maps referrers, `ALLOW_SEED=true`, `CRON_SECRET` set.
3. Development: the same set with the **dev** Firebase project, `NEXT_PUBLIC_FIREBASE_USE_EMULATORS` per choice, `CRON_SECRET` blank.

> **`NEXT_PUBLIC_*` variables are build-time.** They are inlined at build. Changing one requires a **rebuild**, not just a restart. See §12.

---

## 3. GitHub setup

### 3.1 Repository structure

One repository, single package ([02 §4.6](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). No monorepo, no `packages/`.

```
caregrid-ai/                         ← default branch: main
├── .github/
│   ├── workflows/ci.yml              ← §11
│   ├── CODEOWNERS                   ← §3.5
│   ├── pull_request_template.md     ← §3.4
│   ├── ISSUE_TEMPLATE/               ← optional; the S1–S5 severity block from [18 §6.1] is the minimum
│   └── dependabot.yml                ← NFR-013 supply-chain hygiene
├── .husky/pre-commit                 ← secret + format guard ([21 §6](./21_ENVIRONMENT_VARIABLES.md))
├── app/  components/  features/  hooks/  lib/  services/  types/  validators/  config/
├── scripts/                          ← seed.ts, create-admin.ts, emulators.ts, check-*.ts, load/
├── tests/
├── docs/                             ← this documentation set
├── firestore.rules  firestore.indexes.json  storage.rules
├── firebase.json  .firebaserc  vercel.json  middleware.ts
├── package.json  package-lock.json  tsconfig.json  next.config.ts
├── eslint.config.mjs  .prettierrc.json  vitest.config.ts  playwright.config.ts  lighthouserc.json
├── components.json
├── .env.example  .env.local  .nvmrc  .editorconfig  .gitignore
└── README.md  LICENSE
```

### 3.2 Branch model

| Branch | Lives for | Merges into | Who may push |
| --- | --- | --- | --- |
| `main` | forever | — (protected) | nobody directly; merge via PR only |
| `develop` | forever | `main` (via PR) | any developer |
| `feat/<slug>` | **≤ 2 days** | `develop` | its author |
| `fix/<slug>` | ≤ 2 days | `develop` | its author |
| `chore/<slug>` | ≤ 1 day | `develop` | its author |
| `docs/<slug>` | ≤ 1 day | `main` (docs-only changes) | its author |

Rules:

1. `feat/*` and `fix/*` are **short-lived**. A branch older than two days is a coordination failure, not a feature. During a 36-hour hackathon this means: branch, merge, delete — in that order, within the working block.
2. Never commit directly to `main` or `develop`. Not even a one-line fix. The protected-branch rule is the cheapest CI we have.
3. Tag before the demo: `git tag -a v1.0.0-hackathon -m "Hackathon release"` and push the tag. Vercel can deploy by tag; the tag is also the rollback anchor a human can name.
4. `main` is the production branch. Vercel's production deployment is wired to `main`. A `develop` push produces a **Preview** deployment, which is where staging happens (§5.6).

### 3.3 Required status checks

These are the checks that must be green on the pull request before a merge. A **skipped** job does **not** count as green ([18 §16.4](./18_TESTING_QA_PLAN.md)).

| # | Check | Command | Enforces | Fails on |
| --- | --- | --- | --- | --- |
| 1 | `typecheck` | `npm run typecheck` | NFR-022 | any type error |
| 2 | `lint` | `npm run lint` | NFR-022/023/024, boundary rules, the `NEXT_PUBLIC_` rule | any ESLint error |
| 3 | `format:check` | `npm run format:check` | NFR-023 | any Prettier diff |
| 4 | `test:unit` | `npm run test:unit` | FR-049, AI safety rules, the lifecycle table | any failure |
| 5 | `test:integration` | `npm run test:integration` | the API contract, Zod-before-DB, authorisation | any failure |
| 6 | `test:rules` | `npm run test:rules` | NFR-014, FR-131 | any rules assertion failure |
| 7 | `build` | `npm run build` | — | any build error |
| 8 | `check:bundle` | `npm run check:bundle` | B-1…B-7, FR-086 | any budget breach or the Maps chunk in `/dashboard` |
| 9 | `test:e2e (chromium)` | `npm run test:e2e -- --project=chromium` | NFR-017, NFR-018, NFR-020, NFR-021 | any journey failure |
| 10 | `test:a11y` | `npm run test:a11y` | NFR-017 | any serious/critical axe violation |
| 11 | `lhci` | `npx lhci autorun` | NFR-001, NFR-002 | any budget breach |
| 12 | `secret-scan` | `gitleaks detect --no-git` | NFR-013 | any secret pattern |
| 13 | `route-schema` | `npm run test:integration -- route-schema` | NFR-025 | a route without an exported Zod schema |
| 14 | `unit-only (no emulator)` | matrix leg, stages 1–6 + 15 | isolation of the pure suite | a test that only passes with the emulator |

`load-rehearsal` is a **release checklist item** ([18 §16.4](./18_TESTING_QA_PLAN.md) final row), not a branch check, because it needs a real Firebase project and 10 minutes of wall clock.

### 3.4 Pull request template

```markdown
## What changed
<!-- one sentence, in the user's terms, not the implementation's terms -->

## FR / NFR
<!-- e.g. FR-040, FR-049. "None" is a valid answer; an unstated answer is not. -->

## Test IDs
<!-- e.g. TC-DUP-001b, TC-DUP-010. A behaviour change without a test ID is rejected. -->

## Files
<!-- the 3–8 paths that actually changed, so a reviewer can review those and skim the rest -->

## Acceptance
- [ ] `npm run verify` is green locally
- [ ] Every changed query has `where('deletedAt','==',null)` ([07 §12.4](./07_DATABASE_SCHEMA.md))
- [ ] Every changed query has a `limit()`
- [ ] No new `process.env` read outside `lib/env.ts` / `lib/env.client.ts`
- [ ] No new `NEXT_PUBLIC_*` var introduced
- [ ] No new `any`, no `dangerouslySetInnerHTML`, no `console.log`
- [ ] No component in `features/` or `components/` over 400 lines
- [ ] If this touches `services/ai/`: the mock adapter still passes, and no fixture needed editing
- [ ] If this touches `firestore.rules` / `storage.rules`: `npm run test:rules` is green and I ran `firebase deploy --only firestore:rules,firestore:indexes,storage --dry-run`
- [ ] Screenshots for any UI change (light and dark)

## Risk
<!-- what breaks if this is wrong, and how we would notice -->
```

### 3.5 Branch protection rules for `main` and `develop`

Set both, identically, in **Settings → Branches → Branch protection rules**.

| Setting | Value | Why |
| --- | --- | --- |
| Require a pull request before merging | ✔, **1** approving review | A second pair of eyes on a security boundary is the cheapest review there is |
| Require approvals | ✔, dismiss stale approvals on new push | — |
| Require conversation resolution | ✔ | — |
| Require status checks to pass | ✔, all 14 from §3.3 | A red gate means we cannot claim the build is verified |
| Require branches to be up to date | ✔ | Prevents "green on an old base" |
| Require signed commits | ✖ (too slow for a hackathon; document as accepted) | — |
| Require linear history | ✔ | Keeps `git bisect` usable |
| **Do not allow bypassing the above settings** | ✔, admins included | Otherwise the rule is advisory |
| Restrict who can push to matching branches | ✔, nobody | — |
| Restrict who can delete the branch | ✔ | — |
| Allow force pushes | ✖ | — |
| Allow deletions | ✖ | — |
| Linear history + "Automatically delete head branches" | ✔ | Kills the `feat/*` sprawl |

`.github/CODEOWNERS`:

```
# Default owner for anything not matched below.
*                               @caregrid-ai/maintainers

# Security boundaries — two owners required, because a single-person review of a
# rules file is not a review.
firestore.rules                  @caregrid-ai/maintainers @caregrid-ai/security
storage.rules                    @caregrid-ai/maintainers @caregrid-ai/security
app/api/admin/**                 @caregrid-ai/maintainers @caregrid-ai/security
services/auth/**                 @caregrid-ai/maintainers @caregrid-ai/security
lib/server/auth-guard.ts         @caregrid-ai/maintainers @caregrid-ai/security
vercel.json                      @caregrid-ai/maintainers @caregrid-ai/security
.github/workflows/**             @caregrid-ai/maintainers
package-lock.json                @caregrid-ai/maintainers

# AI safety
services/ai/**                   @caregrid-ai/maintainers @caregrid-ai/ai-safety
tests/fixtures/ai/**             @caregrid-ai/maintainers @caregrid-ai/ai-safety

# Pure correctness
lib/duplicates/**                @caregrid-ai/maintainers
lib/incidents/**                 @caregrid-ai/maintainers
lib/geo/**                       @caregrid-ai/maintainers

# Docs
docs/**                          @caregrid-ai/maintainers
```

> For a 3-person team, the `CODEOWNERS` file still earns its place: it forces the *second* pair of eyes onto `firestore.rules`, `services/ai/**`, and `lib/incidents/**` — the three places where a silent mistake is a safety bug rather than a cosmetic bug.

---

## 4. Region pairing — `DECISION REQUIRED`

### 4.1 The requirement

The Vercel function region and the Firestore region must be the same (or in the same continent). A mismatch adds one network round-trip to **every** request, on the exact path where NFR-003 (`POST /api/incidents` ≤ 800 ms p95) and NFR-001 (`/dashboard` LCP ≤ 2.5 s) are already tight.

| Item | Candidate | Status |
| --- | --- | --- |
| Firestore region | `asia-south1` (Mumbai) — the `bom1` candidate named in [02 §4.4](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) and [21 §8](./21_ENVIRONMENT_VARIABLES.md) | **`DECISION REQUIRED`** — the Firestore location is a one-way choice at project creation and cannot be changed afterwards. Confirm before creating the project. |
| Vercel region | The region matching the Firestore region | `DECISION REQUIRED` — set on the Vercel project and in `vercel.json` `regions` |
| Google Maps / Gemini | Global; `GOOGLE_MAPS_REGION=IN` biases geocoding results, not latency | not a pairing concern |

### 4.2 What to do, in order

1. **Decide before creating the Firebase project.** Firestore's location is fixed at database creation. Getting it wrong means a new project and a data migration.
2. Prefer the region closest to the **users** (the demo city), not closest to the team. A Hyderabad/Secunderabad demo is `asia-south1`.
3. After the project exists, **read the actual location** from the Firebase console (Firestore → Data → ⚙ → "Location") and record it in the release notes for the day.
4. Set the Vercel region to match, and set `regions` in `vercel.json`.
5. Record the measured first-paint latency against NFR-001 in the load-rehearsal report. If a mismatch is discovered later, a region move is a **re-deploy**, not a data migration, and is cheap — but it must be a deliberate decision, not an accident.

### 4.3 Custom domain — `DECISION REQUIRED`

| Option | Cost | Effect on the $0 claim |
| --- | --- | --- |
| **`*.vercel.app` subdomain** (recommended) | $0 | The $0 claim in [02 §7](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) stays exactly true |
| Custom domain | a real, recurring annual cost | **Breaks the strict $0 claim.** Not "hurts the claim" — invalidates it, because a cost line appears |

> **Honest statement for the submission form:** the demo runs on the `*.vercel.app` subdomain, and a purchased domain would have introduced a recurring cost. This is documented as `DR-03` in [02 §13.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) and remains open. If a judge requires a custom domain, that is a **budget decision, not a technical one**, and it is funded by the entrant, not by the project.

### 4.4 Vercel Hobby plan terms — `DECISION REQUIRED`

Vercel Hobby covers **personal and non-commercial use**. A hackathon entry is non-commercial. The terms must be *read*, not assumed, and the submission should be marked non-commercial. This is `DR-04` in [02 §13.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md). It is not a technical blocker; it is a compliance statement.

---

## 5. First-time deployment runbook

> **Numbered, copy-pasteable, and ordered so that each step is safe to fail at.** Steps 1–12 run on one machine with one shell. Placeholders in `ANGLE BRACKETS` must be replaced. Every command is expected to be run from the repository root.

### 5.0 Prerequisites checklist

- [ ] Node **22.11.0 or newer** installed (`node --version`); the version matches `engines.node` and `.nvmrc`
- [ ] npm **≥ 10.9** (`npm --version`)
- [ ] Java 11+ available (the Firebase emulator needs a JRE)
- [ ] A GitHub account with write access to the repository
- [ ] A Vercel account
- [ ] A Google account that can own the Firebase project
- [ ] A Gemini API key from Google AI Studio (free tier)
- [ ] A Google Cloud project with **billing enabled** for the Maps APIs, and a **hard budget alert** armed ([21 §5](./21_ENVIRONMENT_VARIABLES.md))
- [ ] The region decision from §4.1 made

### 5.1 Steps 1–5: clone, install, toolchain

```bash
# 1 — clone
git clone https://github.com/<ORG>/caregrid-ai.git
cd caregrid-ai

# 2 — confirm the toolchain BEFORE installing
node --version          # must be >= v22.11.0
npm --version           # must be >= 10.9
cat .nvmrc              # must match engines.node

# 3 — install, lockfile-exact (never `npm install`)
npm ci

# 4 — confirm the single gate runs at all (the emulator is not needed for this leg)
npm run typecheck
npm run lint

# 5 — create the local env file from the template
cp .env.example .env.local
```

### 5.2 Steps 6–9: Firebase project provisioning

```bash
# 6 — install and log in to the Firebase CLI (interactive, once per machine)
npm i -g firebase-tools
firebase login

# 7 — create the dev project. Pick the region you decided in §4.1.
#     The CLI cannot create a Firestore database in a different region later;
#     create the project with --add-google-cloud-platform-project so the
#     billing/alert work in step 20 is possible.
firebase projects:create caregrid-ai-dev --display-name "CareGrid AI (dev)"

# 8 — link the aliases (writes .firebaserc)
#     Do this by hand if the CLI prompts are unhelpful: .firebaserc is JSON with
#     one entry per alias and one default.
firebase use --add caregrid-ai-dev dev
firebase use --add caregrid-ai-staging staging      # after step 21
firebase use --add caregrid-ai-prod    prod         # after step 21
```

Repeat steps 7–8 for `caregrid-ai-staging` and `caregrid-ai-prod`, **in that region**. Then, in the Firebase console for each project:

| Step | Action | Notes |
| --- | --- | --- |
| 9a | **Firestore → Create database** | Choose the region from §4.1. **Native mode**, not Datastore mode ([02 §3.7](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). This choice is permanent. |
| 9b | **Storage → Get started** | Default bucket (`<project>.appspot.com` or the `firebasestorage.app` domain). Three top-level prefixes only: `staging/`, `incidents/`, `quarantine/` ([10 §10.1](./10_AUTHORIZATION_SECURITY.md)). |
| 9c | **Authentication → Get started → Sign-in method** | Enable **Email/Password** and **Google**. Nothing else. |
| 9d | **Authentication → Settings → Authorized domains** | Add `localhost` (dev), the staging domain, and the production domain. Firebase auto-adds the `*.vercel.app` domain on the first Vercel deployment. |
| 9e | **Google sign-in → OAuth client ID** | Create an **OAuth client (Web application)**. Add the authorised JavaScript origins: `http://localhost:3000`, `https://<staging-domain>`, `https://<prod-domain>`. Add the authorised **redirect URI** `https://<project-id>.firebaseapp.com/__/auth/handler`. Copy the client ID — it goes in the Firebase web config, not in a custom env var. |
| 9f | **Project settings → General → Your apps → Web** | Register a web app, copy the `firebaseConfig` object. This supplies the six `NEXT_PUBLIC_FIREBASE_*` values. The web API key is **not a secret** ([21 §1 rule 6](./21_ENVIRONMENT_VARIABLES.md)) but it *is* environment-specific. |
| 9g | **Project settings → Service accounts → Generate new private key** | Downloads `*-firebase-adminsdk-*.json`. Move it **out of the repository** immediately. Extract `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` (the latter with literal `\n` escapes, as in the [21 §3](./21_ENVIRONMENT_VARIABLES.md) template). Delete the JSON file. |
| 9h | **Re-authentication** | If the project is created with a 2-step verification prompt, `firebase login --reauth` may be required before `firebase deploy` succeeds. |

**The exact restricted-key setup for Google Maps** (per project, per environment, from [21 §5](./21_ENVIRONMENT_VARIABLES.md)):

| Key | Where it is created | Application restriction | API restriction |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Cloud console → APIs & Services → Credentials | **HTTP referrers**: `http://localhost:3000/*`, `https://<staging-domain>/*`, `https://<prod-domain>/*` | Maps JavaScript API, Places API |
| `GOOGLE_MAPS_SERVER_KEY` | Same console, a **second, separate** key | **IP addresses**: the Vercel egress ranges for the environment (from the Vercel project → Settings → Network → Egress IPs) plus the local machine's IP | Geocoding API, Places API |

> **A key with no application restriction is a finding, not a shortcut** ([21 §5](./21_ENVIRONMENT_VARIABLES.md), [24](./24_THREAT_MODEL_SECURITY.md) T-14). An unrestricted browser key can be used from any site to burn the Maps monthly credit, which is real money ([02 §7.5](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). Verify the restriction by making a request from an unlisted referrer and confirming it fails.

**The default time zone** is not a Firebase setting — it is the application's. Set `APP_TIMEZONE=Asia/Kolkata` in `.env.local` and in every Vercel environment ([21 §2](./21_ENVIRONMENT_VARIABLES.md)). It determines the `analyticsDaily` day-bucket keys ([07 §11.7](./07_DATABASE_SCHEMA.md)) and every displayed time. It is also written into `config/app` as `appTimezone` and `defaultTimezone`, and every `analyticsDaily` document records the `timezone` it was computed in.

### 5.3 Steps 10–12: fill `.env.local`, run the emulators, run the dev server

```bash
# 10 — fill .env.local from the template, using the values from 9f/9g and the
#      Gemini + Maps keys. Then confirm the file is ignored by git.
git check-ignore -v .env.local      # must print a .gitignore rule

# 11 — start the emulators (Auth 9099, Firestore 8080, Storage 9199, UI 4000)
#      Terminal 1
npm run emulators

# 12 — dev server (Terminal 2)
npm run dev
#     Then open http://localhost:3000
```

Confirm `firestore.json`/`firebase.json` matches [18 §7.1](./18_TESTING_QA_PLAN.md): auth `9099`, firestore `8080`, storage `9199`, ui `4000`, `singleProjectMode: true`.

**The default local path uses the dev project's real Firestore**, not the emulator ([02 §4.3](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). Set `NEXT_PUBLIC_FIREBASE_USE_EMULATORS=true` **only** for a rules-test session. State this out loud in the team, because it is the single easiest way to accidentally write demo data into production.

### 5.4 Steps 13–20: seed, admin, verify, deploy rules, deploy the app

```bash
# 13 — seed the demo data (non-production only; throws in production, FR-147)
ALLOW_SEED=true npm run seed

# 14 — create the FIRST admin, out of band, with the service account.
#      This is the only path to an admin (FR-133, [22 §8.1](./22_USER_ROLES_PERMISSIONS.md)).
node --experimental-strip-types scripts/create-admin.ts \
  --email admin@caregrid.demo \
  --display-name "Arun Iyer"

# 15 — the pre-deploy gate, in one command
npm run verify          # typecheck + lint + format:check + test:unit
                        # + test:integration + test:rules + check:bundle
                        # + check:listeners + check:copy + check:fixtures

# 16 — the full local journey suite, then the accessibility sweep
npm run test:e2e -- --project=chromium
npm run test:a11y

# 17 — Lighthouse, three blocking routes
npx lhci autorun

# 18 — deploy rules + indexes + storage rules. RULES FIRST, ALWAYS.
firebase deploy --only firestore:rules,firestore:indexes,storage --project caregrid-ai-dev
#     Verify the deployed artefact matches the repository file
npm run test:rules -- --emulators     # self-starting variant
#     or, against the live project:
#     firebase deploy --only firestore:rules --dry-run   # shows the diff

# 19 — deploy the app. First deploy: the Vercel CLI.
npm i -g vercel
vercel link                 # choose the project; answer the framework questions
                           #   Framework Preset: Next.js
                           #   Build Command:      npm run build
                           #   Install Command:     npm ci
                           #   Output Directory:    .next   (leave the default)
                           #   Node version:        22.11+ — MUST match engines.node
vercel env add <NAME> production      # repeat per variable, per §2.2
vercel --prod

# 20 — after the FIRST deploy, add the resulting *.vercel.app host to
#      Firebase Auth → Authorized domains, and add it to the Maps browser-key
#      HTTP-referrer restriction. A missing authorised domain is the single most
#      common first-deploy failure (see §12, "RefererNotAllowedMapError").
```

### 5.5 Integration verification — run every one of these, once, per environment

A deployment is not "done" until each row has a green observation. A tick means *observed*, not *assumed*.

| # | Check | Command / action | Expected | If it fails |
| --- | --- | --- | --- | --- |
| V1 | **Health** | `curl -s "$APP_URL/api/health"` | `200`, `status: "ok"`, `checks.firestore/gemini/storage` all `ok`, **no** project id, bucket name, or stack in the body | §12 "build failures" / check `FIREBASE_*` |
| V2 | **Auth — email/password** | Sign up in the browser at `$APP_URL/signup` | Lands on `/report`; `users/{uid}` exists with `role: "citizen"` | §12 `permission-denied` |
| V3 | **Auth — Google popup** | Sign in with Google | Popup completes; same `users/{uid}` shape | `Popup blocked by browser` → allow popups; `auth/unauthorized-domain` → step 20 |
| V4 | **Role authority** | Sign in as the admin; call `GET /api/me` | `user.role` is `admin`; `permissions[]` is server-computed | §12 "claim drift" |
| V5 | **Firestore write** | Submit a text report on `/report` | `201`; a row appears in `/dashboard` within 3 s; `statusHistory/created` exists | §12 "permission-denied" |
| V6 | **Firestore read scoping** | As citizen B, open citizen A's incident id in the URL | `404` with the **identical** body as a non-existent id | a `403` or a differing body is a security defect, not a bug |
| V7 | **Storage upload** | Attach a JPEG and submit | Per-file progress, then `evidenceCount: 1`; the object moved from `staging/` to `incidents/…` | §12 `PERMISSION_DENIED` on Storage / CORS on the signed PUT |
| V8 | **Magic-byte rejection** | Attach a `.png` that is really a JPEG | Inline rejection on the chip; the other files and the text survive | The API accepted the declared type — FR-008 is broken |
| V9 | **Gemini triage** | Submit a report and watch the AI panel | `triageSource: "ai"`, a category, an urgency, `aiConfidence`; an `aiRuns` row with `model`/`promptVersion`/`latencyMs` | §12 "quota exceeded" |
| V10 | **Gemini fallback** | Temporarily set `GEMINI_API_KEY=` to an invalid value; submit | Still `201`; `triageSource: "fallback"`, `urgency: "medium"`, `triageError` set, a **Needs review** badge | A `500` here breaks FR-029 |
| V11 | **Maps render** | Open `/map` | Markers render; the map is **not** in the `/dashboard` bundle (`npm run check:bundle`) | §12 `RefererNotAllowedMapError` |
| V12 | **Maps degradation** | Block `maps.googleapis.com` in DevTools | `MapListFallback` renders, expanded, with a **Retry map** action | FR-085 is broken |
| V13 | **Realtime** | Open `/dashboard` in two windows; change a status in one | The other updates within 3 s, no refresh | listener teardown or role scoping |
| V14 | **Security headers** | `curl -sI "$APP_URL/dashboard" \| grep -iE 'content-security-policy\|x-content-type\|referrer-policy\|permissions-policy\|x-frame'` | All five present, with the `Permissions-Policy` from [10 §15.1](./10_AUTHORIZATION_SECURITY.md) | §12 "CSP blocking the app" |
| V15 | **Seed is blocked in production** | `ALLOW_SEED=true NODE_ENV=production npm run seed` | Non-zero exit with a message | FR-147 is unenforced |
| V16 | **Cron is guarded** | `curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/cron/analytics-daily"` | `401` | `CRON_SECRET` is unset or the guard is missing |
| V17 | **Deployed rules hash** | `GET /api/admin/system/health` as admin, compare the rules hash to `sha256sum firestore.rules` | Equal | §7.3, rules rollback |
| V18 | **Read budget** | Read Firebase console → Usage & billing after V5–V13 | Comfortably inside the allowance | §10.3 |

### 5.6 Rollback

```bash
# Revert the application only. Instant, one command, no data impact.
# Either: Vercel dashboard → Deployments → ⋯ → "Promote to Production" on the
#         last known-good deployment (preferred; it is atomic and auditable)
# Or:    vercel rollback <deployment-url-or-sha> --prod
# Or:    git revert <sha> && git push origin main   (which triggers a redeploy)

# Revert the rules. NOT a Vercel rollback.
git checkout <good-sha> -- firestore.rules storage.rules
firebase deploy --only firestore:rules,storage --project <alias>

# Revert the indexes. Note: deleting an index is asynchronous; queries that
# depended on it fail with FAILED_PRECONDITION until the delete completes.
git checkout <good-sha> -- firestore.indexes.json
firebase deploy --only firestore:indexes --project <alias>
```

**Rule:** never roll back the app *below* the deployment that matches the deployed rules without rolling the rules back too, and in the other order. A client bundle written for `schemaVersion: 2` reading a database at `schemaVersion: 1` is the exact class of bug that a rollback creates if the order is wrong.

---

## 6. Release checklist

### 6.1 Pre-deploy

| # | Check | Command | Pass |
| --- | --- | --- | --- |
| P1 | Clean working tree | `git status --porcelain` | empty |
| P2 | Branch is up to date | `git fetch && git status -sb` | no `behind` |
| P3 | Install is lockfile-exact | `rm -rf node_modules && npm ci` | no drift |
| P4 | Single gate | `npm run verify` | green |
| P5 | E2E | `npm run test:e2e -- --project=chromium` | green |
| P6 | Accessibility | `npm run test:a11y` | 0 serious, 0 critical |
| P7 | Performance | `npx lhci autorun` | green on `/report`, `/dashboard`, `/map`, `/incidents/[id]` |
| P8 | Secret scan | `gitleaks detect --no-git` | clean |
| P9 | Load rehearsal | `node --experimental-strip-types scripts/load/run.ts --env dev --scenario all --dispatchers 10 --citizens 50 --duration 600 --warmup 60 --out reports/load-<ts>.json` | every threshold in [26 §11.5](./26_PERFORMANCE_REQUIREMENTS.md) met, artefact attached |
| P10 | Console usage after the rehearsal | Firebase console → Usage & billing | reads/writes under the allowance with headroom |
| P11 | AI health | `GET /api/admin/system/health` | success ≥ 95 %, fallback ≤ 5 %, p95 ≤ 8 s, quota headroom ≥ 50 % |
| P12 | Maps budget alert | Google Cloud console → Billing → Budgets | armed at 50 %, 90 %, 100 % |
| P13 | Maps key restrictions | make a request from an unlisted referrer | it fails |
| P14 | `ALLOW_SEED=false` in production | read the Vercel production env | `false` |
| P15 | `CRON_SECRET` in production | `curl -o /dev/null -w '%{http_code}' $APP_URL/api/cron/analytics-daily` | `401` |
| P16 | Deployment protection on **preview** deployments | Vercel project → Settings → Deployment Protection → Vercel Authentication (Standard, or Protection Bypass for team members) | on for previews |
| P17 | Rules dry-run | `firebase deploy --only firestore:rules,firestore:indexes,storage --dry-run` | the diff is only what the PR intended |
| P18 | Visual diff reviewed by a human | `npx playwright test --project=visual` | reviewed, not auto-updated |

### 6.2 Deploy

| # | Step | Command | Pass |
| --- | --- | --- | --- |
| D1 | Merge the PR | GitHub | all required checks green, ≥ 1 approval |
| D2 | Rules + indexes **first** | `firebase deploy --only firestore:rules,firestore:indexes,storage` | deployed to the target project |
| D3 | Confirm the index state | `firebase firestore:indexes` (or the console) | all required indexes `READY`; none `BUILDING` |
| D4 | Promote the app | the Vercel production deployment from `main`, or `vercel --prod` | ready |
| D5 | Smoke the new deployment | §5.5 V1, V2, V5, V9, V11, V14 | all green |
| D6 | Tag | `git tag -a v<N>.<M>.<P> -m "..." && git push --tags` | tag pushed |
| D7 | Attach the load + verification report to the release notes | — | done |

### 6.3 Post-deploy

| # | Check | When | Pass |
| --- | --- | --- | --- |
| A1 | Re-run §5.5 V1–V18 against the production URL | immediately | all green |
| A2 | Confirm the rules hash matches the repo | immediately | equal (TC-RULES-026) |
| A3 | Watch Vercel runtime logs for 15 min | immediately | no `5xx`, no repeated `DB_UNAVAILABLE` |
| A4 | Read the Firebase usage graph | after 1 h | the shape matches the load report |
| A5 | Read the AI Studio usage graph | after 1 h | no error spike |
| A6 | Read the Google Cloud billing page | after 1 h and after 24 h | zero charges |
| A7 | Provider status pages | at T+1 h | recorded ([26 §10.3](./26_PERFORMANCE_REQUIREMENTS.md)) |
| A8 | Update the decision register if anything was decided during the release | same day | `DECISION REQUIRED` items resolved are marked resolved with the evidence |

---

## 7. Firestore & Storage rules and indexes

### 7.1 Why the rules are deployed **before** the app

| Reason | Consequence of the wrong order |
| --- | --- |
| The new app may depend on a new field, a new index, or a new rule | Deploy app first ⇒ the app reads a field that does not exist yet ⇒ a `500` on a live surface |
| A **tightened** rule is a breaking change for an old bundle | Deploy rules first ⇒ old bundles lose access instantly, e.g. a citizen's report form that starts failing with `permission-denied` |
| A **loosened** rule is a security regression | Deploy rules first and the window of over-permission is zero seconds |
| An index that is still `BUILDING` fails the query with `FAILED_PRECONDITION` | Deploy indexes first and the app is deployed against indexes that are already `READY` |

The only artefact where app-first is correct is a *new optional field read defensively*. The design has none: [07 §2](./07_DATABASE_SCHEMA.md) requires readers to tolerate absence, and the deploy discipline is rules-first regardless, because the failure mode is asymmetric — a too-early app deploy breaks the product, a too-late app deploy breaks nothing.

### 7.2 The exact deploy command

```bash
# Single command, all three artefacts, to the alias from .firebaserc
firebase deploy --only firestore:rules,firestore:indexes,storage

# Explicit project, because "which project did that just hit?" is a real question
firebase deploy --only firestore:rules,firestore:indexes,storage --project caregrid-ai-prod

# Dry run first. Always. This prints the diff without applying it.
firebase deploy --only firestore:rules,firestore:indexes,storage --dry-run

# Rules only, for a rules-only PR
firebase deploy --only firestore:rules,storage

# Confirm the live rules
firebase firestore:rules
```

> **`--project` is not optional in a three-project setup.** `firebase use` writes a default into `.firebaserc`, and a default plus a forgotten argument is how a staging rules change lands in production. Pass `--project` in every command in CI and in any command run near a demo.

### 7.3 The emulator workflow, and why it exists

Three ways to run the rules suites, all from [18 §8.1](./18_TESTING_QA_PLAN.md):

| Context | Command | Proves |
| --- | --- | --- |
| Emulator already running (terminal 1) | `npm run test:rules` (terminal 2) | the rules **file** behaves as the suite expects |
| Self-starting, one command | `npm run test:rules -- --emulators` | the same, with no second terminal and no stale state |
| One-shot, for CI or a clean check | `firebase emulators:exec --only auth,firestore,storage "npm run test:rules"` | the same, and the emulator is torn down afterwards |

`emulators:exec` is the right tool for a **clean-room verification** because it starts and stops the emulator in one process, so nothing from a previous session can leak in. The harness pins `projectId: 'caregrid-ai-rules-test'` with `singleProjectMode: true`, and the emulator refuses to start if that id appears in `.firebaserc` — a guard against a typo pointing the suite at a real project.

**A rules test proves the file is correct. It does not prove the file is deployed.** Three checks close that gap:

| Test ID | Check |
| --- | --- |
| TC-RULES-026 | `GET /api/admin/system/health` reports the **deployed** rules document hash; it must equal `sha256(firestore.rules)` in the repository. A mismatch is a hard release blocker. |
| TC-RULES-027 | After the deploy, the suite is re-run against the **deployed** rules fetched from the project, so the deployed artefact is the one tested. |
| TC-RULES-028 | Static: `firestore.rules` contains no `allow read, write: if true` catch-all, and its final `match` is a deny-by-default `if false`. |

### 7.4 `firestore.indexes.json`

Aligned to the 11 `incidents` composites in [07 §4](./07_DATABASE_SCHEMA.md), plus the collection-group and per-collection composites the queries in [07 §12](./07_DATABASE_SCHEMA.md) require.

```jsonc
// firestore.indexes.json — document inline; the implementation must match.
{
  "indexes": [
    // ---------- incidents: the 11 composites of [07] §4 ----------
    // #1 dispatcher active queue (default)
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // #2 urgency filter
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "urgency", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // #3 category filter
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "category", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // #4 citizen "my reports"
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "reporterUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // #5 responder assignments
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "assigneeUid", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    // #6 MAP VIEWPORT / duplicate candidate search
    //    [07 §4] row 6 lists `deletedAt, status IN [7], updatedAt DESC`; the note
    //    beneath it states the platform field-order rule: array-membership comes
    //    FIRST. geoCells (CONTAINS) therefore leads. This is the resolution of
    //    that note and is the normative form.
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "geoCells", "arrayConfig": "CONTAINS" },
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    // #7 history / analytics recent
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // #8 SLA breach sweep
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "verifiedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "urgency", "order": "ASCENDING" }
      ]
    },
    // #9 breached-only filter
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "slaBreachedAt", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" }
      ]
    },
    // #10 analytics window
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "createdAt", "order": "ASCENDING" },
        { "fieldPath": "slaTargetMin", "order": "ASCENDING" },
        { "fieldPath": "verifiedAt", "order": "ASCENDING" }
      ]
    },
    // #11 cursor pagination for the admin list (explicit __name__ so the
    //    order is total and pagination is stable under concurrent writes)
    {
      "collectionGroup": "incidents",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "deletedAt", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" },
        { "fieldPath": "__name__", "order": "DESCENDING" }
      ]
    },

    // ---------- subcollection collection groups ----------
    // cross-incident "all reports by user" (admin, abuse review)
    {
      "collectionGroup": "reports",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "reporterUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    // cross-incident status history (admin timeline across incidents)
    {
      "collectionGroup": "statusHistory",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "actorUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },

    // ---------- responders ----------
    // candidate ranking base ([07] §7.1)
    {
      "collectionGroup": "responders",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "verification", "order": "ASCENDING" },
        { "fieldPath": "lastLocationAt", "order": "DESCENDING" }
      ]
    },
    // staleness sweep
    {
      "collectionGroup": "responders",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "lastLocationAt", "order": "DESCENDING" }
      ]
    },

    // ---------- responderLocations ----------
    {
      "collectionGroup": "responderLocations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "capturedAt", "order": "DESCENDING" }
      ]
    },

    // ---------- dispatches ----------
    // find the live assignment for an incident
    {
      "collectionGroup": "dispatches",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "incidentId", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" }
      ]
    },
    // the responder's own view
    {
      "collectionGroup": "dispatches",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "responderUid", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "dispatchedAt", "order": "DESCENDING" }
      ]
    },
    // expiry sweep
    {
      "collectionGroup": "dispatches",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "expiresAt", "order": "ASCENDING" }
      ]
    },

    // ---------- notifications ----------
    {
      "collectionGroup": "notifications",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "recipientUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "notifications",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "recipientUid", "order": "ASCENDING" },
        { "fieldPath": "read", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },

    // ---------- aiRuns ----------
    // AI health and error-rate monitoring ([09] §9.1, [26] §10.2)
    {
      "collectionGroup": "aiRuns",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "outcome", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },

    // ---------- auditLogs ----------
    {
      "collectionGroup": "auditLogs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "actorUid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "auditLogs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "action", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "auditLogs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "entityType", "order": "ASCENDING" },
        { "fieldPath": "entityId", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ],

  "fieldOverrides": [
    // geoCells is queried with array-contains in every geospatial path.
    // The default single-field index config for an array field does NOT include
    // a CONTAINS index; without this override the duplicate-candidate query and
    // the map viewport query fail with FAILED_PRECONDITION at runtime.
    {
      "collectionGroup": "incidents",
      "fieldPath": "geoCells",
      "indexes": [
        { "queryScope": "COLLECTION", "arrayConfig": "CONTAINS" }
      ]
    },
    // The array element itself never needs an ASC/DESC index.
    {
      "collectionGroup": "incidents",
      "fieldPath": "geoCells",
      "indexes": []
    }
  ]
}
```

**Consistency notes:**

- [18 §8.3](./18_TESTING_QA_PLAN.md) TC-RULES-029 says "the 11 composite indexes in `firestore.indexes.json`". The **11** refers to the `incidents` composites of [07 §4](./07_DATABASE_SCHEMA.md); the file also carries the per-collection and collection-group composites those queries need. A static test asserts that the `incidents` set is exactly 11 and matches [07 §4](./07_DATABASE_SCHEMA.md).
- **TTL policies are not in this file.** `expiresAt` on `rateLimits` and `notifications` is enabled through the Firestore TTL API, not the index file:
  ```bash
  gcloud firestore fields ttls update expiresAt \
    --collection-group=rateLimits --project=caregrid-ai-prod
  gcloud firestore fields ttls update expiresAt \
    --collection-group=notifications --project=caregrid-ai-prod
  gcloud firestore fields ttls list --project=caregrid-ai-prod   # verify
  ```
  Firestore deletes within 24 h of `expiresAt`, so TTL is a **hygiene tool, never a correctness mechanism** ([07 §12.7](./07_DATABASE_SCHEMA.md)). `TC-PERF-045` asserts that the `rateLimits` document count is not growing without bound.

### 7.5 How long an index build takes

| Situation | Observed range | Consequence for the runbook |
| --- | --- | --- |
| Empty or demo-scale collection (hundreds of docs) | seconds to a couple of minutes | Rules-first deploy is effectively instant; a query against a `BUILDING` index is still possible in the first minutes, so §6.2 D3 polls the index state |
| Tens of thousands of documents | minutes to tens of minutes | Never deploy the app in the same minute as a *new* index; deploy the index, wait for `READY`, then deploy the app |
| Hundreds of thousands+ of documents | can be hours | Not a hackathon problem. It **is** a Horizon-2 problem, and the reason [28](./28_FUTURE_ROADMAP.md) moves analytics off Firestore |

- **VERIFY:** exact build times are not restated here. The authoritative state is `firebase firestore:indexes` or the Firestore console → Indexes, which shows `READY`, `BUILDING`, or `NEEDS_BACKUP`/`ERROR` per index.
- **An index in an error state** usually means a query is missing a filter or has the field order wrong. The console shows the failing query. The most common cause in this design is forgetting `where('deletedAt','==',null)`, because a composite index's field list must contain *every* field the query constrains ([07 §12.4](./07_DATABASE_SCHEMA.md)).
- **Deleting an index is slower than creating one.** A query depending on a deleted index keeps working for a while and then fails. Do not delete an index in the same release that stops using it.

---

## 6b. Vercel project setup

*(Numbering continues the runbook in §5; this is the dashboard walkthrough referenced by §5.4 step 19.)*

### 8.1 Import

| Field | Value | Notes |
| --- | --- | --- |
| Import from | GitHub, the `caregrid-ai` repository | the first deploy happens on import |
| Framework Preset | **Next.js** (auto-detected) | do not override to "Other"; the preset sets the output handling and the build cache |
| Root Directory | *(repository root)* | single package, so no subdirectory |
| Install Command | **`npm ci`** | never `npm install`; the lockfile is the guarantee |
| Build Command | **`npm run build`** | |
| Output Directory | `.next` (the default) | do not enable `standalone` — not required on Vercel ([02 §11.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) |
| Node.js Version | **22.11.0 or newer**, matching `engines.node` and `.nvmrc` | a mismatch here is the classic "works locally, fails on deploy" |

### 8.2 Git integration

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Preview deployments | every other branch, and every PR |
| `main` deployments | **Automatic** (or manual for a fully gated demo; see §11.4) |
| `develop` / `feat/*` | Preview only |

### 8.3 Region

Set in **Project Settings → Functions → Regions** and mirrored in `vercel.json` under `regions`. Hobby exposes a single region choice; the pairing requirement in §4.1 is the whole reason this is called out. **VERIFY** the currently selectable regions in the Vercel dashboard rather than trusting a remembered list.

### 8.4 Environment variables

Enter per §2.2, Production last. Two Vercel-specific behaviours to know:

1. A `NEXT_PUBLIC_*` variable is inlined **at build time**. Changing it requires a **rebuild**; a restart is not enough. A redeploy triggered by a new commit picks it up; a settings change alone may not.
2. Preview deployments inherit the **Preview** environment variables. A preview pointing at the *production* Firebase project is a data-safety incident waiting to happen, so §5.6's deployment protection matters: with protection on, a preview is not publicly reachable and cannot be driven by a stranger.

### 8.5 Custom domain

Per §4.3, use the `*.vercel.app` subdomain. If a domain is later purchased: add it in the Vercel project, add the apex **and** the `www` variant, add both to Firebase Auth → Authorized domains, add both to the Maps browser-key referrer restriction, and update `NEXT_PUBLIC_APP_URL` **in every environment** — a stale `NEXT_PUBLIC_APP_URL` breaks the CSRF origin check (§1.8 of [08](./08_API_SPECIFICATION.md)) with `403 CSRF_FAILED`, which looks like a security bug and is actually a configuration bug.

### 8.6 Deployment protection on preview deployments

**Project Settings → Deployment Protection → Vercel Authentication** (Standard or Protection Bypass for a team member). Rationale: a preview deployment is a *complete running copy* of the app, pointed at the staging Firebase project, with the staging service-account credentials in its environment. Without protection, the first person who guesses or is told the preview URL can read the staging database. Protection costs nothing on Hobby and removes a whole class of embarrassment.

> For the demo itself, production is what matters: consider disabling Vercel Authentication on **production** so the judges can reach the URL unauthenticated, and keep it on for previews. Record which state each environment is in, because "the demo URL asked for a login" is a real and avoidable failure.

---

## 9. `vercel.json` — the complete file

```jsonc
// vercel.json — documented inline; the implementation must match [21] §8 and
// [10] §15. Keep this file reviewable: it is the deployment contract.
{
  "$schema": "https://openapi.vercel.sh/vercel.json",

  "framework": "nextjs",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",

  // §4.1 — must match the Firestore region. DECISION REQUIRED until verified.
  "regions": ["bom1"],

  // ---------------------------------------------------------------------------
  // Cron. Vercel Hobby allows cron jobs ONLY ONCE PER DAY, so this single slot
  // owns the daily analyticsDaily rollup ([14] §..., [02] §8.6). Risk recompute
  // and the four maintenance sweeps are ADMIN-TRIGGERED, not scheduled, because
  // a second daily slot does not exist on this plan.
  // ---------------------------------------------------------------------------
  "crons": [
    {
      "path": "/api/cron/analytics-daily",
      "schedule": "0 3 * * *"
    }
  ],

  // ---------------------------------------------------------------------------
  // Security headers for the static/CDN surface. The per-request nonce CSP
  // cannot live here — a static file cannot hold a nonce — so `middleware.ts`
  // sets the CSP and `vercel.json` sets everything else. Both are required
  // ([10] §15). Do not remove a header from here on the assumption middleware
  // covers it: the static surface bypasses middleware.
  // ---------------------------------------------------------------------------
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        {
          "key": "Permissions-Policy",
          "value": "geolocation=(self), microphone=(self), camera=(self), payment=(), usb=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=(), autoplay=(), fullscreen=(self), interest-cohort=()"
        },
        { "key": "X-Frame-Options", "value": "DENY" },
        // Functional requirement for signInWithPopup, NOT a hardening measure.
        // Do not "tighten" this to `same-origin`; Google sign-in will break.
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin-allow-popups" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" },
        { "key": "X-DNS-Prefetch-Control", "value": "off" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" }
      ]
    },
    // Operational surfaces stay out of search indexes.
    {
      "source": "/admin/:path*",
      "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }]
    },
    {
      "source": "/dashboard",
      "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }]
    },
    {
      "source": "/map",
      "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }]
    },
    // Content-hashed assets are immutable.
    {
      "source": "/_next/static/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ]
}
```

> **`Strict-Transport-Security` with `preload` is only correct once the domain is confirmed HTTPS-only.** Vercel serves HTTPS by default, so this is safe; on a self-hosted or proxied domain it is not.

### 9.1 The cron budget, and the manual fallback

| Fact | Consequence |
| --- | --- |
| Hobby = **one cron per day** | The daily `analyticsDaily` rollup takes the single slot. |
| The rollup for "today" can only be produced tomorrow morning | **Accept it.** `GET /api/analytics` switches to a bounded live scan when the range ends less than 48 h ago (FR-116), so the gap is invisible to the user. (`DR-09` in [02 §13.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md).) |
| Cron invocations cost a Vercel function invocation | One per day is one invocation. Irrelevant. |
| The cron route is **guarded** by `Authorization: Bearer $CRON_SECRET` | Without the secret, `401`. `lib/env.ts` throws at boot in production if `CRON_SECRET` is missing, so this is enforced at deploy time too. |

**Manual fallback, in the order to use it:**

1. `POST /api/analytics/recompute` with `{ "target": "daily", "from": "<date>", "to": "<date>" }` as `admin` — returns `202 { jobId, status: "queued" }` and is rate-limited to 5/hour. This is the intended demo-day refresh.
2. `POST /api/analytics/recompute` with `{ "target": "risk" }` — the only way risk zones are recomputed on this plan.
3. `POST /api/admin/maintenance/sweep-expired-dispatches`, `…/sweep-staging-uploads`, `…/purge-closed-locations`, `…/recompute-analytics` — each individually audited, each requiring a `reason`, each refused with `422 MAINTENANCE_DISABLED` unless `ENABLE_MAINTENANCE_JOBS=true` (which is `false` in production).
4. Trigger the cron route by hand: `curl -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/analytics-daily"`. Works, and is the honest "we run the same code path" answer.

**Budget alert for the cron.** A cron that starts failing does not notify anyone on a free tier. The substitute is a scheduled digest (§11.3) that reads `GET /api/admin/system/health` and includes the `analyticsDaily` completeness for today. If the digest reports `partial` for a day that ended more than 48 h ago, the cron did not run — that is the alert.

> **Naming note (`DECISION REQUIRED`).** The canonical cron path is `/api/cron/analytics-daily` ([14](./14_ANALYTICS_SPECIFICATION.md)); [18 §18.2](./18_TESTING_QA_PLAN.md) item 22 refers to `GET /api/cron/daily-rollup`. Both are the same `[job]` parameter. The job name must be one string. This document uses `analytics-daily`; the decision owner should amend the other document.

---

## 10. Data management

### 10.1 Backups

Firestore does **not** have a free point-in-time backup tier that we can rely on for a $0 claim, so the backup story is an **export**, scheduled by us.

```bash
# Full export of a database to Cloud Storage (AVRO)
gcloud firestore export gs://<BACKUP_BUCKET>/firestore/$(date -u +%Y-%m-%dT%H%M%SZ) \
  --project=caregrid-ai-prod

# Collection-group export (smaller, faster, and the right shape for most needs)
gcloud firestore export gs://<BACKUP_BUCKET>/firestore/incidents/$(date -u +%Y-%m-%dT%H%M%SZ) \
  --collection-ids=incidents,statusHistory,reports,dispatches \
  --project=caregrid-ai-prod

# Verify what exists
gsutil ls -l gs://<BACKUP_BUCKET>/firestore/
```

| Question | Answer |
| --- | --- |
| Does an export cost money? | The export itself writes to Cloud Storage. **Small, infrequent exports on a small database are within the free storage allowance; verify the current figures in the console.** A weekly full export of a demo-scale database is megabytes, not gigabytes. The risk is not the export, it is a misconfigured retention policy that never expires a growing bucket. Set a lifecycle rule. |
| Where do the backups live? | A **separate** GCP project from the app, with its own billing and its own access. A backup in the same project as the data is not a backup against a project-level mistake. |
| Who can read them? | The project owner only. A backup contains `originalText`, reporter UIDs, IP hashes, and evidence paths. Treat it as the most sensitive artefact the project produces. |
| How long to keep? | 30 days for a hackathon. Longer only if a real retention policy exists ([NFR-028](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) covers location retention, not backups). |
| How often? | Weekly during active development, and **once immediately before any demo** — because the demo writes data and the seed script is destructive. |

### 10.2 Restore procedure

```bash
# 1. Inspect the export before trusting it
gsutil ls gs://<BACKUP_BUCKET>/firestore/<timestamp>/

# 2. Restore into a SCRATCH project first. Never restore over the live project
#    to "see what happens" — that is how a restore becomes a second incident.
gcloud firestore import gs://<BACKUP_BUCKET>/firestore/<timestamp> \
  --project=caregrid-ai-restore-test

# 3. Verify counts in the console: incidents, statusHistory, dispatches,
#    auditLogs. auditLogs is the one that matters most — it is append-only and
#    irreplaceable, so if it restores, the restore is trustworthy.

# 4. Only then, to the target project, and only with the app stopped or the
#    target environment's data explicitly disposable:
gcloud firestore import gs://<BACKUP_BUCKET>/firestore/<timestamp> \
  --project=caregrid-ai-dev      # for a dev reset
```

| Restore property | Value |
| --- | --- |
| RTO | Hours. This is a batch import, not a point-in-time recovery. |
| RPO | One export interval (weekly, or one pre-demo export). |
| Data loss window in a disaster | Everything since the last export. On a demo-scale system with a full seed script, that is *acceptable and stated*. On a real system it is not, and the correct answer is a paid PITR plan. |
| What a restore does **not** restore | Storage evidence bytes. `gcloud firestore export` covers Firestore only. Evidence is in Cloud Storage and needs its own (`gsutil rsync` to a second bucket) or its own export. This is the single most commonly missed step. |
| Audit-log integrity | A restore rewrites documents. `auditLogs` are append-only by *rule*, not by *physics*; the Admin SDK bypasses rules. After any restore, re-run `npm run test:rules` and check `GET /api/admin/audit-logs` renders. |

### 10.3 What is and is not worth backing up for a hackathon

| Data | Back it up? | Why |
| --- | --- | --- |
| `incidents` + `statusHistory` + `reports` | **Yes** | The product record. Also cheap to recreate from `services/seed/seed-data.ts` if the seed is the source of truth. |
| `auditLogs` | **Yes, highest priority** | Append-only and irreplaceable (FR-131). A lost audit log is a lost accountability claim. |
| `resources`, `config/app` | Yes (tiny) | Reference data. A misconfigured duplicate radius is a silent quality regression. |
| `users`, `responders` | Yes | Roles and verification state. Losing them means re-verifying responders. |
| `rateLimits` | **No** | Pure hygiene, TTL-expired within an hour ([07 §11.6](./07_DATABASE_SCHEMA.md)). Restoring it would resurrect stale counters. |
| `notifications` | No | Expiring UI state. |
| `aiRuns` | Optional | Valuable for the accuracy study in [28](./28_FUTURE_ROADMAP.md) H1-7. If you want to run that study, export `aiRuns` **before** you clean anything. |
| `analyticsDaily` | No | Reconstructible from `POST /api/analytics/recompute` or the seed. |
| Storage evidence bytes | Only if a real user uploaded something | For a demo, the seed regenerates the images. For real users, this is the whole product. |
| `riskZones` | No | Recomputed. |

> **The honest hackathon answer:** the seed script plus a single pre-demo export is sufficient, and the project should say so rather than implying an enterprise backup posture. The gap is recorded in [28](./28_FUTURE_ROADMAP.md) H1-5 (backup verification) and in §13's limitations.

---

## 11. Monitoring — free tools only

> **No paid APM.** No Sentry, no Datadog, no New Relic, no LogRocket, no uptime service. `SENTRY_DSN` exists as an **optional, default-disabled** hook so the plug-in point is real (NFR-030), and the zero-cost posture is a hard requirement (NFR-026). ([02 §6.8](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md), [26 §10](./26_PERFORMANCE_REQUIREMENTS.md))

### 11.1 The measurement stack

| Signal | Where to look | Cost | What it answers |
| --- | --- | :-: | --- |
| **Liveness** | `GET /api/health` — unauthenticated, cached 30 s, each dependency check ≤ 1.5 s | $0 | Is the app up, and are Firestore/Gemini/Storage reachable? Never exposes a project id, bucket name, or stack |
| **AI + quota health** | `GET /api/admin/system/health` — `admin` only | $0 | Is the AI healthy, is the quota guard near its ceiling, are rules deployed, is the read budget intact? |
| **Server logs** | Vercel project → Logs → Runtime/Function logs, filterable by `requestId` | $0 | Which route, which status, which `requestId`, how long |
| **Deployment logs** | Vercel project → Deployments → ⋯ → Build Logs | $0 | Did the build succeed, which commit, which Node version, which env |
| **Firestore usage** | Firebase console → Usage & billing | $0 | **The number that actually threatens the $0 claim.** Reads, writes, deletes, stored data, day by day |
| **Auth usage** | Firebase console → Authentication → Usage | $0 | Sign-in and email-sending quota |
| **Storage usage** | Firebase console → Storage → Usage | $0 | Stored bytes and egress |
| **AI usage** | AI Studio → Usage | $0 | Requests/min and /day, error rate, latency |
| **Maps usage and cost** | Google Cloud console → Billing → Budgets + Usage; Maps Platform → Usage | $0 | Whether the credit is at risk |
| **Lighthouse CI** | GitHub Actions artefacts from `npx lhci autorun` | $0 | LCP/INP/CLS regression before merge, per route |
| **Load rehearsal** | The local Node load script against the dev project | $0 | The real read/write counts and latencies for a demo day |
| **Provider status** | status.vercel.com, status.firebase.google.com | $0 | Was a provider down when something broke |

### 11.2 `GET /api/admin/system/health` — the in-product dashboard

The single page that answers *"is the $0 claim still true, and is the AI healthy?"* Group by group, with the alert condition that matters ([26 §10.2](./26_PERFORMANCE_REQUIREMENTS.md)):

| Group | Look at | Alert when |
| --- | --- | --- |
| **Firestore** | reads in the last hour, writes in the last hour | > 3 000 reads/h with 1 active session; > 1 000 writes/h |
| | `rateLimits` document count | growing without bound ⇒ TTL is not working (`TC-PERF-045`) |
| | index health | a failed query in the logs ⇒ a missing index |
| **Realtime** | listener count per collection, as a declared maximum | any client reporting > 8 (FR-091) |
| **AI** | 24 h success rate | < 95 % |
| | 24 h fallback rate | > 5 % warn, > 20 % alert — and per [09 §9.1](./09_AI_GEMINI_SPECIFICATION.md), above 20 % the honest move is to demo the fallback and say so |
| | p50 / p95 `latencyMs` | p95 > 8 s (NFR-004) |
| | local quota-guard headroom (`GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT` vs. observed) | < 50 % ⇒ drop audio from the AI call |
| | `aiRuns` failures in 24 h | any sustained non-zero |
| **Storage** | staging objects older than 30 min | > 0 ⇒ `sweep-staging-uploads` is not running |
| **Config** | `config/app.updatedAt`, `schemaVersion` | a stale schema version |
| **Rules** | the deployed rules document hash | ≠ the repository file ⇒ **hard release blocker** (TC-RULES-026) |
| **Deployment** | `VERCEL_GIT_COMMIT_SHA`, uptime | — |

Cost discipline: the endpoint uses **bounded** queries (`limit(500)`), never a listener, and never scans `incidents`. Budget ≤ 900 ms p95, ≤ ~1 500 reads per call. It is a page an admin opens deliberately, not a heartbeat.

### 11.3 Alerting without an alerting tool

There is no free uptime pager. The substitute is a **scheduled digest**: a daily local (or GitHub Actions scheduled) job that collects the same numbers and posts them somewhere a human will see.

```bash
# scripts/load/../ ops digest is intentionally a plain curl, not a service.
# Run it on a schedule; read it once a day. That is the whole alert stack.
APP_URL="https://<prod-domain>"
TOKEN="<an admin ID token>"
curl -s "$APP_URL/api/health" | tee /tmp/health.json
curl -s -H "Authorization: Bearer $TOKEN" \
     "$APP_URL/api/admin/system/health" | tee /tmp/system-health.json
```

| Signal | Threshold | Action if breached |
| --- | --- | --- |
| `status != "ok"` or a `checks.*` value is not `ok` | any | read Vercel runtime logs for the failing dependency; the requestId in the error chip is the join key |
| AI success rate < 95 % | any | investigate prompt/schema drift; the fallback rate is the real user-visible symptom |
| AI fallback rate > 20 % | any | the AI feature is not working; run the demo on the keyword fallback **honestly** ([09 §9.1](./09_AI_GEMINI_SPECIFICATION.md)) |
| Gemini headroom < 50 % | any | set `GEMINI_AUDIO_ENABLED=false` for the demo |
| Firestore reads > 80 % of the day's allowance by mid-afternoon | any | drop the map listener cap from 150 to 75; do **not** raise the target (`DR-19`) |
| `rateLimits` doc count growing without bound | any | check the TTL policy with `gcloud firestore fields ttls list` |
| Staging objects older than 30 min | > 0 | run `sweep-staging-uploads` |
| Rules hash mismatch | any | **stop.** Redeploy the rules before investigating anything else |
| Any `5xx` in the last hour | any | the demo is at risk; `INTERNAL_ERROR` details are suppressed in the response, so the log is the only place the cause exists |

---

## 12. Troubleshooting

| # | Symptom | Likely cause | Fix | Owner |
| --- | --- | --- | --- | --- |
| 1 | Build fails with a Node version error | Vercel Node version ≠ `engines.node`/`.nvmrc` | Set Project Settings → Node.js Version to the same value, then redeploy. Locally: `nvm use` | build |
| 2 | `npm ci` fails on the server but not locally | the committed `package-lock.json` is out of sync with `package.json` | Regenerate and commit the lockfile: `npm install && git add package-lock.json` | build |
| 3 | Emulator will not start: "address already in use" on 8080/9099/9199 | another emulator or a stale process | `lsof -i :8080` (or `netstat -ano \| findstr 8080` on Windows), kill it, or use `firebase emulators:exec` which uses ephemeral ports. **Change a port in `firebase.json` AND in `tests/helpers/emulator.ts` together** — a one-sided change is a confusing timeout, not a clear error | dev |
| 4 | Every rules assertion fails with `permission-denied` | the harness `projectId` does not match `initializeTestEnvironment`, so rules evaluate against an empty ruleset | Check `projectId` in `tests/helpers/emulator.ts` and `singleProjectMode` | tests |
| 5 | `FirebaseError: [code=permission-denied]` **in the browser** | the deployed rules are older than the code; or the role custom claim is stale; or the query is missing `where('deletedAt','==',null)` | Check the rules hash in `GET /api/admin/system/health`; call `getIdToken(true)`; confirm the query shape | rules |
| 6 | `FirebaseError: [code=permission-denied]` **from a route handler** | the Admin SDK was not used (a client SDK leaked into a server path), or the wrong project id is configured | Assert `FIREBASE_PROJECT_ID` in production; check that `lib/server/firebase-admin.ts` is the only bootstrap ([20 §7 #1](./20_PROJECT_FOLDER_STRUCTURE.md)) | backend |
| 7 | `RefererNotAllowedMapError` / "This page can't load Google Maps correctly" | the deployed host is not in the browser key's HTTP-referrer restriction | Add the exact host (including scheme) to the key restriction in the Google Cloud console. Also add it to Firebase Auth → Authorized domains if sign-in is also failing | ops |
| 8 | Gemini `429 RESOURCE_EXHAUSTED` | the free-tier per-minute or per-day quota is exhausted | This is **expected** and handled: the local guard short-circuits, the deterministic fallback produces the triage, `aiRuns.errorCode = 'AI_QUOTA'`, and the report still succeeds. Reduce `GEMINI_RPM_LIMIT`/`GEMINI_RPD_LIMIT`, or set `GEMINI_AUDIO_ENABLED=false`. **Never** add a paid key mid-demo | AI |
| 9 | Gemini `400` | a bad API key, or an unsupported model name | Verify `GEMINI_API_KEY` and that `GEMINI_MODEL` matches a model the key can reach | AI |
| 10 | `PERMISSION_DENIED` on a Storage upload | the signed URL was issued to a different uid; or the staging path does not match the rules regex; or the bucket's rules were never deployed | Confirm the path matches `staging/{uid}/med_[A-Z2-7]{12}.{ext}`; redeploy `storage.rules`; confirm the token has not expired (`UPLOAD_SIGNED_URL_TTL_SEC`, default 900) | storage |
| 11 | CORS error on the signed-URL `PUT` from the browser | the Storage bucket CORS policy is missing, or the `Content-Type` sent does not match the value the signature covered | Set the bucket CORS to allow `PUT` from `NEXT_PUBLIC_APP_URL`; send exactly the `requiredContentType` returned by `POST /api/uploads/sign`. **A CORS failure is not a rules failure** — the object may have been written | storage |
| 12 | Invalid service-account key: "Invalid key input" | `FIREBASE_PRIVATE_KEY` was pasted with real newlines instead of `\n` escapes, or quotes were stripped by the dashboard | Re-enter it as a single line with literal `\n` and surrounding quotes, exactly as in [21 §3](./21_ENVIRONMENT_VARIABLES.md). Then **redeploy** — env changes are not hot | ops |
| 13 | `NEXT_PUBLIC_*` change has no effect | it is inlined at build time, not read at runtime | Redeploy. If the value is read by a Server Component it is also inlined; if by client code it is inlined into the chunk. Either way: rebuild | build |
| 14 | Vercel cold start times out in the demo | the instance was idle and the first request pays the cold start (§4.3 of [26](./26_PERFORMANCE_REQUIREMENTS.md) budgets cold p95 ≤ 2 500 ms) | "Warm the route" 15 minutes before the demo: sign in as each demo role and load each demo route once. Also report the cold and warm numbers separately rather than hiding the cold start in an average | demo |
| 15 | `GET /api/cron/analytics-daily` returns `401` | `CRON_SECRET` unset or wrong | Set it in the Vercel environment and redeploy. `lib/env.ts` throws at boot in production without it | ops |
| 16 | `429 RATE_LIMIT_EXCEEDED` in development where it should not happen | the dev environment's rate limits were left at production values, or `RATE_LIMIT_TRUST_PROXY` is `false` so every request shares one IP bucket | [21 §4](./21_ENVIRONMENT_VARIABLES.md) documents 5× the production values for dev; set `RATE_LIMIT_TRUST_PROXY=true` on Vercel | backend |
| 17 | `500` with a generic body | a bug; details are suppressed by design | Search Vercel runtime logs by the `requestId` from the error chip. The response body will never contain the cause — that is the correct behaviour, not an omission | backend |
| 18 | Analytics returns `truncated: true` and "partial data" | the range ends less than 48 h ago **and** the live scan hit its 500-read cap | Expected behaviour (FR-116). For a demo, use a range that ends more than 48 h ago so the rollup path serves it | analytics |
| 19 | Duplicate search returns 0 candidates where one exists | the geohash neighbour derivation is wrong (`DR-06`) | Run the `buildGeoCells` unit tests against the reference table (TC-GEO-008). If the offsets cannot be made exact, raise the fan-out to a precision-5 scheme and **re-verify the read budget** | geo |
| 20 | A rules test passes locally and fails in CI | state leaked between tests, or a cached emulator directory | Add `clearFirestore()` in `beforeEach`; the CI emulator is always fresh by design and the emulator data directory is deliberately **not** cached | CI |
| 21 | `AI_OUTPUT_INVALID` reaches a client | the fallback was explicitly disabled by config on the triage route | This is the **only** path where an `AI_*` code reaches a client (TC-FR-029e). Restore the fallback; `FR-029` requires it | AI |
| 22 | Deploy succeeded but the site 404s on every route | a `vercel.json` schema error was silently ignored, or the Output Directory was changed | `vercel build` locally reproduces it. Check `vercel.json` against §9 | build |
| 23 | Google Cloud bill shows a Maps charge | an unrestricted key, or the monthly credit was exceeded, or a crawler hit the site | §10.4, immediately | ops |

### 12.1 The four errors worth reading twice

1. **`FirebaseError: [code=permission-denied]`** is the single most misleading error in this stack, because it has three unrelated causes (stale deployed rules, a stale custom claim, a missing soft-delete filter) and only one of them is a rules bug. Check the rules hash first.
2. **`RefererNotAllowedMapError`** is a *Google Cloud console* problem, not a code problem. The fix is a key restriction, and the reason it appears is almost always a new Vercel host.
3. **An invalid service-account key** almost always means a paste problem, not a rotation problem. The `\n` escaping is the entire difficulty.
4. **A `NEXT_PUBLIC_*` value that "did not update"** is not a cache problem. It is inlined at build time and requires a redeploy. This is the correct Next.js behaviour and it surprises people once.

---

## 13. Cost control

### 13.1 The four alerts that must be armed

| Alert | Where | Threshold | What it protects | Armed when |
| --- | --- | --- | --- | --- |
| **Google Cloud budget** | Google Cloud console → Billing → Budgets | A small amount — 3 × the expected demo-period Maps cost, with alerts at 50 %, 90 %, 100 % | **The only alert in the project that prevents real money being spent** ([02 §7.5](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) | **Before the first deploy.** Not before the demo. Before the deploy. |
| **Firebase quota email** | Firebase console → Usage & billing → the quota notification emails | Google's own thresholds | The daily Firestore operation pool | At project creation |
| **Vercel spend/invoice** | Vercel project → Settings → Billing | Any credit card on file; the alert email is the free part | The Hobby→Pro automatic upgrade, or any paid add-on | At project creation |
| **AI Studio quota** | AI Studio → the project's quota/usage page | `GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT` set **below** the documented quota with ≥ 50 % headroom | Demo-day AI availability | Before the rehearsal |

`DR-05` in [02 §13.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) requires the **exact** Maps monthly credit and the **exact** budget-alert amount to be read from the console and recorded. This document does not assert those numbers, because quotas change and a wrong number in a document is worse than an honest instruction to look.

### 13.2 What to do if a bill appears

Ordered, and calm:

1. **Do not delete anything.** The bill is data. Read it.
2. Identify the line item. It is almost certainly Maps JavaScript API loads (`[26 §8.3](./26_PERFORMANCE_REQUIREMENTS.md)) or Geocoding/Places requests.
3. Identify the key that caused it. Google Cloud console → APIs & Services → Credentials → the key's usage chart shows the referrer or IP. An unrestricted key is the usual cause.
4. **Restrict or delete that key immediately.** Restricting is better than deleting if the app is live; deleting is better if you do not know the cause.
5. Add the referrer/IP restriction from [21 §5](./21_ENVIRONMENT_VARIABLES.md).
6. Confirm the map still works. If it does not, the correct response is the documented degradation: every map surface falls back to `MapListFallback` (FR-085). **The demo still works with the map switched off** — that is why the fallback is a first-class, tested component and not a spinner.
7. Set a hard budget alert at a small amount and record the number in [29](./29_DEMO_SCENARIO.md).
8. Document the incident in the release notes. A project that says "we overran the Maps credit by $X, here is why, here is the alert" is more credible than one that says "it never happened".

### 13.3 Cost lines that are structurally $0

| Line | Why it cannot drift into a cost |
| --- | --- |
| Vercel | Hobby, non-commercial, one project, no add-ons, no paid integrations |
| Firestore | Spark plan; the read budget is an *architectural* constraint, not an optimisation ([26 §5.7](./26_PERFORMANCE_REQUIREMENTS.md)) |
| Storage | Spark; ~3 MB of demo evidence against the stored-data allowance |
| Gemini | Free tier, quota-guarded, fallback always available; **no billing-enabled key exists** |
| Maps | Within the monthly credit, **conditional on the budget alert** |
| CI | GitHub Actions free minutes; `gitleaks` self-hosted |
| Error monitoring | `SENTRY_DSN` unset |
| SMS / WhatsApp | `ENABLE_SMS_NOTIFICATIONS=false`, `ENABLE_WHATSAPP_NOTIFICATIONS=false`; no provider implemented |
| Domain | not purchased (§4.3) |

---

## 14. CI/CD

### 14.1 The workflow

```yaml
# .github/workflows/ci.yml — every stage matches [18 §16.1](./18_TESTING_QA_PLAN.md).
name: ci

on:
  pull_request:
  push:
    branches: [main, develop]

# One run per ref. A second push supersedes the first instead of queueing.
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  NODE_VERSION: '22.x'

jobs:
  verify:
    name: verify (${{ matrix.name }})
    runs-on: ubuntu-latest
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        include:
          - emulator: true
            name: full (emulator)
          - emulator: false
            name: unit-only (no emulator)
    services:
      # Present only for the emulator leg. `services` cannot be conditional, so
      # the unit-only leg simply does not use it — that is exactly the leg's job.
      firebase-emulator:
        image: node:22
        ports: ['9099:9099', '8080:8080', '9199:9199']
        options: >-
          --health-cmd "node -e \"require('net').connect(8080,()=>process.exit(0)).on('error',()=>process.exit(1))\""
          --health-interval 10s --health-timeout 5s --health-retries 6
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
      - run: npm ci
      - name: Secret scan (pre-flight)
        run: gitleaks detect --no-git
      - name: Fixture determinism
        run: npm run check:fixtures
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Format
        run: npm run format:check
      - name: Unit + component
        run: npm run test:unit
      - name: Client-bundle secret scan (static source scan)
        run: npm run check:secrets
      - name: Copy check
        run: npm run check:copy

      # ---- everything below needs the emulator ----
      - name: Integration
        if: matrix.emulator
        run: npm run test:integration
        env:
          FIRESTORE_EMULATOR_HOST: 127.0.0.1:8080
          FIREBASE_AUTH_EMULATOR_HOST: 127.0.0.1:9099
          FIREBASE_STORAGE_EMULATOR_HOST: 127.0.0.1:9199
      - name: Rules
        if: matrix.emulator
        run: npm run test:rules
        env:
          FIRESTORE_EMULATOR_HOST: 127.0.0.1:8080
          FIREBASE_AUTH_EMULATOR_HOST: 127.0.0.1:9099
          FIREBASE_STORAGE_EMULATOR_HOST: 127.0.0.1:9199
      - name: Build
        if: matrix.emulator
        run: npm run build
      - name: Bundle budget
        if: matrix.emulator
        run: npm run check:bundle
      - name: Built-bundle secret scan
        if: matrix.emulator
        run: node --experimental-strip-types scripts/check-secrets.ts --dir .next/static
      - name: Listener check
        if: matrix.emulator
        run: npm run check:listeners
      - name: Route -> Zod schema
        if: matrix.emulator
        run: npm run test:integration -- route-schema
      - name: E2E (chromium)
        if: matrix.emulator
        run: npm run test:e2e -- --project=chromium
      - name: Accessibility
        if: matrix.emulator
        run: npm run test:a11y
      - name: Lighthouse CI
        if: matrix.emulator
        run: npx lhci autorun
      - name: Upload coverage artefact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ matrix.name }}
          path: coverage/
          if-no-files-found: ignore

  deploy-preview:
    name: deploy (preview)
    needs: verify
    if: github.ref != 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      vercel-issues: write
      id-token: write        # only if the project is Vercel-managed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.x', cache: npm }
      - run: npm ci
      # Gated on `needs: verify` — the deploy is a consequence of the gate, not a
      # parallel activity. A red gate means no new preview exists to look at.
      - name: Deploy to Vercel (preview)
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: npx vercel pull --yes --environment=preview --token="$VERCEL_TOKEN"
      - run: npx vercel build --token="$VERCEL_TOKEN"
      - run: npx vercel deploy --prebuilt --token="$VERCEL_TOKEN"
```

### 14.2 Secret handling in CI

| Rule | Detail |
| --- | --- |
| Secrets live in **GitHub Actions secrets**, never in the repository, never in `env:` at the workflow level, never in a `with:` value | a workflow-level `env:` is visible in the Actions log for a child process |
| Only **four** secrets are needed | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`, and optionally `FIREBASE_TOKEN` for a `firebase deploy` from CI |
| `gitleaks` runs **before** any other step that could echo a variable | the cheapest possible leak detector |
| No environment self-hosted runner | a self-hosted runner on a laptop is a supply-chain risk for a project whose whole claim is trust |
| `permissions:` is minimal per job | `contents: read` by default; `id-token: write` only on the deploy job |
| `pull_request` from a **fork** gets no secrets | GitHub does not provide them, which is the correct behaviour; the `gitleaks` and static checks still run |
| Rotation is a Vercel/GitHub operation, not a code change | see §15.1 |

**Should CI deploy the Firebase rules?** For a hackathon: **no.** Rules deploy is a deliberate, human, `--project`-explicit action from a laptop (§7.2), and a CI deploy would put a schema-free database behind an automatic path during the exact window where the team is changing it. The recommendation: keep rules deployment manual until after the demo, then add a gated job that requires an `admin`-approved environment. This is the honest answer and it is a deliberate deviation from "fully automated CD", recorded here so it is a decision and not an omission.

### 14.3 Concurrency groups

| Workflow | Group | `cancel-in-progress` | Why |
| --- | --- | --- | --- |
| `ci.yml` | `ci-${{ github.workflow }}-${{ github.ref }}` | ✔ | a second push supersedes a stale run. Without it, a 25-minute job for an old SHA blocks the branch protection requirement for 25 minutes for nothing |
| `deploy.yml` (if added) | `deploy-${{ github.ref }}` | ✖ | deploys must not be cancelled halfway; a partial promotion is worse than a slow one |
| Nightly matrix | none | ✖ | nightly runs are serial by design so a failure is attributable |

### 14.4 Production deployment policy for the demo

| Policy | Setting | Reason |
| --- | --- | --- |
| `main` → Production | **Automatic** is the default | a deploy per merge is the correct steady state |
| For the demo window, consider **Manual** | Vercel project → Git → uncheck automatic production deployment | a demo-day deploy that goes out mid-rehearsal is the worst possible timing, and a manual promotion is one click |
| Promotion | Vercel dashboard → Deployments → the intended build → Promote to Production | atomic and auditable; this is also the rollback mechanism (§5.6) |
| Instant rollback | same screen, on the last known-good deployment | one click, no rebuild |

> **Recommendation:** set production to **manual** for the duration of the event, and rehearse the promote-and-roll-back pair so both are muscle memory. Write it in [29](./29_DEMO_SCENARIO.md)'s rehearsal checklist.

---

## 15. Operational runbook

### 15.1 Key rotation

| Secret | Cadence | Procedure | Verify |
| --- | --- | --- | --- |
| `FIREBASE_PRIVATE_KEY` (service account) | **90 days** ([21 §6](./21_ENVIRONMENT_VARIABLES.md)) | 1. GCP console → the service account → Keys → **Add key → JSON**. 2. Put the new email + key into the Vercel environment for **every** environment. 3. Redeploy. 4. Run §5.5 V1/V2/V5. 5. **Delete the old key** in GCP. 6. Delete the downloaded JSON from the machine and confirm it is not in a shell history | `GET /api/health` `checks.firestore == "ok"`; §5.5 V5 |
| `CRON_SECRET` | 180 days | Update the Vercel env, redeploy, then `curl` the cron route with the new value | `200` with the new value, `401` with the old |
| `GOOGLE_MAPS_SERVER_KEY` | 90 days | Create a new key with the same IP + API restrictions; swap; delete the old | §5.5 V5 (the reverse geocode populates `placeName`) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | 90 days | Same, plus update the referrer list | §5.5 V11 |
| `GEMINI_API_KEY` | on suspicion | Revoke in AI Studio, create a new key, update the env, redeploy; then read the AI Studio usage chart for the exposure window | §5.5 V9 |
| `IP_HASH_SALT` | **daily** | A scheduled rotation, or rotate-on-deploy. Historic hashes stay pseudonymous by design, so rotating does not invalidate them | — |

> **If a service-account key is ever committed:** revoke it in GCP **first**, then create a new one, then redeploy, then audit `auth.login_failed` and `user.role_change` events for the exposure window, then remove it from history (`git filter-repo` or a platform secret-scanning purge), then rotate anything else that was in the same commit. Order matters: revocation before replacement stops the window from widening.

### 15.2 Purging staged uploads

```bash
# Who is this for: a user who abandoned a report, or a sweep that has not run.
# The server-side job is POST /api/admin/maintenance/sweep-staging-uploads
# with { "reason": "..." } — admin only, individually audited, refused with
# 422 MAINTENANCE_DISABLED unless ENABLE_MAINTENANCE_JOBS=true.
# Direct inspection, for a manual decision:
gsutil ls -r gs://caregrid-ai-prod.appspot.com/staging/ | wc -l
```

| Rule | Value |
| --- | --- |
| What counts as orphaned | an object under `staging/` older than `STAGING_UPLOAD_SWEEP_MIN` (default 30 minutes) that is not referenced by any `incidentReports.media[].storagePath` |
| How often | the daily cron slot is taken by the rollup, so: **admin-triggered**, plus a manual sweep on demo day |
| How to tell the sweep is broken | `GET /api/admin/system/health` reports staging objects older than 30 min > 0 |
| What the sweep must never do | delete an object under `incidents/` or `quarantine/` |

### 15.3 Expiring stale dispatches

| Item | Value |
| --- | --- |
| What is stale | `dispatches/{id}.status == 'active'` with `expiresAt` in the past, and no `acceptedAt` |
| Where | `POST /api/admin/maintenance/sweep-expired-dispatches` with a `reason` |
| What it does | closes the dispatch as `expired`, decrements `responders.activeIncidentCount`, restores `responders.status` when it reaches 0, returns the incident to `verified`, emits `responder_unavailable` to the dispatchers who offered it, and audits `incident.unassign` |
| Why it matters | an unexpired-but-accepted dispatch is fine; an expired `active` dispatch silently blocks the next assignment with `409 ALREADY_ASSIGNED`, which reads as a bug and is really hygiene |
| Idempotency | it must be safe to run twice. The claim transaction already reads `expiresAt` inside the transaction, so a claim cannot succeed on an expired dispatch (TC-FR-069d) |

### 15.4 Recomputing analytics

```bash
# Daily rollup
POST /api/analytics/recompute  { "target": "daily", "from": "2026-09-19", "to": "2026-09-26" }   # admin, 5/hour

# Risk zones
POST /api/analytics/recompute  { "target": "risk" }                                                 # admin, 5/hour
```

| Item | Value |
| --- | --- |
| Why it is manual | Vercel Hobby has one cron per day and the rollup owns it ([02 §8.6](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) |
| What it writes | `analyticsDaily/{YYYY-MM-DD}` with `completeness: 'partial' \| 'final'`; `riskZones/{zoneId}` with its `params` (FR-115) |
| How to check it worked | `GET /api/analytics?include=totals,category,trend` and read `range.source`; a range ending more than 48 h ago must report `source: "rollup"` |
| The honest answer about "today" | it cannot be final until tomorrow. `GET /api/analytics` falls back to a bounded live scan for ranges ending less than 48 h ago (FR-116), so no user sees a hole |

### 15.5 Purging closed locations

```bash
POST /api/admin/maintenance/purge-closed-locations  { "reason": "NFR-028 90-day retention" }
```

| Rule | Detail |
| --- | --- |
| Trigger | an incident `closed` for longer than `config.retention.locationPurgeDays` (default 90, NFR-028) |
| What it removes | `geo`, `geoCells`, and `locationText` |
| What it keeps | the incident, its `statusHistory`, its `auditLogs` row, its category, urgency, resolution, and `placeName` (the coarse label) |
| What it is **not** | a data purge. It removes the *precise* location, not the record |
| Admin extension | `config.retention.locationPurgeDays` may be raised by an admin; the change is audited as `config.update` |
| Guard | refused with `422 MAINTENANCE_DISABLED` unless the feature flag is on; the action is always audited |
| Test | TC-INT-006: a closed incident 91 days old has `geo` purged, `placeName` retained, the action audited |

---

## 16. Honest limitations

These are not hedges. Each one is a real property of the deployment, and the project states it rather than discovering it in front of a judge.

| # | Limitation | Consequence | Mitigation actually in place |
| --- | --- | --- | --- |
| 1 | **No WAF** | no L7 DDoS protection, no bot management, no geo-blocking. A free-tier project cannot buy this | rate limits on every write route (NFR-016), `auth.login_failed` capped at 10/IP/hour (FR-135), the `FirebaseError` path tested |
| 2 | **No on-call** | if production breaks at 3 a.m., nobody is paged and nothing detects it | documented degradation for every optional dependency; `GET /api/health` for a manual check; a scheduled digest (§11.3). NFR-011 is a design target, not an SLO, and is **not gated** ([26 §10.3](./26_PERFORMANCE_REQUIREMENTS.md)) |
| 3 | **Single region** | a Firestore regional outage is a total outage; there is no failover region and multi-region roughly doubles per-operation cost | none, deliberately. Single-city, single-region is a deliberate ADR ([02 §4.4](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)). Recorded as a Horizon-2 item |
| 4 | **Free-tier quotas are not contractual** | Firebase, Google, and Vercel can change or withdraw quotas without notice and without a changelog aimed at hobby projects | every design has a degraded path: the AI fallback, the map list fallback, the read budget. Never a "we will not be affected" claim |
| 5 | **Vercel Hobby non-commercial terms** | a later commercial deployment is not permitted on this plan without a paid one | the submission is marked non-commercial (`DR-04`); the limitation is stated in the README |
| 6 | **No 99.9 % SLA** | any claim of availability on a free tier is dishonest | NFR-011's 99.5 % is recorded as "design target, best effort" and is explicitly **not** a CI gate. Provider status is recorded at T−1 h and T+1 h instead |
| 7 | **Backups are exports, not PITR** | a disaster loses everything since the last export (up to a week, or since the pre-demo export) | the seed script makes a demo-scale database reconstructible. Stated, not papered over |
| 8 | **`FUNCTION MAX DURATION`** | see §17 `DEC-01`. The single unresolved item that can break the demo's core narrative | three options analysed, one recommended, one pre-committed fallback |
| 9 | **No automated rules deployment in CI** | a rules change is a human action with a human error mode | `--project` is mandatory, `--dry-run` is mandatory, the deployed-hash check is a release gate (TC-RULES-026) |
| 10 | **Secrets are in one place** | the Vercel project holds every production secret. A Vercel account compromise is a full compromise | 90-day rotation, minimal `permissions:`, a `gitleaks` gate, and the documented "revoke first" leak procedure (§15.1) |
| 11 | **No CDN caching of data** | every authenticated response is `no-store` by design | correct for privacy; it means latency is paid on every request, and that is the trade ([26 §14.2](./26_PERFORMANCE_REQUIREMENTS.md)) |
| 12 | **Preview deployments are real applications** | a preview pointed at staging is a copy of production with staging credentials | deployment protection is on (§8.6) |
| 13 | **Region choice is irreversible** | a wrong Firestore region means a new project and a data migration | the decision is made *before* project creation (§4.1), and the two regions are recorded in the release notes |
| 14 | **The Google Cloud budget alert is the only cost control** | if the alert email is not watched, an overrun is silent | the demo-day check reads the billing page before and after the rehearsal ([18 §18.2](./18_TESTING_QA_PLAN.md) items 19–20), and the map can be turned off entirely with a tested fallback |

---

## 17. `DECISION REQUIRED` register

| # | Question | Why it is open | Proposed resolution | Blocks | Owner / when |
| --- | --- | --- | --- | --- | --- |
| **DEC-01** | **What is the maximum function duration on the actual Vercel plan, and does it exceed the ~21 s worst-case request budget?** ([21 §8](./21_ENVIRONMENT_VARIABLES.md) §8 flags a possible 10 s Hobby cap, which is **shorter than** the 20 s `GEMINI_TIMEOUT_MS`.) | `POST /api/incidents` runs the Gemini call inline (FR-020). If the platform kills the function before the fallback fires, the client sees a 5xx and **FR-029 is violated**: reporting fails because the AI failed | See §17.1 for the three options. **Recommended: Option A with A′**, with Option B pre-built as the fallback | FR-020, FR-029, NFR-004, the demo's core narrative | **Before the first deploy.** Full analysis below |
| **DEC-02** | Which Vercel region and which Firestore region? | The Firestore location is fixed at database creation. `bom1`/`asia-south1` (Mumbai) is the candidate, unconfirmed | Decide the city first, then the region, then create the project. Read the actual location back and record it (§4.2) | NFR-001, NFR-003, the first deploy | **Before creating the Firebase project** |
| **DEC-03** | Custom domain, or the `*.vercel.app` subdomain? | A domain is a real recurring cost and invalidates the strict $0 claim | Use `*.vercel.app`. State the URL on the submission form. If a judge requires a domain, it is the entrant's budget, not the project's | NFR-026, [02 §7 line 2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) | Before the submission |
| **DEC-04** | Is Vercel Hobby acceptable for a hackathon submission? | Its terms cover personal and non-commercial use. That matches, but must be read | Yes, with the submission clearly marked non-commercial | NFR-026 | Before the submission |
| **DEC-05** | What is the Google Maps monthly credit, and what exact budget-alert amount? | The credit is what makes the Maps line $0 | Read both from the console, arm the alert, record the number in [29](./29_DEMO_SCENARIO.md) | NFR-026, [02 §7.5](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) | **Before the first deploy** |
| **DEC-06** | Which `N` for the Maps daily map loads is acceptable, and who watches the budget email on demo day? | An unattended email is not a control | Nominate a named person for the demo window; that person reads the billing page at T−1 h and T+1 h | NFR-026 | Before the demo |

### 17.1 `DEC-01` — the function-duration problem, in full

**The constraint, stated precisely.** From [26 §4.2](./26_PERFORMANCE_REQUIREMENTS.md):

```
POST /api/incidents total request budget, including AI
  p95                     ≤ 9.0 s
  hard ceiling            ~21 s      (app 800 ms + AI 20 000 ms + overhead)
target function duration 25 000 ms  (the triage route)
```

And `export const maxDuration = 25` is set on `app/api/incidents/route.ts`. **The platform clamps that value to the plan's maximum.** If the plan maximum is below the hard ceiling, the function is killed mid-request, and the client sees a gateway error rather than a `201` with a fallback triage — which is a direct FR-029 violation and a demo-ending failure.

**VERIFY first, decide second.** The correct first action is to read the plan's documented maximum function duration in the Vercel dashboard or the plan documentation. This document does **not** assert a number, because plan limits change. If the verified value is **≥ 25 s**, Option A is available and `DEC-01` closes with a one-line note.

#### Option A — keep synchronous triage, verify the plan limit is ≥ 25 s

**What it is.** No change to the architecture. `POST /api/incidents` continues to run triage inline and returns a fully triaged incident, which is what [08 §3.1](./08_API_SPECIFICATION.md) specifies and what FR-020 requires ("triage on every accepted report **before** the incident becomes visible in the dispatcher queue").

**What must be true.** The plan's maximum function duration ≥ 25 s.

**What it costs.** Nothing in code. The only cost is the risk that the limit is lower than documented, or is lowered later.

**What it buys.** The demo narrative is intact with **zero** ambiguity: the citizen presses submit, waits, and the incident arrives at the dispatcher *already triaged*. There is no "triaging…" state for a judge to wonder about, and no second request for a judge to notice is missing.

**`A′` — the safety net inside Option A.** Whatever the verified limit is, make the AI timeout a function of the remaining budget rather than a constant:

```ts
// services/ai/gemini.ts — the shape, not the final code
const FUNCTION_BUDGET_MS = 25_000;                 // matches maxDuration
const SAFETY_MARGIN_MS  = 3_000;                   // serialise, audit, notify, respond
const APP_BUDGET_MS     = 1_200;                   // [26] §4.1 excludes AI: p95 800 ms

const effectiveAiTimeout = Math.min(
  Number(env.GEMINI_TIMEOUT_MS),                  // the documented 20 000 ceiling
  FUNCTION_BUDGET_MS - SAFETY_MARGIN_MS - APP_BUDGET_MS,
);

// If the plan limit turns out to be 10 s, this evaluates to ~5 800 ms:
// the fallback fires, `201` is returned, and FR-029 holds — on a 10 s plan.
```

This is worth building **regardless** of which option is chosen, because it is the difference between "the platform killed the request" and "the application degraded gracefully". It is also the honest engineering answer: a hard-coded timeout inside a platform limit is a bug waiting for a plan change.

#### Option B — create the incident synchronously, then triage on a second client-triggered request

**What it is.** `POST /api/incidents` writes the incident with `triageSource: 'pending'` and returns `201` immediately. The client (or the dispatcher console, via a listener) then issues `POST /api/incidents/{id}/triage`, which runs the AI call and updates the incident. The response is no longer blocked by the model.

**What it costs — and this is the real cost, not the code:**

| Cost | Detail |
| --- | --- |
| **An API contract amendment** | [08 §3.1](./08_API_SPECIFICATION.md) §3.1 currently specifies that the `201` body contains the triaged incident. `triageSource: 'pending'` is **not in the schema** ([07 §4.1](./07_DATABASE_SCHEMA.md) lists `ai\|fallback\|manual`). Both documents must be amended **first** — [07](./07_DATABASE_SCHEMA.md) and [08](./08_API_SPECIFICATION.md) are the anchors, and per [20 §7 #16](./20_PROJECT_FOLDER_STRUCTURE.md) the code is wrong if it differs |
| **FR-020 must be amended** | "before the incident becomes visible in the dispatcher queue" is no longer true, because the incident is created and visible first. The requirement becomes "triage must complete before the incident may be *dispatched*" — which is a weaker, different guarantee, and weaker exactly where the safety argument lives |
| **A visible untriaged window in the demo** | a judge watching the dispatcher queue sees an incident sit at `pending`. That invites the question "why is it not triaged yet?", and answering it costs demo seconds that are not in the script |
| **A new failure mode** | if the second request never happens (tab closed, offline, a client that does not retry), the incident stays untriaged. A durable queue would be needed — and [02 §6.12](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) **explicitly rejects** a queue library. The honest version is a client retry plus a dispatcher-visible "triage pending" state, which is a new UI state with its own test burden |
| **A second round trip** | the citizen's submission becomes two requests; NFR-003 (≤ 800 ms p95 for `POST /api/incidents`) becomes easy, which is a genuine win, but the *user-visible* time-to-triage gets worse and more variable |
| **A `triageSource: 'pending'` state to test** | one more enum value across validators, config, badges, analytics (`aiFallbackCount`), and the AI panel |

**What it buys.** The AI call moves off the critical path entirely, which removes the function-duration constraint and shortens NFR-003 substantially. It is also the architecturally cleaner long-term shape.

#### Option C — move to a paid Vercel plan

**What it is.** Upgrade to a plan whose maximum function duration is comfortably above 25 s.

**What it costs.** **It ends the $0 claim.** NFR-026 is `$0`, [02 §7](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) is a line-by-line $0 argument, and the free-tier posture is one of the project's most defensible properties. A paid plan also changes Vercel Hobby's non-commercial terms, which are currently *satisfied*.

**What it buys.** Nothing the project needs. Function duration is the only binding constraint, and Option A′ handles it inside a $0 budget.

### 17.2 Recommendation

> **Adopt Option A with A′ implemented unconditionally. Pre-build Option B as the committed fallback. Reject Option C.**

| | |
| --- | --- |
| **Primary** | **Option A.** Verify the plan's maximum function duration is ≥ 25 s. If yes, the problem does not exist, `DEC-01` closes, and nothing in the architecture changes. |
| **Always** | **A′.** Make the AI timeout derive from the function budget. This is correct engineering independent of the decision, and it means that if the plan limit is lower than documented, the application still satisfies FR-029 on that plan instead of failing. |
| **Fallback, pre-built** | **Option B**, in this form: `POST /api/incidents` gains an optional `triageMode: 'sync' \| 'deferred'` field; `'sync'` is the default and the current behaviour. The *deferred* path — `triageSource: 'pending'`, an immediate `201`, and a client-triggered `POST …/triage` — is implemented and tested **behind that flag**, with the `triageSource` enum value added to [07](./07_DATABASE_SCHEMA.md) and the response shape documented in [08](./08_API_SPECIFICATION.md). If `DEC-01` resolves badly, the fallback is a one-word env change, not a refactor. |
| **Why B is pre-built but not primary** | B costs an anchor-document amendment and weakens FR-020's guarantee. Paying that cost speculatively to protect against a risk that A′ already bounds is the wrong trade. Paying it *after* the verification result is known, if the result is bad, is the right one. |
| **Rejected** | **Option C**, because it converts the project's single strongest claim into its weakest. |
| **Deadline** | The verification must complete **before the first deploy**, and **before the first time the demo is rehearsed end to end**. A `DEC-01` that is still open at T−2 h is a `DEC-01` that will be discovered on stage. |

---

**End of document 19.** Amendments must reference the anchor document they change, and must not introduce an environment variable, endpoint, script, collection, or file path that is not already defined in [07](./07_DATABASE_SCHEMA.md), [08](./08_API_SPECIFICATION.md), [20](./20_PROJECT_FOLDER_STRUCTURE.md), or [21](./21_ENVIRONMENT_VARIABLES.md).

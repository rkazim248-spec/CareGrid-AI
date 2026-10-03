# CareGrid AI

**Emergency and community-aid routing for urban crises.**

Citizen reports an incident by text, photo, or voice. Gemini extracts a structured triage
suggestion as strict JSON. A dispatcher reviews a live queue and assigns a nearby verified
responder, who moves the incident through a real-time lifecycle. **The AI never dispatches
anyone. A human always does.**

> **CareGrid AI is a hackathon demonstration system.** It is not a certified emergency
> dispatch system, it has no SLA, and it must not be presented as a substitute for a public
> emergency number. In a real emergency, contact your local emergency services first.

---

## Table of contents

- [Problem](#problem)
- [Solution](#solution)
- [Key features](#key-features)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [AI usage](#ai-usage)
- [Database](#database)
- [Security](#security)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Demo instructions](#demo-instructions)
- [Current status and known limitations](#current-status-and-known-limitations)
- [Further documentation](#further-documentation)

---

## Problem

During an urban emergency — a road accident, a fire, a flood, a medical event — the gap
between *something is wrong* and *the right person is on the way* is where most harm
occurs. Traditional emergency systems have three structural weaknesses:

1. **Telephone triage puts a human between the public and the responder queue.** During a
   mass-casualty event, call volumes exceed human capacity, so reports queue rather than
   route. Text channels help but are unstructured.
2. **Duplicate reports fragment the picture.** The same accident generates dozens of
   submissions from different witnesses. Handled naively, one event becomes forty
   "incidents" and responders are dispatched to the same corner repeatedly while a
   genuinely different emergency nearby goes unattended.
3. **Local knowledge does not travel.** A responder who knows that a particular underpass
   floods is not in the system when a report arrives there at 02:00.

## Solution

CareGrid AI compresses the path from report to responder, while keeping a human in the
decision loop:

- **Structured intake.** Text, image, and voice are normalised into one incident shape.
- **AI-assisted triage, not AI triage.** Gemini proposes a category, urgency, summary, and
  confidence. Its output is schema-validated and bounded; it cannot dispatch, cannot change
  incident state, and cannot authorise anything.
- **Deterministic duplicate suppression.** Nearby reports in a time window are scored on
  geospatial proximity plus text similarity, so one event stays one incident.
- **Human dispatch with local context.** A dispatcher sees a live queue with candidates
  ranked by distance, verified status, and current capability — then assigns.
- **Real-time lifecycle.** `assigned → en_route → on_scene → resolved`, with every
  transition appended to an immutable history.
- **Every privileged action audited**, including AI confidence scores, so a bad
  recommendation can be traced after the fact.

---

## Key features

| Area | Feature |
| --- | --- |
| **Intake** | Text report, image evidence, voice note, GPS or manual map pin |
| **AI** | Gemini triage → strict JSON schema, confidence scoring, human review threshold |
| **Safety** | Prompt-injection sanitisation, PII redaction, deterministic fallback when AI is unavailable |
| **Evidence** | Signed uploads, server-side MIME sniffing, size/duration/dimension limits, quarantine on mismatch |
| **Duplicates** | Geohash + radius search scored against text similarity within a lookback window |
| **Dispatch** | Candidate ranking, assignment, accept/decline, expiry, notification fan-out |
| **Tracking** | Realtime status lifecycle, append-only transition history, public tracking code |
| **Operations** | Dispatcher dashboard, incident queue, filters, responder roster |
| **Analytics** | KPI grid, trend/category/response-time charts, risk-zone map |
| **Admin** | User role management, verification queue, audit review, retention settings |
| **Platform** | Role-gated routes, rate limiting, CSRF origin checks, audit logging, structured errors |

---

## Architecture

```
                  ┌─────────────┐
                  │   Citizen   │  text · photo · voice
                  └──────┬──────┘
                         │ HTTPS
                         ▼
                  ┌─────────────┐
                  │   Next.js   │  App Router · React 19 · Tailwind 4
                  │  (frontend) │
                  └──────┬──────┘
                         │ Firebase ID token
                         ▼
             ┌───────────────────────┐
             │   Next.js API Routes  │  withRequest: CSRF → rate limit →
             │     /app/api/**       │  auth → validation → capability → handler
             └───────┬───────────┬───┘
                     │           │
        ┌────────────▼───┐   ┌───▼──────────────┐
        │  Firebase Auth │   │   AI Providers   │
        │  (verify ID    │   │ Gemini · Assembly│
        │   token)       │   │ AI · Mapbox ·    │
        └────────────┬───┘   │ ImageKit · Twilio│
                     │       └───┬──────────────┘
        ┌────────────▼───────────▼──────────────┐
        │            Firebase                  │
        │  Firestore (Admin SDK, server-only)   │
        │  Storage · Realtime listeners         │
        └──────┬─────────────────────┬─────────┘
               │                     │
    ┌──────────▼─────────┐  ┌────────▼────────┐
    │  Incident Engine   │  │    Dispatch     │
    │  duplicate scoring │→ │  candidate rank │
    │  status machine    │  │  assign/accept  │
    └──────────┬─────────┘  └────────┬────────┘
               │                     │
               │              ┌──────▼──────┐
               │              │  Responder  │  accept · en_route · on_scene
               │              └──────┬──────┘
               │                     │
               └──────────┬──────────┘
                          ▼
                  ┌───────────────┐
                  │   Analytics   │  daily aggregates · response times
                  │               │  category mix · risk zones
                  └───────────────┘
```

### Request pipeline

Every mutating route runs through one wrapper, so ordering is uniform and testable:

```
withRequest(handler)
  → CSRF origin check        (state-changing methods only)
  → rate limit               (IP + authenticated user)
  → requireUser              (verify Firebase ID token)
  → parameter + body validation   (Zod)
  → requireCapability        (role/permission gate)
  → handler
```

`GET /api/health` is the only route reachable without authentication.

### Key directories

| Path | Contents |
| --- | --- |
| `app/` | App Router pages and API routes |
| `features/` | UI components grouped by domain (reporting, dispatch, incidents, analytics, admin…) |
| `services/` | Domain logic — AI, dispatch, uploads, geo, notifications, analytics, admin |
| `lib/` | Shared utilities, Firebase clients, error funnel, validation schemas |
| `firestore.rules` | Client-side authorization boundary |
| `storage.rules` | Upload authorization boundary |
| `scripts/` | `security-check.cjs`, `secret-scan.cjs` |
| `tests/` | Vitest suites, including `tests/unit/security/` |

---

## Technology stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15.5 (App Router), React 19, TypeScript 5.9 |
| Styling | Tailwind CSS 4, Radix UI primitives, `class-variance-authority` |
| Icons | `lucide-react` |
| Charts | Recharts |
| Validation | Zod 4 |
| Forms | React Hook Form + `@hookform/resolvers` |
| Backend / DB | Firebase 11 — Auth, Firestore, Storage, Realtime |
| Server SDK | `firebase-admin` 13 |
| AI | `@google/genai` 2.24 (Gemini), AssemblyAI (REST) |
| Maps | `mapbox-gl` 3.32, Google Maps (REST), `ngeohash` |
| Media | ImageKit (REST) |
| Notifications | Twilio (REST), `sonner` for in-app toasts |
| Testing | Vitest 3 |
| Lint / format | ESLint 9, Prettier 3 |
| Runtime | Node 22.11.0 (`.nvmrc`), deploys to Vercel |

---

## AI usage

Gemini is used for exactly one job: turning messy human language into a structured triage
suggestion. It does not decide anything.

**Gemini produces** (subject to schema validation):
`category` · `urgency` · `summary` · `confidence` · `flags`

**Deterministic code owns** everything else:
urgency clamping and escalation · duplicate scoring · responder ranking · assignment ·
status transitions · authorization · every write to Firestore.

**The AI cannot:**
- create, dispatch, or assign anything
- change incident status
- authorize a request or elevate a role
- select a responder
- widen an upload's allowed type or size
- bypass a rate limit

Its output is treated as **untrusted input**. Every model response passes through
`sanitiseForModel()` on the way in and `aiTriageOutputSchema.safeParse()` on the way out. A
response that fails validation is discarded and replaced by the rule-based fallback, never
by a partial or best-effort parse. A low confidence score routes the case to human review.

See [`docs/09_AI_GEMINI_SPECIFICATION.md`](./docs/09_AI_GEMINI_SPECIFICATION.md).

---

## Database

Firestore, accessed **server-side through the Admin SDK**. The browser never reads or writes
incident data directly with elevated privilege.

| Collection | Purpose | Client-writable |
| --- | --- | --- |
| `users/{uid}` | Identity, role, account state | Own profile only; **role is server-owned** |
| `profiles/{uid}` | Display name, preferences | Own only |
| `incidents/{id}` | The incident record | Limited field sets per role |
| `incidents/{id}/reports/{id}` | Citizen reports | Append-only |
| `incidents/{id}/statusHistory/{id}` | Status transitions | **Server only** |
| `responders/{uid}` | Volunteer profile, availability | Own limited fields; **verification is admin-only** |
| `responderLocations/{uid}` | Live coordinates | Own only |
| `dispatches/{id}` | Assignment records | Server-owned |
| `notifications/{id}` | In-app notifications | Recipient may mark read only |
| `evidence/{id}`, `aiReviews/{id}` | Uploads, AI audit | Server only |
| `auditLogs/{id}` | Privileged action trail | **Server only — deny-all to clients** |
| `analyticsDaily/{day}` | Aggregates | Server only |
| `riskZones/{id}`, `config/{id}`, `rateLimits/{key}` | Configuration | Server only |

Composite indexes are declared in `firestore.indexes.json`; the client SDK is denied direct
access to server-owned collections, so a browser listener cannot read them at all.

---

## Security

| Control | Implementation |
| --- | --- |
| **Authentication** | Firebase ID token verified on every protected route. Authoritative role lives in Firestore `users/{uid}.role`; token claims are treated as a hint, and a *present but conflicting* claim is rejected and audited. Missing claims are tolerated to avoid lockout on first login. |
| **Authorization** | Two independent layers: capability gates in the API, and `firestore.rules` for the client SDK. `allowMissingUserDoc` is restricted to `POST /api/me/bootstrap`. |
| **Server-side provider keys** | Gemini, AssemblyAI, Twilio, and the Firebase service account are **server-only** environment variables with no `NEXT_PUBLIC_` prefix, so they are never inlined into the client bundle. |
| **Uploads** | Three-step: sign (server assigns path, kind, MIME, size cap) → direct PUT to Storage → finalize re-validates actual bytes by **sniffing magic numbers**, not by trusting the declared type. A mismatch quarantines rather than deletes. |
| **Rate limiting** | Per-IP and per-user windows on every metered endpoint; identity keyed on the verified token, never on a client-supplied header. |
| **CSRF** | Same-origin enforcement on state-changing methods, ahead of authentication. |
| **Audit logs** | Every privileged action is written server-side. `auditLogs` is **deny-all to clients** — an earlier `allow create: if isSignedIn()` permitted audit forgery and has been fixed. |
| **AI output validation** | Schema-validated, then clamped. Model output is data, never authority. `assertNoAiResultInBody()` rejects caller-supplied AI/review fields. |
| **Duplicate handling** | De-duplication is scored, never destructive. Merging is a human decision, so a false positive cannot destroy a report. |
| **Secret scanning** | `npm run secrets:scan` scans the repository with redacted SHA-256 fingerprints so findings can be de-duplicated without printing secret material. |

Deeper material: [`docs/10_AUTHORIZATION_SECURITY.md`](./docs/10_AUTHORIZATION_SECURITY.md),
[`docs/24_THREAT_MODEL_SECURITY.md`](./docs/24_THREAT_MODEL_SECURITY.md).

---

## Setup

### Prerequisites

- **Node.js 22.11.0** (see `.nvmrc`) — `nvm use`
- **npm 10+**
- A **Firebase project** with Auth, Firestore, Storage, and Realtime Database enabled
- API keys for the providers you intend to exercise (Gemini, Mapbox, ImageKit, AssemblyAI)

```bash
git clone <your-repository-url>
cd CareGrid-AI
nvm use
npm install
cp .env.example .env.local     # then fill in your own values
```

### Creating Firebase credentials

1. Firebase console → **Project settings** → **Service accounts** → *Generate new private key*.
2. Place the downloaded JSON **outside the repository**. Do not commit it.
3. Copy its fields into `.env.local`:

```dotenv
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

> Keep the key quoted with literal `\n` escapes, and never remove the trailing `\n`.

The `NEXT_PUBLIC_FIREBASE_*` values are your web app config. They are **designed** to be
public — Firebase identifies the project through them and security comes from
`firestore.rules` plus server-side authorization. Only the Admin SDK credentials above are
secret.

---

## Environment variables

Full annotated list: [`docs/21_ENVIRONMENT_VARIABLES.md`](./docs/21_ENVIRONMENT_VARIABLES.md).
Template: [`.env.example`](./.env.example). The essentials:

| Variable | Purpose | Public? |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini triage | **No** — server only |
| `GEMINI_MODEL` | Model id | No |
| `AI_MOCK_MODE` | Use deterministic triage without calling Gemini | No |
| `AI_CONFIDENCE_REVIEW_THRESHOLD` | Confidence below which a human must review | No |
| `MAPBOX_ACCESS_TOKEN` / `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | Map rendering | Token is public; restrict by domain |
| `NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY` | Client-side upload signing | Yes (restricted) |
| `IMAGEKIT_PRIVATE_KEY` | Server-side signing | **No** |
| `ASSEMBLYAI_API_KEY` | Voice transcription | **No** |
| `TWILIO_*` | SMS / WhatsApp | **No** |
| `FIREBASE_*` | Admin SDK | **No** |
| `NEXT_PUBLIC_FIREBASE_*` | Web app config | Yes (by design) |
| `IP_HASH_SALT` | Salts rate-limit identifiers before storage | **No** |
| `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_STORE` | Rate-limit tuning | No |
| `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_AUDIO_BYTES`, `UPLOAD_SNIFF_BYTES` | Upload limits | No |
| `SEED_DEMO_PASSWORD` | Demo account password | **No — never commit** |

**Never commit `.env.local`, service-account JSON, or private keys.** `.gitignore` covers
them; `npm run security:check` and `npm run secrets:scan` verify that they stay out.

---

## Local development

```bash
npm run dev            # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run format` | Prettier write |
| `npm run security:check` | Security assertions over the codebase and config |
| `npm run secrets:scan` | Repository-wide secret scan |
| `npm run verify` | typecheck → lint → test → security → secrets → build |

> **Note:** Development uses `.next-dev`; production builds use `.next`, so a build does not
> replace the normal development output. If you run more than one dev server at a time, give
> each a distinct `NEXT_DEV_DIST_DIR` value to prevent their webpack chunks from colliding.

`security:check` deliberately **fails closed** when it cannot verify something. In an
environment without `git` installed it reports the three tracking checks as failures rather
than assuming they pass.

---

## Deployment

Targets **Vercel** (see [`vercel.json`](./vercel.json) and
[`docs/26_PRODUCTION_DEPLOYMENT.md`](./docs/26_PRODUCTION_DEPLOYMENT.md)).

```bash
npm i -g vercel
vercel link
vercel env add GEMINI_API_KEY production      # and the rest of the server-only keys
vercel --prod
```

Deployment checklist:

1. Node version set to **22.11.0**.
2. Every server-only variable configured in the Vercel project — an unset `GEMINI_API_KEY`
   degrades to mock mode rather than failing loudly, so verify it explicitly.
3. Firebase **authorized domains** updated to include the production hostname.
4. `NEXT_PUBLIC_APP_URL` set to the production origin so CSRF origin checks pass.
5. Mapbox / ImageKit keys restricted to that hostname.
6. Firestore and Storage rules deployed:
   ```bash
   npx firebase deploy --only firestore:rules,firestore:indexes,storage
   ```
7. Post-deploy smoke test: sign in, submit a report, confirm triage returns, open the map,
   upload one image, assign a responder, advance the status.

---

## Demo instructions

A walkthrough scenario is in [`docs/29_DEMO_SCENARIO.md`](./docs/29_DEMO_SCENARIO.md).

**Demo accounts.** Demo credentials are **not** committed. Create them locally, then share
them with judges out of band:

```dotenv
SEED_DEMO_PASSWORD=<choose a local-only password>
ALLOW_SEED=true
```

Three accounts are needed: one `citizen`, one `responder` (verified), one `dispatcher`.
Passwords must never appear in this repository, in a commit, in a screenshot, or in a demo
video.

**Demo data.** Use only synthetic records. No real names, phone numbers, home addresses, or
medical details. The seeded fixtures use clearly fictional values.

---

## Current status and known limitations

This section is deliberately explicit, because a demo that overstates itself fails when a
judge tests it.

### Known gaps

- **Incident creation is not wired to the API.** There is no `POST /api/incidents` route.
  The report form's submit handler waits on a timer and calls its success callback without
  sending a request (`features/reporting/report-form.tsx`). The submit path is UI-complete
  but does not persist an incident, so the downstream dispatch lifecycle cannot be exercised
  from the reporting screen alone.
- **Duplicate detection is not called by any route or component.** `services/geo/find-duplicates.ts`
  is implemented and unit-tested but has no production caller.
- **Voice reporting is not wired.** `services/speech/speech-to-text.ts` is implemented and
  tested but unreferenced, and `ENABLE_VOICE_REPORTING` is not read by the reporting UI.
- **The admin overview is backed by mock data** (`@/lib/mock-data`). It is labelled as such
  in the UI via `DemoDataBadge`, but it is not API-backed.
- **`firestore.rules` has three open findings**, pinned by tests in
  `tests/unit/security/firestore-rules.test.ts`: three `list` rules reference `resource.data`
  (unevaluable by Firestore, so they deny rather than leak); the `/incidents` dispatcher
  update branch has no field allow-list; and one redundant `allow read: if false` clause
  restricts nothing.
- **Rules are verified statically, not executed.** No Firestore emulator is configured, so
  the rule tests assert rule *text*, not rule *behaviour*.

### Not yet done

- No production deployment has been performed; there is no live URL.
- No CI pipeline is configured.
- `security:check` reports 133/136; the three failures are all because `git` is unavailable
  in the current environment, which makes tracking status unverifiable.

---

## Further documentation

| Document | Contents |
| --- | --- |
| [`docs/DOCUMENTATION_INDEX.md`](./docs/DOCUMENTATION_INDEX.md) | Index of all documents and when to read each |
| [`docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md`](./docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md) | Requirements, personas, user stories |
| [`docs/03_SYSTEM_ARCHITECTURE.md`](./docs/03_SYSTEM_ARCHITECTURE.md) | Full architecture |
| [`docs/08_API_SPECIFICATION.md`](./docs/08_API_SPECIFICATION.md) | Endpoint reference |
| [`docs/09_AI_GEMINI_SPECIFICATION.md`](./docs/09_AI_GEMINI_SPECIFICATION.md) | AI triage design |
| [`docs/10_AUTHORIZATION_SECURITY.md`](./docs/10_AUTHORIZATION_SECURITY.md) | Roles, permissions, authorization |
| [`docs/21_ENVIRONMENT_VARIABLES.md`](./docs/21_ENVIRONMENT_VARIABLES.md) | Every variable, annotated |
| [`docs/24_THREAT_MODEL_SECURITY.md`](./docs/24_THREAT_MODEL_SECURITY.md) | Threat model |
| [`docs/29_DEMO_SCENARIO.md`](./docs/29_DEMO_SCENARIO.md) | End-to-end demo walkthrough |
| [`docs/27_DEPENDENCY_AUDIT.md`](./docs/27_DEPENDENCY_AUDIT.md) | Dependency risk triage |

---

## License

Hackathon project. All rights reserved.
# CareGrid AI

**Emergency and community-aid routing for urban crises.**

CareGrid AI turns unstructured, panic-typed citizen reports into a verified, geolocated,
de-duplicated incident queue that responders and dispatchers can act on in seconds.

```
Citizen Report → AI Triage → Location Detection → Duplicate Detection
→ Incident Creation/Linking → Dispatcher Review → Responder Assignment
→ Notification → En Route → On Scene → Resolved → Analytics
```

---

## ⚠️ Read this first

CareGrid AI is a **demonstration system built for a hackathon**. It is **not** a certified
emergency dispatch system and must never be presented as a replacement for a public
emergency number.

- The AI is **decision support only**. It proposes a category, an urgency, a summary, and
  suggested resources. It never dispatches, never contacts any external emergency service,
  and never makes an irreversible decision. A human dispatcher always disposes.
- There is **no code path** that lets an AI output cause an outbound call, SMS, or public
  alert. See [09 AI/Gemini Specification](./docs/09_AI_GEMINI_SPECIFICATION.md) §1.2.
- The system runs on **free tiers** with a **$0** target cost. Free-tier quotas change
  without notice. See [02 Technical Requirements](./docs/02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7.
- A production deployment would require a privacy impact assessment, a retention policy, an
  independent security review, a clinical/triage accuracy study, and a formal agreement with
  the relevant emergency authority. None of that is in scope here, and claiming otherwise
  would be dishonest.

---

## What it does

| Capability | Summary |
| --- | --- |
| Multi-modal reporting | A citizen submits text, up to 3 photos, and (P1) a 120-second voice clip |
| AI triage | Gemini (`gemini-2.5-flash`) extracts category, urgency, summary, people affected, required resources, safety flags, and a self-reported confidence — as a strict JSON schema |
| Honest unknowns | Anything the model cannot support is `null`. It never invents a location, a casualty count, a diagnosis, or a resource need |
| Never blocked by AI | If Gemini times out, errors, or is blocked, the report is **still** accepted and the incident is still created, flagged `triageSource: fallback` with a deterministic keyword triage |
| Location | Device GPS with accuracy grading, manual pin drop, free-text address, and a deliberate "submit without location" path |
| Duplicate detection | 500 m radius, 6-hour window, category similarity, and token-similarity scoring — **suggested** to a dispatcher, never auto-merged |
| Dispatcher console | A live, filterable queue with AI-vs-human verification badges, SLA state, ranked nearby responders, and one-click assignment |
| Responder app | One-tap `en_route` / `on_scene` / `resolved` with a controlled resolution code, live over Firestore listeners |
| Interactive map | Live incident and responder markers coloured by urgency, with a 500 m duplicate-zone ring and a mandatory list fallback |
| Notifications | In-app only in the MVP; SMS/WhatsApp/email are optional, disabled by default, behind a channel interface with no provider implemented |
| Analytics | Operational metrics (response times, SLA compliance, category distribution) plus heuristic geographic risk zones |
| Audit trail | Append-only. Every privileged mutation is recorded with actor, action, entity, before/after, reason, request id, and a hashed IP. No role, including admin, can delete an audit row |
| **Authentication** | **Built in Phase 2.** Email/password + Google, persisted sessions, password reset, one central auth listener, sanitised error messages, a 61-row permission matrix computed server-side, deny-by-default Firestore rules, and protected routes. See [30.2](./docs/30.2_PHASE_2_IMPLEMENTATION.md) |

Every row above except **Authentication** is a Phase 3+ capability. The capability tables in
[01 PRD](./docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md) say which is which; this table is a
summary of the finished product, not of today's build.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router) · React 19 · TypeScript 5.7 `strict` |
| UI | Tailwind CSS v4 · shadcn/ui (Radix) · lucide-react · sonner |
| Auth | Firebase Authentication (email/password + Google) |
| Database | Cloud Firestore |
| Files | Firebase Storage (direct signed-URL uploads) |
| Backend | Next.js Route Handlers on Vercel |
| AI | Gemini via `@google/genai` |
| Maps | Google Maps Platform via `@vis.gl/react-google-maps` |
| Validation | Zod 4 (shared client/server) · react-hook-form |
| Charts | Recharts 3 |
| Tests | Vitest · Testing Library · `@firebase/rules-unit-testing` · Playwright · axe-core |
| Hosted on | Vercel (Hobby) · Firebase · Google AI Studio — **$0 target** |

Deliberately excluded: no SQL, no Redis, no tRPC, no ORM, no Redux/Zustand/React Query, no
`sharp`, no Storybook, no i18n library, no Sentry, no paid service of any kind. The reasoning
for each exclusion is in [02](./docs/02_TECHNICAL_REQUIREMENTS_DOCUMENT.md).

---

## Build status

| Phase | What it is | State |
| --- | --- | --- |
| 0 | Documentation package — 37 documents | ✅ complete |
| 1 | UI/UX foundation: design system, 22 routes, mock data | ✅ complete — 204 files, 29 tests |
| **2** | **Authentication, roles, permissions, protected routes** | **✅ complete — 134 tests** |
| 3 | Incident database, reports, `/api/incidents` | ⬜ not started |
| 4+ | Gemini triage, locations, dedupe, dispatch, maps, uploads, analytics | ⬜ not started |

**What works right now, with no configuration at all:**

```
npm install
npm run dev
```

Every page, layout, and component renders. The incident queue, dashboards, map, analytics,
and admin screens are driven by **typed sample data**, so the interface can be reviewed in
full. Authentication is the one part that needs a real Firebase project.

**To enable real sign-in**, copy `.env.example` to `.env.local` and fill in the
`NEXT_PUBLIC_FIREBASE_*` values from the Firebase console. Until you do, the protected
routes show an honest *"Firebase is not configured"* panel with the exact steps — they do
**not** pretend to be signed in, and no placeholder API key is shipped on purpose.

See [30.2 Phase 2 Implementation](./docs/30.2_PHASE_2_IMPLEMENTATION.md) for what was built,
what diverged from the plan and why, and a 11-step manual verification checklist.

---

## Documentation

The full documentation package — **37 documents** — is in [`docs/`](./docs/):

| Start here | |
| --- | --- |
| [`docs/DOCUMENTATION_INDEX.md`](./docs/DOCUMENTATION_INDEX.md) | Index of all documents: what each covers and when to read it |
| [`docs/DOCUMENTATION_CONSISTENCY_REPORT.md`](./docs/DOCUMENTATION_CONSISTENCY_REPORT.md) | Cross-document conflict audit, gaps, and resolutions |
| [`docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md`](./docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md) | 133 functional requirements, 30 NFRs, personas, user stories, decisions |
| [`docs/27_HACKATHON_MVP_SCOPE.md`](./docs/27_HACKATHON_MVP_SCOPE.md) | What is in the MVP, what is cut, and the cut order |
| [`docs/30_DEVELOPMENT_PHASE_PLAN.md`](./docs/30_DEVELOPMENT_PHASE_PLAN.md) | Phases 0–11 with tasks, files, dependencies, and acceptance criteria |
| [`docs/30.2_PHASE_2_IMPLEMENTATION.md`](./docs/30.2_PHASE_2_IMPLEMENTATION.md) | **What Phase 2 actually built**, divergences from the plan, manual checks |
| [`docs/32_AI_CODING_AGENT_RULES.md`](./docs/32_AI_CODING_AGENT_RULES.md) | The operating contract for anyone (human or AI) writing code here |

**Read the relevant `docs/` files before writing code.** The documentation is normative; where
the implementation had to diverge, the divergence is recorded in
[30.2](./docs/30.2_PHASE_2_IMPLEMENTATION.md) §5.11 rather than silently applied.

---

## Project layout

```
docs/                       36 documentation files
app/                        Next.js App Router routes and API handlers
  (public)/                 landing, login, signup, forgot-password  — no session needed
  (app)/                    report, incidents, profile, settings  — session required
  (ops)/                    admin/*                                — dispatcher or admin
  api/me/                   GET · PATCH   /api/me
  api/me/bootstrap/         POST         /api/me/bootstrap
  api/auth/event/           POST         /api/auth/event
  api/health/               GET          /api/health
components/
  auth/                     RequireSession, RoleGate, the auth form kit
  providers/                Theme → Session → Tooltip → Toaster
  layout/  ui/  domain/  feedback/
features/                   one folder per product domain (auth, incidents, dispatch, …)
lib/
  api/                      client, envelope, error catalogue
  auth/                     the 61-row permission matrix, role metadata
  firebase/                 client SDK bootstrap and Auth operations
  server/                   Admin SDK, auth guard, audit, route wrapper
  auth/  env.*  format/  mock-data/
types/  config/             shared types, role + nav tables
validators/                 Zod schemas, derived from the runtime enums
scripts/                    repair-encoding, security-check
tests/unit/                 134 assertions
middleware.ts               response headers only — no session check (see 30.2 §5.11)
firestore.rules  storage.rules  firestore.indexes.json  firebase.json
```

The full annotated tree is in [20 Project Folder Structure](./docs/20_PROJECT_FOLDER_STRUCTURE.md).
One structural note: **there is no `src/`** — the application source sits at the repository
root, as [20](./docs/20_PROJECT_FOLDER_STRUCTURE.md) specifies.

---

## Contribution rules (non-negotiable)

1. Read the relevant `docs/` files before writing any code.
2. Never commit a secret. `.env.example` contains placeholders only.
3. Never trust a client-supplied role; the server reads `users/{uid}.role` via the Admin SDK.
4. Never invent a Firestore field, API endpoint, error code, environment variable, or collection. If one is needed, amend [07](./docs/07_DATABASE_SCHEMA.md) and [08](./docs/08_API_SPECIFICATION.md) first.
5. Validate all external input with Zod before any side effect.
6. Every Firestore query needs a `limit()`, and every list query needs `where('deletedAt', '==', null)`.
7. Never add a Firestore listener without a `limit()`; the client budget is 8 (FR-091).
8. Keep TypeScript `strict` with no `any` in `app/`, `features/`, `services/`, or `lib/`.
9. Never claim a location is more precise than it is, and never let AI output drive a dispatch.
10. Run `npm run verify` before opening a PR. It is `typecheck && lint && test && security:check && build`, and it is the only gate — there is no second command to remember. `security:check` mechanically verifies the authentication security checklist (no credentials in source, no role in browser storage or the URL, `firestore.rules` deny-by-default, `server-only` on every secret-reading module, and no hard-coded Firebase config).
11. `firestore.rules` and `storage.rules` are the source of truth for client-SDK access, not documentation. Change the rules, then change the doc, never the reverse.

Full detail: [31 Coding Standards](./docs/31_CODING_STANDARDS.md) and
[32 AI Coding Agent Rules](./docs/32_AI_CODING_AGENT_RULES.md).

---

## Honest limitations

| Limitation | Detail |
| --- | --- |
| **No data beyond accounts** | Only `users` and `profiles` are real. Incidents, dispatches, maps, notifications, and analytics are **typed sample data** until Phase 3+. There is no incident database and no `POST /api/incidents` yet |
| **No role-management UI yet** | The permission matrix, the guards, and the rules all exist and are tested, but the admin user table is read-only. Role changes are granted by an Admin SDK script, not a screen. Phase 5 |
| **No session-cookie middleware** | The documented Edge middleware cannot work, because this product uses no cookies — every call carries a bearer token. [30.2](./docs/30.2_PHASE_2_IMPLEMENTATION.md) §5.11 explains what was built instead and why |
| Not certified | No regulatory approval, no SLA, no 24/7 operation, no on-call |
| AI can be wrong | Mitigated by confidence banding, safety flags, mandatory human verification, and a visible "needs review" state — **not eliminated** |
| Free-tier quotas | Firebase, Gemini, Google Maps, and Vercel all have quotas that can be exhausted mid-demo. Fallbacks are documented in [29 Demo Scenario](./docs/29_DEMO_SCENARIO.md) §9 |
| Geospatial queries are emulated | Firestore has no native geo queries. We use a geohash cell array plus an exact Haversine filter — correct, but not a spatial database ([07](./docs/07_DATABASE_SCHEMA.md) §9) |
| Single region, single provider | One Firebase project, one AI provider, one cloud. Documented in [28 Future Roadmap](./docs/28_FUTURE_ROADMAP.md). **The Firestore region is not yet chosen and is irreversible** — see D-02 in [30.2](./docs/30.2_PHASE_2_IMPLEMENTATION.md) §5.14 |
| No offline-first sync | Responders get a bounded local action queue; there is no full offline database |
| No MFA | Dispatcher and admin accounts are password + Google only. This is a real gap; see [24 Threat Model](./docs/24_THREAT_MODEL_SECURITY.md) residual-risk table |
| No real geometric ops | The audio format check, image dimension handling, and content scanning are best-effort. There is no AV pipeline at $0 ([15](./docs/15_FILE_STORAGE_SPECIFICATION.md)) |

---

## Licence and attribution

Add a `LICENSE` file before publishing. Third-party services (Firebase, Google Maps Platform,
Google AI Studio, Vercel) are used under their own terms and quotas; none of them is
affiliated with this project.

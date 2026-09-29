# CareGrid AI — Documentation Index

**This is the entry point to the entire CareGrid AI documentation package.**

| | |
| --- | --- |
| Package | CareGrid AI — emergency and community-aid routing platform |
| Version | v1.0.4 (post-Phase-4-gemini) |
| Documents | 38 (33 numbered + this index + the consistency report + 3 phase records) |
| Size | 39 243 lines · 49 Mermaid diagrams · 491 code blocks · ~14 000 table rows |
| Status | Documentation complete. **Phases 1, 2, 3, 4, 5, 6, 7 and 8 of the implementation are built** - 29 routes, real authentication, a 61-row permission matrix, deny-by-default Firestore and Storage rules, a full backend foundation (request pipeline, service layer, centralized validation/authorization/rate limiting), the **live Gemini integration** (the `triage-v3` prompt, a `.strict()` output contract, ten deterministic safety rules, a prompt-injection and PII boundary, a keyword fallback engine, image validation by byte signature, the `aiRuns` audit trail, and a citizen triage panel), and **Phase 5's evidence layer** (a six-type media allow-list, a byte-signature sniffer that quarantines executables, server-generated storage paths, signed direct-to-Storage uploads with real progress, a voice recorder, and four honest transcription states). **The Gemini SDK call itself is untested** - see [30.5 §6.1](./30.5_PHASE_4_GEMINI.md). **No Storage call is tested against a live bucket.** **Phase 6 adds maps, geolocation and duplicate detection** (see [30.7](./30.7_PHASE_6_MAPS_DUPLICATES.md)) - the Haversine distance module, FR-032 accuracy grading, the geohash-6 cell block, the `docs/07 §9.4` duplicate engine transcribed gate for gate, a one-read candidate query, coordinate validation, server-only reverse geocoding, and integrity checks that flag and never reject - plus a `MarkerSpec` the map renderer will consume. **The map rendering layer itself is not built**, which is the one real gap. The `POST /api/incidents` create transaction is still outstanding - see [30.6 §6.1](./30.6_PHASE_5_EVIDENCE_UPLOADS.md). **Phase 7 adds responder management and a human-in-the-loop dispatch workflow** (see [30.8](./30.8_PHASE_7_DISPATCH.md)) - the `docs/07 4.3` transition table as one pure, centralised validator, an explainable candidate ranker that never emits a score, an assignment transaction that **writes** the responder so two concurrent assigns actually conflict, `assigneeUid` denormalised onto the incident because `firestore.rules` keys on it, append-only audit and status history, and in-app notifications that are stored rather than pushed and never claim help is on the way. **The AI is allowed exactly one lifecycle transition** (`new -> triaged`), and `auto_suggest` is unreachable from every route. **No UI was built** - no candidate panel, responder dashboard, management screen or citizen tracker - which is the one real gap, alongside **no realtime listener, no expiry sweep, no deployed Firestore index, and no `POST /api/dispatches/:id/claim`**. **Phase 8 adds the realtime layer** (see [30.9](./30.9_PHASE_8_REALTIME.md)) - the listener registry `docs/11 §2.1` names, all ten scoped query builders under Rule R-2, a single attach primitive, a connection state that is derived rather than guessed, and nine new composite indexes (six of fifteen listener query shapes had none, and one shipped index omitted `deletedAt` so it could not serve the map query). `onNetworkStatusChange` is **not public API** in the installed SDK, so connectivity comes from `onSnapshotsInSync` plus a stall detector. **No UI was built** - no operations centre, KPI cards, live queue, detail panel, map, responder panel, citizen tracking, responder dashboard or activity feed - so `features/dashboard/dispatcher-dashboard.tsx` still renders `MOCK_INCIDENTS`, and eight of the ten listeners have no hook. Also outstanding: **`unsubscribeAll()` is not yet wired to `onAuthStateChanged`**, which is the highest-value remaining item. **No listener has ever executed** - no deployed index and no browser. Phase 9+ not started |
| Audience | A 3-person hackathon team, including AI coding agents |
| Read time | Full package ≈ 7–9 hours. Minimum viable read ≈ 90 minutes (see §3) |

---

## 1. How this package is organised

The documents are **not** 33 equal-weight files. They fall into five tiers, and the tier
determines how strictly you must follow it.

| Tier | Documents | Authority | Rule |
| --- | --- | --- | --- |
| **T0 — Anchors** | 01 PRD, 07 Database Schema, 08 API Spec, 09 AI Spec, 21 Env Vars, 22 Roles | **Normative.** These define the contract | If code disagrees with a T0 document, the code is wrong |
| **T1 — Implementation** | 02, 03, 05, 06, 10, 11, 12, 13, 14, 15, 16, 17, 23, 26, 20, 25 | **Normative** for how to build it | Must not contradict T0 |
| **T2 — Process & quality** | 18, 19, 27, 29, 30, 31, 32, 33 | **Normative** for how the team works | Must not contradict T0 or T1 |
| **T3 — Direction** | 04 UI/UX, 28 Future Roadmap | **Normative** for the current build; T3-roadmap items are explicitly non-goals | Never build a roadmap item during the MVP |
| **T4 — Audit** | DOCUMENTATION_CONSISTENCY_REPORT | Record of what was found and resolved | Read it to understand *why* certain decisions are the way they are |

### Precedence rule

```
T0  >  T1  >  T2  >  T3  >  T4
```

If two documents at the same tier disagree, the **lower-numbered** one wins (01 before 07
before 08). A genuine tie is a `DECISION REQUIRED` and must be raised — not silently
resolved by whoever is writing code at the time.

---

## 2. The one-page cheat sheet

| Question | Answer | Source |
| --- | --- | --- |
| What are we building? | An emergency incident routing platform: report → AI triage → dedupe → dispatch → realtime lifecycle → analytics | [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) |
| What is in the MVP? | 15 must-have items, 31.5 ideal hours, with a 17-step cut ladder | [27](./27_HACKATHON_MVP_SCOPE.md) |
| What stack? | Next.js 15 + React 19 + TS 5.7 + Tailwind v4 + shadcn/ui, Firebase Auth/Firestore/Storage, Gemini, Google Maps, Vercel | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) |
| How many requirements? | **133** assigned FRs, **30** NFRs, 14 reserved FR IDs that must never be reused | [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) §13 |
| How many endpoints? | ~45 across incidents, dispatch, responders, notifications, analytics, uploads, geocoding, admin | [08](./08_API_SPECIFICATION.md) |
| How many collections? | 15 Firestore collections + `config/app` + 2 subcollections per incident | [07](./07_DATABASE_SCHEMA.md) §1 |
| How does location work? | Geohash precision 6, a 10-entry `geoCells` array, one `array-contains` query, then exact Haversine. **Firestore has no native geo queries** | [07](./07_DATABASE_SCHEMA.md) §9 |
| How does duplicate detection work? | 500 m + 6 h + category + Jaccard similarity → `potential_duplicate` suggestion. **Never an automatic merge** | [07](./07_DATABASE_SCHEMA.md) §9.4 |
| What can the AI never do? | Dispatch, diagnose, invent a location/casualty count/resource, or assert death. 11 hard prohibitions | [09](./09_AI_GEMINI_SPECIFICATION.md) §1.2 |
| What happens if the AI fails? | The report is still accepted, the incident is still created, `triageSource: fallback`, a deterministic keyword triage runs, and the UI says "needs review" | [09](./09_AI_GEMINI_SPECIFICATION.md) §7 |
| How many roles? | 4 — `citizen`, `responder`, `dispatcher`, `admin`. 61-row permission matrix. 2 hard denials for everyone including admin | [22](./22_USER_ROLES_PERMISSIONS.md) |
| Where is authorization enforced? | 6 layers. The server reading `users/{uid}.role` is the real boundary; the client only hides buttons | [22](./22_USER_ROLES_PERMISSIONS.md) §6, [10](./10_AUTHORIZATION_SECURITY.md) |
| What is the cost? | $0 target. One real risk: Google Maps billing without a budget alert | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7 |
| What are the open decisions? | **18 open `DECISION REQUIRED` items** (7 blocking, 11 phase-gated) plus 12 accepted risks, all with a recommendation and a deadline | [DOCUMENTATION_CONSISTENCY_REPORT](./DOCUMENTATION_CONSISTENCY_REPORT.md) §5 |
| How many test cases? | 552 unique test IDs covering 133/133 assigned FRs and 30/30 NFRs | [18](./18_TESTING_QA_PLAN.md) |

---

## 3. Reading paths

### 3.1 The 90-minute orientation (everyone, before touching anything)

```
01 PRD §1–6           what the product is, who it serves, what it must do
07 §1, §4.1–4.3, §9   the data model, the state machine, the geospatial strategy
08 §1–§3.1            the API envelope, the request pipeline, the create-incident flow
09 §1.2, §5, §7       AI prohibitions, output contract, fallback guarantee
22 §1–§3              roles, the authoritative role source, the permission matrix
27 §1–§3              the MVP cut line
33 README             the project in one page
```

### 3.2 A developer picking up a task

| If your task is… | Read, in order |
| --- | --- |
| Building a screen | [04](./04_UI_UX_DESIGN_SPECIFICATION.md) page spec → [05](./05_FRONTEND_ARCHITECTURE.md) → the endpoint in [08](./08_API_SPECIFICATION.md) → [25](./25_ACCESSIBILITY_RESPONSIVENESS.md) |
| Building an API route | [06](./06_BACKEND_ARCHITECTURE.md) → [17](./17_VALIDATION_RULES.md) → [16](./16_ERROR_HANDLING.md) → the endpoint in [08](./08_API_SPECIFICATION.md) |
| Adding a Firestore field | [07](./07_DATABASE_SCHEMA.md) §2 conventions + §4.1 → [20](./20_PROJECT_FOLDER_STRUCTURE.md) → [32](./32_AI_CODING_AGENT_RULES.md) rule 1 |
| Touching the AI | [09](./09_AI_GEMINI_SPECIFICATION.md) **in full** → [24](./24_THREAT_MODEL_SECURITY.md) prompt-injection threats → [09](./09_AI_GEMINI_SPECIFICATION.md) §10 adversarial fixtures |
| Touching the map or location | [12](./12_MAP_LOCATION_SYSTEM.md) → [07](./07_DATABASE_SCHEMA.md) §9 → [08](./08_API_SPECIFICATION.md) §8.4–8.5 |
| Touching realtime | [11](./11_REALTIME_SYSTEM.md) → [07](./07_DATABASE_SCHEMA.md) §12.2 and §12.5 → [26](./26_PERFORMANCE_REQUIREMENTS.md) read budget |
| Touching uploads | [15](./15_FILE_STORAGE_SPECIFICATION.md) → [10](./10_AUTHORIZATION_SECURITY.md) Storage rules → [24](./24_THREAT_MODEL_SECURITY.md) upload threats |
| Writing tests | [18](./18_TESTING_QA_PLAN.md) → the FR in [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) → [31](./31_CODING_STANDARDS.md) |
| Adding a notification | [13](./13_NOTIFICATION_SYSTEM.md) → the event table in [07](./07_DATABASE_SCHEMA.md) §10.2 |
| Changing analytics | [14](./14_ANALYTICS_SPECIFICATION.md) → [07](./07_DATABASE_SCHEMA.md) §11.7 |
| Changing security | [10](./10_AUTHORIZATION_SECURITY.md) → [24](./24_THREAT_MODEL_SECURITY.md) → [22](./22_USER_ROLES_PERMISSIONS.md) |
| Preparing the demo | [29](./29_DEMO_SCENARIO.md) → [19](./19_DEPLOYMENT_DEVOPS.md) §12 release checklist |
| Adding a dependency | [31](./31_CODING_STANDARDS.md) dependency policy → [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §5 rejected libraries |

### 3.3 An AI coding agent starting work

Read [32 AI Coding Agent Rules](./32_AI_CODING_AGENT_RULES.md) **first, in full**. Then the
"T0 anchor order" in its §0. Do not skip the pre-flight checklist. Do not skip the post-flight
checklist. When you finish, explain the files you changed.

---

## 4. Document catalogue

### T0 — Anchors (normative contract)

| # | Document | What it defines | Read it when |
| --- | --- | --- | --- |
| 01 | [Product Requirements Document](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) | Vision, problem, 4 personas, 18 core features, **133 FRs**, **30 NFRs**, 42 user stories with acceptance criteria, out-of-scope, success metrics, 15-entry decision register, traceability | Always. It is the contract |
| 07 | [Database Schema](./07_DATABASE_SCHEMA.md) | 15 collections + 2 subcollections, every field with type and nullability, 11 composite indexes, example documents, the status transition table, the geohash/Haversine strategy with full pseudocode, transaction patterns, 12 known Firestore constraints, Security Rules outline | Writing or reading any data access code |
| 08 | [API Specification](./08_API_SPECIFICATION.md) | ~45 endpoints with purpose, auth, authorization, request, validation, response, errors, rate limits, security requirements; the response envelope; CSRF; the per-endpoint security checklist; amendment history | Writing or consuming any API |
| 09 | [AI / Gemini Specification](./09_AI_GEMINI_SPECIFICATION.md) | 11 hard AI prohibitions, the JSON output contract, deterministic safety rules R1–R10, **the production system prompt (`triage-v3`)**, the sanitisation boundary, the mandatory fallback, 50 adversarial test cases, honest compliance notes | Any AI work. Non-negotiable reading |
| 21 | [Environment Variables](./21_ENVIRONMENT_VARIABLES.md) | Every variable with visibility and required-ness, a complete `.env.example` with no real values, per-environment matrices, Google key restrictions, rotation policy, boot validation | Before writing any config |
| 22 | [User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md) | 4 roles, the 61-row permission matrix with 2 hard denials, scoped-permission rules, object-level authorization, 6 enforcement layers, the full Security Rules, the role-change procedure | Any authorization work |

### T1 — Implementation

| # | Document | What it defines | Read it when |
| --- | --- | --- | --- |
| 02 | [Technical Requirements](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) | Exact stack and versions, why each technology was chosen **and what was rejected**, free-tier limits per service with fallbacks, browser support, the §7 cost analysis | Questioning a technology choice; planning for a free-tier limit |
| 03 | [System Architecture](./03_SYSTEM_ARCHITECTURE.md) | 13 Mermaid diagrams, every layer's responsibilities *and* what it must not do, trust boundaries, concurrency model, 12 numbered ADRs | Onboarding; reviewing a structural change |
| 05 | [Frontend Architecture](./05_FRONTEND_ARCHITECTURE.md) | Route tree, the server/client component policy, the `features/` breakdown, the hook catalogue, the API client, route protection, **why there is no Redux/Zustand/React Query**, realtime integration rules | Writing any React code |
| 06 | [Backend Architecture](./06_BACKEND_ARCHITECTURE.md) | The 9-step request pipeline, a 54-row route inventory, ~50 service signatures, transaction discipline, 12 race conditions and their prevention, logging, a deterministic build order | Writing any server code |
| 10 | [Authorization & Security](./10_AUTHORIZATION_SECURITY.md) | Auth flows, token revocation, the 19-step check order, the complete deployable `firestore.rules` and `storage.rules`, what rules **cannot** express, CSP, secrets, abuse signals, 20 residual risks | Any security-sensitive work |
| 11 | [Realtime System](./11_REALTIME_SYSTEM.md) | The listener inventory with per-page arithmetic, listener lifecycle, reconnect, optimistic updates, the read-budget table, what rules force to be API-delivered | Anything live |
| 12 | [Map & Location System](./12_MAP_LOCATION_SYSTEM.md) | The 4 location sources, geolocation policy, pin drop, reverse/forward geocoding, marker visual language, viewport query strategy, privacy matrix, map failure handling, the mandatory list fallback | Map or location work |
| 13 | [Notification System](./13_NOTIFICATION_SYSTEM.md) | The `NotificationChannel` interface, all 12 event types with exact copy, dedupe, honest feasibility analysis for email/SMS/WhatsApp/push with costs | Adding or changing a notification |
| 14 | [Analytics Specification](./14_ANALYTICS_SPECIFICATION.md) | Operational vs risk analytics, every metric with formula and caveat, the rollup vs live-scan decision rule, 11 chart specs, the risk score formula, CSV export with injection defence | Building the analytics page |
| 15 | [File Storage Specification](./15_FILE_STORAGE_SPECIFICATION.md) | The 4-shape path scheme, real magic-byte signatures, rejected types with reasons, the 7-step validation chain, EXIF honesty, the no-AV-compensating-controls position, access matrix, ~120-assertion test matrix | Any upload work |
| 16 | [Error Handling](./16_ERROR_HANDLING.md) | The single envelope, the `AppError` class, **75 error codes** with status/message/retryability/log/audit, client handling, offline queue, anti-patterns | Handling any error path |
| 17 | [Validation Rules](./17_VALIDATION_RULES.md) | Zod layer organisation, shared primitives, **an exhaustive field table for every endpoint**, cross-field rules, sanitisation policy, the test matrix | Writing any schema |
| 20 | [Project Folder Structure](./20_PROJECT_FOLDER_STRUCTURE.md) | The complete annotated tree, directory ownership, ESLint import-boundary rules, naming, "files that must not exist" | Adding any file |
| 23 | [Data Flow Diagrams](./23_DATA_FLOW_DIAGRAMS.md) | 19 Mermaid diagrams: submission, triage, dedupe, lifecycle, dispatch, realtime, notification fan-out, media upload, auth, rollup, risk, audit, rate limit, error propagation, retention | Understanding a flow end-to-end |
| 25 | [Accessibility & Responsiveness](./25_ACCESSIBILITY_RESPONSIVENESS.md) | WCAG 2.1 AA scope, keyboard model, focus management, screen-reader contracts, contrast ratios, the 8 breakpoints, per-route responsive behaviour for all 22 routes, honest gaps | Any UI work |
| 26 | [Performance Requirements](./26_PERFORMANCE_REQUIREMENTS.md) | Bundle budgets, latency budgets per endpoint, the Firestore read/write budget arithmetic, caching policy, the free-tools monitoring plan | Optimising, or when a quota is near |

### T2 — Process & quality

| # | Document | What it defines | Read it when |
| --- | --- | --- | --- |
| 18 | [Testing & QA Plan](./18_TESTING_QA_PLAN.md) | 623 test cases covering **133/133 FRs and 30/30 NFRs**, the edge-case catalogue, 95 Security Rules assertions, 50 AI adversarial fixtures, 4 E2E journeys, the emulator setup, the CI pipeline, `npm run verify`, honest automation gaps | Writing any test |
| 19 | [Deployment & DevOps](./19_DEPLOYMENT_DEVOPS.md) | Environment matrix, GitHub branch protection, Firebase and Vercel provisioning, a 31-step first-deploy runbook, `firestore.indexes.json`, release checklist, rollback, free-tool monitoring, cost control, 23-row troubleshooting table | Deploying; preparing the demo |
| 27 | [Hackathon MVP Scope](./27_HACKATHON_MVP_SCOPE.md) | 15 must-haves with hour estimates, 15 nice-to-haves, 15 out-of-scope, **the 17-step cut ladder**, an hour-by-hour time budget, the scope-creep policy, 20 anti-goals | Deciding what to build; deciding what to drop |
| 29 | [Demo Scenario](./29_DEMO_SCENARIO.md) | 31-step setup, the exact demo dataset with real coordinates, **the full duplicate arithmetic proving the demo genuinely triggers `confirmed_duplicate`**, a 4:30 second-by-second script with narration, live-vs-recorded fallbacks, 12 judge Q&A, 5 failure drills, the 60-second version | Rehearsing |
| 30 | [Development Phase Plan](./30_DEVELOPMENT_PHASE_PLAN.md) | The **Phase 0 gate**, phases 0–11 each with 7 required sections plus risks/hours/hard-cutoff/per-phase cut lists, a dependency graph, a 3-developer parallel split, **133/133 FR traceability**, an 18-row plan risk register | Starting work; planning the schedule |
| 31 | [Coding Standards](./31_CODING_STANDARDS.md) | TypeScript rules, naming, component/API/service/Firestore/realtime conventions, Git conventions, security rules in code, the dependency policy, 27 anti-pattern examples, Definition of Done | Writing or reviewing code |
| 32 | [AI Coding Agent Rules](./32_AI_CODING_AGENT_RULES.md) | 15 MUST + 9 MUST NOT from the brief, each expanded with a ❌/✅ violation example; 15 agent-specific rules; pre-flight and post-flight checklists; "if you need X, do Y"; 13 failure modes; a worked example; honesty rules | **Always, if you are writing code here** |
| 33 | [README](./33_README.md) | The project in one page: vision, capabilities, stack, documentation map, contribution rules, honest limitations | Orientation |
| **30.4** | [**Phase 3 Foundation**](./30.4_PHASE_3_FOUNDATION.md) | **What Phase 3 actually built**, file by file; the request pipeline in order; **the three real bugs it found** (a missing error code, a wrong HTTP status, and two product features blocked by a browser policy); the **six reconciliations** where the code and the documentation had to disagree; an acceptance-criteria table; and a paste-ready checklist for Phase 4 | Reviewing the backend foundation; starting Phase 4 |
| **30.5** | [**Phase 4 Gemini**](./30.5_PHASE_4_GEMINI.md) | **What Phase 4 actually built**, file by file; the AI request path in order; **the seven real bugs its own tests found** — three of which were safety rules silently inverting, and two of which would have rejected every real WebP and many real JPEGs; the **six reconciliations**; an acceptance table with the one **partial** criterion stated; **nine known limitations**; and what Phase 5 consumes | Reviewing the AI layer; starting the incident create pipeline |
  | **30.6** | [**Phase 5 Evidence Uploads**](./30.6_PHASE_5_EVIDENCE_UPLOADS.md) | **What Phase 5 actually built** - the seven-step upload chain from `docs/15 A§8.1`; the **sniffer** and the seven traps in `A§5.2` it defends; the **six places the documentation overruled the brief** (notably: the path scheme is staging-then-move because the incident ID does not exist at upload time, and transcription is a by-product of the Gemini call rather than a separate STT step); **the seven bugs this phase own tests found**, including one that would have **silently dropped every upload** while the regex passed every `.test()`; a **bug in the security checks themselves**, caught by mutation testing; **what is deliberately not built** and why - notably the `POST /api/incidents` create transaction, which is the one real gap in the user-facing journey | Reviewing the storage and voice layers; starting the incident create pipeline |
  | **30.7** | [**Phase 6 Maps & Duplicates**](./30.7_PHASE_6_MAPS_DUPLICATES.md) | **What Phase 6 actually built**: the Haversine distance module (and why the law of cosines is wrong for close points), FR-032 accuracy grading, the geohash-6 3x3 cell block, the `docs/07 §9.4` duplicate engine transcribed gate for gate, the **one-read** candidate query, coordinate validation, server-only reverse geocoding with a **structural** FR-035 street-address discard, and `docs/12 §13` integrity checks that flag and never reject. Includes **the six places the documentation overruled the brief** (notably: the time window is 6 h not 24, and `docs/07’s "exactly 10 geohash cells" is an arithmetic error - it is 9); **the nine bugs the tests found**, two of which would have encoded every coordinate at the equator; **four bugs in the security checks themselves**, found by mutation testing; and **what is NOT built** - the map rendering layer is the one real gap | Reviewing the location and duplicate layers; starting the map UI |
| **30.8** | [**Phase 7 Responder Dispatch**](./30.8_PHASE_7_DISPATCH.md) | **What Phase 7 actually built**: the centralised transition table transcribed cell-by-cell from `docs/07 §4.3` (and the four cells the first transcription got wrong); the explainable candidate ranker (a lexicographic order over named factors, never a score); the assignment transaction and **why it must WRITE the responder, not merely read it**; `assigneeUid` and why it is the field `firestore.rules` keys on; the append-only audit and history writers; and **§10 what is not built, including the whole UI**. Plus **6 doc-over-brief reconciliations**, **2 checks that were passing for the wrong reason**, and 19/19 mutations caught. |
| **30.9** | [**Phase 8 Realtime Operations**](./30.9_PHASE_8_REALTIME.md) | **What Phase 8 actually built**: the listener registry `docs/11 §2.1` specifies (the `ListenerId` union verbatim, the 8-slot budget, a per-listener `limit` ceiling, and the composite key a test forced after the first version orphaned a channel); all **ten** scoped query builders under Rule R-2; the single attach primitive every listener must go through; the connection state as a **derivation** (a missing snapshot is never `connected`); and `firestore.indexes.json` — where an audit found **six of fifteen** listener query shapes had no working index, including a shipped index that omitted `deletedAt` and so could not serve the map query. Plus the two places `docs/11` could not be followed literally: `onNetworkStatusChange` is **not public API** in the installed SDK, so connectivity is derived from `onSnapshotsInSync` plus a stall detector — which catches a silent stall the transport monitor would miss. **§7 is the whole gap: no UI at all.** |
| **34** | [**Backend Integration Points**](./34_BACKEND_INTEGRATION_POINTS.md) | **Where every future integration connects**, by exact file. Gemini, Google Maps, Twilio, incidents, realtime. What each later phase edits, what it must not do, and the CSP items still to be added. Plus **seven honest limitations** of the foundation | Before starting any integration phase; answering "where does X go?" |
| **30.2** | [**Phase 2 Implementation**](./30.2_PHASE_2_IMPLEMENTATION.md) | **What Phase 2 actually built**, file-by-file; the **six documented divergences** from the plan and the reason for each; an acceptance-criteria status table; an 11-step manual verification checklist; the Phase 2 → Phase 3 seam | Reviewing the auth layer; starting Phase 3 |
| **30.3** | [**Phase 2 Doc Amendments**](./30.3_PHASE_2_DOC_AMENDMENTS.md) | The **ten amendments** the Phase 2 build found necessary, each with the text as it stands and the text as it should read, plus a paste-ready checklist for the next documentation pass | Amending the normative documents |

### T3 — Direction

| # | Document | What it defines | Read it when |
| --- | --- | --- | --- |
| 04 | [UI/UX Design Specification](./04_UI_UX_DESIGN_SPECIFICATION.md) | Design philosophy and anti-patterns, the full token system with measured contrast, 25 component specs, navigation per role, **a complete spec for all 22 routes** plus 403/404/error, the microcopy dictionary, the "must never look like" list | Any UI work. This is the largest document |
| 28 | [Future Roadmap](./28_FUTURE_ROADMAP.md) | 3 horizons with 30 items each carrying motivation/approach/prerequisites/effort/risk/cost/privacy, a "when to say no" table, a 30-item technical-debt register, the data model's evolution at 100k/1M/10M, migration policy | Pitching the future; resisting scope creep |

### T4 — Audit

| # | Document | What it defines | Read it when |
| --- | --- | --- | --- |
| — | [Documentation Consistency Report](./DOCUMENTATION_CONSISTENCY_REPORT.md) | The full cross-document verification: 10 checks, 22 conflicts found, 9 missing requirements closed, 6 schema amendments, ~60 `DECISION REQUIRED` items with deadlines and recommendations | Before you trust the package; when you need to know *why* something is the way it is |

---

## 5. Identifier conventions used across the package

| Prefix | Meaning | Defined in | Example |
| --- | --- | --- | --- |
| `FR-###` | Functional requirement | 01 | `FR-042` |
| `NFR-###` | Non-functional requirement | 01 | `NFR-007` |
| `US-###` | User story | 01 | `US-021` |
| `DEC-##` | Product decision | 01 §12 | `DEC-01` |
| `TC-<AREA>-#` | Test case | 18 | `TC-DUP-012` |
| `T-##` | Threat | 24 | `T-09` |
| `D-##` / `DEC-##` / `DR-##` | `DECISION REQUIRED` items, prefixed per authoring document | various | `DR-01` |
| `A-#` | API specification amendment | 08 §13 | `A-1` |
| `R#` | AI deterministic safety rule | 09 §5.3 | `R7` |
| `TB#` | Trust boundary | 24 | `TB3` |
| `FR-*` ranges in prose | Inclusive ID range | — | `FR-050…FR-059` |

**Every one of these is stable and cross-referenced.** If you add a requirement, an endpoint,
a field, or a test, you must add its row to the relevant traceability table in the same
change. See [32](./32_AI_CODING_AGENT_RULES.md) rule 15.

---

## 6. Conventions used in these documents

| Convention | Meaning |
| --- | --- |
| **MUST** / **MUST NOT** / **SHOULD** / **MAY** | RFC 2119. MUST is a hard requirement with a test. SHOULD may be deviated with a recorded reason |
| `DECISION REQUIRED: <question>` | A genuine open question that must be answered by a human before the dependent code is written. Never guess past one of these |
| `FR-###` in a table cell | The requirement this row implements |
| `§` | Section within the current document; `[07 §9](./07_DATABASE_SCHEMA.md)` for another document |
| `✔` / `✖` / `◐` / `○` / `—` | Allowed / denied / conditionally allowed / read-only-redacted / not applicable |
| "Honest note", "Known limitation", "Residual risk" | A section where a real weakness is stated rather than hidden. **Do not delete these when editing** |
| Code blocks without a language | Prose or pseudo-data, not runnable code |
| `$0` | Verified against the free-tier table in [02 §7](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) — always paired with a named risk |

---

## 7. Frequently asked questions

**Q: Do I have to read all 37 documents?**
No. Read the T0 anchors plus the documents relevant to your task (§3.2). Before writing any
code, read [32](./32_AI_CODING_AGENT_RULES.md) in full — it is short and it is the contract.

**Q: A document says X and another says Y. Which wins?**
The precedence rule in §1. T0 beats everything. Within a tier, the lower number wins. If it is
a genuine tie, it is a `DECISION REQUIRED` — raise it, do not pick silently.

**Q: The documentation and the code disagree. Which is wrong?**
The code. Unless a T0 document is demonstrably wrong, in which case amend the T0 document in
the same PR that changes the code, and note it in the amendment log.

**Q: Can I add a field / endpoint / library that is not in the docs?**
Not without amending the docs first. [32 rule 1](./32_AI_CODING_AGENT_RULES.md) and
[32 rule 2](./32_AI_CODING_AGENT_RULES.md). A dependency in particular needs a written
justification covering alternatives, bundle impact, maintenance, licence, and free-tier fit
([31](./31_CODING_STANDARDS.md) dependency policy).

**Q: I found a bug in the documentation. Should I fix it silently?**
No. Amend the document, and add a row to its amendment history ([08 §13](./08_API_SPECIFICATION.md)
is the model), then record it in the consistency report. Silent edits destroy traceability.

**Q: What if I am running out of time?**
Use the cut ladder in [27](./27_HACKATHON_MVP_SCOPE.md). It tells you exactly what to drop, in
order, and what the judge narrative becomes after each cut. Never drop duplicate detection,
the human verification gate, or the AI-failure fallback — those are the three things that make
the demo credible.

**Q: What genuinely blocks the demo, and what can break without blocking it?**
See the honesty sections of [19](./19_DEPLOYMENT_DEVOPS.md) §17 and [29](./29_DEMO_SCENARIO.md) §9.
In short: the AI failing is survivable (the fallback exists on purpose); Maps failing is
survivable (there is a list fallback); the free-tier quota being exhausted is survivable
(pre-flight check + a recorded run); an authorization bug is **not** survivable.

**Q: Why is there no real geospatial database?**
Because Firestore has no native geo query and a PostGIS/R-tree database would break the $0
constraint. [07 §9.1](./07_DATABASE_SCHEMA.md) documents the six strategies considered and why
the geohash-cell-array approach was chosen, including its cost and its failure modes.

**Q: Why is the AI fallback a keyword engine rather than just failing?**
Because FR-029 requires that recording an emergency is never blocked by the AI. A pure
technical failure of Gemini must not stop a citizen's report from reaching a human. See
[09 §7](./09_AI_GEMINI_SPECIFICATION.md).

**Q: Where do the honest limitations live?**
Collected in [33 README](./33_README.md) §"Honest limitations", [24 §"What this is NOT"](./24_THREAT_MODEL_SECURITY.md),
[09 §13](./09_AI_GEMINI_SPECIFICATION.md), and the "Known limitations" sections of
[10](./10_AUTHORIZATION_SECURITY.md), [15](./15_FILE_STORAGE_SPECIFICATION.md),
[19](./19_DEPLOYMENT_DEVOPS.md), and [25](./25_ACCESSIBILITY_RESPONSIVENESS.md). They are
deliberate. Do not delete them to make the project look better.

---

## 8. Maintaining this package

| Change | Documents that must be updated in the same change |
| --- | --- |
| Add a functional requirement | 01 (+ its FR range), the implementing document, 18 (a test), 30 (a phase), 08 or 07 (the endpoint/field), this index if a document is added |
| Add an API endpoint | 08, 17 (validation), 16 (error codes), 06 (route inventory), 18 (tests), 05 (typed client function), 10 (authorization decision table) |
| Add or rename a Firestore field | 07 (+ the composite index table), 08 (response shape), 17, 05 (types), 10 (rules if it affects a rule) |
| Add a notification type | 07 §10.2 (event table), 13, 08 §6.4, 22 (permission for sending) |
| Change a role's permissions | 22 (§3 matrix, §4 scoping, §7 rules), 10, 08 (endpoint auth), 18 (permission tests) |
| Add a dependency | 02 (stack + rejected list), 31 (dependency policy compliance), 26 (bundle budget impact), 18 (test tooling if needed) |
| Change a design token | 04, 25 (contrast table), 18 (a11y assertions) |
| Add a `DECISION REQUIRED` resolution | Resolve it here: update every affected document, remove the item from the consistency report's open list, and record the resolution |

**Golden rule:** if a change would make any two documents disagree, it is not finished.

---

## 9. Document numbering map

```
docs/
├── DOCUMENTATION_INDEX.md                      ← you are here
├── DOCUMENTATION_CONSISTENCY_REPORT.md         cross-document audit
├── 01_PRODUCT_REQUIREMENTS_DOCUMENT.md         T0  what the product must do
├── 02_TECHNICAL_REQUIREMENTS_DOCUMENT.md       T1  stack, versions, free tiers, cost
├── 03_SYSTEM_ARCHITECTURE.md                   T1  layers, boundaries, ADRs
├── 04_UI_UX_DESIGN_SPECIFICATION.md            T3  design system + all 22 route specs
├── 05_FRONTEND_ARCHITECTURE.md                 T1  Next.js client architecture
├── 06_BACKEND_ARCHITECTURE.md                  T1  server architecture
├── 07_DATABASE_SCHEMA.md                       T0  Firestore model  ★ANCHOR
├── 08_API_SPECIFICATION.md                     T0  endpoints             ★ANCHOR
├── 09_AI_GEMINI_SPECIFICATION.md               T0  AI contract + prompt   ★ANCHOR
├── 10_AUTHORIZATION_SECURITY.md                T1  auth, rules, secrets
├── 11_REALTIME_SYSTEM.md                       T1  Firestore listeners
├── 12_MAP_LOCATION_SYSTEM.md                   T1  geolocation, maps, geocoding
├── 13_NOTIFICATION_SYSTEM.md                   T1  in-app + optional channels
├── 14_ANALYTICS_SPECIFICATION.md               T1  operational + risk metrics
├── 15_FILE_STORAGE_SPECIFICATION.md            T1  uploads and media security
├── 16_ERROR_HANDLING.md                        T1  75 error codes
├── 17_VALIDATION_RULES.md                      T1  every field, every endpoint
├── 18_TESTING_QA_PLAN.md                       T2  623 test cases
├── 19_DEPLOYMENT_DEVOPS.md                     T2  runbooks, CI/CD, rollback
├── 20_PROJECT_FOLDER_STRUCTURE.md              T1  the annotated tree
├── 21_ENVIRONMENT_VARIABLES.md                 T0  every variable           ★ANCHOR
├── 22_USER_ROLES_PERMISSIONS.md                T0  roles + matrix          ★ANCHOR
├── 23_DATA_FLOW_DIAGRAMS.md                    T1  19 diagrams
├── 24_THREAT_MODEL_SECURITY.md                 T1  49 threats, STRIDE
├── 25_ACCESSIBILITY_RESPONSIVENESS.md          T1  WCAG AA, 8 breakpoints
├── 26_PERFORMANCE_REQUIREMENTS.md              T1  budgets and read costs
├── 27_HACKATHON_MVP_SCOPE.md                   T2  the cut line
├── 28_FUTURE_ROADMAP.md                        T3  horizons 1–3
├── 29_DEMO_SCENARIO.md                         T2  the 4:30 script
├── 30_DEVELOPMENT_PHASE_PLAN.md                T2  phases 0–11
├── 30.5_PHASE_4_GEMINI.md                     T2  Phase 4: what it built, its 7 bugs
├── 31_CODING_STANDARDS.md                      T2  conventions + anti-patterns
├── 32_AI_CODING_AGENT_RULES.md                 T2  the operating contract
└── 33_README.md                                T2  project in one page
```

---

**Next:** if you have never read this project before, go to
[33_README.md](./33_README.md), then [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md).
If you are about to write code, go to [32_AI_CODING_AGENT_RULES.md](./32_AI_CODING_AGENT_RULES.md).
If you are about to start work, go to [30_DEVELOPMENT_PHASE_PLAN.md](./30_DEVELOPMENT_PHASE_PLAN.md) and begin at **Phase 0**.

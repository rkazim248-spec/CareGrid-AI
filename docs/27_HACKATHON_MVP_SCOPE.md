# 27 — Hackathon MVP Scope

**Project:** CareGrid AI
**Document type:** The cut-line. What is in, what is out, what gets dropped first, and what the story becomes after each drop
**Status:** Baseline v1.0 — normative for the demo cut-line
**Related documents:** [01 PRD §5, §9](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) · [02 TRD §1 constraints](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) · [18 Testing & QA Plan §11, §18](./18_TESTING_QA_PLAN.md) · [28 Future Roadmap](./28_FUTURE_ROADMAP.md) · [29 Demo Scenario](./29_DEMO_SCENARIO.md) · [30 Development Phase Plan](./30_DEVELOPMENT_PHASE_PLAN.md)

> **Anchor rule.** Every FR ID, every P0/P1 priority, and every "explicitly out of scope" claim in this document is taken from [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md). This document decides **what gets built in 36 hours**, not what the product is. The product is the product; the MVP is a cut-line through it, and the cut-line is a temporary condition, not an architecture.

---

## 0. The one idea

> **A demo is a story, not a feature list.**

A judge watching 3–5 minutes is not scoring a requirements-coverage matrix. They are answering one question: *did these people solve a real problem, and do they understand their own system?* Everything in this document is organised around producing that answer with the least possible wasted work.

The consequence, applied ruthlessly throughout:

| Principle | What it means in practice |
| --- | --- |
| **A story needs a beginning, a turn, and a resolution** | The demo is: *something bad happens* → *the system turns chaos into a queue* → *a human sends the right person* → *the record survives as data*. The duplicate-detection beat is the **turn** — it is the moment the audience realises the system is not a form with a database behind it. It is protected accordingly. |
| **Every beat must be load-bearing** | A feature that does not appear in the demo and is not required for the demo to be *honest* is not built. That is the entire test. |
| **Specific beats beat broad ones** | "Six people report the same accident" is a story. "Structured logging with request IDs" is a feature list. Log the first, implement the second, and mention the second only in Q&A. |
| **A visible weakness you name beats a visible weakness you hide** | The fallback badge, the "needs review" state, the list fallback, the honest $0 claim — these are assets, not liabilities. See §10. |
| **The demo is the last 10 % of the work** | The first 90 % is making the story *true*. Feature work that does not reach a demo beat is unfinished work. |

### 0.1 What the 3–5 minutes must prove

| # | The audience must leave believing | Proved by | If it is not proved |
| --- | --- | --- | --- |
| P1 | This solves a real, felt problem, not a hypothetical one | the persona-based story: a citizen, a dispatcher, a responder, each with a job the product changes | the project reads as a CRUD demo over a table |
| P2 | The AI is **decision support**, not decision-maker | the AI panel shows model, prompt version, confidence, and the plain-language explanation; the dispatcher then *changes* something the AI said, in one click | the single most dangerous failure mode: a judge believing the AI auto-dispatches |
| P3 | The system is **safe under messy reality** | duplicate detection, a fallback badge, a "needs review" state, `LOCATION UNKNOWN` | the system looks like it only works on clean input |
| P4 | It is **fast** | the report is in the dispatcher's queue within 3 s, with no refresh, and the responder's status change is on the dispatcher's screen within 3 s | realtime is invisible without saying the word "realtime" |
| P5 | It is **secure by construction** | four roles, one-click role change with a reason, an audit log with no edit affordance, responder payloads that literally do not contain the citizen's name | "we have roles" is a claim; "the responder's network payload has no reporter field" is evidence |
| P6 | It costs **$0** to run, honestly | a real line-by-line argument, including the one place that could cost money | the $0 claim is worth nothing if it is not defended |
| P7 | The team **knows its own weaknesses** | naming three known weaknesses unprompted, in Q&A | every team has weaknesses; the differentiator is whether they know which |

---

## 1. MUST HAVE — the 15

All 15 are P0 in [01 §5](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) or are the load-bearing part of one. Effort is **ideal hours**: person-hours for a developer who already has the toolchain, the docs, and the codebase conventions, with no coordination overhead. It includes the unit and integration tests that cover the slice. The 15 sum to **31.5 ideal hours**; see §3.2 for how that relates to the phase plan's 44.0.

| # | Feature | FR coverage | Phase | Owner role | Ideal h | Demo-critical | Definition of done **for the demo** |
| --: | --- | --- | :-: | --- | --: | :-: | --- |
| 1 | **Auth: 4 roles, session, server-authoritative role** — email/password + Google, `citizen`/`responder`/`dispatcher`/`admin`, role read from `users/{uid}.role` on every request, claim mirror, drift → `403 ROLE_MISMATCH` | FR-001, FR-130…FR-133, FR-136, NFR-015 | 2 | all four; owned by `admin` | 2.0 | **Yes** | Three browser profiles are signed in simultaneously as `citizen`, `dispatcher`, `responder`. A citizen deep-linking to `/dashboard` gets the 403 `ForbiddenState`, not a redirect loop and not data. `GET /api/me` returns a server-computed `permissions[]`. The admin account exists via `scripts/create-admin.ts`. |
| 2 | **Text report → incident** — the create form, the validation floor, the success screen, the tracking page | FR-002, FR-003, FR-004, FR-010, FR-011, FR-014, FR-017, FR-019, FR-145 | 3 | `citizen` | 2.0 | **Yes** | A citizen types ≥ 20 characters on a 360 px viewport, one-handed, in under 30 s with the keyboard closed. The submit button is disabled with a linked reason below 20 characters. Submit returns `201`, the success heading has `role="status"` and takes focus, `CG-XXXXXX` is shown with a copy button, and `/track?ref=` renders category, urgency, status, last update, and a "what happens next" line. |
| 3 | **Photo report + direct-to-Storage upload** — 3 images, ≤ 5 MB, signed `PUT`, magic-byte verification, staged then claimed | FR-005, FR-007, FR-008, FR-006 (gate) | 5 | `citizen` | 2.0 | **Yes** | A JPEG attaches with per-file progress, the submit button is disabled while any upload is in flight, and the object lands at `incidents/{id}/reports/{reportId}/{mediaId}.{ext}`. A `.png` containing JPEG bytes is rejected **on its own chip** and the other file plus the text survive. A 3-image submission's `POST /api/incidents` body is under 100 KB — bytes never transit the function. |
| 4 | **AI triage** — structured output, `.strict()` Zod, one repair, deterministic fallback, confidence banding, the AI panel | FR-020…FR-029, NFR-004 | 4 | `dispatcher` | 3.5 | **Yes** | A submitted report is classified and given an urgency before it is visible in the queue. The AI panel shows `model`, `promptVersion`, `confidence`, and a plain-language `explanation`. A row with `aiConfidence < 0.60` shows a **Needs review** badge. With `GEMINI_API_KEY` deliberately invalid, the incident is still created with `triageSource: "fallback"`, `urgency: "medium"`, and a visible **Fallback triage** badge. An injection attempt adding a `dispatch` key fails strict validation and never reaches Firestore. |
| 5 | **Location** — explicit geolocation request, accuracy grading, pin drop, address text, reverse geocoding, `LOCATION UNKNOWN` | FR-030…FR-037, FR-039 | 6 | `citizen`; consumed by `dispatcher` | 2.5 | **Yes** | No geolocation prompt on page load. **Use my current location** requests once, and the accuracy badge reads **High accuracy** for ≤ 50 m. Denied permission offers exactly three options (pin / address / continue without). A no-location incident is flagged `LOCATION UNKNOWN` in the queue, the detail header, and the map, and sorts above `low`-accuracy rows. `placeName` appears; the street-level value is never sent to the model. |
| 6 | **Duplicate detection + human-confirmed merge** — 500 m, 6 h, category group, Jaccard text similarity, one candidate query, breakdown, link / dismiss / undo | FR-040…FR-049, DEC-01, DEC-02, DEC-03 | 3b | `dispatcher` | 2.5 | **Yes** | The live demo report, ~140 m and ~3 min after a seeded report with the same category and similar wording, is classified `confirmed_duplicate` (or `potential_duplicate`) **by the real algorithm**, and the response carries the `breakdown` (`distanceM`, `timeDeltaMin`, `categoryMatch`, `textSimilarity`, `matchedKeywords`, `algorithmVersion`). The dispatcher panel reads "Possible duplicate of CG-XXXXXX (140 m, 3 min earlier, same category)" with **Link report** and **Dismiss**. Merging appends the report, sets the secondary to `merged`, writes one audit row, and is undoable. The candidate search performs **exactly one** Firestore read (`TC-GEO-009b` fails at 10). |
| 7 | **Lifecycle state machine + status history + SLA** | FR-050…FR-058 | 3 | all four | 2.0 | **Yes** | All 11 statuses exist and the 11×11 transition table is enforced server-side with `409 INVALID_STATUS_TRANSITION` for every forbidden cell. Every accepted transition appends one `statusHistory` document **in the same transaction** with actor, from/to, reason, and `requestId`. `resolved` requires a `resolutionCode` from the 6 controlled values. The SLA meter reads `on_track`/`at_risk`/`breached` and a breach fires exactly one `sla_breached` notification. |
| 8 | **Dispatcher live queue** — filters, the default sort, the full row, optimistic actions with visible rollback, KPI tiles | FR-070…FR-078 | 8 | `dispatcher` | 3.5 | **Yes** | The queue shows every FR-072 field per row: reference, category icon, urgency badge, verification badge, AI confidence, status, distance, reporter count, age/SLA, assignee. Default sort is active → urgency → breached → newest, unassigned outranking assigned. Filters compose (`urgency=critical`, `unassigned=true`, free-text `q`) and an unknown filter parameter is **rejected**, not ignored. KPI tiles update live with per-tile as-of times. A rejected optimistic action rolls back visibly with a toast. |
| 9 | **Live map** — incident markers by urgency, responder markers by availability, side panel, list fallback, lazy chunk | FR-080, FR-081, FR-083, FR-085, FR-086, FR-087, FR-088 | 6 | `dispatcher` | 2.5 | **Yes** | The map renders incident markers coloured by urgency and **shaped** by status, with responder markers green/amber and `offline` hidden. Selecting a marker opens a side panel with **Open incident** without changing route. With `maps.googleapis.com` blocked, `MapListFallback` renders expanded, keyboard-operable, with coordinates and a **Retry map** action. `npm run check:bundle` proves no Maps code is in the `/dashboard` chunk. |
| 10 | **Responders: directory, verification, availability, heartbeat** | FR-060…FR-067, FR-069 | 7 | `responder`, `admin` | 2.0 | **Yes** | A `pending` responder's availability switch is disabled with "Your account is awaiting admin verification". An admin verifies with a reason (a reason-less attempt is blocked) and an audit row exists. A verified responder toggles `available` and the dispatcher's map reflects it within 3 s. A heartbeat is sent only while `available`/`busy` and the tab is visible, and the server rejects one that is under 20 s after the stored `capturedAt` with `429 HEARTBEAT_TOO_FREQUENT`. A `pending` responder is **absent** from the candidate list, not an error. |
| 11 | **Assignment + ranked candidates** — nearest-first, capability match, load, staleness, one active dispatch | FR-053, FR-065, FR-074, DEC-05 | 7 | `dispatcher` | 2.0 | **Yes** | `GET …/dispatch/candidates` returns ≤ 10 sorted by distance then `lastLocationAt` desc, each with distance, availability, capability match, `activeIncidentCount`/`maxConcurrentIncidents`, and a **stale location** badge sorted last. Assignment is one click, writes one `dispatches` doc, sets the responder `busy`, and produces exactly one `incident_assigned` notification. Two simultaneous assignments leave exactly one `active` dispatch; the loser gets `409 ALREADY_ASSIGNED`. |
| 12 | **Realtime propagation** — listener registry, ≤ 8 listeners, mandatory unsubscribe, reconnect, no polling anywhere | FR-090…FR-096, FR-098, FR-099, NFR-006, NFR-007 | 8 | all four | 1.5 | **Yes** | A status change is on the dispatcher's screen in **under 3 s**, with a row highlight that respects `prefers-reduced-motion`, and **no refresh**. The registry refuses a 9th listener. `/dashboard` uses exactly 4 listeners, the responder dashboard 3, `/report` **0**. `/login`, `/signup`, and `/track` create zero listeners and zero Firestore reads. Going offline shows a persistent **Reconnecting…** banner and re-subscribes automatically. Analytics creates no listener. |
| 13 | **In-app notifications + bell** — 12 types, recipient-only, dedupe key, unread count | FR-100…FR-104, FR-107, FR-108 | 9 | all four | 1.0 | **Yes** | An assignment produces a `critical` notification on the responder's device within 3 s with a persistent banner and an **Open in maps** action. The bell's accessible name includes the unread count; mark-read and mark-all-read work, and mark-all over 200 returns `422 BATCH_TOO_LARGE` and the client pages. There is **no** `?recipientUid=` parameter, and another user's notification is unreadable and unmarkable. A double-dispatched assignment produces exactly one notification. |
| 14 | **Analytics** — KPI tiles, category distribution, daily/weekly trend, precomputed rollups, CSV export | FR-110, FR-111, FR-112, FR-116, FR-117, FR-118 | 9 | `dispatcher`, `admin` | 2.0 | **Yes** | Tiles show total/active/critical/resolved, cancellation and false-alarm rates, mean time to verify/dispatch/resolve, and SLA compliance %. The category chart and the trend chart render, each with a working **View as table** alternative. A range ending more than 48 h ago reports `source: "rollup"` and costs 1 read per day; a range ending within 48 h reports `source: "live"`, caps at 500 reads, and sets `truncated: true` when capped. A citizen requesting analytics gets `403`. CSV export contains no reporter identity, no IP hash, and no free text. |
| 15 | **Audit log + admin** — append-only log, role change with a reason and a two-step confirm, responder verification queue, config with a reason | FR-130…FR-136, FR-063, FR-133 | 7 | `admin` | 1.5 | **Yes** | Every privileged action writes exactly one `auditLogs` row with actor uid, actor role, action, entity, before/after, `requestId`, hashed IP, and user agent. **No role, including `admin`, can update or delete an audit row**, and there is no edit or delete affordance anywhere in the admin UI. A role change requires a reason ≥ 10 characters and a second confirmation naming the user; an admin targeting themselves gets `400 SELF_ROLE_CHANGE_FORBIDDEN`. A `config` change takes effect for new incidents with no redeploy. |

**Totals: 15 features · 31.5 ideal hours · 15/15 demo-critical.**

> **Why 15 are all demo-critical, and what that means.** "Demo-critical" does not mean "appears on stage". Items 1, 3, 10, 11, 13 and 15 are the *setup* the stage depends on, not the performance. If item 1 is not built, there are no three windows. If item 10 is not built, there is nobody to dispatch. The honest test for a demo-critical item is: **if it is missing, does the demo fail, or does the demo have to be narrated around?** Only 15 items pass that test in 36 hours.

---

## 2. NICE TO HAVE

Ordered by *demo value per hour saved*, best first. Every one of these is P1 in [01 §5](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) or is a P1 requirement surfaced in the anchor documents. None is a MUST HAVE.

| # | Item | FR | Est. ideal h | Demo value if built | Cost / risk if attempted | **Cut first if behind schedule** |
| --: | --- | --- | --: | --- | --- | --- |
| N1 | **Response-time histogram** bucketed by urgency, p50/p90 per urgency | FR-113 | 0.75 | Medium — a third chart in an analytics pane judges will not read for 20 s | Low cost. Recharts histogram is not a new pattern. Risk: a chart with 0 data points looks broken; needs an empty state | **Yes — first.** The trend chart carries the analytics beat alone |
| N2 | **CSV export** of the current incident filter | FR-118, FR-059 | 0.5 | Low on stage; high in Q&A ("can I take this to an authority?") | Low cost. Risk: the `'`-prefix CSV-injection mitigation is easy to forget, and a reviewer who finds an unescaped `=` in an exported cell will say so | **Yes.** Q&A can honestly say "the endpoint exists and is tested; it is not on the stage" |
| N3 | **Marker clustering** above 20 markers, toggleable | FR-082 | 0.5 | Medium — a nice "look, it scales" moment | Low cost. **Risk: the marker library is the one place a bundle budget blows up** (B-3, ≤ 180 KB lazy) | **Yes.** The demo has ~9 markers, below the threshold, so it would not even fire |
| N4 | **Risk zones** — named zones with a 0–100 heuristic score on the map | FR-114, FR-115 | 1.0 | High *if* it is explained; zero if it is not | Medium cost: a second map layer, a recompute path, a config flag, and an empty state. **Risk: the score is a heuristic (DEC-13) and a judge who reads the formula asks for its calibration.** Also needs the heatwave cluster to exist first | **Yes.** It is a Horizon-1 item with a formula and no data behind it |
| N5 | **Bulk verify / bulk false-alarm** on selected rows | FR-077 | 0.5 | Low on stage; credible in Q&A | Low cost. Risk: `writeBatch` ≤ 200 and the 422 paging path; a bulk action that half-succeeds is a worse story than no bulk action | **Yes** |
| N6 | **Self-claim dispatch** — a responder claims an open dispatch | [08 §5.2](./08_API_SPECIFICATION.md) | 1.0 | Medium — "responders can self-dispatch" sounds operationally real | Medium cost: a new claim transaction, three new error codes, expiry interaction (`TC-FR-069d`) | **Yes.** Dispatcher-driven assignment is the actual demo beat |
| N7 | **Voice reporting** — `MediaRecorder` → audio evidence → Gemini transcription | FR-006, US-003 | 1.5 | **High** — a garbled voice note triaged correctly is a memorable demo beat | **High cost and high risk.** The most fragile MIME path in the browser matrix; `audio/webm` vs `audio/ogg`; iOS has no `getUserMedia` audio on some versions; audio inflates the AI payload, the latency, and the quota consumption. `GEMINI_AUDIO_ENABLED=false` is a one-env-var escape hatch ([02 DR-07](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) | **Yes — but only after N1–N6 and only if the browser matrix has been tested on the actual demo laptop** |
| N8 | **Advanced heatmaps** — a density overlay rather than discrete risk zones | — | 2.0 | High on stage; expensive to build | **High cost.** A heatmap layer is a new render path, a new data source (it must not be a client-side scan — that is a read-budget violation), and a bundle cost. **Risk: it competes with the map for the same lazy chunk budget** | **Yes.** Risk zones (N4) are the cheaper 80 % of this idea |
| N9 | **Advanced analytics** — p50/p90 by urgency, SLA compliance over time, reporter-contribution views | FR-113, FR-114 | 2.0 | Medium | Medium cost. **Risk: at 9 incidents most analytics are noise, and a chart that shows 3 data points invites "what is this telling me?"** | **Yes.** The honest move is to say the rollups are built and the data volume is not there yet |
| N10 | **SMS notifications** through a `NotificationChannel` provider | FR-105 | 2.0 | Medium — "the responder got a text" | **High cost and a $0 risk.** Requires finding a genuinely free provider with a real free allowance, or the $0 claim dies. `ENABLE_SMS_NOTIFICATIONS=false` is correct | **Yes** |
| N11 | **WhatsApp notifications** | FR-106 | 3.0+ | High on stage | **Very high cost and it is a P2.** The WhatsApp Business Cloud API requires a registered business account and a Meta app review ([01 FR-106](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md)). A review cycle cannot complete in 36 hours. `FR-013` and `FR-016` are **reserved** and must not be reused | **Yes — never.** It is not a scheduling decision; it is an external dependency with a review queue |
| N12 | **PWA installability + web push** | PRD §10, [02 §6.11](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) | 1.5 | Low — "you can install it" | Medium cost. **Risk: a service worker caching the wrong asset is a class of "works locally, broken on deploy" bug that costs 2 hours to diagnose** | **Yes** |
| N13 | **Do-not-disturb windows** per user, honoured by the notifier | — | 1.0 | Low | Medium cost: a preference, a config field, a filter in the dispatcher, and a test for the interaction with `sla_breached`, which **must not** be suppressed | **Yes** |
| N14 | **Light mode** | [04](./04_UI_UX_DESIGN_SPECIFICATION.md) | 2.0 | Low — the operational default is `dark` | **High cost for low value.** A second complete token set, a second axe pass, a second visual review, a doubled contrast-matrix verification, and a doubled chance of shipping a contrast bug | **Yes.** `NEXT_PUBLIC_MAP_STYLE=dark` is the operational default; dark-only is a defensible design decision, not a shortcut |
| N15 | **The 500 m duplicate-radius ring on the map** | FR-084 | 0.25 | Medium — it visualises the dedup radius, which is the demo's turn | Very low cost (a circle) | **Last to cut.** It is 15 minutes of work for the clearest visual explanation of the most important algorithm |

**Nice-to-have total: 19.25 ideal hours.** Against a surplus of ~7.8 ideal hours (§3.2), the realistic outcome is **N15 + N1 + N2 + N3** ≈ 2.5 hours, plus contingency. The rest are a Horizon-2 backlog ([28](./28_FUTURE_ROADMAP.md)).

### 2.1 Feature flags that make the cut free

Eight of the fifteen nice-to-haves can be toggled off at runtime with **zero** refactoring, because the anchors already define the flags:

| Flag | Gates | Where |
| --- | --- | --- |
| `ENABLE_VOICE_REPORTING` | N7 | [21 §2](./21_ENVIRONMENT_VARIABLES.md) |
| `GEMINI_AUDIO_ENABLED` | N7 | [09 §12](./09_AI_GEMINI_SPECIFICATION.md) |
| `ENABLE_RISK_ZONES` | N4 | [21 §2](./21_ENVIRONMENT_VARIABLES.md) |
| `ENABLE_SMS_NOTIFICATIONS` | N10 | [21 §2](./21_ENVIRONMENT_VARIABLES.md) |
| `ENABLE_WHATSAPP_NOTIFICATIONS` | N11 | [21 §2](./21_ENVIRONMENT_VARIABLES.md) |
| `ENABLE_MAINTENANCE_JOBS` | the maintenance jobs (demo day) | [21 §2](./21_ENVIRONMENT_VARIABLES.md) |
| `config.app.features.bulkActions` | N5 | [07 §11.8](./07_DATABASE_SCHEMA.md) |
| `config.app.features.clusters` | N3 | [07 §11.8](./07_DATABASE_SCHEMA.md) |

> **The feature flags are the cheapest risk reduction available in the project.** Building N4 or N5 behind an existing flag costs the flag read and nothing else, and turning it off on demo day is an env change, not a code change. Build them flag-gated even if the feature is uncertain.

---

## 3. Explicitly out of scope for the hackathon

Each of these is excluded in [01 §9](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) or is a natural extension. "Where it goes instead" points at a horizon in [28](./28_FUTURE_ROADMAP.md).

| Item | Why it is out | Where it goes instead |
| --- | --- | --- |
| **Native mobile apps** | App-store review latency alone exceeds the entire hackathon. Doubling the frontend surface is a bigger risk than the capability is a benefit. PRD §9 | 28 H2-3 |
| **Multi-tenant / multi-city federation** | Single-city deployment in v1. Multi-tenant changes every query, every index, every auth boundary, and the rate-limit subject. That is a re-architecture, not a feature | 28 H3-5 |
| **Offline full sync** | Conflict resolution for a safety-relevant write is a *distributed systems* problem with a merge policy that needs domain input. v1 has a local draft (FR-014) and a FIFO responder action queue (US-014) — deliberately bounded | 28 H2-4 |
| **Machine-learned risk prediction** | No labelled data exists. DEC-13 accepts a heuristic (density × severity × recency). Training a model on 9 incidents produces a number with no meaning, and claiming it does would be dishonest | 28 H3-1 |
| **Government emergency-service integration** | Regulatory and integration complexity; DEC-05 forbids the AI dispatching anything, and [09 §6.4](./09_AI_GEMINI_SPECIFICATION.md) requires a human actor with an `actorUid` in `dispatches.dispatchedBy`. A statutory integration needs a memorandum, an API agreement, and probably months | 28 H2-1 |
| **Internationalised UI** | English-only in v1. FR-004 records the detected input `language` as **data**, which is the cheap, correct first step. A translation surface with one locale is a cost with no reader | 28 H2-5 |
| **Video evidence** | Size and cost, and the 4.5 MB body limit makes the direct-to-Storage path the only option — at which point the client-side downscale and the Gemini payload budget both become the real problem. Images + audio only | 28 H3-4 (as *ingest*, not as user-uploaded video) |
| **Telephony IVR** | Cost, and it inverts the product thesis. A phone-tree for people who cannot use the app is a different (and legitimate) product | 28 H2-6 |
| **Payments / donations / insurance** | Out of product scope ([01 §9](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md)). It is also a compliance surface (PCI, KYC/AML) that has nothing to do with the routing thesis | Not on the roadmap; if a funder needs it, it is a separate product decision |
| **Public anonymous reporting** | DEC-10. Accountability and abuse prevention both require an identity. A moderator-reviewed anonymous tier is a real design (see 28 H2-1's human-in-the-loop section) but not a 36-hour one | 28 H2-1 (as an escalation-review concept, not anonymous intake) |
| **Presence ("who is viewing this incident")** | FR-097 is P2 and explicitly optional. A heartbeat doc for presence is cost with no demo value | Not built |
| **More than 11 incident categories** | DEC-12. A controlled list prevents taxonomy drift. A 12th category with one incident in it is a worse filter, not a better one. See §9 anti-goals | — |
| **A command palette** | [20 S1](./20_PROJECT_FOLDER_STRUCTURE.md): blocked by an open product decision ([04 D1](./04_UI_UX_DESIGN_SPECIFICATION.md)). Kept as a documented stub returning `null`, excluded from the route tree. **Not** built speculatively | [04](./04_UI_UX_DESIGN_SPECIFICATION.md) D1 |
| **A virtualised table** | [20 S1](./20_PROJECT_FOLDER_STRUCTURE.md): blocked by an open decision ([05 F4](./05_FRONTEND_ARCHITECTURE.md)). Documented stub | [05](./05_FRONTEND_ARCHITECTURE.md) F4 |
| **Redis, a job queue, a server-state cache, an ORM, GraphQL, Storybook, Docker, Terraform, Sentry, `sharp`, Moment/Day.js** | [02 §6](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) is normative: each is excluded with a stated reason. Adding any of them requires a §13 decision-register entry | [28](./28_FUTURE_ROADMAP.md) H1/H2 where relevant |

---

## 4. The cut ladder — the most valuable part of this document

> **The rule that governs everything below: cut ≠ fake.** A cut is a smaller, still-true demo. Faking is showing something the system did not do. If the demo degrades, it degrades **loudly and honestly** — the narration says "we are running on the keyword fallback now, and here is the badge that tells you so". A demo that is smaller but honest beats a demo that is bigger and false, every time, and the difference is only visible to someone technical — who is exactly who is in the room.

### 4.1 The two decision points

| Gate | Clock | Who decides | What they look at |
| --- | --- | --- | --- |
| **G1 — T−6 h** | `T+30` | all three developers, 15 minutes, standing | the §4.2 ladder, the demo beat list, and the *demo-critical* column |
| **G2 — T−2 h** | `T+34` | whoever is driving the demo, alone, 5 minutes | §4.3 last resorts |

Between G1 and T−2 h, **only bug fixes**. A feature started after G1 does not ship; it is half-built on the final deploy. This is the single most important process rule in the document and it is the one most often broken.

### 4.2 T−6 h: the drop order

Drop in this order. Each row states what is dropped, what it saves, and **what the judge narrative becomes** — because a drop that changes the story is a decision, and a decision has to be made deliberately.

| Cut | Drop | Saves | Demo-critical? | **The narrative after the cut** |
| --: | --- | --: | :-: | --- |
| **1** | N11 WhatsApp | 3.0 h | No | Nothing changes on stage. In Q&A: "WhatsApp needs a Meta business account and an app review — we scoped the channel interface and shipped no provider, deliberately, because we did not want a review queue in a 36-hour build." *This is a stronger answer than a working integration would be, because it shows the constraint was understood.* |
| **2** | N14 light mode | 2.0 h | No | Nothing changes. The console is dark, and dark-only was a design decision for an operations tool, not a shortcut. |
| **3** | N12 PWA / web push | 1.5 h | No | Nothing changes. Drop the install prompt from the narration entirely; never mention a capability that is not there. |
| **4** | N10 SMS | 2.0 h | No | The assignment notification is in-app and on the responder's screen within 3 s. That is the beat. SMS is a channel behind an interface with no provider, and a paid one would break the $0 claim. |
| **5** | N8 advanced heatmaps | 2.0 h | No | The map still shows live incident markers and responder markers. If asked about density: "we compute a per-cell risk score server-side; today it is a heuristic with nine incidents behind it, and we would rather show you a formula than a colour gradient with no calibration." |
| **6** | N9 advanced analytics | 2.0 h | No | The analytics beat becomes: the KPI tiles plus the category chart. "A 30-day view costs about thirty reads because it is served from precomputed daily rollups — that is the design decision, and it is the one that keeps us inside the free tier." *The read-budget argument is worth more than the third chart.* |
| **7** | N4 risk zones | 1.0 h | No | The heatwave cluster still exists in the seed data, so the category chart shows a real distribution with a real spike. "The cluster is in one geohash cell, which is exactly the granularity the risk score is computed at." |
| **8** | N6 self-claim dispatch | 1.0 h | No | Assignment is dispatcher-driven, which is the correct operational story anyway: a control room allocates scarce responders, it does not let them self-serve. *This cut improves the narrative.* |
| **9** | N5 bulk actions | 0.5 h | No | One click per incident. "Bulk actions are behind a feature flag and we chose not to spend the last hour on them." |
| **10** | N3 marker clustering | 0.5 h | No | ~9 markers, below the 20-marker threshold, so it would not have fired anyway. The bundle budget is met without it. |
| **11** | N2 CSV export | 0.5 h | No | In Q&A only: "the export endpoint exists, is tested, and deliberately has no reporter identity in it." The *absence of PII in the export* is a better answer than showing a download button. |
| **12** | N1 response-time histogram | 0.75 h | No | The analytics beat is tiles + category + trend. |
| **13** | N7 voice reporting | 1.5 h | No | Text + photo. "Voice is our highest-value P1 and our most fragile: the audio MIME path differs across Chromium, Firefox, and iOS, and it inflates the AI payload and the quota. We shipped the `MediaRecorder` feature-detect and the gate, and we left the flag off." |
| **14** | N15 the 500 m radius ring | 0.25 h | No | The duplicate beat loses its circle. It keeps the numbers — "140 metres, 3 minutes, same category, 0.73 text similarity" — which are more convincing than a circle. |
| **15** | **Photo reporting** (item 3) | 2.0 h | **Becomes No** | **The narrative changes shape.** "Text in, structured incident out, in under ten seconds." The AI beat is unchanged — Gemini is called on text alone, and the latency improves, which makes the demo *faster*. The evidence panel shows a placeholder. **State it: "we cut image upload in the last six hours to protect the core pipeline."** A team that names its cut is more credible than a team with a half-working uploader. |
| **16** | **The live map** (item 9) | 2.5 h | **Becomes No** | **This is the strongest possible cut, and it should be considered early.** The narrative becomes: "Here is the dispatcher queue — the operational picture does not need a map to be useful. Our map is lazily loaded, it is not in the dashboard bundle, and every map surface has a list fallback. We are showing you the fallback on purpose." A team that demonstrates its own degradation path is more persuasive than a team that shows a map. **Pre-built:** a static PNG of the seeded incidents over the metro-gate area, captured at rehearsal, captioned "same data, list view". |
| **17** | **Analytics entirely** (item 14) | 2.0 h | **Becomes No** | **The narrative loses a beat, which is why this is second-to-last.** Replace it with the SLA meter and the status history on the incident detail: "every transition is appended with the actor and a request id, and it is retained for the life of the incident — that is what the analytics is built on." The *data* is on screen even without the charts. |

**After all 17 cuts, the remaining demo is:** four roles and role-gating → text report → AI triage with category, urgency, and confidence → location with an accuracy badge → **live duplicate detection with a human-confirmed merge** → the dispatcher queue → ranked candidates → assignment → realtime propagation → responder lifecycle → resolve → the incident timeline with the SLA meter → the audit log. That is **11 of the 14 demo beats**, and it contains the turn (duplicates) and the resolution (resolve + audit). It is a complete story.

### 4.3 T−2 h: last resorts

In order. Each of these is a presentation change, never a correctness change.

| # | Situation | Action | Time | Honest framing |
| --: | --- | --- | :-: | --- |
| L1 | A primary journey is flaky, not broken | Run it **once more**; if it passes, stop touching it | 5 min | — |
| L2 | The AI is slow or the quota is low | Run the demo on the keyword fallback and say so at beat 3 | 0 min | "The AI quota guard tripped, so triage is running on the deterministic keyword path. The badge says **Fallback triage** and the confidence is capped at 0.55 by design, so it is badged **Needs review**. Reporting never failed — that is the requirement." |
| L3 | The live duplicate detection is unstable (network, latency) | Show the **stored** `duplicateBreakdown` on the seeded incident's detail page | 20 s | "This is the breakdown the real algorithm stored when this report was created: 140 metres, 3 minutes, same category, 0.73 similarity. We are reading the stored record rather than creating a new one, because the network in this room is not ours." |
| L4 | The live report submission is slow | Type the text **ahead of time** in a second tab, then paste | 5 s | Do not fake a submit. If a submit is pre-filled, say "I have typed this in so we can spend the time on the response" — that is a legitimate demo technique |
| L5 | One browser profile will not sign in | Reduce to **two** windows (citizen + dispatcher) and narrate the responder side from the dispatcher's live view | 0 min | "The responder's status change arrives here within three seconds — you can see it land in the queue." The realtime beat survives with one viewer. **Two windows, not one.** |
| L6 | A Firestore listener is not updating | Refresh once, and say the word "refresh" out loud | 2 s | "That is a manual refresh. Without it this arrives in about a second and a half. The number in our performance budget is 1.5 seconds p95 commit-to-paint, and the requirement is 3." |
| L7 | The map will not load | The list fallback **is** the demo | 0 min | Already rehearsed as a drill ([29](./29_DEMO_SCENARIO.md)). Say: "Maps are off — deliberately, so you can see the degradation path." |
| L8 | Everything is on fire | Run the **60-second version** ([29 §9](./29_DEMO_SCENARIO.md)) | 60 s | One sentence of context, one report, one assignment, one status change, one resolve. The story survives at 60 seconds. |

**Never, at any gate:**

- Do not pre-record a screen and present it as live. If a recording is used, say "this is a recording from yesterday's rehearsal, because the network here is unreliable."
- Do not remove a "needs review" or "fallback" badge to make the AI look better. The badge is the product.
- Do not disable rate limiting, CSRF, or a rule to make a flow work. If a rule blocks the demo, that is the highest-priority bug in the room.
- Do not hard-code a demo incident's triage result. If the AI is unavailable, the fallback computes it honestly.
- Do not promise a number on stage that has not been measured. "Under 3 seconds" is safe; "300 milliseconds" without a measurement is not.

---

## 5. Time budget

### 5.1 Capacity arithmetic

```
Team                          3 developers
Event window                  36 h elapsed
Sleep + setup                 −4 h per person  ⇒  32 productive hours each
Gross person-hours            3 × 32            =  96
Coordination, review, standup −8 h (≈ 2.7 h/person)
Usable person-hours                                 =  88
Ideal → actual multiplier      × 1.7   (integration, debugging, review, rework)
                                               ⇒  ≈ 51.8 ideal hours of capacity
```

**The 1.7× multiplier is not a guess dressed as a number.** It is the observed ratio between an honest task estimate and wall-clock effort for work that spans a database, an API, a framework with strict boundaries, and a browser, built by someone who did not write the spec they are implementing. Track it during the event: if the observed ratio at T+12 h is above 1.9, the plan is already behind and cut at G1 will be aggressive.

### 5.2 Consumption

| Block | Ideal hours | Source |
| --- | --: | --- |
| Phase 0 — documentation approval, toolchain, repo, CI skeleton, lint/format config | 3.0 | [30 §3](./30_DEVELOPMENT_PHASE_PLAN.md) |
| Phase 1 — UI/UX bring-up (design system, shell, badges, layout) | 3.5 | " |
| Phases 2–9 — the 15 MUST HAVEs | 31.5 | §1 of this document |
| Phases 2–9 — the non-feature remainder (emulator wiring, rules v1, indexes) | 2.5 | [30](./30_DEVELOPMENT_PHASE_PLAN.md) |
| Phase 10 — security, `npm run verify` green, the test infrastructure that is not feature-adjacent | 5.0 | [30](./30_DEVELOPMENT_PHASE_PLAN.md) |
| Phase 11 — deployment, integration verification, rehearsal, demo dataset | 4.0 | [30](./30_DEVELOPMENT_PHASE_PLAN.md) |
| **Plan total** | **48.5** | — |
| **Capacity** | **≈ 51.8** | §5.1 |
| **Surplus** | **≈ 3.3** | — |

> **The surplus is 3.3 ideal hours. That is roughly one nice-to-have and a contingency — not nine nice-to-haves.** This arithmetic is the reason §4.2 exists. A plan that "should fit" with a 19-hour nice-to-have list has already failed; the list is a *menu for the last three hours*, not a backlog for the event.

### 5.3 Hour-by-hour allocation

`T0` = event start. Hard stops are non-negotiable and are stated as failures if missed.

| Clock | Phase | Dev A — **Backend & AI** | Dev B — **Frontend** | Dev C — **Infra, Map, Test** | **Hard stop** |
| --- | --- | --- | --- | --- | --- |
| **T+0 → T+2** | 0 | Approve [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md), [07](./07_DATABASE_SCHEMA.md), [08](./08_API_SPECIFICATION.md), [09](./09_AI_GEMINI_SPECIFICATION.md). **No feature code.** Install the toolchain, verify Node 22.11+, `npm ci`, create the repo skeleton, CI skeleton, `eslint.config.mjs`, `.prettierrc.json`, `.nvmrc` | Same reviews; read [04](./04_UI_UX_DESIGN_SPECIFICATION.md) and [25](./25_ACCESSIBILITY_RESPONSIVENESS.md) | Create the three Firebase projects; enable Auth providers; generate the service account; restrict the two Maps keys; **arm the budget alert**; write `.env.local` | **T+2 — docs approved or the plan is re-cut. No feature code has been written; this is the gate, and it is absolute.** |
| **T+2 → T+6** | 1, 2 | `validators/*`, `lib/api/{envelope,errors,schemas}`, `lib/env.ts` (boot validation), `lib/server/{firebase-admin,auth-guard,request-id,logging}` | Design system bring-up (shadcn, tokens, `globals.css`), app shell, `UrgencyBadge`/`StatusBadge`/`ConfidenceBadge`, `Sidebar`/`TopBar`/`BottomNav` | `firebase.json` + `.firebaserc`, emulator suite green, `firestore.indexes.json`, `firestore.rules` v1 | |
| **T+4 → T+8** | 2 | `services/auth/{bootstrap-user,claims}`, `POST /api/me/*`, `PATCH /api/admin/users/:id/role` | `/login`, `/signup`, `/forgot-password`, `SessionProvider`, role-gated nav, `ForbiddenState` | Auth emulator rules tests, `config/*` tables | **T+8 — a citizen can sign in and land on `/report`.** |
| **T+6 → T+12** | 3 | `services/incidents/create-incident.ts` (no AI yet), `lib/incidents/{lifecycle,sla,reference,allowed-next}`, the create transaction, `PATCH …/status` | `/report` form, text validation, submit-disabled-with-reason, success screen, `/track`, the local draft | Rules v1 + indexes deployed to `caregrid-ai-dev`; Storage bucket created | |
| **T+9 → T+14** | 4 | `services/ai/*` — `gemini.ts`, `triage.ts`, `prompts.ts`, `schema.ts`, `sanitize.ts`, `rules.ts`, `fallback.ts`, `explain.ts`, `provider.ts` | The "Analysing your report" state, the AI panel, confidence badges, the source badge | Mock adapter green; 50 adversarial fixtures; 10 golden files; the nightly real-AI harness | **T+14 — a report is triaged end to end, and the fallback path is proven.** |
| **T+12 → T+16** | 5, 6 | `services/uploads/{sign-upload,finalize-upload,signed-url,staging-sweeper}`, magic-byte sniff, `lib/geo/{haversine,geohash,geo-cells,accuracy-grade}`, the reverse geocode | Media chips + per-file progress, `useGeolocation`, `LocationBadge`, pin drop, the three-option fallback | Storage rules + CORS; `components/map/*` lazy chunk; `MapListFallback`; `NEXT_PUBLIC_MAP_*` | **T+16 — a photo report works and a denied-permission report works.** |
| **T+14 → T+20** | 3b | `lib/duplicates/score.ts`, `services/duplicates/{findCandidates,merge,dismiss,undo-merge}` — **one** candidate query | The duplicate panel, Link report / Dismiss, the citizen's "there may already be a report" message | The 499/500/501 m boundary suite; `TC-GEO-009b` (fails at 10 queries) | |
| **T+18 → T+24** | 7, 8 | `services/dispatch/{assign,candidates,claim,withdraw,expire-sweeper}`, `lib/firebase/listener-registry.ts`, `services/notifications/*` | `/dashboard` queue + filters + KPI tiles, `/incidents/[id]` with the timeline, the responder dashboard, availability toggle, heartbeat hook | The listener-budget tests, the transaction/race suite, the realtime propagation measurement | **T+24 — dispatch → realtime assignment → responder status change works.** |
| **T+22 → T+27** | 9 | `services/analytics/{query,rollup,recompute,export-csv}`, `POST /api/cron/[job]` | The notification bell and list, `/analytics` with the three charts and **View as table**, the CSV button | 3-viewer E2E, axe sweep, the responsive matrix at 5 viewports | |
| **T+27 → T+31** | 10 | `middleware.ts` (nonce CSP), CSRF, the Firestore rate limiter, the audit writer, secret/boot guards | 360/390/768 responsive fixes, the keyboard-only pass, the `copy.ts` strings | **`npm run verify` green**, the load rehearsal, `gitleaks`, the Lighthouse run, the visual diff review | **T+30 — FEATURE FREEZE. After this line it is bug fixes only, no exceptions.** |
| **T+31 → T+34** | 11 | Deploy rules + indexes to `caregrid-ai-prod`; the production Vercel deploy; env vars; §5.5 V1–V18 integration verification | Freeze the demo dataset; capture the fallback screenshot set; rehearse the failure drills | Budget/quota check, venue-network check, warm the routes | **T+33 — production verified. T+34 — rehearsal 1 complete.** |
| **T+34 → T+36** | 11 | Rehearsal × 2 against the real production URL | Rehearsal × 2, including the 60-second version | Final budget read, final quota read, the rollback path clicked once | **T+36 — DEMO. Nothing is deployed after T+34.** |

### 5.4 The hard stops, and what happens when one is missed

| Hard stop | Clock | If missed, the consequence is |
| --- | --- | --- |
| Documentation approved | T+2 | Everything after it is built on assumptions. The 31.5 hours of feature work are re-planned, not just delayed. **This is the only stop that is not recoverable by working later** |
| Citizen signs in | T+8 | Item 1 slips and the three-window demo collapses to one window |
| Triage works end to end | T+14 | The AI beat goes. Recoverable: cut to the fallback and narrate it (L2) |
| Photo report works | T+16 | Cut 15 fires |
| Dispatch → realtime works | T+24 | The middle of the story is missing. Cut 16 (map) and cut 17 (analytics) fire to buy the time |
| **Feature freeze** | T+30 | Everything downstream compresses. A demo built in the last 2 hours is a demo that fails in the last 2 hours |
| Production verified | T+33 | The demo runs on an unverified deployment. **The only acceptable response is to run the demo on the previous verified deployment** |
| Nothing deployed after | T+34 | The last action of the event is a change, which means the first thing that happens is a change |

---

## 6. Scope-creep policy

### 6.1 The 24-hour rule

> **A new feature may only be started if it can be finished, tested, and rehearsed within 24 hours. If it cannot, it is written down in [28](./28_FUTURE_ROADMAP.md) with a one-line motivation, and the team says so out loud in the next standup.**

Why 24 hours and not "if time permits": because "time permits" is unfalsifiable, and an unfalsifiable rule loses to enthusiasm every time. "24 hours" is checkable against a clock, and a checkable rule is the only kind that survives contact with a hackathon.

### 6.2 The four-question filter

Any "wouldn't it be cool if…" runs through this, in order, in under 60 seconds. Any **No** is a No.

| # | Question | A No means |
| --- | --- | --- |
| 1 | Does it appear in a **demo beat** in [29](./29_DEMO_SCENARIO.md)? | If no → Horizon. It is a great idea for a different document |
| 2 | Is it a **MUST HAVE** in §1? | If no → it is a nice-to-have, and nice-to-haves are on a menu worth 3.3 ideal hours |
| 3 | Can it ship **without touching `services/ai/*`, `lib/incidents/lifecycle.ts`, `firestore.rules`, or the auth pipeline**? | If it touches one of those four, the blast radius is larger than the feature. Say no, or say "after G1" |
| 4 | Does it **remove** work as well as add it? | If it only adds, it is a cost. Only add something that deletes something |

### 6.3 The park, do not kill

Scope creep is not a sin; **unrecorded** scope creep is. Anything cut goes somewhere durable, in this exact form:

```markdown
## Parked during the event (2026-09-26)
- **Feature:** one line.
- **Who wanted it:** who.
- **Why it was cut:** the actual reason — time, risk, an external dependency, a legal constraint.
- **Where it goes:** 28 H<n>-<n>, or "nowhere — we decided against it".
- **Trigger to revisit:** the concrete event that would make it worth doing ("≥ 5 000 labelled incidents", "a signed MoU with the fire service").
```

Two reasons this matters. First, the next person to have the same idea finds the decision instead of re-litigating it. Second, at Q&A "we cut X" is only credible if the team can say where it went — and a judge will ask.

### 6.4 The one-sentence enforcement

The demo driver has standing authority to say **"park it"** with no discussion, and no one may reopen a parked item before the event ends. This is a process rule, not a preference: the alternative is three developers optimising three different things and a demo that is three mediocre things.

---

## 7. Minimum data seed

The dataset is specified in [07 §14](./07_DATABASE_SCHEMA.md) and [18 §15.3](./18_TESTING_QA_PLAN.md), and it is written out in full — every user, every incident, every coordinate, every timestamp — in **[29](./29_DEMO_SCENARIO.md) §3**. This section states **why each element is required**; [29](./29_DEMO_SCENARIO.md) is the executable version.

| Element | Exact content | Why it is required |
| --- | --- | --- |
| **1 admin** | `admin@caregrid.demo` / "Arun Iyer", created out of band by `scripts/create-admin.ts` | The only path to an admin exists ([22 §8.1](./22_USER_ROLES_PERMISSIONS.md)). Its absence is invisible until the moment you need it |
| **2 dispatchers** | `meera@caregrid.demo` "Meera Rao" (the demo's dispatcher), `deepa@caregrid.demo` "Deepa Menon" | **Two**, so the realtime fan-out is visible: a change in one window must appear in the other. One dispatcher cannot demonstrate propagation |
| **4 responders** (3 verified, 1 pending) | `yusuf@caregrid.demo` "Yusuf Khan" (verified, available, ~635 m from the demo incident), `kiran@caregrid.demo` "Kiran B" (verified, offline, far away), `lata@caregrid.demo` "Lata Desai" (verified, available, farther — the *second* candidate), `manoj@caregrid.demo` "Manoj P" (pending) | The **pending** responder is what makes FR-064 visible: their switch is disabled and they are absent from the candidate list. **Two** available responders make the ranked candidate list a *ranking* instead of a single name |
| **6 citizens** | `priya@caregrid.demo` "Priya Nair" (the live demo reporter), plus 5 seeded | A responder's payload must demonstrably contain no citizen identity. That needs a real reporter with a real name and a real account |
| **3 geo-anchored incidents** | The primary `traffic_accident` (the duplicate partner), the live report's partner, and one unrelated resolved incident | The duplicate pair is mandatory — the demo's turn. A third incident proves the queue is a *queue* and not one row |
| **The 4-incident heatwave cluster** | 4 × `heatwave` inside **one** geohash-6 cell | Makes the category distribution a real distribution with a real spike, and it is the reason the duplicate engine must correctly return `separate_incident` for a same-cell, different-category report (FR-048). Two beats from one dataset |
| **12-entry `resources` catalogue** | `res_ambulance`, `res_first_aid`, `res_fire_engine`, `res_fire_extinguisher_team`, `res_police_support`, `res_traffic_control`, `res_heavy_tow`, `res_water_rescue`, `res_cooling_shelter`, `res_food_water_kit`, `res_search_team`, `res_power_team` | The AI's `required_resources` must reference a **closed** catalogue. An empty catalogue makes the resource beat look like a hallucination |
| **`config/app`** | Including `duplicateRadiusM: 500`, `duplicateTimeWindowMin: 360`, `textSimilarityConfirm: 0.60`, `slaMinutes`, `retention` | Every threshold the demo asserts is read from here, so the asserted numbers are the *configured* numbers |
| **14 days of `analyticsDaily` rollups** | `2026-09-13` … `2026-09-26`, with `completeness: "final"` for the days before today and `"partial"` for today | A 30-day analytics view costs ~30 reads because it is served from rollups. With no rollups the demo would either scan live (over budget) or show nothing |
| **Coordinates** | All within ~1.2 km of `17.4478, 78.4874` (a metro-gate service road in the Hyderabad/Secunderabad area) — the anchors used in [07 §4.6](./07_DATABASE_SCHEMA.md) and [07 §7.2](./07_DATABASE_SCHEMA.md) | Realistic places, close enough that 500 m is a meaningful radius and 140 m is a meaningful duplicate distance. A world-spanning dataset makes every distance meaningless |
| **Timestamps** | Seed-relative: the duplicate partner at T−3 min, the heatwave cluster spread over the previous 6 h, resolved incidents 1–3 days old, rollups for 14 days | If the seed is run more than 4 h before the demo, the 6 h duplicate time window and the heatwave cluster's recency decay both decay out of the story. The seed must be run **during** the 30-minute setup |
| **`users` + `responders` docs** | Complete per [07 §3](./07_DATABASE_SCHEMA.md) and [07 §7](./07_DATABASE_SCHEMA.md), with the responder custom-claim mirror set | A missing mirror produces `403 ROLE_MISMATCH` on stage, which is a 10-minute diagnosis in the worst case and a visible failure in the best |

**Guards on the seed:** `NODE_ENV !== 'production'` **and** `ALLOW_SEED=true` (FR-147). `lib/env.ts` throws at boot if `NODE_ENV === 'production'` and `ALLOW_SEED === 'true'`, so this is enforced in code, not by convention (TC-FR-147).

---

## 8. Demo-readiness checklist

Every line must be true **at T−30 min**. Anything false is either fixed in the 30 minutes or converted into a narrated workaround with the honest framing from §4.3.

### Data and accounts
- [ ] `ALLOW_SEED=true npm run seed` run **within the last 30 minutes**
- [ ] All 13 demo users exist and all four roles sign in
- [ ] The `pending` responder's switch is disabled with the documented explanation
- [ ] Three `verified` responders exist with locations; one is `available` and inside the demo incident's radius
- [ ] The duplicate partner exists at ~140 m / ~3 min earlier with the documented text
- [ ] The heatwave cluster is 4 incidents in one geohash-6 cell
- [ ] 14 days of `analyticsDaily` rollups exist, `final` for all days before today
- [ ] `resources` has 12 entries; `config/app` has the demo thresholds

### Build and deploy
- [ ] `npm run verify` green on the exact commit that is deployed
- [ ] `firestore.rules` and `storage.rules` deployed; the deployed rules hash equals the repo file
- [ ] All 11 `incidents` composite indexes are `READY` (none `BUILDING`)
- [ ] Production deploy is at the intended commit; `GET /api/health` returns `200` with all three checks `ok`
- [ ] `CRON_SECRET` set; `GET /api/cron/analytics-daily` without it returns `401`
- [ ] `ALLOW_SEED=false` in production, verified by attempting a seed
- [ ] Security headers present: CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`
- [ ] Routes warmed 15 minutes ago (cold start avoided)

### Function
- [ ] §5.5 V1–V18 all green against the production URL
- [ ] The 14-beat script rehearsed **twice** end to end, timed
- [ ] The 60-second version rehearsed once
- [ ] The responder's network payload inspected and confirmed to contain no reporter identity
- [ ] The map list fallback rehearsed (Maps blocked)
- [ ] The AI fallback rehearsed (`GEMINI_API_KEY` deliberately invalid)
- [ ] The offline banner + queued action rehearsed
- [ ] Duplicate boundary numbers read from a real response and matched against the script
- [ ] Lighthouse green on the three blocking routes

### Environment
- [ ] **Network throttling OFF** in DevTools on all three browser profiles
- [ ] Browser zoom at 100 % on all three; the projector or second screen is legible
- [ ] `NEXT_PUBLIC_MAP_STYLE`, `NEXT_PUBLIC_MAP_ZOOM_DEFAULT` and the map centre correct
- [ ] **Gemini pre-flight check** run: `GET /api/admin/system/health` shows success ≥ 95 %, fallback ≤ 5 %, headroom ≥ 50 %
- [ ] **Google Cloud budget alert armed** and the billing page read: zero charges
- [ ] Firebase usage read after the rehearsal: reads/writes under the allowance with headroom
- [ ] Provider status pages recorded at T−1 h
- [ ] Venue Wi-Fi tested; the offline path rehearsed on the venue's actual network
- [ ] **Fallback screenshot set** captured: the queue, the map (or its list view), the AI panel, the duplicate panel, analytics
- [ ] Demo passwords are in the presenter's password manager, **not** in the repository
- [ ] `docs/29_DEMO_SCENARIO.md` open on a second device at the demo beat table

### Team
- [ ] Roles assigned: one presents, one drives the browser, one watches the health/quota dashboards
- [ ] The three hardest engineering problems and the three known weaknesses each rehearsed aloud once ([29 §10](./29_DEMO_SCENARIO.md))
- [ ] One person owns "if something breaks, say so" — the honesty rule from §4

---

## 9. Anti-goals

Things that would look impressive and will cost the demo. Each entry states the trap and the specific thing to do instead, because "don't do X" is not an instruction.

| # | Anti-goal | Why it is a trap | Do this instead |
| --: | --- | --- | --- |
| A1 | **More than 11 incident categories** | A 12th category with one incident in it is a worse filter, not a better one. DEC-12 exists because taxonomy drift silently breaks every filter and every chart | Keep 11. If a judge proposes a 12th, agree enthusiastically and say it is a *config* change with a migration note, not a code change |
| A2 | **Extra chart types** in analytics | A judge glancing at a screen for 8 s reads the first two charts. The third is bundle cost (B-5, 110 KB) and review time | Two charts, each with **View as table**. The read-budget argument is worth more than a third chart |
| A3 | **Real-time voice in the demo** | It is the single most fragile path in the browser matrix, it consumes the AI quota fastest, and a codec failure on the demo laptop is a 5-minute dead end on stage | If it works, show it in 15 s. If it does not, the audio option is feature-detected away and the report still works. `GEMINI_AUDIO_ENABLED=false` is the escape hatch |
| A4 | **Polish on settings, profile, or the privacy page** | None of it is in a demo beat, and a polished settings page is evidence of having had time that was not spent on the queue | Ship the minimum that is *correct* (the privacy summary is FR-142/US-042, and it is one page) and nothing more |
| A5 | **A settings page for the 11 admin config keys** | US-033 requires the thresholds be editable with a reason. Building a beautiful config UI is a 2-hour item that never appears on stage | Ship the route with the documented ranges and Zod validation. No polish |
| A6 | **A marketing landing page with a hero video** | The public surface is a `page.tsx` under `(public)`. Every hour is a feature hour | One headline, one paragraph, the honest disclaimer from [09 §13](./09_AI_GEMINI_SPECIFICATION.md), and a link to sign in |
| A7 | **A dark-mode *and* light-mode theme** | Two complete token sets, two axe passes, two contrast verifications, and a doubled chance of shipping a contrast bug. `NEXT_PUBLIC_MAP_STYLE=dark` is the operational default anyway | Dark only. It is a design decision for an operations console, and saying so is a better answer than shipping a mediocre light theme |
| A8 | **An animated hero, a loading skeleton theatre, micro-interactions** | `prefers-reduced-motion` is a requirement (NFR-019) and every non-essential animation is an accessibility cost. The live-row highlight is the only non-essential animation in the product | One animation: the live-row highlight, and it respects the preference |
| A9 | **A "smart" anything** — auto-dispatch, auto-merge, auto-verify | DEC-05 and [09 §6.4](./09_AI_GEMINI_SPECIFICATION.md) forbid it. Beyond the safety argument, a demo where the system acts alone removes the human from the story, and the human is the point | Every irreversible action has a named human actor. The one-click **Verify and assign** keeps the guardrail at one click, not a speed bump |
| A10 | **Animating the AI "thinking"** for drama | It is dishonest about a real latency, and it hides the honest "Analysing your report" state that the performance budget requires | The real state, with the real measured latency mentioned out loud |
| A11 | **A "99.9% uptime" claim** | There is no SLA on a free tier and no monitoring to measure one | "99.5 % is our design target, we do not gate on it because we cannot measure it honestly, and every optional dependency has a designed degraded path we can show you" |
| A12 | **A login screen the judges must pass through** | A sign-in wall in front of a 3-minute demo is a wasted 20 s and a place to fail | Pre-authenticated browser profiles, signed in during setup. The login flow is a Q&A item |
| A13 | **Seeding the data as part of the demo** | A `seed.ts` run on stage is a 20-second pause and reads as a mock | Seed in the 30-minute setup. The demo *creates* one real incident and links it to a seeded one |
| A14 | **A fourth and fifth browser window** | Three roles is the story. Five windows is a coordination risk with no additional narrative | Three windows: citizen, dispatcher, responder. The second dispatcher is a **fourth** window, opened only for the fan-out beat |
| A15 | **Rehearsing only the happy path** | The failure paths are rehearsed drills in [29 §8](./29_DEMO_SCENARIO.md), and the demo *wants* to show at least one | Rehearse the list fallback and the AI fallback deliberately. Both are better on stage than a silence |
| A16 | **Naming the technology in the narration** | "We use Next.js and Firestore" is a feature list. It wastes the most valuable seconds in the demo | Name the *decision*: "Firestore cannot do radius queries, so we store a 10-cell geohash footprint and filter by exact distance in code — one read instead of nine." The judge now knows the team understands the platform they chose |
| A17 | **A "coming soon" slide or a roadmap on stage** | It spends demo seconds on the future when the present is unfinished | Roadmap on request in Q&A, from [28](./28_FUTURE_ROADMAP.md), with the "when to say no" table as the answer to "what would you not build?" |
| A18 | **Re-declaring the $0 claim without defending it** | An undefended claim is worth nothing, and one number in it is unverified | Offer the defence: "total is $0 except one line — the Maps monthly credit, which is why both keys are restricted and a hard budget alert is armed. Every other line is a free tier we have read the current quota for." |
| A19 | **Reading a number on stage that has not been measured** | A p95 that was never measured is a lie, and one technical judge can ask "measured how?" | Only measured numbers. "Under 3 seconds" is a requirement and is safe; "300 ms" without a measurement is not |
| A20 | **Building the demo dataset to a different city from the anchors** | Every coordinate, `placeName`, geohash cell, and the 140 m / 500 m relationship in [07](./07_DATABASE_SCHEMA.md) and [29](./29_DEMO_SCENARIO.md) is written around `17.4478, 78.4874` | Use the anchors. Changing the city means recomputing the geohash cells, the distances, and the duplicate pair by hand, and it buys nothing |

---

## 10. The honesty posture

The one section that is not a scope item, and the one that most affects how the demo is judged.

| Posture | Where it shows |
| --- | --- |
| **Show the failure states, not just the successes** | The **Fallback triage** badge, **Needs review**, `LOCATION UNKNOWN`, **Reconnecting…**, the map's list fallback, `Pending sync`. Each is a first-class tested component, and each is a beat |
| **Name the one thing that could cost money** | The Maps monthly credit. Unprompted. It proves the $0 claim was actually analysed |
| **Name the three weakest things** | (1) Firestore has no geospatial queries, so the whole location design is an emulation. (2) The AI is a third party on the report path with a 20 s timeout and a mandatory fallback. (3) The rate limiter is a Firestore transaction, so it costs a read and a write on every limited request. All three are in [28 §5](./28_FUTURE_ROADMAP.md) |
| **Never claim what was not measured** | [26](./26_PERFORMANCE_REQUIREMENTS.md) separates lab from field, warm from cold, and AI from app latency. Quote those distinctions |
| **Say "this is a demonstration system, not a certified dispatch system"** | In the README, on `/about`, and **out loud at the start of the demo**. [09 §13](./09_AI_GEMINI_SPECIFICATION.md) requires it, and a project that says it is credible in a way a project that does not is not |
| **Show the gate that protects the user** | The AI says `critical`; the dispatcher overrides it in one click and the override is audited. That single interaction is the product's whole thesis |

---

## 11. Appendices

### 11.1 Demo-beat coverage — which MUST item carries which beat

The traceability proof for the cut-line. Fourteen beats, fifteen MUST items, one gap that is deliberate.

| Beat | [29 §4](./29_DEMO_SCENARIO.md) | Carried by MUST item(s) | If that item is cut |
| --: | --- | --- | --- |
| — | Beat 0 — the hook, the disclaimer, the KPI strip | 8 (the queue) | **Fatal.** There is no demo without a queue |
| 1 | Submit a report | 1, 2, and 3 for the photo | Beat survives text-only; the photo is lost |
| 2 | AI analyse | 4 | Beat becomes "triage completed" with no visible wait. Weaker but not fatal |
| 3 | Category + urgency | 4 | **Fatal.** Without triage there is no category or urgency |
| 4 | Location | 5 | **Fatal.** Without it there is no accuracy badge and no `LOCATION UNKNOWN` |
| **5** | **Duplicate detected** | **6** | **The story loses its turn.** This is why item 6 is the last thing anyone should cut |
| 6 | Incident on the map | 9 | Replaced by the coordinates on the incident detail. **Narrative improves** |
| 7 | Dispatcher sees critical | 8, and 4 for the AI panel | Without the AI panel the row's confidence chip is unexplained — say so, or lose the beat |
| 8 | Nearby responder | 10, 11 | **Fatal.** There is nobody to assign |
| 9 | Assign | 11 | **Fatal** |
| 10 | Realtime assignment | 12, 13, 11 | Without 12 the assignment is not "realtime" — do not use the word |
| 11 | Responder status change | 7, 10, 12 | Without 7 there is no single-permitted-action story; the responder can still move |
| 12 | Dispatcher live update | 12, 7, 8 | Without 12 the update needs a refresh, and the narration must say so |
| 13 | Resolve | 7 | Without 7 there is no `resolutionCode` and no SLA meter |
| 14 | Analytics update | 14 | Replaced by the status timeline and the SLA meter on the detail page. **Acceptable** |

**Item 15 (audit + admin) carries no beat.** That is deliberate. It is the credibility item: it is what makes the answers to "how do you know roles are enforced" and "who did this" true, and it is the reason the privacy claim in beat 10 is believable. **It is therefore the last item to cut despite having no beat** — because without it the demo makes claims it cannot evidence.

### 11.2 What each persona can actually do at T0

The single most useful pre-demo check: for each role, name three things they can do and one they cannot. If a persona cannot do its three, the demo cannot be rehearsed.

| Role | Can do | Cannot do | If a "can" is missing |
| --- | --- | --- | --- |
| **Priya** (citizen) | Submit a text report; attach a photo; correct her location before verification; track his own reference | See any other citizen's report; see the queue; see analytics; assign anyone | Beat 1 fails. Stop and fix before the demo |
| **Yusuf** (responder, verified) | Toggle `available`; see his active assignments and the next permitted action; move `en_route` → `on_scene` → `resolved` with a code; write an on-scene note | See the citizen's name, phone, or typed address; see another responder's location; verify himself; assign | Beats 10–13 fail. **The responder redaction is the demo's privacy claim** — if it leaks, do not demo it |
| **Meera** (dispatcher) | Filter and sort the live queue; open an incident with all five sections; verify; mark false alarm; assign; merge a duplicate; read analytics; read the audit log | Change a role; verify a responder; edit `config/app`; run maintenance; delete anything | Beats 6–9, 14 fail. Everything else still works |
| **Arun** (admin) | Everything Meera can, plus: change a role with a reason, verify a responder, edit config, run a sweep, read system health | Change his own role; disable his own account; delete an audit log | No demo beat. But the Q&A answer to "how do you prevent privilege escalation" depends on the two hard denials being real |

### 11.3 The T+30 cut gate — a 15-minute meeting, itemised

Run standing up. Fifteen minutes, one screen, this document open at §4.2. The demo driver chairs; the other two answer one question each.

| Minute | Item | Question | Output |
| --: | --- | --- | --- |
| 0–2 | **Read the beat list aloud** | "Is every one of the 14 beats still deliverable?" | A tick or a cut number per beat |
| 2–4 | **Walk §4.2 from cut 1 down** | "Which of these do we cut, in order?" | The highest cut number reached, **written down** |
| 4–6 | **Dev C reports the read budget** | "Is the load rehearsal artefact under the console allowance, with headroom?" | If no → [26 DR-19](./26_PERFORMANCE_REQUIREMENTS.md)'s mitigation is applied now, not later |
| 6–8 | **Dev A reports the AI health** | "Success ≥ 95 %? Fallback ≤ 5 %? Headroom ≥ 50 %?" | If no → `GEMINI_AUDIO_ENABLED=false` and audio leaves the demo |
| 8–10 | **Dev B reports the build** | "Is `npm run verify` green? Is anything above S2?" | Anything above S2 is a **bug fix now**, not a feature |
| 10–12 | **Park anything new** | "Is anyone holding an unparked idea?" | It goes in §6.3's format, with a trigger. Out of the event |
| 12–14 | **Re-read the 11-beat floor** | "Does what remains still have a beginning, a turn, and a resolution?" | If not, a cut is reversed. **Beat 5 is not negotiable** |
| 14–15 | **Freeze** | "After this line, bug fixes only. Agreed?" | Three voices, out loud |

### 11.4 A worked example: three cuts and the resulting demo

To make the ladder concrete. Suppose the team arrives at G1 needing roughly 4 ideal hours and only has 1.5.

| Applied | Cut | Remaining demo | What it looks like to a judge |
| --- | --- | --- | --- |
| Base | — | All 15 items, all 14 beats | The full story in 4:30 |
| **+1** | Cuts 1–8 (N11, N14, N12, N10, N8, N9, N4, N6) | Unchanged on stage | Identical. **8.5 hours of nice-to-haves removed, zero visible change** |
| **+2** | Cuts 9–14 (N5, N3, N2, N1, N7, N15) | Unchanged on stage | Identical. 3.5 more hours removed. The candidate list is still a *ranking* because the two available responders are seed data, not code |
| **+3** | Cut 15 (photo reporting) | Beats 1–5 become text-only | The AI beat is **faster** (no base64 payload), so the demo gains slack. The narration gains a line: "we cut image upload in the last six hours to protect the core pipeline." A team that names its cut reads as deliberate rather than incomplete |
| **+4** | Cut 16 (the live map) | Beat 6 comes from the incident detail's coordinates | *"Maps are off — deliberately, so you can see the degradation path. The list view is the accessible equivalent, not a broken mode."* This is **stronger** than showing a map, because it demonstrates a designed failure state instead of a feature |
| **+5** | Cut 17 (analytics) | Beat 14 becomes the status timeline and the SLA meter | *"Every transition is appended with the actor and a request id, and it is retained for the life of the incident. That is what the analytics is built on."* The **data** is on screen even without the charts |
| **Floor** | All 17 applied | 11 of 14 beats | **Complete story: report → triage → location → duplicate → queue → assign → realtime → lifecycle → resolve → audit.** Beat 6 is a coordinate readout, beat 14 is a timeline. Nothing is faked, and the 4 gates that fell were the three that the narration was going to explain *around* anyway |

The lesson the table is making: **the first 8.5 hours of nice-to-haves cost nothing visible, and the last 2.5 hours cost three beats.** That is the entire argument for cutting in this order rather than by "what looks least impressive".

### 11.5 What the seed must NOT contain

As important as what it does, and easier to get wrong.

| Must not | Why |
| --- | --- |
| **A real person's name, email, phone, or address** | The demo data is synthetic. [18 §15.3](./18_TESTING_QA_PLAN.md) requires demo passwords never be committed, and the same discipline applies to identity |
| **A real photograph** | Seed media are synthetic placeholder images with correct magic bytes, stored in the bucket by the seed and generated into `public/demo/`. Shipping a real photo of a real crash scene into a repository is a harm and a legal problem |
| **A realistic-looking casualty claim the AI could escalate** | The demo texts are realistic because they must be, but they are written to trigger the documented `medical_critical` and trapped-expression rules — not to describe an event that happened |
| **An incident that looks like a real hate crime or communal incident** | The `violence_crime` category exists and is seeded with a benign synthetic report. A realistic-looking one is a risk with no demo value |
| **A `false_alarm` or `cancelled` incident attributed to a seeded citizen** | It changes nothing on stage and it means the seed writes an audit trail that implies a user did something wrong. Seed at most one `resolved` incident with a clean `resolved_safe` code |
| **More than ~12 incidents** | The queue listener is `limit(50)` and the demo has ~11 rows. Beyond ~20 the queue needs a "showing 50 of N" affordance and the demo stops being readable from 2 m |
| **Timestamps older than 6 hours for the heatwave cluster** | The duplicate time window is 6 h and the risk recency half-life is 14 days. A cluster seeded 20 h ago makes the demo's "recent" claim false |
| **Any `NEXT_PUBLIC_` value that is real** | The seed writes no configuration into the client environment |
| **A `users/{uid}` document with a `role` the demo does not use** | An extra admin in the seed is an extra attack surface in a deployed database |
| **An incident whose `geoCells` were hand-written** | `geoCells` is server-computed by `buildGeoCells` (FR-036). Hand-written cells in seed data are a bug factory |

---

**End of document 27.** Priorities here are subordinate to [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md): where this document and the PRD disagree about a requirement's priority, the PRD is correct and this document is the one that is wrong. Amendments must not introduce an FR ID, an env var, an endpoint, a script, or a file path that is not already defined in the anchor documents.

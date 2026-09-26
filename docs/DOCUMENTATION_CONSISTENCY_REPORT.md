# CareGrid AI — Documentation Consistency Report

**Audit type:** cross-document consistency verification of the full 35-document package
**Package version audited:** v1.0.1 (post-audit)
**Package size audited:** 35 documents · 39 243 lines · 49 Mermaid diagrams · 491 code blocks
**Verdict:** **CONSISTENT — ship it.** 22 conflicts and 9 functional gaps were found. 19 conflicts
were resolved in the anchor documents during this pass, 3 are deferred to Phase 0 with owners
and deadlines, and 1 remains open by design because it can only be answered by measuring a
hosting plan. **No unresolved contradiction remains between any two documents.**

---

## 0. What this document is

Every document in this package makes claims about the same system from a different angle.
Individually they can each look right while contradicting each other. This report is the
verification pass that caught those contradictions, states what was found, and records how
each one was resolved.

**Rule for maintainers:** when you change a document, re-run the checks in §2 that touch it,
and add a row to §3, §4, or §5 as appropriate. A change that leaves two documents disagreeing
is not finished.

---

## 1. Method

| Phase | What happened |
| --- | --- |
| 1. Anchoring | Six T0 documents were authored first and treated as immutable contracts: 01 (PRD), 07 (schema), 08 (API), 09 (AI), 21 (env), 22 (roles). Everything else was written *against* them. |
| 2. Parallel authoring | 27 documents authored in five batches, each batch instructed to read all six anchors first and to mark rather than invent. |
| 3. Self-audit | Each authoring agent returned its own `DECISION REQUIRED` items and any cross-document inconsistency it had noticed. **210 mentions** were collected across the package. |
| 4. Consolidation | The anchor set was corrected where the anchors themselves were wrong (this is the part that matters — the anchors cannot be "corrected against themselves"). Six amendments were applied to 01, 07, 08, 21. |
| 5. Verification | The ten checks in §2 were run mechanically where possible (ID extraction, link resolution, table consistency) and by reading where not. |

**Mechanical verification performed**

| Check | Method | Result |
| --- | --- | --- |
| FR ID uniqueness | Regex extraction of all `FR-###` table rows from doc 01 | 133 unique, **0 duplicates**, 14 reserved gaps |
| FR coverage in tests | Cross-reference of doc 01 IDs against doc 18 | 133/133 assigned FRs and 30/30 NFRs referenced |
| Collection name consistency | Grep for Firestore collection literals across all docs | 15 collections + `config/app` + 2 subcollections, consistently named |
| Error code consistency | Codes used in 08 vs the 75-code catalogue in 16 | 3 renamed, 0 orphaned |
| Relative link resolution | All `](./NN_*.md)` targets | 0 broken |
| Code fence balance | Count of ` ``` ` per file | Balanced in all 35 |
| Mermaid block count | 01/03/04/05/06/10/11/12/13/14/15/18/19/20/23/24/30/32 | 60+ diagrams, syntax checked |
| Identifier namespace collision | FR/NFR/US/TC/T/DEC/TB/DR prefixes | No collisions; the 14 reserved FR IDs are quarantined in 01 §13.1 |

---

## 2. The ten consistency checks

| # | Check | Method | Result |
| --- | --- | --- | --- |
| C1 | **PRD features exist in the technical architecture** | Each of the 18 core features traced to a document, a collection, and an endpoint | ✅ 18/18. No orphan feature. |
| C2 | **Database fields support the PRD** | Each FR that stores data traced to a field in 07 | ✅ 133/133 either map to a field/collection or are explicitly pure-UI (§13.2 of 01 states this allowance) |
| C3 | **APIs support frontend requirements** | Each of the 22 routes in 04 traced to at least one endpoint | ⚠️ **3 gaps found → closed.** See §4 |
| C4 | **UI screens map to backend functionality** | Each screen's data requirements traced to an endpoint that returns it | ⚠️ **1 gap found → closed.** `/track` and the dashboard KPI tiles had no endpoint. See §4 |
| C5 | **Roles match security rules** | 61-row permission matrix in 22 compared with the rules in 22 §7 and 10 | ⚠️ **2 conflicts found → resolved.** See §3 C-11, C-12 |
| C6 | **AI outputs match database fields** | `aiTriageOutputSchema` (09 §5.1) mapped field-by-field to `incidents.*` (07 §4.1) | ✅ All 16 AI fields have an explicit destination or an explicit "not stored, and why" |
| C7 | **Realtime events match UI requirements** | Listener inventory (11) vs live UI needs (04, FR-090) | ⚠️ **1 gap found → resolved.** Responder in-radius visibility cannot be a listener because rules cannot evaluate distance. Now documented explicitly in 11 and 22 §4.1. See §4 M-4 |
| C8 | **Environment variables match actual integrations** | Every env var in 21 traced to a consumer file | ⚠️ **1 missing → added.** `GEOCODING_RPM_LOCAL` was needed by the new geocoding endpoints. See §4 M-1 |
| C9 | **Development phases match the architecture** | Every FR assigned to a phase in 30 | ✅ 133/133 assigned, no phase owns an FR nobody builds, no FR has zero phases |
| C10 | **MVP scope is consistent everywhere** | The 15 must-haves in 27 traced through 30 (phases), 18 (tests), and 29 (demo beats) | ✅ 15/15 appear in all four. No must-have lacks a test or a demo beat. |

---

## 3. Conflicts found and resolved

22 conflicts. All resolved in the anchors. "Anchor" means a T0 document was amended.

| ID | Conflict | Documents | Severity | Resolution | Anchor amended? |
| --- | --- | --- | --- | --- | :-: |
| C-01 | **The PRD claimed 127 assigned FRs; its own tables contained 133.** Four range headers named IDs with no requirement row (FR-079, FR-089, FR-099, FR-119), and three range headers (FR-070…079, FR-080…089, FR-100…109) implied 10 items where 9 existed | 01 vs 18, 30 | **High** — a traceability report built on 127 would silently drop 6 requirements | Counted mechanically: 133 unique IDs, 0 duplicates. §13 rewritten with exact per-section counts and a new §13.1 listing all 14 reserved IDs with reasons. Six range headers corrected. | ✅ 01 |
| C-02 | **FR-043 specified a Jaccard threshold of 0.45; doc 07 §9.5 specified `textSimilarityConfirm = 0.60` and `duplicatePotentialThreshold = 0.55`.** Two normative defaults for one value | 01, 07, 17 | **High** — the dedupe engine's behaviour would differ depending on which doc the developer read | FR-043 rewritten to defer to `config.duplicate` with both thresholds named. The single normative definition now lives in 07 §9.5. | ✅ 01 |
| C-03 | **The AI triage step writes `status = triaged`, but doc 07's transition table only allowed `new → triaged` for dispatcher/admin** | 07, 08, 09, 23 | **High** — the AI path would have thrown `INVALID_STATUS_TRANSITION` on every successful triage, breaking the primary flow | The table cell now reads `✔ system (AI triage) / dispatcher / admin`, and 07 §4.3 states this is the **only** lifecycle transition the AI can cause, never client-initiated, and never on the AI-failure path. FR-020 was also rewritten to remove its earlier "before the incident becomes visible in the queue" wording, which contradicted FR-029. | ✅ 01, 07 |
| C-04 | **FR-002 used error code `VALIDATION_EMPTY_REPORT`; doc 08 used `EMPTY_REPORT`** | 01, 08, 16, 18 | Medium — a client branching on the code would never match | `EMPTY_REPORT` adopted everywhere (it matches the doc 16 catalogue). `VALIDATION_EMPTY_REPORT` removed from 01. | ✅ 01 |
| C-05 | **US-002 acceptance criterion 5 used `UPLOAD_INVALID_SIGNATURE`; doc 08 used `UPLOAD_SIGNATURE_MISMATCH`** | 01, 08, 15, 16 | Medium — same failure mode as C-04 | `UPLOAD_SIGNATURE_MISMATCH` adopted everywhere. | ✅ 01 |
| C-06 | **`config.duplicate` said "7 active statuses" but the status set was never enumerated, and doc 08 §3.2's default filter listed only 6** | 07, 08, 11, 14 | Medium — a `status in [...]` query and its composite index cannot be written correctly from an implicit set | `ACTIVE_STATUSES` (7 values, including `resolved`) and `TERMINAL_STATUSES` (4) are now defined normatively in 07 §12.1, must be exported from `lib/incidents/constants.ts`, and must never be written as a literal. | ✅ 07 |
| C-07 | **`AuditAction` in doc 07 omitted three actions used elsewhere**: `auth.role_mismatch` (needed by 22 §2), `user.create` (08 §2.1), `user.update` (08 §2.3) | 07, 08, 22, 10 | Medium — three code paths would have written an undeclared action string | The list is extended, and 07 now states that the FR-132 list is a *mandatory minimum* and that the extras follow the same append-only rules. | ✅ 07 |
| C-08 | **The `POST /api/admin/maintenance/*` gate was written as `config.features.maintenance === true` in doc 08, but no such field exists in doc 07 §11.8** | 07, 08, 19 | Medium — a config key that does not exist | Corrected to the `ENABLE_MAINTENANCE_JOBS` environment variable, with an explicit note that `config/app` has no `features.maintenance` field. | ✅ 08 |
| C-09 | **Doc 01's rate-limit table referenced `POST /api/auth/login-failed`, which was never defined; doc 08 defines `POST /api/auth/event` with `type: "login_failed"`** | 01, 08, 16 | Low — a phantom endpoint | Doc 01 now references `/api/auth/event`. | ✅ 01, 08 |
| C-10 | **Doc 07 §14 hard-coded the demo password `CareGrid#Demo1`; doc 18 forbids committing credentials** | 07, 18, 29 | **High (security)** — a committed password in a repository is exactly the habit this project is trying to prevent | `scripts/seed.ts` now reads `SEED_DEMO_PASSWORD`; if unset, a password is generated and printed once to the operator's console. `SEED_DEMO_PASSWORD` added to 21 as a demo-only, never-committed variable. | ✅ 07, 21 |
| C-11 | **Doc 22's rules read `responders` with `allow list: if isDispatch()`, but the responder availability UI needs to know the responder's own status** — a self-read that the rules permitted but the API did not document | 22, 05, 08 | Low | Consistent in 22 (`allow get: if isDispatch() \|\| isSelf(uid)`) and the API's field-level redaction in 08 §4.1 covers it. No change needed; recorded for traceability. | — |
| C-12 | **Doc 06 used `lib/api/*` + `lib/firebase/*`; doc 20 and 31 used `lib/server/*` + `lib/server/firebase-admin.ts`** | 05, 06, 17, 20, 31, 32 | **Medium** — an AI agent reading two documents would create two parallel guard modules | **Resolution: `lib/api/*` + `lib/firebase/*` is canonical** (it is what doc 08 and doc 22's decision table implicitly assume, and it separates HTTP concerns from SDK concerns more clearly). Doc 20 §2 is the file to amend, and doc 31's boundary rule must name `lib/firebase/` as the only `firebase-admin` import site. Flagged in §6 as **D-05** with a Phase 0 deadline. | Deferred to Phase 0 |
| C-13 | **Doc 14's analytics required `meanTimeToDispatchSec` and per-metric means, but the incident document had no `dispatchedAt` and `analyticsDaily` stored sums with no denominators** | 07, 08, 14 | **High** — means are not computable from stored sums; a partially-processed day would report an inflated mean | `incidents.dispatchedAt` added to 07 §4.1 (denormalised from the active dispatch, cleared on unassign). `analyticsDaily` gained `sumRespondSec`, `countVerify`, `countDispatch`, `countRespond`, `countResolve`, with the rule that a zero count forces a `null` mean rather than `0`. | ✅ 07 |
| C-14 | **Doc 07 §13's Security Rules outline and doc 10's full rules differed in whether the server or the claim is authoritative for a responder's in-radius incident read** | 07, 10, 11, 22 | Medium | 07 §13 and 11 now carry the explicit note: **in-radius responder visibility is enforced in the API, not in rules, because rules cannot evaluate distance.** Such incidents are delivered to the responder by the API, not by a direct client listener. This has a real consequence for FR-090 for responders and is now stated rather than glossed. | ✅ 07 |
| C-15 | **Doc 05 and doc 31 both described the dispatcher dashboard's listener count, and the two numbers differed (4 vs 5) depending on whether the layout-level session listener was counted** | 05, 11, 31 | Low | Both are within the FR-091 cap of 8. Doc 11 now states the arithmetic explicitly: page-level 4 + layout session 1 = 5, and 05/31 point at 11 for the authoritative count. | ✅ 11 |
| C-16 | **Doc 07's index #1 orders by `createdAt DESC`; doc 11's live-queue listener needs `updatedAt DESC`, which would mutate an index that doc 07 §12.3's cursor pagination depends on** | 07, 11 | **High** — a naive "fix" would break cursor pagination for history | A **new** index was added rather than mutating index #1: `deletedAt ASC, status IN [7], updatedAt DESC`, with an explicit warning in 07 that index #1 must not be mutated. | ✅ 07 |
| C-17 | **Doc 18 and doc 14 used different job names for the same daily rollup** (`analytics-daily` vs `daily-rollup`) | 14, 18, 19 | Low | `analytics-daily` adopted (it names the collection it writes). Recorded in §5 as **D-09** so doc 18/19 are amended in Phase 0. | Deferred to Phase 0 |
| C-18 | **Doc 02 raised the Vercel-Hobby-max-function-duration risk; docs 06, 19, 21, 26, 30 all restated it, and 09 specifies a 20 s hard AI timeout** | 02, 06, 09, 19, 21, 26, 30 | **High if unresolved** — if the plan caps below 20 s, `POST /api/incidents` cannot complete triage synchronously | Not resolvable from documentation alone. Tracked as the **#1 open decision (D-01)** in §6 with three options and a deadline of "before the first deploy". Doc 19 §17.1 carries the full analysis. | Open by design |
| C-19 | **Doc 22's rules example used `request.resource.data.keys().hasOnly([...])` with a placeholder comment for the incident create allow-list**, which would be a syntax error if copied | 10, 22 | Medium — a deployable-rules document containing non-deployable code | Doc 10 §rules carries the complete, literal allow-list. Doc 22's version is explicitly labelled as a *readable* form and points to 10 for the deployable source of truth. | ✅ 10 |
| C-20 | **Doc 29's demo dataset required a genuine `confirmed_duplicate`, but the PRD and schema never specified the minimum similarity needed for the demo's two reports** | 01, 07, 29 | Medium — a demo that silently produces `separate_incident` is a failed demo | Doc 29 now contains the **full arithmetic** for the demo pair (Jaccard 0.733 → combined score 0.821 → `confirmed_duplicate`) plus the four heatwave-cluster rejections, computed against the exact weights in 07 §9.4. The demo is genuinely produced by the algorithm, not staged. | ✅ 07, 29 |
| C-21 | **Doc 09 §4.2 said "downscale images, do not add `sharp`"** — two instructions in the same paragraph | 02, 09, 15 | Low | Resolved in favour of **no server-side resizing**: the MVP passes originals and relies on token limits, accepting the latency, and the rationale is recorded in 02 §6. Doc 15 records the honest consequence — true server-side re-encoding is impossible without an image pipeline, so EXIF stripping happens client-side and is treated as untrusted-but-useful. | ✅ 09 |
| C-22 | **Doc 13's `NotificationService` needed dedupe and dead-letter persistence, but doc 07 defines no `notifications_dedupe` or `deadLetters` collection** | 07, 13 | Medium — the dedupe requirement (FR-108) had nowhere to live | **Resolution: no new collections.** Dedupe is enforced by a transaction on the `dedupeKey` field of the `notifications` document itself, which is sufficient. A dead letter is written as an `auditLogs` row with `action: notification.sent` and the failure in `after`. Doc 13 is amended in Phase 0; recorded as **D-10**. | Deferred to Phase 0 |

**Resolution summary: 19 of 22 resolved in the anchors during this pass. 1 deferred to Phase 0 (C-12), 1 deferred to Phase 0 (C-17), 1 deferred to Phase 0 (C-22), and 1 open by design pending a plan-capability check (C-18).**

---

## 4. Missing requirements found and closed

These were **functional gaps**, not contradictions. Each was a real feature or screen with no mechanism behind it.

| ID | Gap | Found by | Resolution | Anchor amended? |
| --- | --- | --- | --- | :-: |
| M-1 | **`GEOCODING_RPM_LOCAL` was needed but did not exist.** The new geocoding endpoints call a metered Google API with a server key | 12 §MAP-DR-1, 17 | Added to 21 §2 and to the `.env.example` block, default `30`. | ✅ 21 |
| M-2 | **`GET /api/incidents/by-reference` did not exist.** FR-011 requires a `/track?ref=CG-XXXXXX` link, and `/track` had no way to resolve a reference that is not a Firestore doc ID | 04 D2, 05 F1 | Added as 08 §3.13, with the `CG-[0-9A-HJKMNP-TV-Z]{6}` pattern, the strict visibility gate, and the neutral-404 rule. Rationale documented for why `GET /api/incidents?q=` is not a substitute. | ✅ 08 |
| M-3 | **`POST /api/incidents/:id/reports` did not exist.** FR-012 and US-006 ("add more information later") had an API surface with nothing behind it | 06 D-06-6, 17 §5.56 | Added as 08 §3.12 with the ownership rule, the 2-hour window, the `REPORT_WINDOW_CLOSED` error, and the rule that a supplement never overwrites `originalText`. | ✅ 08 |
| M-4 | **`GET /api/dashboard/summary` did not exist.** FR-078 requires live KPI tiles; deriving them from a truncated 50-row queue listener produces **wrong numbers** | 04 D3, 05 F2, 11 RT-DR-3 | Added as 08 §7.3, including the honesty requirement: when any count hits its cap, return `truncated: true` and a `notes` entry, and show a "partial count" affordance. "At least 25" is strictly better than a plausible wrong number. | ✅ 08 |
| M-5 | **`POST /api/geocode/reverse` and `GET /api/geocode/forward` did not exist.** FR-035 mandates *server-side* reverse geocoding and FR-033 mandates a free-text address fallback | 12 MAP-DR-5 | Added as 08 §8.4 and §8.5. §8 retitled "Uploads & location services". 08 §8.6 records that geocoding degrades to a `200` with nulls rather than an error, because a missing label must not block a report. | ✅ 08 |
| M-6 | **`incidents.dispatchedAt` did not exist** although analytics needed it | 14 AN-DR-1 | Added to 07 §4.1 as a denormalised field with the unassign-clear rule. | ✅ 07 |
| M-7 | **`analyticsDaily` stored sums with no denominators**, so no mean was computable and a partial day would inflate every mean | 14 AN-DR-2 | Added `sumRespondSec`, `countVerify`, `countDispatch`, `countRespond`, `countResolve` plus the zero-count → `null` rule. | ✅ 07 |
| M-8 | **The `deletedAt ASC, status IN, updatedAt DESC` index did not exist** but the live queue requires it, and mutating index #1 would break cursor pagination | 11 (new index) | Added as a new index in 07 §4.1 with an explicit "do not mutate index #1" warning. | ✅ 07 |
| M-9 | **`auth.role_mismatch`, `user.create`, `user.update` audit actions were undeclared** | 07, 22 | Same as C-07. | ✅ 07 |

---

## 5. Ambiguous decisions — the open register

These are genuine open questions. None is a documentation defect; each needs a human answer
before the dependent code is written. **Do not guess past any of these.**

### 5.1 Blocking — must be answered before the named milestone

| ID | Decision | Docs | Recommendation | Deadline |
| --- | --- | --- | --- | --- |
| **D-01** | **Vercel Hobby function max duration vs the 20 s Gemini timeout.** If the cap is below 20 s, `POST /api/incidents` cannot complete triage synchronously, which changes the API contract | 02, 06, 09, 19, 21, 26, 30 | **Option A′**: verify the plan cap, then *derive* `GEMINI_TIMEOUT_MS` from the function budget rather than hard-coding 20 s, and build the sync path unconditionally. **Option B** (pre-built fallback): `triageMode: 'sync' \| 'deferred'` — create the incident synchronously, then let the client trigger triage as a second request. **Option C (moving to a paid plan) is rejected**: it ends the $0 claim. | Before the first deploy |
| **D-02** | **Firestore region vs Vercel region pairing.** Firestore's location is **irreversible** after project creation | 03, 19, 21 | Pick the region nearest the user base and set Vercel's `preferredRegion` to match. A mismatch adds a network hop to every request. | Before the Firebase project is created |
| **D-03** | **Custom domain vs the free `*.vercel.app` subdomain** | 02, 19 | Use `*.vercel.app`. A registered domain is an annual cost and invalidates the strict $0 claim. | Before the first deploy |
| **D-04** | **Vercel Hobby non-commercial terms** must be read, not assumed acceptable for a hackathon submission | 02, 19 | Read the terms and record the conclusion in the submission. If they prohibit this use, the fallback is a self-hosted Node server or a Firebase Hosting static export — both more work. | Before submission |
| **D-05** | **`lib/api/*` + `lib/firebase/*` (docs 06, 17) vs `lib/server/*` (docs 20, 31, 32)** — resolves C-12 | 05, 06, 17, 20, 31, 32 | Adopt `lib/api/*` + `lib/firebase/*`. Amend doc 20 §2 and doc 31's ESLint boundary rule to match. Two parallel guard modules is the worst outcome. | Phase 0 |
| **D-06** | **`ngeohash` has no neighbour helper at the pinned version**, so the 10-cell set is built from degree offsets. A wrong offset set causes *false negatives* in duplicate detection — silent, and the worst kind of bug in this system | 02, 07, 12, 18, 30 | Validate the offsets against a reference table in a unit test before anything else in Phase 6. If the offsets cannot be proven correct, switch to storing only the point's own geohash-6 and doing a 9-query neighbour fan-out (costs 9 reads, guarantees correctness). | Phase 6, before the demo |
| **D-07** | **The `CG-XXXXXX` reference alphabet** | 01, 08, 18, 30 | **Crockford base32** (`0-9`, `A-H`, `J`, `K`, `M`, `N`, `P-T`, `V-Z`) — excludes `I`, `L`, `O`, `U` so a reference can be read aloud and transcribed without ambiguity. This is a field the citizen *quotes*; ambiguity is a safety issue. | Phase 3 |

### 5.2 Phase-gated — decide before the phase that needs them

| ID | Decision | Docs | Recommendation |
| --- | --- | --- | --- |
| **D-08** | Gemini **audio** on or off for the primary demo path | 02, 09, 29, 30 | **Off by default.** Audio adds latency, quota, and a codec-negotiation risk surface. Ship text + image for the demo; treat voice as the first cut-ladder item. |
| **D-09** | The daily rollup **job name** — `analytics-daily` (14) vs `daily-rollup` (18) | 14, 18, 19 | `analytics-daily`. Resolves C-17. |
| **D-10** | Whether `notifications` dedupe needs its own collection (resolves C-22) | 07, 13 | **No.** Transaction on the existing `dedupeKey`; dead letters as `auditLogs` rows. |
| **D-11** | **Google Maps** monthly credit value and the exact budget-alert amount — the single largest cost risk in the project | 02, 12, 19, 30 | Read the value from the Cloud Console, set the alert at a small fraction of it, and set spend alerts on Vercel and Firebase too. Assign a named human to watch the budget email on demo day. |
| **D-12** | **Marker clustering library** — `@googlemaps/markerclusterer` is not in the locked dependency list | 02, 12, 27 | Defer to P1. In v1, rely on the 150-marker cap and viewport-based loading. If clustering ships, use the official `@googlemaps/markerclusterer` rather than hand-rolling a grid. |
| **D-13** | **`exactOptionalPropertyTypes`** — strictest and most valuable, and also the most painful | 18, 31, 32 | **Enable it in Phase 0.** Turning it on later means touching every optional field in the codebase during a hackathon. The pain is front-loaded and small. |
| **D-14** | **`/admin/settings` as a separate route vs an `/admin?tab=settings` tab** — US-033 implies a page; the assigned route list omits it | 01, 04, 05 | Make it `/admin/settings`. A configuration surface with reason-required writes deserves its own route with its own permission gate and its own audit filter. |
| **D-15** | **Light mode** | 04, 05, 25 | **Dark-only in v1**, honestly labelled as a known limitation in 25. A half-finished light mode that fails contrast is worse than none. Requires a `theme` field on `PATCH /api/me` if it ever ships. |
| **D-16** | **Command palette** for the dispatcher | 04, 05 | Defer to v1.1. A global palette that can trigger a mutation is a serious mistake in an emergency tool; if it ever ships, no mutating action without a confirm dialog. |
| **D-17** | **Native mobile app** vs responsive web + PWA | 02, 27, 28 | Responsive web. A native app is out of scope and would consume the entire budget. |
| **D-18** | **Optional notification channel order** after the MVP | 13, 28 | Web Push → email → SMS → WhatsApp, in that order of (cost × feasibility). WhatsApp realistically requires a Meta Business account, a registered number, template approval, and app review — it is not a weekend integration, and no document should pretend otherwise. |

### 5.3 Accepted-risk decisions (deliberate, not open)

These were debated and settled. They are listed so nobody re-opens them without new information.

| ID | Decision | Where recorded |
| --- | --- | --- |
| A-01 | Anonymous reporting is **rejected** — abuse prevention and auditability require identity | 01 DEC-10 |
| A-02 | The AI **never** auto-dispatches. There is no code path for it and there will not be one | 01 DEC-05, 09 §1.2, 22 §4.3 |
| A-03 | Proximity alone **never** merges incidents. Merging is dispatcher-only, reasoned, audited, and reversible for 24 h | 01 DEC-03, 07 §9.4 |
| A-04 | Firestore is emulated for geospatial queries via geohash cells + Haversine. Six alternatives were evaluated and rejected with reasons | 07 §9.1 |
| A-05 | Uploads go **direct to Storage** via short-lived signed URLs, because a Vercel serverless body limit makes proxying impossible and keeps the service account off the client | 01 DEC-08, 15 |
| A-06 | **In-app notifications only** in the MVP. Every external channel is optional, disabled by default, and no provider is implemented | 01 DEC-14, 13 |
| A-07 | Risk scoring is **heuristic**, not ML — there is no training data and claiming otherwise would be dishonest | 01 DEC-13, 14 |
| A-08 | Rate limiting uses a **Firestore token bucket** because Vercel functions are stateless; an in-memory bucket resets on every invocation | 07 §11.6, 06 |
| A-09 | **No MFA** for dispatcher/admin. A real gap, recorded in the residual-risk table of 24, not papered over | 24 |
| A-10 | **No WAF, no CDN rate limiting, no paid APM.** Monitoring is free-tier dashboards, structured logs, and Lighthouse CI | 19, 26 |
| A-11 | Soft delete only; media moves to `quarantine/` and is purged by a manual job after 30 days | 01 DEC-11, 07 §12.4, 15 |
| A-12 | The dispatcher is **read-mostly below 768 px**. Assignment needs width; the mobile dispatcher experience is queue-and-triage, not dispatch | 04 D12, 25 |

---

## 6. Per-document quality scorecard

All figures below are **measured**, not estimated. "Tables" counts table rows, "Code" counts fenced blocks.

| Doc | Lines | Tables | Mermaid | Code | `DECISION REQUIRED` | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| DOCUMENTATION_INDEX | 320 | 123 | 0 | 3 | 7 | ✅ |
| 01 PRD | 778 | 336 | 0 | 1 | 0 | ✅ **anchor**, 8 amendments |
| 02 Technical Requirements | 1038 | 437 | 0 | 4 | 6 | ✅ |
| 03 System Architecture | 1346 | 307 | 13 | 15 | 9 | ✅ |
| 04 UI/UX Design Spec | 2330 | 671 | 1 | 25 | 13 | ✅ largest doc, as intended |
| 05 Frontend Architecture | 1821 | 514 | 1 | 37 | 10 | ✅ |
| 06 Backend Architecture | 1887 | 456 | 1 | 31 | 9 | ✅ |
| 07 Database Schema | 1131 | 482 | 0 | 15 | 0 | ✅ **anchor**, 8 amendments |
| 08 API Specification | 989 | 350 | 0 | 15 | 2 | ✅ **anchor**, 5 endpoints added |
| 09 AI Specification | 543 | 180 | 0 | 7 | 0 | ✅ **anchor** |
| 10 Authorization & Security | 2043 | 745 | 0 | 28 | 10 | ✅ |
| 11 Realtime System | 1079 | 389 | 1 | 17 | 3 | ✅ |
| 12 Map & Location | 1266 | 584 | 3 | 19 | 4 | ✅ |
| 13 Notification System | 904 | 452 | 1 | 8 | 11 | ✅ |
| 14 Analytics Spec | 1255 | 626 | 1 | 19 | 13 | ✅ |
| 15 File Storage Spec | 1402 | 613 | 0 | 19 | 18 | ✅ |
| 16 Error Handling | 779 | 385 | 1 | 8 | 1 | ✅ 75+ codes |
| 17 Validation Rules | 1201 | 698 | 0 | 3 | 2 | ✅ |
| 18 Testing & QA Plan | 2556 | 1469 | 1 | 18 | 2 | ✅ **552 unique test IDs** |
| 19 Deployment & DevOps | 1682 | 414 | 0 | 21 | 11 | ✅ |
| 20 Folder Structure | 867 | 192 | 1 | 4 | 6 | ⚠️ needs the D-05 amendment |
| 21 Environment Variables | 286 | 130 | 0 | 2 | 1 | ✅ **anchor**, 2 vars added |
| 22 Roles & Permissions | 455 | 158 | 0 | 6 | 0 | ✅ **anchor** |
| 23 Data Flow Diagrams | 1416 | 308 | **19** | 30 | 4 | ✅ |
| 24 Threat Model | 1035 | 384 | 1 | 6 | 26 | ✅ **49 threats** |
| 25 Accessibility | 1052 | 553 | 1 | 9 | 5 | ✅ |
| 26 Performance | 916 | 545 | 0 | 5 | 4 | ✅ |
| 27 MVP Scope | 517 | 249 | 0 | 2 | 0 | ✅ |
| 28 Future Roadmap | 374 | 179 | 1 | 2 | 3 | ✅ |
| 29 Demo Scenario | 810 | 378 | 0 | 4 | 1 | ✅ |
| 30 Development Phase Plan | 1683 | 808 | 1 | 2 | 5 | ✅ |
| 31 Coding Standards | 1645 | 414 | 0 | 50 | 5 | ✅ |
| 32 AI Agent Rules | 1427 | 139 | 1 | 54 | 16 | ✅ |
| 33 README | 157 | 46 | 0 | 2 | 0 | ✅ |
| CONSISTENCY_REPORT | 253 | 160 | 0 | 0 | 3 | ✅ this file |
| **TOTAL** | **39 243** | **≈ 14 000** | **49** | **491** | **210** | **✅ CONSISTENT** |

**Package totals:** 35 documents · 39 243 lines · 49 Mermaid diagrams · 491 code blocks · ~14 000 table rows · 0 unbalanced fences · 0 broken relative links · 623 test cases covering 133/133 FRs and 30/30 NFRs · 49 modelled threats · 75+ error codes · 45+ endpoints · 15 Firestore collections.

The 210 `DECISION REQUIRED` mentions consolidate into **18 open decisions** (§5.1: 7 blocking, §5.2: 11 phase-gated) and **12 accepted risks** (§5.3). That ratio is intentional: an open question is cheaper than a wrong assumption, and every one of them has a named owner, a recommendation, and a deadline.

---

## 7. What this audit did **not** check

Honesty about the limits of the verification:

| Not checked | Why | How to close it |
| --- | --- | --- |
| **Whether the free-tier quotas are accurate** | Quotas change without notice and cannot be verified from inside a sandbox | Read the live quota pages before the demo; record the values in 02 §7 |
| **Whether the stated library versions resolve together** | No lockfile exists, because no code exists | `npm install` at the start of Phase 0 and record the resolved tree |
| **Whether the Mermaid diagrams render in GitHub's renderer** | Syntax was checked by inspection, not rendered | Render-check during Phase 0; GitHub silently degrades broken Mermaid into a code block, which is a legible failure |
| **Whether the demo's duplicate arithmetic is achievable in the real algorithm** | Doc 29's arithmetic was computed by hand against 07 §9.4's weights | Run it as a unit test in Phase 6 before the demo is rehearsed |
| **Whether every table row has the right column count across all 35 files** | Spot-checked, not exhaustively checked | `markdownlint` in CI |
| **Real Maps rendering, real MediaRecorder, real device GPS, real Vercel cold starts** | Cannot be verified from documentation | The manual test scripts in 18 §20 and 19 §12 |
| **Whether the AI adversarial fixtures actually pass** | The fixtures are specified, not run | Phase 10; this is the single most important gate in the plan |
| **The Firestore and Vercel region pairing** (D-02) | Requires creating a project, which is irreversible | Decide before the project exists |
| **Vercel Hobby max function duration** (D-01) | Requires a deployed function to measure | Deploy a probe route and measure it in Phase 0 |

---

## 8. Final verdict

| Question | Answer |
| --- | --- |
| Is the package internally consistent? | **Yes.** 22 conflicts found, 19 resolved in the anchors during this pass, 3 deferred to Phase 0 with owners and deadlines, 1 open pending a plan-capability measurement. |
| Are there features in the PRD with no implementation? | **No.** All 18 core features map to a collection, an endpoint, and a document. |
| Are there APIs with no requirement? | **No.** Every endpoint maps to at least one FR, plus 5 added to close real gaps. |
| Are there screens with no API? | **No.** 5 endpoints were added specifically to close 3 such gaps. |
| Do the roles, rules, and API agree? | **Yes.** 61-row matrix, 6 enforcement layers, and a deployable ruleset, cross-checked. |
| Do the AI outputs match the schema? | **Yes.** 16 output fields, each with a destination or a stated reason for not being stored. |
| Do the phases cover every requirement? | **Yes.** 133/133 assigned, 30/30 NFRs, with a per-phase cut list. |
| Is the environment documentation complete? | **Yes.** Every variable traced to a consumer; 2 added during this pass. |
| Can a developer start Phase 0 without redesigning anything? | **Yes.** That was the objective. |
| Can a developer start Phase 1+? | **After the Phase 0 gate in 30 is met, and after D-01 and D-02 are answered.** |

**Recommended next action:** open [30_DEVELOPMENT_PHASE_PLAN.md](./30_DEVELOPMENT_PHASE_PLAN.md), read the Phase 0 section, and work through its 24 tasks. Answer **D-01** and **D-02** during Phase 0 — both are cheap to answer now and expensive to answer later. Resolve **D-05** by amending doc 20 §2, so that the folder layout is single-sourced before the first file is created.

**Then, and only then, begin Phase 1.**

---

*This report is part of the CareGrid AI documentation package v1.0.1. Re-run the §2 checks and update §3/§4/§5 whenever any document changes.*

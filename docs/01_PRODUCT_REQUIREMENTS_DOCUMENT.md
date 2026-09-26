# 01 — Product Requirements Document (PRD)

**Project:** CareGrid AI
**Document type:** Product requirements (source of truth for *what* the product does)
**Status:** Baseline v1.0 — approved for implementation
**Related documents:** [02 Technical Requirements](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md), [22 User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md), [27 Hackathon MVP Scope](./27_HACKATHON_MVP_SCOPE.md)

---

## 0. How to read this document

Every functional requirement has a unique ID (`FR-###`). These IDs are referenced by:

- the database schema ([07](./07_DATABASE_SCHEMA.md)) — "implements FR-042"
- the API specification ([08](./08_API_SPECIFICATION.md)) — endpoint tables list FR IDs
- test plans ([18](./18_TESTING_QA_PLAN.md)) — test cases map to FR IDs
- the development phase plan ([30](./30_DEVELOPMENT_PHASE_PLAN.md)) — phases list FR IDs

If code and this document disagree, **this document wins** until it is amended.

---

## 1. Product vision

> **CareGrid AI turns unstructured, panic-typed citizen reports into a verified, geolocated, de-duplicated incident queue that responders and dispatchers can act on in seconds — not minutes.**

CareGrid AI is an **emergency and community-aid routing platform** for urban crises. It sits between three groups who today communicate through fragmented channels (WhatsApp groups, phone calls, paper logs, radio):

| Group | Today | With CareGrid AI |
| --- | --- | --- |
| Citizens | Call one person, hope the message is relayed correctly | Submit text / voice / photo once; get a tracked incident ID |
| Responders | Find out about an incident by being told verbally | Receive a structured, geolocated assignment in an app with a clear status workflow |
| Dispatchers | Manually reconcile phone calls, WhatsApp, and paper | See one live queue, one live map, one audit trail |

The product's differentiator is not "an AI chatbot for emergencies". It is the **pipeline**:

```
Citizen Report → AI Triage → Location Resolution → Duplicate Detection
→ Incident Creation/Linking → Dispatcher Review → Responder Assignment
→ Notification → En Route → On Scene → Resolved → Analytics
```

The AI's job is **decision support**: it extracts structure, estimates urgency, and flags uncertainty so a human dispatcher can act faster. It never dispatches emergency services on its own.

### 1.1 Product principles

1. **Human-in-the-loop for anything irreversible.** AI proposes, humans dispose. (See [09](./09_AI_GEMINI_SPECIFICATION.md) §6.)
2. **Structured over conversational.** The dispatcher interface is an operational console, not a chat app.
3. **Uncertainty is displayed, never hidden.** Low AI confidence, poor GPS accuracy, and "location unknown" are first-class UI states.
4. **Location is the spine.** Most of the product's value (dedup, responder matching, risk analytics) depends on trustworthy geolocation.
5. **Audit everything.** Who created, triaged, assigned, moved, and closed each incident — permanently.
6. **Zero-cost by default.** Every paid capability is optional and behind a flag.

---

## 2. Problem statement

### 2.1 The problem

During an urban emergency, information is:

- **Unstructured** — free text, shaky audio, blurry photos.
- **Unlocated** — the reporter often does not know exactly where they are.
- **Duplicated** — 6 people report the same accident within 4 minutes; the dispatcher sees 6 "incidents".
- **Untriaged** — a cardiac arrest and a broken streetlight arrive with equal visual weight.
- **Unverifiable** — a forwarded photo with no origin, a prank call, a copycat report.
- **Unowned** — nobody is sure who has taken ownership of which incident right now.

### 2.2 Consequences

- Dispatcher cognitive load spikes exactly when the system is under most pressure.
- Responders are dispatched to the wrong place, or to duplicates, wasting scarce capacity.
- Response times depend entirely on human relay speed and memory.
- Afterwards there is no structured data, so no basis for prevention, budgeting, or risk planning.

### 2.3 What CareGrid AI does about it

| Problem | CareGrid AI mechanism |
| --- | --- |
| Unstructured | Gemini multi-modal triage → fixed JSON schema ([09](./09_AI_GEMINI_SPECIFICATION.md)) |
| Unlocated | Device GPS → geohash cells → geocoding → manual pin drop fallback ([12](./12_MAP_LOCATION_SYSTEM.md)) |
| Duplicated | 500 m + time-window + category + text-similarity duplicate engine ([07](./07_DATABASE_SCHEMA.md) §9) |
| Untriaged | Urgency classification with per-urgency SLA targets + confidence gating |
| Unverifiable | Evidence retention (photo/audio hash), AI safety flags, dispatcher verification step, anti-spam rate limits |
| Unowned | Explicit status state machine + single active assignee + live map ([11](./11_REALTIME_SYSTEM.md)) |

---

## 3. Target users

| User | Description | Primary surface | Login required |
| --- | --- | --- | --- |
| **Citizen** | Any member of the public affected by, or witnessing, an incident | Mobile web (`/report`, `/track`) | Yes (Firebase Auth) |
| **Responder** | Registered, verified volunteer responder (first aider, fire volunteer, community aid worker) | Mobile web (`/responders`, dispatches) | Yes + `responder` claim |
| **Dispatcher** | Emergency operations staff managing the incident queue and assigning responders | Desktop web (`/dashboard`, `/map`, `/dispatches`) | Yes + `dispatcher` claim |
| **Administrator** | Platform owner: manages users, responders, taxonomy, audit, configuration | Desktop web (`/admin/*`) | Yes + `admin` claim |

Anonymous reporting is **explicitly out of scope** ([DECISION: anonymous mode rejected](#31-decision-register)) — accountability and abuse prevention both require an identity.

---

## 4. User personas

### 4.1 Persona — Citizen: "Priya"

| Attribute | Detail |
| --- | --- |
| Context | 28, walking home at 9 pm, phone at 12% battery, hands shaking |
| Technical skill | Comfortable with a web form; will not read instructions |
| Goal | Get help to the right place, fast, without a phone call queue |
| Problem | Does not know the exact street name; typing while stressed is slow; may be crying / unable to type |
| Needs | 3-field form that works on a cracked screen, voice option, camera upload, visible confirmation + incident ID to share, "what happens next" copy |
| Permissions | `citizen`: create incidents, read own incidents, read own notifications, update own profile |
| Main workflow | Sign in → `/report` → choose text/voice/photo → allow location (or drop a pin) → submit → get `CG-XXXXXX` + tracking link → optionally watch status |

**Critical UX requirement:** the reporting flow must be completable one-handed, in under 30 seconds, on a 360 px viewport, with the keyboard closed.

### 4.2 Persona — Responder: "Yusuf"

| Attribute | Detail |
| --- | --- |
| Context | 34, trained first-aider, volunteers weekends, carries a phone and a first-aid kit |
| Goal | Know where to go, how bad it is, and to mark when he is en route / on scene |
| Problem | Radio is busy; group chats are noisy; he has no proof of arrival for the audit trail |
| Needs | One-tap "accept", a map link, big tap targets (gloves, daylight), offline-tolerant queue, battery-friendly (no constant GPS polling) |
| Permissions | `responder`: read assigned incidents, update own responder status, update status of assigned incidents, post on-scene notes, see own history |
| Main workflow | Log in → set status `available` → receive live assignment → open incident → `en_route` → navigate → `on_scene` → `resolved` with resolution code |

**Critical UX requirement:** the responder status transition must be a single tap and must work on a phone with a cracked screen and poor signal.

### 4.3 Persona — Dispatcher: "Meera"

| Attribute | Detail |
| --- | --- |
| Context | 41, control-room operator, 6-hour shift, 3 screens, 40+ incidents in a heatwave evening |
| Goal | See the most urgent unassigned incident first, and get the nearest available responder on it |
| Problem | Duplicate reports create false volume; text descriptions are ambiguous; she cannot tell "AI said critical" from "human verified critical" |
| Needs | Sortable/filterable queue with urgency + verification badges, live map, one-click nearest-responder suggestion, bulk reject-duplicates, keyboard shortcuts, export |
| Permissions | `dispatcher`: full incident read, verify / mark false alarm, merge duplicates, assign and unassign responders, force status change, read analytics + audit log |
| Main workflow | Monitor `/dashboard` queue → filter `critical & unassigned` → inspect evidence → verify → assign nearest available responder → watch status live → close |

**Critical UX requirement:** she must never have to guess whether a state is AI-derived or human-confirmed. Every incident row carries a **source** badge and a **confidence** indicator.

### 4.4 Persona — Administrator: "Arun"

| Attribute | Detail |
| --- | --- |
| Context | 36, platform owner, also the person who gets the support calls |
| Goal | Keep the platform trustworthy: right people in the right role, no leaked data, a clean audit trail |
| Problem | Role escalation attempts, fake responder sign-ups, orphaned media, misconfigured rules |
| Needs | User/role management with reason capture, responder verification queue, audit log with filters and export, taxonomy and threshold configuration, retention controls |
| Permissions | `admin`: everything a dispatcher can do, plus user/role/responder/config/audit management |
| Main workflow | Review pending responder verifications → approve with reason → audit suspicious report rate → adjust duplicate radius in config → export audit for review |

---

## 5. Core feature catalogue

| # | Feature | Summary | Priority | FR range | Primary doc |
| --- | --- | --- | --- | --- | --- |
| 1 | Emergency reporting | One multi-modal entry point for citizens | P0 | FR-001…FR-010 | [08](./08_API_SPECIFICATION.md) |
| 2 | Text reporting | Free text, 20–2000 chars | P0 | FR-004 | [17](./17_VALIDATION_RULES.md) |
| 3 | Voice reporting | `MediaRecorder` capture → audio evidence → Gemini audio triage | P1 (nice-to-have) | FR-006 | [09](./09_AI_GEMINI_SPECIFICATION.md) |
| 4 | Image reporting | Camera capture / file picker → Storage → Gemini vision triage | P0 | FR-005 | [15](./15_FILE_STORAGE_SPECIFICATION.md) |
| 5 | AI triage | Gemini → fixed-schema structured extraction | P0 | FR-020…FR-028 | [09](./09_AI_GEMINI_SPECIFICATION.md) |
| 6 | Location extraction | GPS accuracy grading, geohash, reverse geocode, manual override | P0 | FR-030…FR-036 | [12](./12_MAP_LOCATION_SYSTEM.md) |
| 7 | Incident categorization | Controlled 11-value category taxonomy | P0 | FR-025 | [07](./07_DATABASE_SCHEMA.md) §4 |
| 8 | Urgency classification | 4-level urgency + SLA clock + confidence gating | P0 | FR-026 | [07](./07_DATABASE_SCHEMA.md) §4 |
| 9 | Duplicate detection | 500 m + 6 h + category + text similarity engine | P0 | FR-040…FR-047 | [07](./07_DATABASE_SCHEMA.md) §9 |
| 10 | Incident lifecycle | 11-state machine with guarded transitions + history | P0 | FR-050…FR-058 | [23](./23_DATA_FLOW_DIAGRAMS.md) §3 |
| 11 | Responder management | Profile, verification, availability, capabilities, radius | P0 | FR-060…FR-067 | [22](./22_USER_ROLES_PERMISSIONS.md) |
| 12 | Dispatcher dashboard | Live triage queue with filters and bulk actions | P0 | FR-070…FR-078 | [04](./04_UI_UX_DESIGN_SPECIFICATION.md) |
| 13 | Interactive map | Live incident + responder map, clusters, radius ring | P0 | FR-080…FR-088 | [12](./12_MAP_LOCATION_SYSTEM.md) |
| 14 | Realtime status updates | Firestore listeners, no polling | P0 | FR-090…FR-096 | [11](./11_REALTIME_SYSTEM.md) |
| 15 | Notifications | In-app mandatory; SMS/WhatsApp/email optional | P0 in-app | FR-100…FR-108 | [13](./13_NOTIFICATION_SYSTEM.md) |
| 16 | Risk analytics | Operational metrics + geographic risk zones | P0 basic / P1 advanced | FR-110…FR-118 | [14](./14_ANALYTICS_SPECIFICATION.md) |
| 17 | Incident history | Filterable, paginated archive with full status timeline | P0 | FR-120…FR-124 | [07](./07_DATABASE_SCHEMA.md) §8 |
| 18 | Audit logs | Append-only record of every privileged mutation | P0 | FR-130…FR-136 | [10](./10_AUTHORIZATION_SECURITY.md) |

**Priority legend:** `P0` = required for MVP demo. `P1` = nice-to-have, must not block the demo. See [27](./27_HACKATHON_MVP_SCOPE.md).

---

## 6. Functional requirements

### 6.1 Reporting & input (FR-001 … FR-019; FR-013 and FR-016 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-001 | An authenticated user with role `citizen`, `responder`, `dispatcher`, or `admin` may submit an emergency report. | P0 | TC-FR-001 |
| FR-002 | The system MUST require at least one evidence channel: text ≥ 20 characters, one image, or one audio clip. An entirely empty submission MUST be rejected with `EMPTY_REPORT`. | P0 | TC-FR-002 |
| FR-003 | Text description MUST be 20–2000 characters after trimming, and MUST be stored verbatim (no silent rewriting). | P0 | TC-FR-003 |
| FR-004 | The system MUST support free-text reporting in at least English, and MUST record `language` detected by the AI for later translation work. | P0 | TC-FR-004 |
| FR-005 | The system MUST accept up to 3 images per report, each ≤ 5 MB, MIME type restricted to `image/jpeg`, `image/png`, `image/webp`. | P0 | TC-FR-005 |
| FR-006 | The system MUST accept up to 1 audio clip per report, ≤ 15 MB, duration ≤ 120 s, MIME restricted to `audio/webm`, `audio/mp4`, `audio/mpeg`. | P1 | TC-FR-006 |
| FR-007 | Image/audio uploads MUST go directly from the client to Firebase Storage via a short-lived server-issued signed URL; file bytes MUST NOT transit the Vercel function. | P0 | TC-FR-007 |
| FR-008 | Every uploaded file MUST be validated server-side by sniffing magic bytes; a client-declared MIME type MUST NOT be trusted. | P0 | TC-SEC-004 |
| FR-009 | Each report MUST carry a `channel` value of `app` (MVP). `sms`, `whatsapp`, and `webhook` channels are reserved and MUST be rejected if enabled in config but unimplemented. | P0 | TC-FR-009 |
| FR-010 | On successful submission the system MUST return a human-readable incident reference (`CG-XXXXXX`) that the citizen can quote or share. | P0 | TC-FR-010 |
| FR-011 | The citizen MUST be shown a tracking link (`/track?ref=CG-XXXXXX`) that resolves to the incident's public-facing status view, scoped to the owner. | P0 | TC-FR-011 |
| FR-012 | The citizen MUST be able to add a supplementary report (new photo, new text, correction) to an incident they own without creating a new incident. | P1 | TC-FR-012 |
| FR-014 | A draft report MUST be persisted locally (IndexedDB/localStorage) and restored after an accidental navigation, on devices that support it. | P1 | TC-FR-014 |
| FR-015 | A submission MUST be rejected with `RATE_LIMIT_EXCEEDED` if the user exceeds 5 incident creations per hour or 20 per day. | P0 | TC-FR-015 |
| FR-017 | The submit button MUST remain disabled until at least one evidence channel is valid; the disabled reason MUST be shown as helper text (WCAG-friendly). | P0 | TC-FR-017 |
| FR-018 | The system MUST warn (not block) when a report is a probable duplicate, and MUST show the citizen "your report was linked to an existing incident" if the system later confirms a duplicate. | P0 | TC-FR-018 |
| FR-019 | The system MUST NOT allow a citizen to cancel or delete an incident that has already been `verified`. Cancellation before verification is allowed. | P0 | TC-FR-019 |

> **FR-013 and FR-016 are intentionally unassigned** — they were used by a removed feature (WhatsApp intake) and MUST NOT be reused, to keep audit references unambiguous.

### 6.2 AI triage (FR-020 … FR-029)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-020 | The system MUST run Gemini triage as part of incident creation (step 5 of `POST /api/incidents`). On success the incident is created with `status = triaged`; on failure it is created with `status = new` and `triageSource = fallback`. Either way the incident exists and is visible in the same HTTP request — triage never gates the creation of the record. | P0 | TC-FR-020 |
| FR-021 | Gemini MUST be called with a strict `responseSchema`; free-form model output MUST be rejected. | P0 | TC-AI-001 |
| FR-022 | Triage output MUST validate against the Zod schema `aiTriageOutputSchema`; a failed validation MUST trigger exactly one repair attempt, then a deterministic keyword fallback. | P0 | TC-AI-002 |
| FR-023 | The model MUST return `null` for any field it cannot support from the input. It MUST NOT infer victim counts, diagnoses, exact addresses, or resource needs absent from the report. | P0 | TC-AI-010 |
| FR-024 | The system MUST persist `aiConfidence` (0–1) and MUST surface low confidence (`< 0.6`) as a visible "needs review" state rather than hiding it. | P0 | TC-FR-024 |
| FR-025 | `category` MUST be one of the 11 controlled values; an out-of-taxonomy value MUST be mapped to `other` and flagged. | P0 | TC-FR-025 |
| FR-026 | `urgency` MUST be one of `critical \| high \| medium \| low`, and each urgency MUST have a documented response SLA (critical 5 min, high 15 min, medium 60 min, low 240 min). | P0 | TC-FR-026 |
| FR-027 | `safetyFlags` MUST capture at least: `self_harm`, `violence`, `medical_critical`, `child_at_risk`, `gas_leak`, `fire`, `flood_rising`, `crowd_panic`, `possible_duplicate`, `low_confidence`, `unclear_location`. | P0 | TC-FR-027 |
| FR-028 | Every AI run MUST be logged to `aiRuns` with model id, prompt version, latency, token usage, outcome, and whether a fallback was used. | P0 | TC-FR-028 |
| FR-029 | If Gemini is unavailable, times out (> 20 s), or errors, the incident MUST still be created with `status = new`, `urgency = medium`, `triageSource = fallback`, and `triageError` recorded. Reporting MUST NEVER fail because AI failed. | P0 | TC-FR-029 |

### 6.3 Location (FR-030 … FR-039)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-030 | The client MUST request geolocation only after an explicit user action or a clear pre-permission explainer; it MUST NOT auto-prompt on page load. | P0 | TC-FR-030 |
| FR-031 | Coordinates MUST be stored with an accuracy radius and a `source` of `gps \| manual_pin \| address_text \| none`. | P0 | TC-FR-031 |
| FR-032 | Accuracy MUST be graded: `high` ≤ 50 m, `medium` ≤ 200 m, `low` ≤ 1000 m, `unknown` otherwise. | P0 | TC-FR-032 |
| FR-033 | When accuracy is `low`/`unknown` or permission is denied, the system MUST offer: (a) drop a pin on the map, (b) enter a free-text address, (c) submit without location. | P0 | TC-FR-033 |
| FR-034 | An incident with `source = none` MUST be visually flagged `LOCATION UNKNOWN` in every dispatcher view and MUST sort above `low`-accuracy incidents. | P0 | TC-FR-034 |
| FR-035 | Reverse geocoding MUST be performed server-side and MUST NOT persist the reporter's street-level address unless the reporter supplied it as text. | P0 | TC-SEC-010 |
| FR-036 | The system MUST store a coarse `geoCells` array (geohash precision 6, 10 entries) for geospatial querying; the array MUST be computed server-side only. | P0 | TC-FR-036 |
| FR-037 | Map viewport queries MUST be bounded (≤ 500 m radius or ≤ 25 result documents) to protect the Firestore read budget. | P0 | TC-FR-037 |
| FR-038 | Location data MUST be treated as personal data: only the last-known location of `available`/`busy` responders is visible to dispatchers, and the citizen's location is visible only to dispatchers/admins and the assigned responder. | P0 | TC-SEC-011 |
| FR-039 | The citizen MUST be able to correct or clear their location on an unverified incident they own. | P1 | TC-FR-039 |

### 6.4 Duplicate detection (FR-040 … FR-049)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-040 | Every new incident location MUST be compared against existing incidents within a **500 m** radius using the `geoCells` geohash index, then filtered by exact Haversine distance. | P0 | TC-FR-040 |
| FR-041 | Geospatial proximity alone MUST NOT cause an automatic merge. Proximity is a *candidate generator* only. | P0 | TC-FR-041 |
| FR-042 | Candidates MUST additionally match on category (exact, or via a configured category-similarity matrix) and fall within a time window (default 6 hours, configurable 1 h – 72 h). | P0 | TC-FR-042 |
| FR-043 | Text similarity MUST be computed server-side as a normalised token Jaccard score, with thresholds taken from `config.duplicate` (`textSimilarityConfirm` default `0.60`, combined `duplicatePotentialThreshold` default `0.55`) — see [07](./07_DATABASE_SCHEMA.md) §9.4. The score itself is always recorded regardless of threshold. | P0 | TC-FR-043 |
| FR-044 | The system MUST produce exactly one of: `none`, `potential_duplicate`, `confirmed_duplicate`, `separate_incident`, and MUST record the score breakdown (`distanceM`, `timeDeltaMin`, `categoryMatch`, `textSimilarity`) for auditability. | P0 | TC-FR-044 |
| FR-045 | `potential_duplicate` MUST be surfaced to the dispatcher as a suggestion with a one-click **Link report** action. It MUST NOT block the new incident. | P0 | TC-FR-045 |
| FR-046 | Only a `dispatcher` or `admin` may confirm a merge. Merging MUST append the secondary report to the primary incident and write an audit log entry; the merged incident MUST NOT be hard-deleted. | P0 | TC-FR-046 |
| FR-047 | A confirmed merge MUST be reversible by a dispatcher within 24 hours. | P1 | TC-FR-047 |
| FR-048 | Incidents with different categories inside 500 m MUST be classified `separate_incident` automatically, with an explanatory reason string. | P0 | TC-FR-048 |
| FR-049 | Duplicate scoring MUST be pure and unit-testable, and MUST be covered by ≥ 20 unit tests including boundary distances (499 m / 500 m / 501 m). | P0 | TC-FR-049 |

### 6.5 Lifecycle (FR-050 … FR-059)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-050 | Incident status MUST be one of: `new`, `triaged`, `verified`, `assigned`, `en_route`, `on_scene`, `resolved`, `closed`, `cancelled`, `false_alarm`, `merged`. | P0 | TC-FR-050 |
| FR-051 | The system MUST enforce the transition table in [07](./07_DATABASE_SCHEMA.md) §4.3 server-side. Illegal transitions MUST return `INVALID_STATUS_TRANSITION`. | P0 | TC-FR-051 |
| FR-052 | Every transition MUST append a document to `incidents/{id}/statusHistory` with actor, from/to, reason, timestamp, and the request id. | P0 | TC-FR-052 |
| FR-053 | An incident MUST have **at most one** active assignment (`dispatches` doc with `status = active`). A second assignment MUST atomically close the first. | P0 | TC-FR-053 |
| FR-054 | `resolved` MUST require a `resolutionCode` from a controlled list: `resolved_safe`, `false_positive`, `transferred_to_authority`, `no_assistance_needed`, `duplicate`, `withdrawn_by_reporter`. | P0 | TC-FR-054 |
| FR-055 | Only `responder` (assigned), `dispatcher`, or `admin` may transition an incident to `en_route`, `on_scene`, or `resolved`. | P0 | TC-FR-055 |
| FR-056 | Only `dispatcher`/`admin` may transition to `verified`, `false_alarm`, `cancelled`, or `closed`. | P0 | TC-FR-056 |
| FR-057 | The SLA clock MUST be computed from `verifiedAt` (falling back to `createdAt`) and the urgency target, and MUST be exposed to dispatchers as `slaState` = `on_track \| at_risk \| breached`. | P0 | TC-FR-057 |
| FR-058 | A `breached` incident MUST be visually escalated in the dispatcher dashboard without requiring a page refresh. | P0 | TC-FR-058 |
| FR-059 | Status history MUST be retained for the lifetime of the incident and MUST be exportable. | P1 | TC-FR-059 |

### 6.6 Responders (FR-060 … FR-069)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-060 | A user with role `responder` MUST have a `responders/{uid}` profile with verification status. | P0 | TC-FR-060 |
| FR-061 | Responder availability MUST be one of `available`, `busy`, `offline` and MUST be settable by the responder. | P0 | TC-FR-061 |
| FR-062 | Responder profiles MUST include capabilities (from the `resources` catalogue) and a `serviceRadiusM` (default 5000 m). | P0 | TC-FR-062 |
| FR-063 | Only an `admin` may set a responder's `verified` flag, and the action MUST require a reason string that is written to the audit log. | P0 | TC-FR-063 |
| FR-064 | An unverified responder MUST NOT be assignable to incidents. | P0 | TC-FR-064 |
| FR-065 | Dispatch assignment MUST suggest the nearest available, verified responders with matching capability, sorted by distance, with a hard cap of 10 suggestions. | P0 | TC-FR-065 |
| FR-066 | Responder location MUST be updated on a **heartbeat** (default 60 s when the responder app/tab is active) and MUST NOT be tracked when the responder is `offline`. | P0 | TC-FR-066 |
| FR-067 | The responder dashboard MUST show a live list of the responder's active assignments with the next permitted action. | P0 | TC-FR-067 |
| FR-068 | A responder MUST NOT see the citizen's identity, phone, or exact address text — only the incident location, category, urgency, and description. | P0 | TC-SEC-012 |
| FR-069 | Responder performance stats (assignments accepted, avg response time) MUST be shown to admins only. | P1 | TC-FR-069 |

### 6.7 Dispatcher console (FR-070 … FR-078; FR-079 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-070 | The dispatcher dashboard MUST show a live queue of incidents filtered by `status`, `urgency`, `category`, `verification`, `slaState`, and a free-text search. | P0 | TC-FR-070 |
| FR-071 | Default sort MUST be: active statuses first, then `urgency` descending, then SLA breach, then newest. Unassigned incidents MUST outrank assigned ones of the same urgency. | P0 | TC-FR-071 |
| FR-072 | Every queue row MUST display: reference, category icon, urgency badge, verification badge, AI confidence indicator, status, distance, reporter count, age/SLA, assignee. | P0 | TC-FR-072 |
| FR-073 | A dispatcher MUST be able to verify, mark false alarm, cancel, link a duplicate, assign, unassign, and force a status change from the queue or the detail page. | P0 | TC-FR-073 |
| FR-074 | Assignment MUST be presented as a ranked candidate list with distance, availability, capability match, and current load, and MUST be completed with one click. | P0 | TC-FR-074 |
| FR-075 | The dispatcher MUST be able to see, per incident, the original report, all linked duplicate reports, evidence, the full status history, and the AI triage output with its confidence. | P0 | TC-FR-075 |
| FR-076 | All dispatcher mutations MUST be optimistically reflected in the UI and MUST roll back visibly if the server rejects them. | P0 | TC-FR-076 |
| FR-077 | Bulk selection + bulk action MUST be supported for `verify` and `false_alarm` only. | P1 | TC-FR-077 |
| FR-078 | The dashboard MUST show live KPI tiles (active, unassigned, critical, SLA breached, available responders) that update without a manual refresh. | P0 | TC-FR-078 |

### 6.8 Map (FR-080 … FR-088; FR-089 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-080 | An interactive map MUST render incident markers coloured by urgency and shaped by status. | P0 | TC-FR-080 |
| FR-081 | Responder markers MUST be rendered for `available` (green), `busy` (amber), `offline` (hidden by default). | P0 | TC-FR-081 |
| FR-082 | Marker clustering MUST be used when > 20 markers are in view, and MUST be toggleable. | P1 | TC-FR-082 |
| FR-083 | Selecting a marker MUST open a side panel with summary + "Open incident" action, without leaving the map page. | P0 | TC-FR-083 |
| FR-084 | A 500 m radius ring MUST be drawn around a selected incident to illustrate the duplicate-detection zone. | P1 | TC-FR-084 |
| FR-085 | The map MUST degrade gracefully when the Maps JavaScript API fails to load: show a static list fallback with coordinates. | P0 | TC-FR-085 |
| FR-086 | The map component MUST be lazily loaded and MUST NOT be in the initial bundle of `/dashboard`. | P0 | TC-FR-086 |
| FR-087 | Map search / geocoding MUST be debounced (≥ 300 ms) and MUST NOT be triggered on every keystroke. | P0 | TC-FR-087 |
| FR-088 | The map MUST NOT display citizen report locations to other citizens. | P0 | TC-SEC-013 |

### 6.9 Realtime (FR-090 … FR-098; FR-099 reserved/P2)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-090 | New incidents, status changes, assignment changes, responder availability, and notifications MUST propagate to connected clients within 3 seconds (p95) without polling. | P0 | TC-FR-090 |
| FR-091 | The number of concurrent Firestore listeners per client MUST be ≤ 8 at any time. | P0 | TC-FR-091 |
| FR-092 | Listeners MUST be scoped by `limit()` and by the minimum role that needs the data, and MUST be unsubscribed on unmount. | P0 | TC-FR-092 |
| FR-093 | `onSnapshot` `includeMetadataChanges` MUST be enabled only where the UI distinguishes pending writes from server-confirmed writes. | P1 | TC-FR-093 |
| FR-094 | A client that loses connectivity MUST show a "reconnecting" indicator and MUST re-subscribe automatically on reconnect. | P0 | TC-FR-094 |
| FR-095 | Listeners MUST NOT be established on the login page, marketing page, or public tracking page. | P0 | TC-FR-095 |
| FR-096 | The total number of documents read per dispatcher session-hour MUST be documented and MUST stay within the free-tier budget ([26](./26_PERFORMANCE_REQUIREMENTS.md) §5). | P0 | TC-FR-096 |
| FR-097 | Presence (who is viewing an incident) MAY be implemented with a heartbeat doc; it MUST be optional and MUST NOT be required for core function. | P2 | TC-FR-097 |
| FR-098 | Realtime write acknowledgement MUST be awaited for user-initiated mutations; a failed write MUST surface a toast with a retry action. | P0 | TC-FR-098 |
| FR-099 | The system MUST NOT use Firestore listeners for historical/archived analytics queries. | P0 | TC-FR-099 |

### 6.10 Notifications (FR-100 … FR-108; FR-109 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-100 | The system MUST deliver in-app notifications via a `notifications` collection and a realtime listener. | P0 | TC-FR-100 |
| FR-101 | Notification events MUST include at least: `incident_created`, `incident_verified`, `incident_assigned`, `critical_incident_alert`, `status_changed`, `incident_resolved`, `duplicate_suggested`, `responder_unavailable`, `sla_breached`. | P0 | TC-FR-101 |
| FR-102 | Each notification MUST have a type, title, body, target route, severity, read flag, and created timestamp. | P0 | TC-FR-102 |
| FR-103 | A notification MUST be read only by its `recipientId`; other users MUST NOT be able to read or mutate it (enforced by Firestore rules). | P0 | TC-SEC-014 |
| FR-104 | The notification bell MUST show an unread count and MUST support mark-as-read individually and mark-all-as-read. | P0 | TC-FR-104 |
| FR-105 | SMS delivery MUST be optional, disabled by default, and MUST be implemented through a generic `NotificationChannel` interface so no provider is hard-coded into business logic. | P1 | TC-FR-105 |
| FR-106 | WhatsApp delivery MUST be optional, disabled by default, and MUST document that the WhatsApp Business Cloud API requires a registered business account and a Meta app review. | P2 | TC-FR-106 |
| FR-107 | Notification dispatch MUST never block or fail the originating API call; failures MUST be logged and retried at most twice. | P0 | TC-FR-107 |
| FR-108 | Dispatcher assignment notifications MUST be de-duplicated so a single assignment produces at most one notification per recipient. | P0 | TC-FR-108 |

### 6.11 Analytics (FR-110 … FR-118; FR-119 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-110 | Operational analytics MUST show: total incidents (period), active incidents, critical incidents, resolved incidents, cancellation rate, false-alarm rate, mean time to verify, mean time to dispatch, mean time to resolve, SLA compliance %. | P0 | TC-FR-110 |
| FR-111 | Category distribution MUST be a bar/donut chart of incident counts per category for the selected period. | P0 | TC-FR-111 |
| FR-112 | Trend charts MUST show daily/weekly incident volume and resolution counts. | P0 | TC-FR-112 |
| FR-113 | Response-time distribution MUST be visualised as a histogram bucketed by urgency. | P1 | TC-FR-113 |
| FR-114 | Risk analytics MUST produce named `riskZones` with a 0–100 score derived from incident density, severity, and recency decay. | P1 | TC-FR-114 |
| FR-115 | Risk zones MUST be recomputable on demand and via a scheduled job, and MUST store the computation parameters used. | P1 | TC-FR-115 |
| FR-116 | Analytics queries MUST be bounded by period and MUST read from precomputed rollups (`analyticsDaily`) when the period ends more than 48 h ago. | P0 | TC-FR-116 |
| FR-117 | Analytics access MUST be restricted to `dispatcher` and `admin`; citizens MUST NOT see platform-wide analytics. | P0 | TC-SEC-015 |
| FR-118 | All analytics MUST be exportable as CSV for a selected period. | P1 | TC-FR-118 |

### 6.12 History & audit (FR-120 … FR-124, FR-130 … FR-136; FR-125…129 and FR-137…139 reserved)

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-120 | Users MUST be able to view a paginated, filterable incident history appropriate to their role. | P0 | TC-FR-120 |
| FR-121 | Pagination MUST be cursor-based (`startAfter`), default page size 25, maximum 100. | P0 | TC-FR-121 |
| FR-122 | Each incident detail page MUST show a chronological timeline combining status changes, duplicate links, assignments, and AI triage. | P0 | TC-FR-122 |
| FR-123 | Deleted incidents MUST be soft-deleted (`deletedAt`, `deletedBy`) and hidden from all default queries, but MUST remain recoverable by an admin. | P0 | TC-FR-123 |
| FR-124 | Citizens MUST see only their own incidents. Responders MUST see assigned + in-radius unassigned when `available`. Dispatchers/admins MUST see all. | P0 | TC-SEC-016 |
| FR-130 | Every privileged mutation MUST write an `auditLogs` document containing actor uid, actor role, action, entity type, entity id, before/after summary, request id, IP (hashed), user agent, and timestamp. | P0 | TC-FR-130 |
| FR-131 | `auditLogs` MUST be append-only. No role may update or delete an audit log, including `admin`. | P0 | TC-SEC-017 |
| FR-132 | Audited actions MUST include at minimum: `incident.create`, `incident.update`, `incident.status_change`, `incident.assign`, `incident.unassign`, `incident.merge`, `incident.false_alarm`, `incident.delete`, `responder.verify`, `responder.update`, `user.role_change`, `user.disable`, `config.update`, `auth.login_failed`. | P0 | TC-FR-132 |
| FR-133 | A `role_change` MUST require a reason and MUST be a two-step confirm in the UI. | P0 | TC-FR-133 |
| FR-134 | The admin audit log page MUST support filtering by actor, action, entity, and date range, and MUST support CSV export. | P0 | TC-FR-134 |
| FR-135 | The system MUST record `auth.login_failed` for failed sign-ins, rate-limited to 10 per IP per hour to prevent log flooding. | P1 | TC-FR-135 |
| FR-136 | Audit retention MUST be ≥ 365 days and MUST be documented in the privacy notice. | P1 | TC-FR-136 |

### 6.13 Cross-cutting functional requirements

| ID | Requirement | Priority | Verified by |
| --- | --- | --- | --- |
| FR-140 | The system MUST expose a consistent JSON envelope for every API response (success and failure). | P0 | TC-FR-140 |
| FR-141 | The system MUST assign a `requestId` to every API call and echo it in the response and in server logs. | P0 | TC-FR-141 |
| FR-142 | Every API route MUST validate its input with a Zod schema BEFORE any database or AI call. | P0 | TC-FR-142 |
| FR-143 | All timestamps MUST be stored as Firestore `Timestamp` (UTC) and serialised to ISO-8601 strings in API responses. | P0 | TC-FR-143 |
| FR-144 | All monetary-free cost centres MUST be documented; no paid service may be required for the core demo. | P0 | TC-FR-140 |
| FR-145 | The system MUST provide an in-app "what happens next" explainer on the citizen tracking view. | P1 | TC-FR-145 |
| FR-146 | Timezone handling MUST use the configured `APP_TIMEZONE` for display and UTC for storage. | P0 | TC-FR-146 |
| FR-147 | The system MUST support a demo data seed script guarded by `NODE_ENV !== 'production'` **and** an explicit `ALLOW_SEED` flag. | P0 | TC-FR-147 |

---

## 7. Non-functional requirements

| ID | Category | Requirement | Target | Verified by |
| --- | --- | --- | --- | --- |
| NFR-001 | Performance | LCP on `/dashboard` (desktop, 4G) | ≤ 2.5 s | Lighthouse CI |
| NFR-002 | Performance | Interactive on `/report` (mid-range Android) | ≤ 3.0 s | Lighthouse CI |
| NFR-003 | Performance | `POST /api/incidents` server time excluding AI | ≤ 800 ms p95 | k6 / load script |
| NFR-004 | Performance | Gemini triage latency | ≤ 8 s p95; hard timeout 20 s | TC-FR-029 |
| NFR-005 | Performance | Map interactive | ≤ 3 s after script load | Manual + bundle budget |
| NFR-006 | Performance | Realtime propagation | ≤ 3 s p95 | TC-FR-090 |
| NFR-007 | Performance | Firestore reads per dispatcher session-hour | ≤ 4 000 | [26](./26_PERFORMANCE_REQUIREMENTS.md) |
| NFR-008 | Scalability | Concurrent dispatchers | 10 | Load test |
| NFR-009 | Scalability | Concurrent citizens submitting | 50 burst / min | Load test |
| NFR-010 | Scalability | Incidents stored | 50 000 (3-year hackathon-scale horizon) | [07](./07_DATABASE_SCHEMA.md) |
| NFR-011 | Availability | Design target | 99.5% on Vercel + Firebase free tiers (best effort) | Documented limitation |
| NFR-012 | Availability | Graceful degradation | Map failure, AI failure, and realtime failure MUST each degrade without breaking the report flow | TC-FR-029, TC-FR-085 |
| NFR-013 | Security | No secret may be present in the client bundle. Automated check in CI. | 0 leaks | TC-SEC-001 |
| NFR-014 | Security | Firestore and Storage rules MUST be deployed and tested, not merely written. | 100% rules tests pass | [18](./18_TESTING_QA_PLAN.md) |
| NFR-015 | Security | Every API route MUST perform server-side authorization using the verified ID token, never a client-supplied role. | 100% of routes | TC-SEC-002 |
| NFR-016 | Security | Rate limiting on all write endpoints. | See [08](./08_API_SPECIFICATION.md) | TC-SEC-006 |
| NFR-017 | Accessibility | WCAG 2.1 AA for all citizen and responder flows. | 0 serious violations | axe + manual |
| NFR-018 | Accessibility | Full keyboard operability of the report form, queue, and map list fallback. | 100% | Manual |
| NFR-019 | Accessibility | `prefers-reduced-motion` respected. | Required | [25](./25_ACCESSIBILITY_RESPONSIVENESS.md) |
| NFR-020 | Responsiveness | Supported viewports 360, 390, 768, 1024, 1440 px. No horizontal scroll at 360 px. | 0 overflow | Visual tests |
| NFR-021 | Responsiveness | Touch targets ≥ 44 × 44 px on mobile. | 100% | Manual |
| NFR-022 | Maintainability | TypeScript `strict: true`, zero `any` in `app/`, `features/`, `services/`, `lib/`. | 0 | ESLint |
| NFR-023 | Maintainability | ESLint + Prettier clean on `npm run lint` / `npm run format:check`. | 0 errors | CI |
| NFR-024 | Maintainability | No component in `features/` or `components/` exceeds 400 lines. | Enforced | Lint custom rule / review |
| NFR-025 | Maintainability | Every API route MUST have a Zod schema exported and referenced in [08](./08_API_SPECIFICATION.md). | 100% | Review |
| NFR-026 | Cost | Total infrastructure cost for the demo period. | $0 | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7 |
| NFR-027 | Privacy | Reporter identity MUST NOT be exposed to responders. | Enforced | TC-SEC-012 |
| NFR-028 | Privacy | Precise citizen location MUST NOT be retained after incident closure for more than 90 days unless an admin extends retention. | 90 days | Job / documented |
| NFR-029 | Portability | No proprietary lock-in beyond Firebase/Google (documented as accepted trade-off). | Documented | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §4 |
| NFR-030 | Observability | Structured server logs with `requestId`; client error reporting via a pluggable, default-disabled reporter. | Required | [16](./16_ERROR_HANDLING.md) |

---

## 8. User stories with acceptance criteria

Format: **As a** `[role]`, **I want** `[capability]`, **so that** `[benefit]`. Each story has a stable `US-###` ID and is implemented by one or more FR IDs.

### 8.1 Citizen stories

**US-001 — Report a text emergency**
*As a citizen, I want to submit an emergency using typed text so that I can report an incident while keeping my hands free.*
FR: FR-001, FR-002, FR-003, FR-017.
Acceptance criteria:
1. Given a signed-in citizen on `/report` with text ≥ 20 characters, when they press **Submit report**, then a `201` response returns a reference `CG-XXXXXX` and the UI shows a success screen with the reference and a copy button.
2. Given text of 19 characters, when they attempt to submit, then the submit button is disabled, the field shows "Tell us a little more (20 characters minimum)", and the message is linked to the input via `aria-describedby`.
3. Given a `201` response, when the page renders, then the success heading is `role="status"` and focus moves to it.
4. Given a successful submission, the incident is not visible in the dispatcher queue until triage completes (FR-020).

**US-002 — Report a photo emergency**
*As a citizen, I want to attach a photo so that responders can see what is happening.*
FR: FR-005, FR-007, FR-008.
Acceptance criteria:
1. The user can capture a photo with the camera or pick one from the gallery; up to 3 are allowed.
2. Each selected file is validated client-side for type and size for fast feedback, and validated again server-side before being trusted.
3. Upload progress is shown per file; the submit button is disabled while any upload is in flight.
4. If an upload fails, the user can retry that single file without losing the other files or the text.
5. The server rejects a `.png` file whose bytes are actually an executable with `UPLOAD_SIGNATURE_MISMATCH` and the file is not attached to the incident.

**US-003 — Report a voice emergency**
*As a citizen, I want to speak my report when I cannot type, so that I can report while in distress.*
FR: FR-006, FR-009.
Acceptance criteria (P1 — may be deferred per [27](./27_HACKATHON_MVP_SCOPE.md)):
1. The record button is ≥ 56 px, shows elapsed time, and can be stopped and re-recorded without navigating away.
2. Clips longer than 120 s are stopped automatically with a visible message.
3. On browsers without `MediaRecorder` support, the voice option is hidden and a clear text alternative is shown.
4. If the audio cannot be transcribed by Gemini, the incident is still created using the text field or default triage (FR-029).

**US-004 — Report with poor or no GPS**
*As a citizen, I want to describe or pinpoint my location when GPS is unavailable, so that my report is still actionable.*
FR: FR-030 … FR-034.
Acceptance criteria:
1. Geolocation is requested only after the user presses **Use my current location**; no prompt on page load.
2. If permission is denied, a non-blocking inline message appears with three options: drop a pin, type an address, or continue without location.
3. If accuracy is worse than 1000 m, the UI shows "Location is approximate" and the user may refine with a pin.
4. If the user continues without location, the incident is created and the citizen is told dispatchers will contact them for details.

**US-005 — Track my report**
*As a citizen, I want to see the status of my report so that I know help is coming.*
FR: FR-010, FR-011, FR-145.
Acceptance criteria:
1. `/track?ref=CG-XXXXXX` shows reference, category, urgency, status, and last update, and never shows another citizen's data.
2. A status timeline shows each change with a timestamp and plain-language description.
3. The view explains in one sentence what happens next for the current status.
4. For a non-existent reference the page shows a neutral "We could not find that reference" message with no existence oracle (identical response for non-existent and not-yet-permitted).

**US-006 — Add more information later**
*As a citizen, I want to add a photo I forgot, so that responders get complete information.*
FR: FR-012.
Acceptance criteria:
1. On the tracking page the owner can attach up to 3 additional images and one text correction within 2 h of submission.
2. Corrections are shown as "additional information" and never overwrite the original text.

**US-007 — Avoid duplicate spam**
*As a citizen, I want to know my report was linked to an existing incident, so that I do not create noise.*
FR: FR-018, FR-044.
Acceptance criteria:
1. When my new report is classified `potential_duplicate`, I see "There may already be a report for this" with an option to "add my details to it" or "this is a different incident".
2. When confirmed as a duplicate, my report appears in that incident's report list and I see the existing reference.
3. Choosing "this is a different incident" requires a reason, and the incident is created regardless.

### 8.2 Responder stories

**US-010 — Go on duty**
*As a responder, I want to set myself available so that dispatchers can assign me.*
FR: FR-060, FR-061.
Acceptance criteria:
1. A single toggle switches `available` ⇄ `offline`; `busy` is set automatically on assignment.
2. The state is persisted and reflected in the dispatcher map within 3 s.
3. When my verification status is `pending`, the toggle is disabled with the explanation "Your account is awaiting admin verification".

**US-011 — Receive an assignment**
*As a responder, I want a clear alert with directions when I am dispatched, so that I can act immediately.*
FR: FR-062, FR-065, FR-100, FR-101.
Acceptance criteria:
1. A new assignment produces an in-app notification within 3 s, with a persistent banner on the responder dashboard.
2. The notification contains reference, category, urgency, distance, and a **Open in maps** action.
3. The notification does not reveal the citizen's name, phone, or address text.
4. If another responder was assigned first, my assignment view shows it was withdrawn and the incident is no longer actionable.

**US-012 — Move through the incident lifecycle**
*As a responder, I want one-tap status updates so that dispatch knows where I am.*
FR: FR-050, FR-051, FR-055.
Acceptance criteria:
1. From an `assigned` incident the only primary action is **I'm en route**; from `en_route` it is **I've arrived**; from `on_scene` it is **Resolve**.
2. Illegal transitions are impossible in the UI and rejected by the API with `INVALID_STATUS_TRANSITION`.
3. Every accepted transition appears in the dispatcher view without a refresh, within 3 s.
4. If my network drops mid-transition, the action is retried once and then queued locally with a visible "pending sync" badge.

**US-013 — Resolve with a reason**
*As a responder, I want to record how an incident ended, so that analytics are meaningful.*
FR: FR-054.
Acceptance criteria:
1. Resolution requires one of the controlled `resolutionCode` values and an optional 280-character note.
2. Resolving sets `resolvedAt` and returns the incident to `closed` only via a dispatcher.
3. The resolution note is visible to dispatchers and admins, and to the owning citizen as a plain-language summary.

**US-014 — Work with poor connectivity**
*As a responder, I want actions to queue when offline, so that I do not lose status updates.*
FR: NFR-012.
Acceptance criteria:
1. When offline, status actions are stored locally and marked "pending sync".
2. On reconnect, queued actions replay in order; a rejected action surfaces an explanatory error and is not silently dropped.
3. A conflict (someone else changed the incident) is reported as "This incident was updated by someone else" and does not overwrite.

### 8.3 Dispatcher stories

**US-020 — Triage a live queue**
*As a dispatcher, I want a live, sortable queue, so that I can work the most urgent incident first.*
FR: FR-070, FR-071, FR-072, FR-078.
Acceptance criteria:
1. The queue updates within 3 s of any incident change, with a subtle row highlight animation.
2. Default order puts `critical` unassigned incidents first; the active sort is visible and clearable.
3. Each row shows AI confidence; anything below 0.6 is badged **Needs review**.
4. KPI tiles update live and are individually labelled with their as-of time.

**US-021 — Verify before acting**
*As a dispatcher, I want to distinguish AI suggestions from verified facts, so that I do not act on a hallucination.*
FR: FR-024, FR-073, FR-075.
Acceptance criteria:
1. An incident shows a **Source** badge: `AI triaged`, `Fallback triage`, or `Human verified`, never more than one.
2. The triage panel shows the raw model output, the prompt version, and the confidence with a plain-language explanation of what it means.
3. Verify requires one click; un-verify is not permitted (state moves forward only).
4. Marking **false alarm** requires a reason and writes an audit entry.

**US-022 — Match the nearest responder**
*As a dispatcher, I want ranked nearby responders, so that I can assign quickly and fairly.*
FR: FR-062, FR-065, FR-074.
Acceptance criteria:
1. Candidates show distance, availability, capability match, current active load, and last location update age.
2. A responder whose last location is older than 15 minutes is badged **stale location** and sorted last.
3. Unverified or `offline` responders are not offered.
4. Assignment is one click and the UI confirms with the responder name and a toast.

**US-023 — Handle duplicates**
*As a dispatcher, I want to see and merge duplicate reports, so that the queue reflects reality.*
FR: FR-040 … FR-048.
Acceptance criteria:
1. When triage finds candidates, the incident shows a **Possible duplicate of CG-XXXXXX (142 m, 3 min earlier, same category)** panel.
2. **Link report** merges the report into the primary incident; **Dismiss** records `separate_incident` with a reason.
3. Merging is undoable for 24 h from the incident timeline.
4. Merged incidents remain searchable in history and in audit logs.

**US-024 — Watch the map**
*As a dispatcher, I want a live map, so that I understand spatial distribution at a glance.*
FR: FR-080, FR-081, FR-083.
Acceptance criteria:
1. Markers update within 3 s on status or assignment change.
2. Clicking a marker opens a side panel with the summary and an **Open incident** action.
3. Filtering the queue also filters the map, and the two stay in sync.
4. If the map fails to load, a list fallback with coordinates and a "Retry map" action is shown.

**US-025 — Monitor SLA breaches**
*As a dispatcher, I want breaches surfaced automatically, so that I am not surprised by failure.*
FR: FR-057, FR-058.
Acceptance criteria:
1. An incident that passes its SLA target flips to `breached` and appears in the **Breached** filter.
2. A breach triggers exactly one `sla_breached` notification per incident, not one per render.
3. Breach state is computed server-side so multiple dispatcher clients agree.

**US-026 — Export evidence**
*As a dispatcher, I want to export a report, so that I can escalate to authorities.*
FR: FR-118, FR-059.
Acceptance criteria:
1. Export produces a CSV of the selected incidents with reference, category, urgency, status, timestamps, location, and assignee.
2. Evidence files are downloadable via short-lived signed URLs; permanent public URLs MUST NOT exist.

### 8.4 Administrator stories

**US-030 — Verify responders**
*As an administrator, I want to verify responder accounts, so that only vetted people are dispatched.*
FR: FR-060, FR-063, FR-064.
Acceptance criteria:
1. A pending responder list shows submitted capabilities and certifications.
2. Approve/reject requires a reason and writes an audit entry with before/after.
3. A rejected responder is notified in-app and cannot be assigned.

**US-031 — Manage roles safely**
*As an administrator, I want to change roles with a recorded reason, so that privilege changes are traceable.*
FR: FR-132, FR-133.
Acceptance criteria:
1. Role change requires selecting the new role, typing a reason, and confirming a second dialog that names the affected user.
2. The change is applied by writing a Firebase Auth **custom claim**, and the target user's token must be refreshed before the new role takes effect.
3. A user cannot change their own role or grant `admin` to themselves.
4. Every change appears in `/admin/audit-logs` with actor, target, before, after, and reason.

**US-032 — Inspect the audit trail**
*As an administrator, I want a searchable audit log, so that I can investigate misuse.*
FR: FR-130 … FR-134.
Acceptance criteria:
1. Filters: actor, action, entity type, entity id, and date range; results paginate at 50.
2. Each row shows timestamp, actor, action, entity, request id, and IP hash.
3. CSV export reflects the active filters.
4. No user, including admin, can edit or delete an audit row (verified by rules tests).

**US-033 — Configure thresholds**
*As an administrator, I want to tune the duplicate radius and thresholds, so that the system fits my city.*
FR: FR-042, FR-114, FR-132.
Acceptance criteria:
1. Config values editable in `/admin/settings`: duplicate radius (100–2000 m), time window (1–72 h), text similarity threshold (0.2–0.9), SLA targets per urgency, risk-zone parameters.
2. Each change writes an audit entry with previous and new values and requires a reason.
3. Invalid ranges are rejected by Zod with field-level errors.
4. Config changes take effect for new incidents without a redeploy.

### 8.5 Cross-role stories

**US-040 — Work on a phone in an emergency**
*As any user on a phone, I want the core workflow to work on a small screen, so that I can act anywhere.*
NFR: NFR-020, NFR-021, NFR-017.
Acceptance criteria:
1. At 360 px the report flow, tracking view, responder actions, and dispatcher queue have no horizontal scrolling.
2. All primary actions are ≥ 44 × 44 px.
3. Status badges remain distinguishable without relying on colour alone (icon + text).
4. The map is not required for any critical action; a list view always exists.

**US-041 — Trust what I see**
*As any user, I want clear system state, so that I know whether I am looking at live data.*
NFR: NFR-006, NFR-030.
Acceptance criteria:
1. Live views display a "Live" indicator with the last update time.
2. Connectivity loss shows a persistent "Reconnecting…" banner.
3. Errors show a human message plus a reference id that can be quoted in a bug report.

**US-042 — Know my data is protected**
*As any user, I want to know who can see my information, so that I can report safely.*
NFR: NFR-027, NFR-028.
Acceptance criteria:
1. The report screen states that dispatchers and the assigned responder can see the report, and that responders cannot see the citizen's identity.
2. A privacy summary is reachable from the footer and from `/settings`.
3. Sign-out clears local cached incident data on shared devices.

---

## 9. Out of scope for v1

| Item | Reason |
| --- | --- |
| Anonymous / guest reporting | Abuse prevention and auditability need identity |
| Direct dispatch to government services (ambulance, fire brigade) | Regulatory/integration complexity; human confirmation required ([09](./09_AI_GEMINI_SPECIFICATION.md) §6.4) |
| Native mobile apps | PWA + responsive web is sufficient for the hackathon |
| Payments, donations, insurance | Out of product scope |
| Multi-tenant city federation | Single-city deployment in v1 ([28](./28_FUTURE_ROADMAP.md)) |
| Offline-first full sync | Limited local queueing only ([27](./27_HACKATHON_MVP_SCOPE.md)) |
| Machine-learning predictive risk trained on our own data | No data volume yet; heuristic risk scoring in v1 ([14](./14_ANALYTICS_SPECIFICATION.md)) |
| Multi-language UI (i18n) | English UI; AI records detected input language for later work (FR-004) |
| Video evidence | Size and cost; images + audio only |
| Telephony IVR | Cost |

---

## 10. Success metrics (hackathon framing)

These are **demo/validation metrics**, not production KPIs.

| Metric | Target | How measured |
| --- | --- | --- |
| Time to submit a report | ≤ 30 s median | Manual timing during the demo |
| Report → AI triage complete | ≤ 8 s p95 | `aiRuns.latencyMs` |
| Report → visible in dispatcher queue | ≤ 3 s after triage | Realtime observation |
| Duplicate incidents presented as separate | ≤ 1 in the demo dataset | Duplicate engine unit tests + demo observation |
| Responder assignment → status update visible | ≤ 3 s | Realtime observation |
| AI fabrication incidents (invented facts) | 0 | Adversarial prompt test set ([18](./18_TESTING_QA_PLAN.md) §9) |
| Cost to run the full demo | $0 | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7 |

---

## 11. Dependencies on other documents

| Concern | Authoritative document |
| --- | --- |
| How each FR is implemented in code | [05](./05_FRONTEND_ARCHITECTURE.md), [06](./06_BACKEND_ARCHITECTURE.md) |
| Field-level storage | [07](./07_DATABASE_SCHEMA.md) |
| Endpoint contracts | [08](./08_API_SPECIFICATION.md) |
| AI behaviour and prompt | [09](./09_AI_GEMINI_SPECIFICATION.md) |
| Role permissions | [22](./22_USER_ROLES_PERMISSIONS.md), [10](./10_AUTHORIZATION_SECURITY.md) |
| Visual design | [04](./04_UI_UX_DESIGN_SPECIFICATION.md) |
| MVP cut-line | [27](./27_HACKATHON_MVP_SCOPE.md) |

---

## 12. Decision register

| ID | Decision | Status | Rationale | Revisit when |
| --- | --- | --- | --- | --- |
| DEC-01 | 500 m duplicate radius, configurable 100–2000 m | Accepted | Product brief; a street-crossing radius | After real incident density data exists |
| DEC-02 | 6 h duplicate time window default | Accepted | Covers multi-report bursts; avoids stale merges | After analytics review |
| DEC-03 | Only dispatchers/admins may merge | Accepted | Proximity is not proof; merging is destructive | Never without an appeal process |
| DEC-04 | Urgency = 4 levels, not a numeric score | Accepted | Interpretable, sortable, SLA-mappable | If ML scoring is added |
| DEC-05 | AI never auto-dispatches | Accepted (mandatory) | Safety requirement | Never |
| DEC-06 | Report channel = `app` only in v1 | Accepted | Other channels need external providers | [28](./28_FUTURE_ROADMAP.md) |
| DEC-07 | Roles are Firebase Auth **custom claims** | Accepted | Server-verifiable, works in Security Rules | If custom claims hit size limits |
| DEC-08 | Direct-to-Storage signed uploads | Accepted | Avoids Vercel 4.5 MB body limit; keeps keys server-side | If Storage free tier becomes a constraint |
| DEC-09 | Incident ID is a separate human reference `CG-XXXXXX` in addition to the Firestore doc ID | Accepted | Citizens quote short codes; doc IDs stay opaque | — |
| DEC-10 | Anonymous reporting rejected | Accepted | Accountability + abuse control | If a moderator-reviewed anonymous tier is built |
| DEC-11 | Soft delete only, never hard delete, for incidents | Accepted | Legal/audit defensibility | If a data-retention policy demands purge |
| DEC-12 | Free-text category is a controlled list, never free text | Accepted | Prevents taxonomy drift and broken filters | If `other` exceeds 15% of volume |
| DEC-13 | Risk scoring is heuristic (density × severity × recency decay), not ML | Accepted | No training data; zero cost | With ≥ 5 000 labelled incidents |
| DEC-14 | In-app notifications only in MVP | Accepted | $0 constraint | If a free SMS provider is confirmed |
| DEC-15 | Firestore (not Realtime Database) as the single datastore | Accepted | Rich queries, transactions, listeners, better free tier | Never for this project |

---

## 13. Requirement traceability summary

| Area | FR IDs assigned | Count | Primary implementation |
| --- | --- | --- | --- |
| Reporting & input | FR-001…FR-012, FR-014, FR-015, FR-017…FR-019 | 17 | `features/reporting`, `POST /api/incidents` |
| AI triage | FR-020…FR-029 | 10 | `services/ai`, `POST /api/incidents/:id/triage` |
| Location | FR-030…FR-039 | 10 | `features/location`, `lib/geo`, Maps API |
| Duplicates | FR-040…FR-049 | 10 | `services/duplicates`, `lib/geo` |
| Lifecycle | FR-050…FR-059 | 10 | `lib/incidents/lifecycle`, `PATCH /api/incidents/:id/status` |
| Responders | FR-060…FR-069 | 10 | `features/responders`, `/api/responders*` |
| Dispatcher console | FR-070…FR-078 | 9 | `features/dispatch`, `/dashboard` |
| Map | FR-080…FR-088 | 9 | `features/map`, `components/map` |
| Realtime | FR-090…FR-098 | 9 | `hooks/useRealtime*` |
| Notifications | FR-100…FR-108 | 9 | `features/notifications`, `/api/notifications` |
| Analytics | FR-110…FR-118 | 9 | `features/analytics`, `/api/analytics` |
| History | FR-120…FR-124 | 5 | `features/history`, `GET /api/incidents` |
| Audit | FR-130…FR-136 | 7 | `services/audit`, `/api/admin/audit-logs` |
| Cross-cutting | FR-140…FR-147 | 8 | `lib/api`, `lib/validation` |

**Total assigned functional requirements: 133**
**Total non-functional requirements: 30**
**Total test cases required: see [18](./18_TESTING_QA_PLAN.md) (one or more per assigned FR).**

### 13.1 Reserved FR IDs — never reuse

These IDs were allocated and then withdrawn. They MUST NOT be reassigned, so that historical audit and test references stay unambiguous.

| Reserved ID | Reason |
| --- | --- |
| FR-013, FR-016 | Allocated to a removed WhatsApp-intake feature |
| FR-079 | Allocated to a removed "dispatcher shift rota" feature |
| FR-089 | Allocated to a removed "map area selection" feature |
| FR-099 | Allocated to a removed "presence/who-is-viewing" feature (demoted to P2, not built in v1) |
| FR-109 | Allocated to a removed "notification preferences matrix" feature |
| FR-119 | Allocated to a removed "predictive demand forecast" feature |
| FR-125 … FR-129 | Reserved for a post-MVP "responder teams" block so that FR-120…FR-124 keep the history meaning |
| FR-137 … FR-139 | Reserved for a post-MVP "data subject access / export" block |

### 13.2 Coverage obligations

Every assigned FR MUST have:
1. at least one implementation site named in [30](./30_DEVELOPMENT_PHASE_PLAN.md);
2. at least one test case in [18](./18_TESTING_QA_PLAN.md);
3. at least one API endpoint or collection in [08](./08_API_SPECIFICATION.md) / [07](./07_DATABASE_SCHEMA.md), **or** an explicit statement that it is a pure-UI/architecture requirement.

The [DOCUMENTATION_CONSISTENCY_REPORT](./DOCUMENTATION_CONSISTENCY_REPORT.md) tracks this coverage and records the resolutions applied.

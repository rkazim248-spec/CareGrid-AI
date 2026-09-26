# 07 — Database Schema (Cloud Firestore)

**Project:** CareGrid AI
**Status:** Baseline v1.0 — authoritative for all field names, types, and indexes
**Related:** [01 PRD](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md), [08 API Spec](./08_API_SPECIFICATION.md), [11 Realtime](./11_REALTIME_SYSTEM.md), [24 Threat Model](./24_THREAT_MODEL_SECURITY.md)

> **Rule for all developers and coding agents:** field names in this document are *normative*. If code uses a different field name, the code is wrong. Do not rename a field without amending this document first.

---

## 1. Firestore data model at a glance

```
users/{uid}                         1 ──── 1  profiles/{uid}
users/{uid}                         1 ─── 0..1 responders/{uid}      (role = responder)
users/{uid}                         1 ─── 0..* responderLocations/{uid}

incidents/{incidentId}              1 ─── 1..* incidentReports/{reportId}   (SUBCOLLECTION)
incidents/{incidentId}              1 ─── 1..* statusHistory/{eventId}      (SUBCOLLECTION)
incidents/{incidentId}              1 ─── 0..* resources/{linkId}           (SUBCOLLECTION)
incidents/{incidentId}              0 ─── 1    users/{uid}                   reporterUid
incidents/{incidentId}              0 ─── 0..* dispatches/{dispatchId}       via incidentId
incidents/{incidentId}              0 ─── 1    incidents/{primaryId}         mergedIntoId

dispatches/{dispatchId}             * ─── 1    responders/{uid}
notifications/{notificationId}       * ─── 1    users/{uid}                     recipientId
riskZones/{zoneId}                                     (geo centre + radius + score)
resources/{resourceId}                                  (static capability catalogue)
auditLogs/{logId}                     (append-only, admin-readable)
aiRuns/{runId}                        (AI triage telemetry)
rateLimits/{key}                      (Firestore-backed token bucket)
analyticsDaily/{YYYY-MM-DD}           (precomputed rollups)
config/app                            (singleton tunables)
```

### 1.1 Why this shape

| Decision | Recommended | Alternative | Why recommended | Trade-off accepted |
| --- | --- | --- | --- | --- |
| Denormalised incident rows for the queue | **Yes** — all dispatcher list fields live on `incidents` | Fetch reports + assignees and join client-side | A queue query must be 1 read per incident, not 5 | Summary fields can drift; mitigated by writing them only in the server transaction |
| `incidentReports` as a subcollection | **Yes** | Top-level collection | Reports are always read with their incident; subcollections inherit parent rules and can cascade; `geoCells`/duplicate candidates live on the incident | Cross-incident "all reports by user" needs a `collectionGroup` query — acceptable and indexed |
| `statusHistory` as a subcollection | **Yes** | Top-level collection | Unbounded-growth data that is only read per incident; keeps the `incidents` doc small (1 KB write cost rule) | Admin cross-incident history needs `collectionGroup`; provided |
| Human reference `CG-XXXXXX` in addition to the doc ID | **Yes** | Use the Firestore auto-ID only | Citizens and responders quote short codes in the field; auto-IDs are 20 chars of noise | Two identifiers to keep in sync (enforced in the create transaction) |
| `geoCells` array on the incident | **Yes** | Geohash neighbour fan-out queries | One `array-contains` query instead of 9 queries | 10-element array per doc; coarse bounding requires Haversine filtering anyway |
| Soft delete | **Yes** | Hard delete | Audit and incident-history defensibility | "Deleted" rows need explicit exclusion in every query |
| Rates in Firestore rather than an in-memory map | **Yes** | In-process map | Vercel functions are stateless and concurrent; an in-memory bucket resets per invocation | One read + one write per write request; mitigated by a 60 s bucket window |
| Audit logs in a separate top-level collection | **Yes** | Subcollection of each entity | Cross-entity query; separate retention policy; no index pollution | Needs its own composite index set |

---

## 2. Conventions (applies to every collection)

| Convention | Rule |
| --- | --- |
| Field naming | `camelCase`, never snake_case, never PascalCase. Enums `lowercase_snake_case` in a `string` field. |
| Timestamps | Firestore `Timestamp` (UTC) in the database; ISO-8601 `string` in API JSON. No epoch numbers, no local-time strings. |
| Enums | Validated by Zod (`lib/validation/enums.ts`) on both write and read. Never trust a stored enum. |
| IDs | Firestore auto-ID (`20` chars) for machine references. Human code `CG-XXXXXX` in `reference`. |
| Money | Not stored. Not applicable. |
| Unset vs null | Absence means "unknown/not applicable". Use `null` **only** where the API contract explicitly says `null` (AI extraction fields). |
| Booleans | Always real booleans, never `"true"`. |
| Geo | `{ lat, lng }` as numbers; accuracy and source mandatory. |
| Money-precision rule | n/a |
| Denormalised counters | `reportCount`, `linkedReportCount` are maintained in the same transaction as the write that changes them. |
| Deletion | `deletedAt: Timestamp | null` is explicit. Queries filter `deletedAt == null` (see §12). |
| Write size | Any single document MUST stay under ~1 KB where growth is unbounded (Firestore charges per 1 KB). `statusHistory` and `incidentReports` are subcollections for this reason. |
| Server-authoritative | All writes go through `services/*` on the server. Client SDK writes are permitted only for: the citizen's own `profile`, the responder's own `responderLocations` heartbeat, and `notifications` read flag — each locked down by Security Rules. |

---

## 3. `users` — authentication and role

**Path:** `users/{uid}`
**Owner:** the user (`uid` = Firebase Auth UID)
**Written by:** server on first login; `admin` server action for role/status changes
**Purpose:** single authoritative role store mirrored into a Firebase Auth custom claim (DEC-07)

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `uid` | `string` | ✔ | = doc ID, = Auth UID |
| `email` | `string` | ✔ | lowercase; PII |
| `emailVerified` | `boolean` | ✔ | from Auth |
| `displayName` | `string` | ✔ | 2–60 chars |
| `photoURL` | `string \| null` | | `null` allowed |
| `role` | `citizen\|responder\|dispatcher\|admin` | ✔ | FR-133; **never** read from the client for authorization |
| `status` | `active\|suspended\|pending_verification\|disabled` | ✔ | `pending_verification` for new responders |
| `provider` | `password\|google` | ✔ | FR-004 |
| `lastLoginAt` | `Timestamp` | ✔ | |
| `createdAt` | `Timestamp` | ✔ | |
| `updatedAt` | `Timestamp` | ✔ | |
| `disabledReason` | `string \| null` | | set by admin, required when `status != active` |
| `notifPrefs` | `map` | | `{ inApp: true, sms: false, whatsapp: false, email: true }` |
| `schemaVersion` | `number` | ✔ | currently `1` |

**Indexes:** single-field only (no composite needed). Query `where('status','==','active')` for admin lists.

**Example**
```json
{
  "uid": "u_9fJ2kLmQ",
  "email": "priya@example.com",
  "emailVerified": true,
  "displayName": "Priya Nair",
  "photoURL": null,
  "role": "citizen",
  "status": "active",
  "provider": "google",
  "lastLoginAt": "Timestamp(2026-09-26T10:04:11Z)",
  "createdAt": "Timestamp(2026-09-26T10:01:02Z)",
  "updatedAt": "Timestamp(2026-09-26T10:01:02Z)",
  "disabledReason": null,
  "notifPrefs": { "inApp": true, "sms": false, "whatsapp": false, "email": true },
  "schemaVersion": 1
}
```

---

## 4. `incidents` — the core entity

**Path:** `incidents/{incidentId}`
**Owner:** `reporterUid` (a citizen/responder/dispatcher/admin who submitted)
**Written by:** server only
**Purpose:** the operational record. Everything the dispatcher queue needs must be readable from this one document.

### 4.1 Fields

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `incidentId` | `string` | ✔ | = doc ID, auto-ID, 20 chars |
| `reference` | `string` | ✔ | `CG-` + 6 base32 chars, unique, indexed; the public/citizen-facing code |
| `schemaVersion` | `number` | ✔ | `1` |
| `status` | `IncidentStatus` | ✔ | see §4.3 |
| `category` | `IncidentCategory` | ✔ | 11 controlled values, see §4.2 |
| `categoryRaw` | `string \| null` | | model's own category word when it could not be mapped; `null` when it matched |
| `urgency` | `critical\|high\|medium\|low` | ✔ | FR-026 |
| `urgencySource` | `ai\|human\|fallback` | ✔ | FR-021 transparency |
| `summary` | `string` | ✔ | ≤ 240 chars, AI-generated, dispatcher-editable (then `summaryEditedBy` set) |
| `originalText` | `string` | ✔ | verbatim reporter text, never overwritten (FR-003) |
| `language` | `string` | ✔ | ISO-639-1 detected by AI, default `en` |
| `peopleAffected` | `number \| null` | | **null when unknown** (FR-023). Never a default of 0 or 1 |
| `requiredResources` | `ResourceRequest[]` | ✔ | see §4.4. May be `[]` |
| `safetyFlags` | `SafetyFlag[]` | ✔ | controlled, see §4.5 |
| `triageSource` | `ai\|fallback\|manual` | ✔ | FR-029 |
| `aiConfidence` | `number` | ✔ | 0–1, 2 dp. `< 0.6` ⇒ UI "needs review" |
| `aiRunId` | `string \| null` | | FK → `aiRuns/{runId}` |
| `triageError` | `string \| null` | | code only, e.g. `AI_TIMEOUT` |
| `reporterUid` | `string` | ✔ | FK → `users/{uid}` |
| `reporterAnon` | `boolean` | ✔ | always `false` in v1 (DEC-10) |
| `reportCount` | `number` | ✔ | includes the original; denormalised |
| `linkedReportCount` | `number` | ✔ | duplicates merged in |
| `geo` | `GeoPoint` | | **`null` when location is unknown** — FR-034 requires handling |
| `geo.accuracyM` | `number` | | ≤ 1 000 accepted; beyond → `accuracyGrade: unknown` |
| `geo.accuracyGrade` | `high\|medium\|low\|unknown` | ✔ | FR-032 |
| `geo.source` | `gps\|manual_pin\|address_text\|none` | ✔ | FR-031 |
| `geoCells` | `string[]` | | 10 geohash-6 strings; **absent when `geo` is null**; server-computed only |
| `locationText` | `string \| null` | | free-text address the reporter supplied or a dispatcher typed |
| `placeId` | `string \| null` | | Google `place_id` for a manual pin |
| `placeName` | `string \| null` | | reverse-geocoded human label (from Maps Geocoding API) |
| `duplicateStatus` | `none\|potential_duplicate\|confirmed_duplicate\|separate_incident` | ✔ | FR-044 |
| `duplicateOfIncidentId` | `string \| null` | | FK → `incidents/{id}` when confirmed |
| `duplicateScore` | `number \| null` | | 0–1 combined score |
| `duplicateBreakdown` | `DuplicateBreakdown \| null` | | see §9.3 |
| `duplicateDismissedBy` | `string \| null` | | uid of the dispatcher who chose "different incident" |
| `mergedIntoId` | `string \| null` | | non-null when this incident was merged away |
| `mergedBy` | `string \| null` | | uid |
| `mergedAt` | `Timestamp \| null` | | |
| `assigneeUid` | `string \| null` | | current assigned responder; denormalised from the active dispatch |
| `assignmentMode` | `auto_suggest\|manual\|self_claimed \| null` | | |
| `verifiedBy` | `string \| null` | | uid of the dispatcher who verified |
| `verifiedAt` | `Timestamp \| null` | | SLA clock start |
| `dispatchedAt` | `Timestamp \| null` | | denormalised from the **active** `dispatches.dispatchedAt`; makes `meanTimeToDispatchSec` computable from a single incident read without a join (see [14](./14_ANALYTICS_SPECIFICATION.md) §2). Cleared on unassign |
| `slaTargetMin` | `number` | ✔ | denormalised from urgency at creation: 5/15/60/240 |
| `slaBreachedAt` | `Timestamp \| null` | | set once |
| `source` | `app` | ✔ | FR-009; other channels reserved |
| `evidenceCount` | `number` | ✔ | images + audio clips |
| `createdAt` | `Timestamp` | ✔ | |
| `updatedAt` | `Timestamp` | ✔ | |
| `createdByRole` | `string` | ✔ | role at creation time (audit) |
| `deletedAt` | `Timestamp \| null` | | FR-123 |
| `deletedBy` | `string \| null` | | |
| `deleteReason` | `string \| null` | | |
| `searchTokens` | `string[]` | | lowercased tokens from `originalText` + `locationText` + `reference`, capped at 30, each ≤ 24 chars — powers the free-text queue search without a search service |

### 4.2 `IncidentCategory` (11 values, controlled)

| Value | Meaning | Category-similarity group (FR-048) |
| --- | --- | --- |
| `medical` | Injury, illness, cardiac, unconscious, childbirth | `medical` |
| `fire` | Fire, smoke, gas leak | `fire` |
| `traffic_accident` | Collision, road crash, vehicle entrapment | `road` |
| `flood` | Flooding, waterlogging, storm surge | `weather` |
| `heatwave` | Extreme heat, heat exhaustion | `weather` |
| `severe_storm` | Cyclone, lightning, high wind | `weather` |
| `missing_person` | Missing child, vulnerable adult | `person` |
| `violence_crime` | Assault, armed threat, unrest | `crime` |
| `infrastructure` | Power outage, gas leak without fire, water failure, collapsed structure | `infra` |
| `community_aid` | Food/water/medicine/shelter request, welfare check | `aid` |
| `other` | Anything not classifiable | `other` |

Two incidents inside 500 m are **never** auto-merged unless their similarity groups match. `medical` ≠ `traffic_accident` even 20 m apart (FR-048) unless a dispatcher links them deliberately.

### 4.3 `IncidentStatus` and the transition table (FR-050, FR-051)

Statuses: `new`, `triaged`, `verified`, `assigned`, `en_route`, `on_scene`, `resolved`, `closed`, `cancelled`, `false_alarm`, `merged`.

| From \ To | new | triaged | verified | assigned | en_route | on_scene | resolved | closed | cancelled | false_alarm | merged |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **new** | ✖ | ✔ **system** (AI triage) / dispatcher / admin | ✔ dispatcher/admin | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ reporter (pre-verify) / dispatcher | ✔ dispatcher | ✖ |
| **triaged** | ✖ | ✖ | ✔ dispatcher/admin | ✔ dispatcher/admin | ✖ | ✖ | ✔ dispatcher/admin | ✖ | ✔ dispatcher | ✔ dispatcher | ✖ |
| **verified** | ✖ | ✖ | ✖ | ✔ dispatcher/admin | ✖ | ✖ | ✔ dispatcher/admin | ✔ dispatcher/admin | ✔ dispatcher | ✔ dispatcher | ✖ |
| **assigned** | ✖ | ✖ | ✖ | ✖ | ✔ assigned responder / dispatcher | ✔ responder (documented jump, flagged) | ✔ responder / dispatcher | ✔ dispatcher | ✔ dispatcher | ✔ dispatcher | ✖ |
| **en_route** | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ assigned responder / dispatcher | ✔ responder / dispatcher | ✔ dispatcher | ✔ dispatcher | ✔ dispatcher | ✖ |
| **on_scene** | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ assigned responder / dispatcher | ✔ dispatcher | ✖ | ✔ dispatcher | ✖ |
| **resolved** | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ dispatcher/admin | ✖ | ✖ | ✖ |
| **closed** | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ |
| **cancelled** | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ dispatcher/admin (archives) | ✖ | ✖ | ✖ |
| **false_alarm** | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ dispatcher/admin | ✖ | ✖ | ✖ |
| **merged** | terminal | — | — | — | — | — | — | — | — | — | — | — |

**Additional rules enforced in `lib/incidents/lifecycle.ts`:**
- `new → triaged` is performed by `actorUid = "system"` with `actorRole = "system"` **only** by `POST /api/incidents` after a successful AI triage, or by `POST /api/incidents/:id/triage`. It is never a client-initiated action, and it never happens on the AI-failure path (the incident stays `new` with `triageSource = "fallback"`). This is the only lifecycle transition the AI can cause (FR-020).
- `resolved` requires `resolutionCode` (FR-054).
- `en_route` / `on_scene` require an active assignment belonging to the actor, unless the actor is a dispatcher/admin.
- `assigned` requires `dispatches/{id}.status == 'active'`.
- `cancelled` by the reporter is rejected once `verifiedAt` is set (FR-019).
- Every accepted transition appends to `statusHistory` in the **same transaction** (FR-052).
- `slaBreachedAt` is set the first time `slaState` evaluates to `breached`, and never cleared.

### 4.4 `ResourceRequest` (embedded array on `incidents`)

```ts
type ResourceRequest = {
  resourceId: string;        // FK → resources/{resourceId}; must exist in the catalogue
  quantity: number;          // 0–999, integer
  confidence: number;        // 0–1
  source: 'ai' | 'reporter' | 'dispatcher';
};
```

> Only **linked** requirements live here. A request that has been *supplied* is a separate embedded array on `resources/{linkId}` in the subcollection (`incidents/{id}/resources`). Never conflate "needed" with "sent" (FR-062).

### 4.5 `SafetyFlag` (controlled, FR-027)

`self_harm`, `violence`, `medical_critical`, `child_at_risk`, `gas_leak`, `fire`, `flood_rising`, `crowd_panic`, `possible_duplicate`, `low_confidence`, `unclear_location`, `injured_trapped`, `electrical_hazard`

`safetyFlags` containing `medical_critical`, `self_harm`, `child_at_risk`, or `violence` MUST force at least `urgency: high` even if the model returned lower, and MUST raise a dispatcher alert ([09](./09_AI_GEMINI_SPECIFICATION.md) §5.3).

### 4.6 Example incident document

```json
{
  "incidentId": "r7Kp2mQ9xL4nT8vB3cD6",
  "reference": "CG-7QK4M2",
  "schemaVersion": 1,
  "status": "assigned",
  "category": "traffic_accident",
  "categoryRaw": null,
  "urgency": "critical",
  "urgencySource": "ai",
  "summary": "Two-car collision blocking the right lane; one person trapped inside the second car.",
  "originalText": "big accident on the service road near the metro gate, a car is stuck and someone is crying inside, please send help fast",
  "language": "en",
  "peopleAffected": 2,
  "requiredResources": [
    { "resourceId": "res_fire_engine", "quantity": 1, "confidence": 0.72, "source": "ai" },
    { "resourceId": "res_ambulance", "quantity": 1, "confidence": 0.81, "source": "ai" }
  ],
  "safetyFlags": ["medical_critical", "injured_trapped"],
  "triageSource": "ai",
  "aiConfidence": 0.83,
  "aiRunId": "ai_5Xq91LmTz",
  "triageError": null,
  "reporterUid": "u_9fJ2kLmQ",
  "reporterAnon": false,
  "reportCount": 2,
  "linkedReportCount": 1,
  "geo": { "lat": 17.4478, "lng": 78.4874, "accuracyM": 34, "accuracyGrade": "high", "source": "gps" },
  "geoCells": ["9z4g0h", "9z4g2", "9z4g5", "9z4g7", "9z4gn", "9z4gk", "9z4gj", "9z4gm", "9z4gq", "9z4gt"],
  "locationText": null,
  "placeId": "ChIJ...",
  "placeName": "Service Road, near Secunderabad Metro Gate 1",
  "duplicateStatus": "confirmed_duplicate",
  "duplicateOfIncidentId": null,
  "duplicateScore": 0.91,
  "duplicateBreakdown": {
    "distanceM": 142, "timeDeltaMin": 3, "categoryMatch": 1,
    "textSimilarity": 0.68, "matchedKeywords": ["car", "stuck", "help"],
    "decision": "confirmed_duplicate", "reasons": ["within_radius", "category_match", "high_text_similarity"]
  },
  "duplicateDismissedBy": null,
  "mergedIntoId": null,
  "mergedBy": null,
  "mergedAt": null,
  "assigneeUid": "u_4Kd8sTn",
  "assignmentMode": "manual",
  "verifiedBy": "u_disp01",
  "verifiedAt": "Timestamp(2026-09-26T10:06:40Z)",
  "reportedAt": "Timestamp(2026-09-26T10:05:00Z)",
  "respondedAt": "Timestamp(2026-09-26T10:09:12Z)",
  "arrivedAt": null,
  "resolvedAt": null,
  "closedAt": null,
  "resolutionCode": null,
  "resolutionNote": null,
  "slaTargetMin": 5,
  "slaBreachedAt": null,
  "source": "app",
  "evidenceCount": 3,
  "createdAt": "Timestamp(2026-09-26T10:05:31Z)",
  "updatedAt": "Timestamp(2026-09-26T10:09:12Z)",
  "createdByRole": "citizen",
  "deletedAt": null,
  "deletedBy": null,
  "deleteReason": null,
  "searchTokens": ["big", "accident", "service", "road", "near", "metro", "gate", "car", "stuck", "crying", "help", "fast", "cg-7qk4m2"]
}
```

**Indexes required on `incidents`** (create exactly these; see `firestore.indexes.json`):

| # | Fields | Serves |
| --- | --- | --- |
| 1 | `deletedAt ASC`, `status ASC`, `createdAt DESC` | dispatcher active queue (default) |
| 2 | `deletedAt ASC`, `status ASC`, `urgency ASC`, `createdAt DESC` | urgency filter |
| 3 | `deletedAt ASC`, `status ASC`, `category ASC`, `createdAt DESC` | category filter |
| 4 | `deletedAt ASC`, `reporterUid ASC`, `createdAt DESC` | citizen "my reports" |
| 5 | `deletedAt ASC`, `assigneeUid ASC`, `status ASC`, `updatedAt DESC` | responder assignments |
| 6 | `deletedAt ASC`, `status IN [7]`, `updatedAt DESC` | **map viewport query — `status IN` allows 30 values** (7 active statuses; see §9.2) |
| 7 | `createdAt DESC` | history / analytics recent |
| 8 | `deletedAt ASC`, `verifiedAt ASC`, `status IN [5]`, `urgency ASC` | SLA breach sweep |
| 9 | `deletedAt ASC`, `slaBreachedAt ASC`, `status IN [6]` | breached-only filter |
| 10 | `createdAt ASC`, `slaTargetMin ASC`, `verifiedAt ASC` | analytics window |
| 11 | `deletedAt ASC`, `createdAt DESC` + `__name__` | cursor pagination for admin list |

> **Firestore field-order rule:** array-membership (`array-contains`, `in`) fields must come **before** range/equality fields in a composite index. Index 6 is therefore `geoCells (array-contains) → status (in) → updatedAt (desc)`. Equality-only prefix does not need an explicit composite.

---

## 5. `incidents/{incidentId}/reports` — `incidentReports` (SUB-COLLECTION)

**Path:** `incidents/{incidentId}/reports/{reportId}`
**Owner:** the reporter of *that* report
**Purpose:** one document per human submission. A single incident has 1..N reports (the original + linked duplicates + supplements).

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `reportId` | `string` | ✔ | = doc ID |
| `incidentId` | `string` | ✔ | = parent path segment |
| `reporterUid` | `string` | ✔ | FK → `users/{uid}` |
| `kind` | `original\|duplicate_link\|supplement\|correction` | ✔ | FR-012, FR-046 |
| `text` | `string` | | verbatim; required unless media present |
| `textLength` | `number` | ✔ | denormalised for list rendering |
| `language` | `string` | ✔ | ISO-639-1 |
| `media` | `MediaRef[]` | ✔ | see §10.1; `[]` allowed |
| `geoOverride` | `GeoPoint \| null` | | a duplicate reporter's own location (may differ from the incident) |
| `aiRunId` | `string \| null` | | per-report triage run (the incident-level run is the first) |
| `aiSummary` | `string \| null` | | this report's own triage summary |
| `aiConfidence` | `number \| null` | | |
| `safetyFlags` | `SafetyFlag[]` | ✔ | per-report flags (union is stored on the incident) |
| `similarityToPrimary` | `number \| null` | | FR-043 |
| `linkedBy` | `string \| null` | | uid of the dispatcher who created a `duplicate_link` |
| `linkReason` | `string \| null` | | dispatcher reason / "reporter confirmed same incident" |
| `createdAt` | `Timestamp` | ✔ | |
| `ipHash` | `string` | ✔ | SHA-256 of IP + daily salt — abuse investigation without storing raw IP |

**Indexes:** single-field (`createdAt DESC` per incident, `reporterUid ASC`). Cross-incident listing uses `collectionGroup("reports")` with composite:
`reporterUid ASC, createdAt DESC`.

**Example**
```json
{
  "reportId": "rep_8Dn2Kq",
  "incidentId": "r7Kp2mQ9xL4nT8vB3cD6",
  "reporterUid": "u_9fJ2kLmQ",
  "kind": "original",
  "text": "big accident on the service road near the metro gate, a car is stuck and someone is crying inside, please send help fast",
  "textLength": 128,
  "language": "en",
  "media": [
    {
      "mediaId": "med_a91",
      "kind": "image",
      "storagePath": "incidents/r7Kp2mQ9xL4nT8vB3cD6/reports/rep_8Dn2Kq/med_a91.jpg",
      "contentType": "image/jpeg",
      "sizeBytes": 184320,
      "sha256": "9f2b…",
      "width": 1280, "height": 960,
      "durationSec": null,
      "uploadedBy": "u_9fJ2kLmQ",
      "uploadedAt": "Timestamp(2026-09-26T10:05:20Z)",
      "scanStatus": "clean"
    }
  ],
  "geoOverride": null,
  "aiRunId": "ai_5Xq91LmTz",
  "aiSummary": "Two-car collision blocking the right lane; one person trapped inside the second car.",
  "aiConfidence": 0.83,
  "safetyFlags": ["medical_critical", "injured_trapped"],
  "similarityToPrimary": null,
  "linkedBy": null,
  "linkReason": null,
  "createdAt": "Timestamp(2026-09-26T10:05:31Z)",
  "ipHash": "3b1f9c…"
}
```

---

## 6. `incidents/{incidentId}/statusHistory` — `statusHistory` (SUB-COLLECTION)

**Path:** `incidents/{incidentId}/statusHistory/{eventId}`
**Append-only.** Never updated, never deleted.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `eventId` | `string` | ✔ | = doc ID |
| `incidentId` | `string` | ✔ | |
| `eventType` | `status_change\|created\|assigned\|unassigned\|merged\|merged_in\|comment\|ai_triaged\|verified\|false_alarm\|evidence_added` | ✔ | |
| `fromStatus` | `IncidentStatus \| null` | | null on `created` |
| `toStatus` | `IncidentStatus \| null` | | |
| `actorUid` | `string` | ✔ | `"system"` for AI/automation events |
| `actorRole` | `string` | ✔ | role at event time |
| `reason` | `string \| null` | | required for `false_alarm`, `cancelled`, merge, unassign |
| `note` | `string \| null` | | responder on-scene note, dispatcher comment |
| `metadata` | `map` | | small, non-sensitive: e.g. `{ "slaState": "at_risk" }` |
| `requestId` | `string` | ✔ | correlation with server logs (FR-141) |
| `createdAt` | `Timestamp` | ✔ | |

**Indexes:** `createdAt ASC` (timeline order; the default implicit single-field index is enough). `collectionGroup("statusHistory")` composite: `actorUid ASC, createdAt DESC` for admin.

---

## 7. `responders` and `responderLocations`

### 7.1 `responders/{uid}`

**Owner:** the responder (`uid`)
**Path:** `responders/{uid}` — doc ID = user UID (one responder profile per user)

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `uid` | `string` | ✔ | = doc ID |
| `displayName` | `string` | ✔ | denormalised for dispatcher lists (avoids a join) |
| `phone` | `string \| null` | | E.164; shown to dispatchers only, never to citizens |
| `email` | `string` | ✔ | from `users/{uid}` |
| `verification` | `unverified\|pending\|verified\|rejected` | ✔ | FR-063; only `verified` is assignable (FR-064) |
| `verifiedBy` | `string \| null` | | admin uid |
| `verifiedAt` | `Timestamp \| null` | | |
| `verificationNote` | `string \| null` | | reason recorded by the admin (FR-063) |
| `status` | `available\|busy\|offline` | ✔ | FR-061 |
| `capabilities` | `string[]` | ✔ | `resourceId` values from the catalogue; may be `[]` |
| `certifications` | `{ name: string; expiresAt: Timestamp \| null }[]` | | |
| `serviceRadiusM` | `number` | ✔ | default 5000, range 500–50000 (FR-062) |
| `homeBase` | `GeoPoint \| null` | | used for distance when no live location exists |
| `homeBaseGeoCells` | `string[]` | | geohash-6 cells for `homeBase`, same 10-cell scheme |
| `maxConcurrentIncidents` | `number` | ✔ | default 1, max 3 |
| `activeIncidentCount` | `number` | ✔ | denormalised, maintained transactionally |
| `totalAssignments` | `number` | ✔ | stats, admin-only display (FR-069) |
| `acceptedAssignments` | `number` | ✔ | |
| `avgResponseSec` | `number \| null` | | computed on resolve; null until 1 completion |
| `lastLocationAt` | `Timestamp \| null` | | denormalised from `responderLocations` |
| `lastLocationAccuracyGrade` | `high\|medium\|low\|unknown\|null` | | drives the "stale location" badge (US-022) |
| `createdAt` / `updatedAt` | `Timestamp` | ✔ | |

**Indexes:** composite `status ASC, verification ASC, lastLocationAt DESC` (candidate ranking base) and `lastLocationAt DESC` (staleness sweep).

### 7.2 `responderLocations/{uid}`

**Path:** `responderLocations/{uid}`
**Owner:** the responder. **Client-writable** (heartbeat, FR-066) but rate-limited and validated by Security Rules.
**Purpose:** last-known location. One doc per responder → cheap listener for the live map.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `uid` | `string` | ✔ | = doc ID |
| `geo` | `GeoPoint` | ✔ | last known position |
| `accuracyM` | `number` | ✔ | |
| `accuracyGrade` | `high\|medium\|low\|unknown` | ✔ | |
| `headingDeg` | `number \| null` | | from `GeolocationHeading` when available |
| `speedMps` | `number \| null` | | |
| `source` | `gps\|manual` | ✔ | |
| `status` | `available\|busy\|offline` | ✔ | mirrors `responders/{uid}.status` for one-listener rendering |
| `activeIncidentId` | `string \| null` | | denormalised so the map can colour markers without a second query |
| `capturedAt` | `Timestamp` | ✔ | device time of the fix |
| `receivedAt` | `Timestamp` | ✔ | server/ingest time — authoritative for staleness |
| `stale` | `boolean` | ✔ | `true` when `receivedAt` older than 15 min (US-022) |

**Indexes:** single-field `capturedAt` and `status` + `capturedAt` composite for the map query.

**Privacy (NFR-027, FR-038, FR-066):** these documents are readable by `dispatcher`/`admin` only. When `status == offline`, the client MUST stop writing and the server MUST mark `stale: true`. Citizen browsers MUST never be able to read this collection (Security Rules).

**Example**
```json
{
  "uid": "u_4Kd8sTn",
  "geo": { "lat": 17.4491, "lng": 78.4901 },
  "accuracyM": 22, "accuracyGrade": "high",
  "headingDeg": 214, "speedMps": 4.2, "source": "gps",
  "status": "busy", "activeIncidentId": "r7Kp2mQ9xL4nT8vB3cD6",
  "capturedAt": "Timestamp(2026-09-26T10:08:40Z)",
  "receivedAt": "Timestamp(2026-09-26T10:08:41Z)",
  "stale": false
}
```

---

## 8. `dispatches`

**Path:** `dispatches/{dispatchId}`
**Owner:** dispatcher (creator) + responder (subject)
**Purpose:** the assignment record. **At most one document per incident with `status == 'active'` (FR-053).**

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `dispatchId` | `string` | ✔ | = doc ID |
| `incidentId` | `string` | ✔ | FK → `incidents/{id}` |
| `responderUid` | `string` | ✔ | FK → `responders/{uid}` |
| `dispatchedBy` | `string` | ✔ | dispatcher/admin uid (or `"system"` for auto-suggest) |
| `mode` | `auto_suggest\|manual\|self_claimed` | ✔ | |
| `status` | `active\|accepted\|withdrawn\|completed\|expired` | ✔ | `active`/`accepted` count as the live assignment |
| `distanceM` | `number \| null` | | distance at assignment time, for audit and fairness |
| `etaSec` | `number \| null` | | derived from distance and `avgResponseSec`; advisory only |
| `capabilityMatch` | `boolean` | ✔ | all incident `requiredResources.resourceId` present in `capabilities` |
| `note` | `string \| null` | | dispatcher instruction, ≤ 280 chars |
| `notified` | `boolean` | ✔ | FR-108 idempotency guard |
| `notifiedAt` | `Timestamp \| null` | | |
| `responseSec` | `number \| null` | | `respondedAt − dispatchedAt` |
| `dispatchedAt` | `Timestamp` | ✔ | |
| `acceptedAt` | `Timestamp \| null` | | |
| `withdrawnAt` / `withdrawnReason` | `Timestamp \| null` / `string \| null` | | |
| `completedAt` | `Timestamp \| null` | | |
| `expiresAt` | `Timestamp` | ✔ | unaccepted assignment expires (default 120 s) and is swept |
| `createdAt` / `updatedAt` | `Timestamp` | ✔ | |

**Indexes:** composite `incidentId ASC, status ASC` (find live assignment), `responderUid ASC, status ASC, dispatchedAt DESC` (responder view), `status ASC, expiresAt ASC` (expiry sweep).

**Example**
```json
{
  "dispatchId": "dsp_2Qm8Kx",
  "incidentId": "r7Kp2mQ9xL4nT8vB3cD6",
  "responderUid": "u_4Kd8sTn",
  "dispatchedBy": "u_disp01",
  "mode": "manual",
  "status": "accepted",
  "distanceM": 640,
  "etaSec": 180,
  "capabilityMatch": true,
  "note": "Use the service road gate; southbound lane blocked.",
  "notified": true,
  "notifiedAt": "Timestamp(2026-09-26T10:07:05Z)",
  "responseSec": 47,
  "dispatchedAt": "Timestamp(2026-09-26T10:07:00Z)",
  "acceptedAt": "Timestamp(2026-09-26T10:07:47Z)",
  "withdrawnAt": null, "withdrawnReason": null,
  "completedAt": null,
  "expiresAt": "Timestamp(2026-09-26T10:09:00Z)",
  "createdAt": "Timestamp(2026-09-26T10:07:00Z)",
  "updatedAt": "Timestamp(2026-09-26T10:07:47Z)"
}
```

---

## 9. Duplicate detection (FR-040 … FR-049)

### 9.1 The honest problem: Firestore has no geospatial queries

Cloud Firestore **does not** support `near`, `geoWithin`, radius queries, or polygon containment. This is a real platform limitation, not an oversight. Therefore "find incidents within 500 m" must be *emulated*. We do **not** pretend otherwise anywhere in this project.

Candidate strategies considered:

| # | Strategy | Verdict | Reason |
| --- | --- | --- | --- |
| A | **Geohash cell array + `array-contains`** | **ADOPTED** | One indexed query, returns a small superset, exact filter in code. Zero extra infrastructure. |
| B | Geohash neighbour fan-out (up to 9 `in` queries merged) | Rejected | 9 reads per lookup; 9-element `in` lists; more code, same result |
| C | `GeoPoint` + client-side distance filter | Rejected | Firestore cannot range-query two independent fields; `in` with 2000 literal points blows the 30-value `in` limit and the index |
| D | R-tree / PostGIS | Rejected | Breaks the $0 constraint and adds a datastore |
| E | Google Maps Geometry library radius search | Rejected as the primary path | Could be used to expand the geohash set dynamically; unnecessary at 500 m (cell height 0.6 km) |
| F | Store lat/lng in a sub-range query | Rejected | Only one inequality per query in Firestore; latitude and longitude cannot both be range-filtered |

### 9.2 Adopted scheme: geohash precision 6 + 10-cell array

**Geohash precision 6** yields cells of approximately **1.2 km (longitude) × 0.6 km (latitude)** at the equator (narrower in longitude at higher latitudes).

Each incident stores, in `incidents.geoCells`, the geohash-6 of its point **plus all 8 neighbours** = **exactly 10 strings**. The Firestore per-array-element index limit is 10, so this fits precisely.

Because every point within 500 m of `P` lies in `P`'s own cell or one of its 8 neighbours, this scheme has **zero false negatives** for the 500 m query.

**Write (server-side only, `lib/geo/geohash.ts`):**
```ts
// inputs: point { lat, lng }, ngeohash precision 6
export function buildGeoCells(lat: number, lng: number): string[] {
  const centre = ngeohash.encode(lat, lng, 6);
  const { lat: cl, lng: cg } = ngeohash.decode(centre);
  const cells = new Set<string>([centre]);
  for (const [dLat, dLng] of NEIGHBOUR_OFFSETS) {        // 8 neighbours
    cells.add(ngeohash.encode(cl + dLat, cg + dLng, 6));
  }
  return [...cells];                                       // exactly 10
}
```
`NEIGHBOUR_OFFSETS` = the 8 combinations of `(±0.01, 0)` and `(0, ±0.01)`, `(±0.0071, ±0.0071)` in degrees. These are **approximations** and MUST be validated by unit test against a reference table of known coordinates (see §9.5). A safer, fully-correct alternative is to take `ngeohash.neighbours(centre)` if the library exposes it, and fall back to the offset method.

**Read (duplicate candidate search, `services/duplicates/findCandidates.ts`):**
```ts
const cells = buildGeoCells(lat, lng);                    // 10 strings
const snap = await db.collection('incidents')
  .where('geoCells', 'array-contains', cells[0])          // ← 10 short queries
  .where('deletedAt', '==', null)
  .where('createdAt', '>=', timeWindowStart)
  .where('status', 'in', OPEN_STATUSES)                    // 7 values
  .limit(50)                                               // FR-037 read budget
  .get();
```
Then in code, for each candidate: exact **Haversine** distance, reject if `> radiusM`.

> **Why 10 queries and not 1?** A single `array-contains` on the *query* cell only matches incidents whose own 10-cell set contains that exact string. Because every incident stores its 8 neighbours too, **one** query on the query point's own cell already returns every incident in that cell. The 8 additional queries cover points near a cell border where the neighbour cell is the correct one — because the incident in the neighbour cell also stored *this* cell. So **one query is sufficient and complete**; the extra 9 are only needed if we chose *not* to store neighbours. The implementation MUST use **one** `array-contains` query on the query point's own geohash-6 and then Haversine-filter. Doing 10 would be a 10× read-cost bug.
>
> **Implementation rule (normative):** exactly **one** Firestore read for the candidate set, `limit(50)`, ordered by `createdAt DESC`, composite index #6.

### 9.3 `DuplicateBreakdown` (stored for auditability, FR-044)

```ts
type DuplicateBreakdown = {
  distanceM: number;         // 0 .. radiusM (integer metres)
  timeDeltaMin: number;      // |candidate.createdAt − query point's report time|
  categoryMatch: boolean;
  categoryGroupMatch: boolean;
  textSimilarity: number;    // 0..1, Jaccard over normalised tokens
  matchedKeywords: string[]; // ≤ 10
  decision: 'none' | 'potential_duplicate' | 'confirmed_duplicate' | 'separate_incident';
  reasons: string[];         // e.g. ['within_radius','category_match','low_text_similarity']
  algorithmVersion: string;  // 'dedupe-v1'
};
```

### 9.4 Algorithm and pseudocode (normative, `lib/duplicates/score.ts`)

```
function classifyDuplicate(report, incident, cfg) -> DuplicateBreakdown

  # --- Gate 0: absolute time window ---------------------------------
  dt = |report.reportedAt − incident.reportedAt| in minutes
  if dt > cfg.timeWindowMin:                      → decision 'none', reason 'time_window'
  if incident.status in [closed, cancelled, false_alarm, merged]:
                                                     → decision 'none', reason 'incident_terminal'

  # --- Gate 1: geospatial -------------------------------------------
  d = haversineM(report.point, incident.geo)
  if d > cfg.radiusM (default 500):                → decision 'none', reason 'outside_radius'
                                                      score = 0

  # --- Gate 2: category ---------------------------------------------
  exactCategory   = (report.category == incident.category)
  sameGroup       = CATEGORY_GROUPS[report.category] == CATEGORY_GROUPS[incident.category]
  if not exactCategory and not sameGroup:
                                                      → decision 'separate_incident'
                                                      reason 'category_mismatch'   # FR-048

  # --- Gate 3: text similarity ---------------------------------------
  sim = jaccard(normTokens(report.text), normTokens(incident.originalText))
  # normTokens: lowercase, strip punctuation, drop STOPWORDS + digits-only
  #             tokens, collapse whitespace, cap at 60 tokens each
  keywords = topOverlapTokens(10)

  # --- Scoring -------------------------------------------------------
  sDist  = clamp01(1 − d / cfg.radiusM)                 # 0..1
  sTime  = clamp01(1 − dt / cfg.timeWindowMin)          # 0..1
  sCat   = exactCategory ? 1 : (sameGroup ? 0.6 : 0)
  sText  = sim
  score  = 0.35*sDist + 0.10*sTime + 0.25*sCat + 0.30*sText

  if incident.reportCount > 1:  score += 0.05           # nudge: a multi-report incident
  score = clamp01(score)

  # --- Decision ------------------------------------------------------
  if exactCategory and sim >= cfg.textSimilarityConfirm (0.60):
        decision = 'confirmed_duplicate'  reason ['within_radius','category_match','high_text_similarity']
  else if score >= cfg.potentialThreshold (0.55):
        decision = 'potential_duplicate'  reason ['within_radius','category_or_text_match']
  else:
        decision = 'separate_incident'    reason ['low_overall_similarity']

  return { d, dt, exactCategory, sameGroup, sim, keywords, score, decision, algorithmVersion: 'dedupe-v1' }
```

**Rules that must not be violated (FR-041, FR-045, FR-046):**
1. `confirmed_duplicate` is a **suggestion surfaced to a human**, not an executed merge. The incident is always created; a dispatcher performs the merge via `POST /api/incidents/{id}/merge`.
2. Merging requires `dispatcher` or `admin`, a `reason`, and writes `auditLogs`.
3. Merging sets `mergedIntoId`, `mergedBy`, `mergedAt`, appends a `statusHistory` `merged_in` event, appends the report to the primary incident, and is reversible for 24 h.
4. The pure functions `haversineM`, `jaccard`, `classifyDuplicate` MUST live in `lib/` with **no Firestore import**, so they are unit-testable (FR-049).

### 9.5 Configurable thresholds

Read from `config/app` (see §16), overridable per admin change:

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `duplicateRadiusM` | `500` | 100–2000 | DEC-01 |
| `duplicateTimeWindowMin` | `360` | 60–4320 | DEC-02 |
| `textSimilarityConfirm` | `0.60` | 0.2–0.9 | auto-confirm similarity floor |
| `duplicatePotentialThreshold` | `0.55` | 0.2–0.95 | potential-duplicate score floor |
| `duplicateMaxCandidates` | `50` | 10–200 | `limit()` read cap |
| `stopwords` | 60-word list | — | EN; extendable |
| `algorithmVersion` | `dedupe-v1` | — | bump when weights change; stored per incident |

**Required unit tests:** distances 0/499/500/501/1000 m; time deltas at 359/360/361 min; same category diff wording; different category same spot; identical text far away; empty text (audio-only) → falls back to category+distance only; inverted hemisphere; poles; identical coordinates.

---

## 10. `notifications`

**Path:** `notifications/{notificationId}`
**Owner:** `recipientId` (the reader). **Only the recipient may read/mark-read** (FR-103).
**Written by:** server (`services/notifications`).

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `notificationId` | `string` | ✔ | = doc ID |
| `recipientUid` | `string` | ✔ | FK → `users/{uid}` |
| `type` | `NotificationType` | ✔ | see §10.2 |
| `severity` | `info\|warning\|critical` | ✔ | drives colour + sound + sorting |
| `title` | `string` | ✔ | ≤ 90 chars, no user-supplied HTML |
| `body` | `string` | ✔ | ≤ 240 chars, plain text |
| `incidentId` | `string \| null` | | FK |
| `dispatchId` | `string \| null` | | FK |
| `actorUid` | `string \| null` | | who caused it; hidden from responders when it is a citizen |
| `link` | `string \| null` | | internal route, e.g. `/incidents/{id}` |
| `dedupeKey` | `string` | ✔ | e.g. `assign:{dispatchId}` — prevents FR-108 duplicates |
| `read` | `boolean` | ✔ | |
| `readAt` | `Timestamp \| null` | | |
| `expiresAt` | `Timestamp \| null` | | after which it is hidden (not deleted) |
| `createdAt` | `Timestamp` | ✔ | |

**Indexes:** `recipientUid ASC, createdAt DESC` (bell + list) and `recipientUid ASC, read ASC, createdAt DESC` (unread count/filter).

### 10.1 `MediaRef` (embedded in `incidentReports.media`)

```ts
type MediaRef = {
  mediaId: string;
  kind: 'image' | 'audio';
  storagePath: string;      // relative to the Storage bucket root
  contentType: string;      // server-verified, not client-declared
  sizeBytes: number;
  sha256: string;           // integrity + duplicate-upload detection
  width: number | null;     // images
  height: number | null;
  durationSec: number | null; // audio
  uploadedBy: string;
  uploadedAt: Timestamp;
  scanStatus: 'clean' | 'pending' | 'quarantined';
};
```

### 10.2 `NotificationType` (FR-101)

`incident_created`, `incident_verified`, `incident_assigned`, `critical_incident_alert`, `status_changed`, `incident_resolved`, `duplicate_suggested`, `responder_unavailable`, `sla_breached`, `responder_verified`, `role_changed`, `account_suspended`

**Dispatch matrix:**

| Event | Recipients | Severity | In-app MVP? |
| --- | --- | --- | --- |
| `incident_created` | all available dispatchers | `critical` if `urgency == critical`, else `info` | ✔ |
| `critical_incident_alert` | all dispatchers + admins (deduped per incident) | `critical` | ✔ |
| `incident_verified` | reporter | `info` | ✔ |
| `incident_assigned` | assigned responder | `critical` | ✔ |
| `status_changed` | all dispatchers; reporter for terminal states only | `info` | ✔ |
| `incident_resolved` | reporter, all dispatchers, assignee | `info` | ✔ |
| `duplicate_suggested` | all dispatchers | `warning` | ✔ |
| `responder_unavailable` | dispatchers who had that responder assigned | `warning` | ✔ |
| `sla_breached` | all dispatchers | `critical` | ✔ |
| `responder_verified` / `role_changed` / `account_suspended` | the affected user | `warning` | ✔ |

> **FR-109 is reserved** and MUST NOT be used, to keep the traceability table in [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) honest.

---

## 11. `resources`, `riskZones`, `aiRuns`, `auditLogs`, `rateLimits`, `analyticsDaily`, `config`

### 11.1 `resources/{resourceId}` — capability catalogue

Read-only reference data, seeded by `scripts/seed.ts`. **Never deleted** (referential integrity), only `active: false`.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `resourceId` | `string` | ✔ | = doc ID, e.g. `res_ambulance` |
| `name` | `string` | ✔ | "Ambulance" |
| `category` | `medical\|fire\|rescue\|traffic\|utility\|shelter\|logistics\|medical_supplies` | ✔ | |
| `icon` | `string` | ✔ | lucide icon name |
| `urgencyAffinity` | `IncidentCategory[]` | | categories it usually serves |
| `unit` | `vehicle\|person\|unit\|kit\|person_shift` | ✔ | |
| `active` | `boolean` | ✔ | |
| `description` | `string` | ✔ | |

**Seed set (minimum 10):** `res_ambulance`, `res_first_aid`, `res_fire_engine`, `res_fire_extinguisher_team`, `res_police_support`, `res_traffic_control`, `res_heavy_tow`, `res_water_rescue`, `res_cooling_shelter`, `res_food_water_kit`, `res_search_team`, `res_power_team`.

### 11.2 `incidents/{id}/resources/{linkId}` — supplied resources

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `linkId` | `string` | ✔ | = doc ID |
| `incidentId` | `string` | ✔ | |
| `resourceId` | `string` | ✔ | FK → `resources/{resourceId}` |
| `quantity` | `number` | ✔ | 0–999 |
| `status` | `requested\|committed\|en_route\|delivered\|returned` | ✔ | |
| `providedBy` | `string \| null` | | responder uid or `"authority"` |
| `requestedAt` / `committedAt` / `deliveredAt` | `Timestamp` | | |
| `note` | `string \| null` | | |
| `createdAt` / `updatedAt` | `Timestamp` | ✔ | |

### 11.3 `riskZones/{zoneId}` (P1, FR-114, FR-115)

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `zoneId` | `string` | ✔ | `rz_{geohash6}_{bucket}` |
| `centre` | `GeoPoint` | ✔ | geohash-6 cell centre |
| `geohash6` | `string` | ✔ | |
| `geoCells` | `string[]` | ✔ | for map-region queries |
| `radiusM` | `number` | ✔ | default 500 |
| `score` | `number` | ✔ | 0–100 |
| `severity` | `critical\|high\|medium\|low` | ✔ | |
| `dominantCategory` | `IncidentCategory \| null` | | |
| `incidentCount` | `number` | ✔ | in the window |
| `criticalCount` | `number` | ✔ | |
| `windowDays` | `number` | ✔ | lookback used |
| `params` | `map` | ✔ | `{ weightDensity, weightSeverity, halfLifeDays }` |
| `computedAt` | `Timestamp` | ✔ | |
| `expiresAt` | `Timestamp` | ✔ | stale zones hidden |
| `createdAt` | `Timestamp` | ✔ | |

**Score formula (normative, `lib/analytics/riskScore.ts`):**
```
density   = incidentCount / (windowDays)            → normalised: min(density / 4, 1)
severity  = (criticalCount * 1.0 + highCount * 0.5 + mediumCount * 0.2) / max(incidentCount, 1)
recency   = exp(-ln2 * daysSinceLastIncident / halfLifeDays)   # halfLifeDays = 14
score     = 100 * (0.5*density + 0.35*severity + 0.15*recency)
severity band: score ≥ 70 critical, ≥ 45 high, ≥ 20 medium, else low
```

### 11.4 `aiRuns/{runId}`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `runId` | `string` | ✔ | = doc ID |
| `incidentId` | `string \| null` | | |
| `reportId` | `string \| null` | | |
| `model` | `string` | ✔ | e.g. `gemini-2.5-flash` |
| `promptVersion` | `string` | ✔ | e.g. `triage-v3` |
| `inputChannels` | `text\|image\|audio` | ✔ | which modalities were sent |
| `mediaCount` | `number` | ✔ | |
| `inputChars` | `number` | ✔ | |
| `latencyMs` | `number` | ✔ | |
| `promptTokens` / `responseTokens` | `number` | | from `usageMetadata`, null if absent |
| `finishReason` | `string \| null` | | |
| `attempt` | `number` | ✔ | 1 = first try, 2 = repair |
| `outcome` | `success\|validation_failed\|timeout\|error\|blocked` | ✔ | |
| `fallbackUsed` | `boolean` | ✔ | FR-029 |
| `fallbackKind` | `keyword_rules\|none` | | |
| `errorCode` | `string \| null` | | |
| `rawOutputHash` | `string` | ✔ | SHA-256 of the raw model text — never store the full raw text in `aiRuns` to avoid duplicating PII |
| `confidence` | `number \| null` | | model's own self-reported confidence |
| `createdAt` | `Timestamp` | ✔ | |

**Indexes:** `incidentId ASC`, `createdAt DESC`, `outcome ASC, createdAt DESC` (error-rate monitoring).

### 11.5 `auditLogs/{logId}` — append-only (FR-130, FR-131)

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `logId` | `string` | ✔ | = doc ID |
| `actorUid` | `string` | ✔ | `"system"` for automation |
| `actorRole` | `string` | ✔ | |
| `action` | `AuditAction` | ✔ | see FR-132 list |
| `entityType` | `incident\|user\|responder\|dispatch\|config\|auth\|notification` | ✔ | |
| `entityId` | `string` | ✔ | |
| `incidentRef` | `string \| null` | | human ref, for readability |
| `summary` | `string` | ✔ | ≤ 200 chars, human-readable |
| `before` | `map \| null` | | whitelisted fields only — **never** raw PII or evidence URLs |
| `after` | `map \| null` | | |
| `reason` | `string \| null` | | required for privileged actions |
| `requestId` | `string` | ✔ | FR-141 |
| `ipHash` | `string` | ✔ | SHA-256(ip + daily rotating salt) |
| `userAgent` | `string` | ✔ | ≤ 200 chars |
| `createdAt` | `Timestamp` | ✔ | |

`AuditAction` values: `incident.create`, `incident.update`, `incident.status_change`, `incident.assign`, `incident.unassign`, `incident.merge`, `incident.merge_revert`, `incident.false_alarm`, `incident.delete`, `incident.restore`, `incident.reporter_location_update`, `responder.verify`, `responder.reject`, `responder.update`, `responder.location_opt_out`, `user.create`, `user.update`, `user.role_change`, `user.disable`, `user.enable`, `config.update`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.role_mismatch`, `notification.sent`, `analytics.recompute`, `maintenance.run`.

> The FR-132 list is the **mandatory minimum**. The extra values above cover actions the API surface requires but FR-132 does not name (account creation, self-service profile update, claim drift, AI/route side effects). They are all `config`-independent and use the same append-only rules.

**Indexes:** `createdAt DESC` (default), `actorUid ASC, createdAt DESC`, `action ASC, createdAt DESC`, `entityType ASC, entityId ASC, createdAt DESC`.

### 11.6 `rateLimits/{key}` — Firestore-backed token bucket

**Path:** `rateLimits/{sha256(userUid + route + windowBucket)}` — the key is hashed so the doc ID does not leak a UID.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `key` | `string` | ✔ | = doc ID |
| `count` | `number` | ✔ | requests in the current window |
| `windowStart` | `Timestamp` | ✔ | |
| `expiresAt` | `Timestamp` | ✔ | TTL → auto-delete |
| `subjectUid` | `string` | ✔ | for admin visibility (doc ID itself stays hashed) |
| `route` | `string` | ✔ | |
| `updatedAt` | `Timestamp` | ✔ | |

Written with `transaction`/`runTransaction` (read-modify-write). **Cost:** 1 read + 1 write per limited request — accepted, see §15.

### 11.7 `analyticsDaily/{YYYY-MM-DD}` — precomputed rollups (FR-116)

Document ID is the local-date string in `APP_TIMEZONE` (default `Asia/Kolkata`, configurable).

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `date` | `string` | ✔ | `YYYY-MM-DD`, = doc ID |
| `timezone` | `string` | ✔ | |
| `total`, `critical`, `high`, `medium`, `low` | `number` | ✔ | by urgency |
| `byCategory` | `map<string, number>` | ✔ | 11 keys |
| `resolvedCount`, `cancelledCount`, `falseAlarmCount`, `mergedCount` | `number` | ✔ | |
| `sumVerifySec`, `sumDispatchSec`, `sumResolveSec` | `number` | ✔ | for means |
| `sumRespondSec` | `number` | ✔ | `respondedAt − dispatchedAt`, for `meanTimeToRespondSec` |
| `countVerify`, `countDispatch`, `countRespond`, `countResolve` | `number` | ✔ | **denominators.** Without these a mean is not computable from stored sums, and a partially-processed day would report an inflated mean. A day with `countX = 0` forces the corresponding mean to `null` rather than `0` |
| `slaBreachedCount` | `number` | ✔ | |
| `avgPeopleAffected` | `number` | ✔ | nulls excluded, count of non-null tracked in `peopleSampleSize` |
| `peopleSampleSize` | `number` | ✔ | transparency about the null-heavy field |
| `topLocations` | `{ geohash6: string; count: number }[]` | ✔ | ≤ 10, for the heat list |
| `reporterCount` | `number` | ✔ | unique reporters |
| `aiFallbackCount` | `number` | ✔ | AI health |
| `aiAvgConfidence` | `number \| null` | | |
| `computedAt` | `Timestamp` | ✔ | |
| `completeness` | `partial\|final` | ✔ | `partial` for today |

**Indexes:** none beyond the doc ID (always queried by ID range). Aggregation over a range uses `orderBy('date').startAt(end).endAt(start)`, which is single-index.

> **Why not compute on the fly?** Firestore has no `GROUP BY`/`COUNT` aggregation, and scanning a 30-day window of raw incidents would be 1 read per incident. Rollups keep `/analytics` at ~30 reads for a month regardless of incident volume (FR-116).

### 11.8 `config/app` — singleton tunables

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `number` | ✔ | |
| `appName` | `string` | ✔ | "CareGrid AI" |
| `defaultTimezone` | `string` | ✔ | `APP_TIMEZONE` |
| `appTimezone` | `string` | ✔ | display timezone |
| `slaMinutes` | `map` | ✔ | `{ critical: 5, high: 15, medium: 60, low: 240 }` |
| `duplicate` | `map` | ✔ | all §9.5 keys |
| `notifications` | `map` | ✔ | `{ channels: { inApp: true, sms: false, whatsapp: false, email: false } }` |
| `realtime` | `map` | ✔ | `{ slaWarnPct: 80, staleLocationMin: 15, responderHeartbeatSec: 60 }` |
| `risk` | `map` | ✔ | `{ weightDensity, weightSeverity, halfLifeDays, windowDays, enabled }` |
| `features` | `map` | ✔ | `{ voice: true, image: true, clusters: false, riskZones: false, bulkActions: false }` — feature flags for P1 items (US-014 §27) |
| `retention` | `map` | ✔ | `{ locationPurgeDays: 90, auditDays: 365 }` |
| `updatedAt` / `updatedBy` | `Timestamp` / `string` | ✔ | every change is audited (FR-132 `config.update`) |

---

## 12. Cross-cutting Firestore patterns

### 12.1 Geospatial summary (normative)

| Task | Mechanism | Reads |
| --- | --- | --- |
| Find incidents within 500 m of a point | one `where('geoCells','array-contains', geohash6(query))` + `limit(50)` + Haversine filter | ≤ 51 |
| Duplicate candidate search | same query + `createdAt >=` window + `status in [7]` | ≤ 51 |
| Map viewport render | `where('geoCells','array-contains', cell)` + `status in [7]` + `orderBy('updatedAt','desc').limit(150)`; cells computed from the viewport bounds (dedupe the set; a 3×3 cell block = 9 cells → 9 queries max, or one `array-contains`-any… **note:** `in` cannot be combined with `array-contains`, so viewport queries use up to 9 sequential `array-contains` reads; cap the viewport span at 25 km) | ≤ 9 × 150, capped by §12.5 |
| Nearest available responders | client fetches `where('status','==','available').where('verification','==','verified').limit(60)`, then Haversine + capability + radius filter in `lib/geo/nearest.ts`; for > 500 responders, add `homeBaseGeoCells array-contains` pre-filtering | ≤ 61 |

**Hard limits (FR-037):** never fetch more than 150 incidents for a map view; never more than 60 responders for candidate ranking; always `limit()`.

**Active statuses (the canonical 7-element set used by every `status in [...]` query and index):**

```
ACTIVE_STATUSES = ['new', 'triaged', 'verified', 'assigned', 'en_route', 'on_scene', 'resolved']
TERMINAL_STATUSES = ['closed', 'cancelled', 'false_alarm', 'merged']
```

`ACTIVE_STATUSES` MUST be exported from `lib/incidents/constants.ts` and imported everywhere; it is never written as a literal. `resolved` is included because a resolved-but-not-closed incident still has an open audit/analytics obligation and must stay visible on the dashboard. All status sets are ≤ 7 values, comfortably inside Firestore's 30-value `in` limit.

### 12.2 Realtime updates

- `onSnapshot` is used **only** for the live queue, the map, the notification bell, and the responder's active incidents.
- Every listener query **must** include a `limit()` and a role-appropriate `where` filter ([11](./11_REALTIME_SYSTEM.md)).
- Listeners are torn down on unmount and on role change (never leave a citizen's client subscribed to dispatcher data).
- Writes from a client use `includeMetadataChanges: true` **only** in the queues that show a "pending" state.
- Never attach a listener to an unbounded collection. Never listen to `incidents` for analytics (FR-099 is reserved; the rule stands as FR-116/FR-117).

### 12.3 Pagination (FR-121)

Cursor-based only, no offsets:
```ts
let q = db.collection('incidents')
  .where('deletedAt', '==', null)
  .orderBy('createdAt', 'desc')
  .limit(pageSize);                 // default 25, max 100
if (cursor) q = q.startAfter(cursorDoc);   // cursor = the last document's snapshot
```
Cursor tokens returned to the client are the **opaque document ID** plus a `createdAt` value; the server re-reads the document to build `startAfter`, so the client cannot inject arbitrary cursors. Results are returned as `{ items, nextCursor, hasMore }`.

### 12.4 Soft deletion (FR-123)

- `deletedAt` / `deletedBy` / `deleteReason` are set; `updatedAt` is bumped.
- Every default query MUST include `where('deletedAt', '==', null)`. This is the single most commonly forgotten rule — it is enforced by a custom ESLint/review checklist item and by rules tests.
- Deleting evidence: media files are moved to `quarantine/` and purged after 30 days by a manual job; **no hard delete in the request path**.
- Admins can restore (audit `incident.restore`).
- A dedicated privileged query `includeDeleted=1` is dispatcher/admin-only and always audited.

### 12.5 Read budget rules (hard limits)

| Rule | Limit |
| --- | --- |
| Max `limit()` on any client listener | 200 |
| Max `limit()` on any server query | 500 (analytics raw scans never exceed 500) |
| Map viewport | ≤ 150 incidents, ≤ 9 cell queries, ≤ 25 km span |
| Candidate responders | ≤ 60 |
| Duplicate candidates | ≤ 50 |
| Listeners per client | ≤ 8 (FR-091) |
| Documents read per dispatcher session-hour | ≤ 4 000 (NFR-007) |

### 12.6 Transaction patterns (normative — no races)

| Operation | Atomic operation |
| --- | --- |
| Create incident | `runTransaction`: read `users/{uid}` (role/limits), write `incidents/{id}`, `incidents/{id}/statusHistory/created`, `incidents/{id}/reports/{reportId}`; generate `reference` with a uniqueness retry |
| Assign responder | `runTransaction`: read `incidents/{id}` (status, assignee), read `dispatches` where `incidentId==id && status in [active,accepted]`, read `responders/{uid}`; write new `dispatches/{id}`, set `incidents.assigneeUid`, increment `responders.activeIncidentCount`, set `responders.status='busy'`, append `statusHistory` |
| Change status | `runTransaction`: read incident, validate transition + permission, write status/timestamps, append `statusHistory` |
| Merge duplicate | `runTransaction`: read both incidents, write `mergedIntoId/mergedBy/mergedAt`, append report (move = copy + delete source), append `statusHistory` on both, write `auditLogs` |
| Notification | `runTransaction` on `dedupeKey` to guarantee one notification per key (FR-108) |
| Rate limit | `runTransaction` read-modify-write with a 60 s window |
| Mark notifications read | `writeBatch`, ≤ 200 doc batch limit |
| Role change | `runTransaction`: update `users/{uid}` **then** `setCustomUserClaims` (claim write is outside Firestore; treat as a compensating action and log failures — see §12.7) |

### 12.7 Known Firestore constraints (documented, not worked around silently)

| Constraint | Consequence in this project |
| --- | --- |
| No cross-document ACID outside a transaction | All multi-entity writes listed in §12.6 are inside `runTransaction`; anything that also touches Auth or Storage is **not** atomic and is made idempotent + auditable |
| Auth custom claims are not transactional with Firestore | `user.role_change` writes Firestore first, then the claim; a claim failure leaves a `role_change_pending` marker in `users` and a retry job; the **server** treats the Firestore `role` as authoritative for authorization, and the claim is only for Security Rules |
| `array-contains` cannot combine with `in`/`orderBy` on a different field without a composite index | Index #6 exists for exactly this |
| `array-contains` is not a "near" query | Haversine filtering is mandatory after any geospatial query |
| 10-element array index limit | `geoCells` is exactly 10 by design (§9.2) |
| 30-value `in` limit, 10-value `or` limit | Status sets are grouped to stay ≤ 30 (7 active statuses) |
| 500-doc `writeBatch` limit, 20 writes/s in a transaction | Bulk ops are chunked and queued |
| Maximum 1 MiB per document | Unbounded data lives in subcollections |
| Deletion costs 1 write/doc | Soft delete is also a cost decision |
| A transaction retries silently up to 5 times | All transaction bodies must be **idempotent** (no counters incremented twice on retry) |
| Firestore TTL deletes within 24 h of `expiresAt` | TTL is a hygiene tool, never a correctness mechanism |

---

## 13. Security Rules outline (full rules in [10](./10_AUTHORIZATION_SECURITY.md) and `firestore.rules`)

| Collection | `citizen` | `responder` | `dispatcher` | `admin` |
| --- | --- | --- | --- | --- |
| `users/{uid}` | read self | read self | read all | read/write all |
| `users/*` (role field) | ✖ | ✖ | ✖ | write (server-mediated only) |
| `profiles/{uid}` | rw self | rw self | read | rw |
| `incidents` | create (own `reporterUid`), read own | read assigned + in-radius when available | read/write all | read/write all |
| `incidents` status/assignment fields | ✖ | only own assigned transition fields | ✔ | ✔ |
| `incidents/*/reports` | create in own incident | read if incident visible | ✔ | ✔ |
| `incidents/*/statusHistory` | read if incident visible | read if incident visible | read | read |
| `incidents/*/resources` | read if visible | read if visible | ✔ | ✔ |
| `responders` | read verified+available minimal fields | read/write self fields | read all | read/write all |
| `responders` verification fields | ✖ | ✖ | ✖ | write |
| `responderLocations` | ✖ | write own (rate-limited) | read all | read all |
| `dispatches` | read own incident's | read own | rw | rw |
| `notifications` | read/update-read own only | same | same | same |
| `resources` | read active | read active | read | read |
| `riskZones` | ✖ | read | read | read/write |
| `auditLogs` | ✖ | ✖ | read | read |
| `aiRuns` | ✖ | ✖ | read | read |
| `rateLimits` | ✖ | write own key | ✖ | read |
| `analyticsDaily` | ✖ | ✖ | read | read |
| `config/app` | read | read | read | read |
| **No collection** | ✖ | ✖ | ✖ | **delete of `auditLogs`** |

Rules use the `role` custom claim; the **server is the real enforcement point** (NFR-015) because rules alone cannot express "assigned responder may transition this incident".

---

## 14. Seed data (demo, `scripts/seed.ts`)

Guarded by `NODE_ENV !== 'production'` **and** `ALLOW_SEED=true` (FR-147).

- 1 admin, 2 dispatchers, 4 responders (3 `verified`, 1 `pending`), 6 citizens.
- Demo account **passwords are never hard-coded in this repository.** `scripts/seed.ts` reads the password from the `SEED_DEMO_PASSWORD` environment variable; if it is unset a random password is generated and printed to the operator's console once, and the operator distributes it out of band. This satisfies both the demo requirement and the "no committed credentials" rule in [18](./18_TESTING_QA_PLAN.md) §15.
- 3 geo-anchored incidents matching [29](./29_DEMO_SCENARIO.md) exactly (same coordinates, same text, same timeline), including the pre-existing nearby report that makes the duplicate engine produce a genuine `confirmed_duplicate`.
- 1 "heatwave" cluster of 4 incidents in one geohash-6 cell to make the analytics and risk-zone visuals meaningful.
- `resources` catalogue (12 entries), `config/app`, and 14 days of `analyticsDaily` rollups.
- Every seed document is written with an explicit `Timestamp`, never `serverTimestamp()`, so the demo timeline is reproducible.

---

## 15. Cost awareness (per-operation read/write estimate)

| Operation | Reads | Writes | Notes |
| --- | --- | --- | --- |
| `POST /api/incidents` (create) | 1–2 (user, duplicate candidates ≤ 50) | 3 (incident, history, report) + 1 `aiRuns` | Duplicate search is the dominant cost |
| `PATCH /status` | 1–2 | 2 (incident, history) | inside a transaction |
| `POST /dispatch` | 2–3 | 3 (dispatch, incident, history) + notifications | |
| `GET /api/incidents?limit=25` | 25 | 0 | |
| `/dashboard` first paint (RSC) | ~120 | 0 | queue 50 + KPIs 20 + responder snapshot 50 |
| Live queue listener, 1 h idle | ~50 initial + N×changes | 0 | listen to 50 docs → 1 read each on attach |
| `GET /api/analytics?days=30` | ~30 (rollups) | 0 | FR-116 |
| Duplicate `potential_duplicate` creation | 1 + ≤ 50 | 3 + 1 | cap candidates to 25 when a listener is active |

All estimates are compared against the free-tier budget in [26](./26_PERFORMANCE_REQUIREMENTS.md) §5.

---

## 16. Collection → requirement traceability

| Collection | Implements FR | Used by API routes | UI |
| --- | --- | --- | --- |
| `users` | FR-001, FR-130, FR-132, FR-133 | all (auth), `/api/admin/users` | `/admin/users` |
| `profiles` | FR-038 | `/api/me` | `/profile` |
| `incidents` | FR-001…FR-058, FR-070…FR-075, FR-120…FR-124 | `/api/incidents*` | `/incidents*`, `/dashboard`, `/map` |
| `incidentReports` | FR-003, FR-005, FR-006, FR-012, FR-046 | `/api/incidents/:id/reports` | incident detail |
| `statusHistory` | FR-052, FR-059, FR-122 | `/api/incidents/:id` | incident timeline |
| `responders` | FR-060…FR-064, FR-069 | `/api/responders*` | `/responders`, dispatcher assign panel |
| `responderLocations` | FR-066, FR-081 | `PATCH /api/responders/:id/location` | `/map` |
| `dispatches` | FR-053, FR-065, FR-074 | `/api/incidents/:id/dispatch` | `/dispatches`, responder dashboard |
| `notifications` | FR-100…FR-108 | `POST /api/notifications` | `/notifications`, bell |
| `resources` + `incidentResources` | FR-062, FR-065 | `/api/resources` | dispatch panel, incident detail |
| `riskZones` | FR-114, FR-115 | `GET /api/analytics?include=risk` | `/analytics` risk tab |
| `auditLogs` | FR-130…FR-136 | `/api/admin/audit-logs` | `/admin/audit-logs` |
| `aiRuns` | FR-028 | triage service | incident detail (AI panel) |
| `rateLimits` | FR-015, NFR-016 | all write routes | — |
| `analyticsDaily` | FR-110…FR-118 | `GET /api/analytics` | `/analytics` |
| `config/app` | FR-042, FR-057, FR-114, FR-133 | all read paths | `/admin/settings` |

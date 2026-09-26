# 08 — API Specification

**Project:** CareGrid AI
**Status:** Baseline v1.0 — normative for every endpoint, request, and response
**Related:** [06 Backend Architecture](./06_BACKEND_ARCHITECTURE.md), [07 Database Schema](./07_DATABASE_SCHEMA.md), [16 Error Handling](./16_ERROR_HANDLING.md), [17 Validation Rules](./17_VALIDATION_RULES.md)

---

## 1. Conventions

### 1.1 Base and transport

| Aspect | Rule |
| --- | --- |
| Base | `/api/*` — Next.js Route Handlers under `app/api/**/route.ts` |
| Runtime | `export const runtime = 'nodejs'` on **every** route (Firebase Admin + Gemini need Node) |
| Content type | Request `application/json` (except media upload, which is a direct Storage PUT) |
| Auth | `Authorization: Bearer <Firebase ID token>` |
| Token | Obtained client-side via `auth.currentUser.getIdToken()`; refreshed on 401 |
| Method override | ✖ none. Use explicit verbs. |
| Versioning | Path segment `/api/v1/**` is **deferred** (single-client hackathon). Schema versioning uses `schemaVersion` fields ([07](./07_DATABASE_SCHEMA.md) §2). `DECISION REQUIRED` — decide before any second consumer exists. |
| Docs | Hand-written here; each route's Zod schema is the executable contract ([06](./06_BACKEND_ARCHITECTURE.md) §5) |
| Idempotency | `POST /api/incidents` accepts an optional `Idempotency-Key` header (see §3.1) |
| Timeouts | Server-side `AbortSignal.timeout(20_000)` for AI, `8_000` for Maps, `5_000` for Firestore writes |
| Response compression | Automatic (Vercel) |

### 1.2 Success envelope (FR-140)

```json
{
  "success": true,
  "data": { "...": "..." },
  "meta": { "requestId": "req_7Kd2mQ9xL4n", "timestamp": "2026-09-26T10:05:31.000Z" }
}
```

### 1.3 Error envelope (FR-140, full catalogue in [16](./16_ERROR_HANDLING.md))

```json
{
  "success": false,
  "error": {
    "code": "INCIDENT_NOT_FOUND",
    "message": "Incident could not be found.",
    "details": [{ "field": "urgency", "issue": "invalid_enum_value" }],
    "requestId": "req_7Kd2mQ9xL4n"
  }
}
```

Rules: `code` is a stable machine string; `message` is human-readable English and safe to show a user; `details` is optional field-level validation info only (never stack traces, never internal IDs); `requestId` is always present.

### 1.4 Serialisation rules

| Firestore type | JSON |
| --- | --- |
| `Timestamp` | ISO-8601 UTC string `"2026-09-26T10:05:31.000Z"` |
| `GeoPoint` | `{ "lat": 17.4478, "lng": 78.4874 }` |
| `DocumentReference` | its path string |
| `null` field | `null` (only where the contract says so) |
| Absent field | omitted from the response (never `undefined`) |

Dates are always UTC ISO-8601; client formats using `APP_TIMEZONE` (NFR-146).

### 1.5 List responses (FR-121)

```json
{
  "success": true,
  "data": {
    "items": [ /* … */ ],
    "page": { "nextCursor": "r7Kp2mQ9xL4nT8vB3cD6", "hasMore": true, "limit": 25 }
  },
  "meta": { "requestId": "req_…", "timestamp": "…" }
}
```

`nextCursor` is an opaque token (the last document ID). `startAfter` cursor is re-resolved server-side, so a client cannot inject an arbitrary snapshot.

### 1.6 Authentication flow on every protected route

```
1. Read Authorization header → missing ⇒ 401 AUTH_REQUIRED
2. admin.auth().verifyIdToken(token)        → invalid ⇒ 401 AUTH_INVALID_TOKEN
3. token.uid must have an active users/{uid} doc  → missing/disabled ⇒ 403 ACCOUNT_UNAVAILABLE
4. Resolve role from users/{uid}.role (server-authoritative, NFR-015) and cross-check the
   token claim; if they disagree ⇒ 403 ROLE_MISMATCH and an audit log entry
5. Verify CSRF origin for non-GET requests (§1.8)
6. Enforce rate limit (§1.9)
7. Validate the Zod schema BEFORE any DB/AI/Maps call (FR-142)
8. Execute; on success return 200/201 with the envelope
```

### 1.7 Roles and status codes used in this document

`citizen` · `responder` · `dispatcher` · `admin` (see [22](./22_USER_ROLES_PERMISSIONS.md))

| Status | When |
| --- | --- |
| 200 | Read/update success |
| 201 | Resource created |
| 400 | Schema validation failure (`VALIDATION_FAILED`) |
| 401 | Missing/invalid token (`AUTH_REQUIRED`, `AUTH_INVALID_TOKEN`, `AUTH_EXPIRED`) |
| 403 | Authenticated but not permitted (`FORBIDDEN`, `ROLE_MISMATCH`, `ACCOUNT_UNAVAILABLE`, `CSRF_FAILED`, `UPLOAD_FORBIDDEN_PATH`) |
| 404 | Not found **or** not visible to the caller — identical response for both (no existence oracle, US-005) |
| 409 | State conflict (`INVALID_STATUS_TRANSITION`, `ALREADY_ASSIGNED`, `DUPLICATE_REFERENCE`) |
| 413 | Upload too large |
| 415 | Unsupported media type / unsupported evidence type |
| 422 | Well-formed but semantically rejected (`EMPTY_REPORT`, `AI_OUTPUT_INVALID`, `RESOURCE_REQUIRED`) |
| 429 | Rate limited (`RATE_LIMIT_EXCEEDED`) |
| 500 | Unexpected (`INTERNAL_ERROR`) — body must never leak internals |
| 502/503 | Upstream failure (`AI_UNAVAILABLE`, `MAPS_UNAVAILABLE`, `DB_UNAVAILABLE`) |

### 1.8 CSRF protection

Same-origin enforcement on all **non-GET** requests: the server compares the `Origin` (or `Referer`) header against `NEXT_PUBLIC_APP_URL`. A mismatch → `403 CSRF_FAILED`. Bearer-token APIs are not classically CSRF-vulnerable, but this check is defence in depth against a token captured in a malicious page's request. `Idempotency-Key` is also required on `POST /api/incidents`.

### 1.9 Rate limits (FR-015, NFR-016)

Implemented with the Firestore token bucket in [07](./07_DATABASE_SCHEMA.md) §11.6. Limits are per `uid` (or per IP for unauthenticated routes) and per route class.

| Route class | Limit | Window | Over-limit response |
| --- | --- | --- | --- |
| `POST /api/incidents` | 5 / 20 | 1 h / 24 h | 429 `RATE_LIMIT_EXCEEDED` |
| `POST /api/incidents/:id/triage` | 20 | 1 h | 429 |
| `PATCH /api/incidents/:id/status` | 60 | 1 h | 429 |
| `POST /api/incidents/:id/dispatch` | 30 | 1 h | 429 |
| `POST /api/incidents/:id/merge` | 20 | 1 h | 429 |
| `POST /api/uploads/sign` | 30 | 1 h | 429 |
| `PATCH /api/responders/:id/location` (client heartbeat) | 120 | 1 h (≈ 30 s effective floor) | 429; client backs off to 60 s |
| `GET /api/incidents` | 120 | 1 min | 429 |
| `GET /api/analytics` | 30 | 1 min | 429 |
| `POST /api/notifications` (internal/test) | 10 | 1 min | 429 |
| Unauthenticated `POST /api/auth/event` with `type: "login_failed"` | 10 / IP | 1 h | 429 (FR-135) |

Every 429 includes `Retry-After` (seconds) and a `RATE_LIMIT_EXCEEDED` code. The Firestore counter is reset when the window expires.

---

## 2. Authentication (Firebase client SDK)

> Firebase Authentication is handled **client-side**; the server only verifies tokens. There is no `/api/auth/login` route.

| Flow | Client call | Server involvement |
| --- | --- | --- |
| Sign up (email/password) | `createUserWithEmailAndPassword` | `POST /api/me/bootstrap` to create the `users/{uid}` doc |
| Sign in | `signInWithEmailAndPassword` | — (optional `POST /api/auth/event` for audit) |
| Google sign-in | `signInWithPopup(GoogleAuthProvider)` | same as sign-up |
| Sign out | `signOut` | `POST /api/auth/event { type: 'logout' }` (best-effort) |
| Reset password | `sendPasswordResetEmail` | none |
| Refresh claims | `getIdToken(true)` after a role change | — |

### 2.1 `POST /api/me/bootstrap`

Create the `users/{uid}` record on first authenticated client call. Idempotent.

| | |
| --- | --- |
| Auth | Required, any role |
| Rate limit | 10 / hour / uid |
| Request | `{ "displayName": "Priya Nair", "timezone": "Asia/Kolkata" }` |
| Validation | `displayName` 2–60 chars; `timezone` valid IANA name |
| Behaviour | If `users/{uid}` exists → `200` with the existing user (no overwrite). If not → create with `role: 'citizen'`, `status: 'active'`, `provider` from the token. Also writes `profiles/{uid}`. |
| Response 200/201 | `{ "user": {UserPublic}, "isNew": false }` |
| Errors | `VALIDATION_FAILED`, `ACCOUNT_UNAVAILABLE`, `RATE_LIMIT_EXCEEDED` |
| Audit | `user.create` (not in the FR-132 mandatory list; allowed extra) |

### 2.2 `GET /api/me`

| | |
| --- | --- |
| Auth | Required |
| Response 200 | `{ "user": {UserPublic}, "profile": {Profile}, "permissions": ["incident:create", "incident:read:own", …] }` — the **server-computed** permission list used to render the UI. The UI uses this for affordances only; **it is never an authorization input** (FR/NFR-015) |
| Errors | `AUTH_REQUIRED` |

### 2.3 `PATCH /api/me`

| | |
| --- | --- |
| Auth | Required |
| Request | `{ "displayName"?: string, "timezone"?: string, "locale"?: string, "notifPrefs"?: { inApp?: boolean, email?: boolean, sms?: boolean, whatsapp?: boolean } }` |
| Validation | Same bounds; **role, status, verification, and email are not present in the schema and can never be set here** |
| Response 200 | `{ "user": {UserPublic} }` |
| Audit | `user.update` |
| Errors | `VALIDATION_FAILED`, `ACCOUNT_UNAVAILABLE` |

### 2.4 `POST /api/auth/event`

Audit-only endpoint for login/logout/failure. Fire-and-forget from the client.

| | |
| --- | --- |
| Auth | Optional (failures arrive without a token) |
| Rate limit | 30 / hour per uid-or-IP |
| Request | `{ "type": "login\|logout\|login_failed", "provider": "password\|google", "reason": "INVALID_PASSWORD\|USER_NOT_FOUND\|USER_DISABLED\|NETWORK" }` |
| Behaviour | Writes `auditLogs` only. **Never** returns whether a user exists. |
| Response 200 | `{ "ok": true }` |
| Errors | `RATE_LIMIT_EXCEEDED` |

---

## 3. Incidents

### 3.1 `POST /api/incidents` — create incident (FR-001 … FR-019, FR-029, FR-040)

The single most important endpoint. Accepts the report, uploads nothing (media is pre-uploaded to Storage), runs triage, runs duplicate detection, and returns the incident.

| | |
| --- | --- |
| Auth | Required. Roles: `citizen`, `responder`, `dispatcher`, `admin` |
| Authorization | Any authenticated active user |
| Idempotency | `Idempotency-Key` header, ≤ 64 chars, stored in `rateLimits` alongside the uid for 24 h; replay returns the original `201` body with header `Idempotent-Replay: true` |
| Rate limit | 5/hour, 20/day (FR-015) |
| **Validation order** | Zod parse → media ownership check → duplicate search → AI triage → transaction write |

**Request body**
```json
{
  "text": "big accident on the service road near the metro gate, a car is stuck and someone is crying inside, please send help fast",
  "media": [
    { "mediaId": "med_a91", "kind": "image", "storagePath": "incidents/r7Kp2mQ9xL4nT8vB3cD6/reports/rep_8Dn2Kq/med_a91.jpg", "contentType": "image/jpeg", "sizeBytes": 184320, "sha256": "9f2b…" }
  ],
  "location": {
    "lat": 17.4478, "lng": 78.4874, "accuracyM": 34, "source": "gps",
    "text": null, "placeId": null
  },
  "reportedAt": "2026-09-26T10:05:00.000Z",
  "language": "en",
  "skipTriage": false
}
```

Field rules (full schemas in [17](./17_VALIDATION_RULES.md)):

| Field | Required | Rules |
| --- | --- | --- |
| `text` | conditional | 20–2000 chars after trim. Required when `media` is empty. `null` allowed only with ≥ 1 media item (FR-002) |
| `media` | conditional | ≤ 3 images, ≤ 1 audio, total ≤ 3 items; each path MUST match `^incidents/[A-Za-z0-9]{20}/(reports|supplements)/[A-Za-z0-9]{2,}/[A-Za-z0-9_.-]+$` and MUST belong to a signed upload issued to this uid within 30 min |
| `location` | no | `lat ∈ [-90,90]`, `lng ∈ [-180,180]`, `accuracyM ∈ [0, 1000]`, `source ∈ gps\|manual_pin\|address_text\|none`; if `source = none` all coordinates must be `null`; if `source = address_text`, `location.text` is required (3–200 chars) |
| `reportedAt` | no | ISO-8601, not more than 24 h in the past, not more than 5 min in the future |
| `language` | no | ISO-639-1, default `en` |
| `skipTriage` | no | `dispatcher`/`admin` only; forces `triageSource: 'manual'` with `aiConfidence: 0` |

**Server pipeline** (each step is individually failure-tolerant):

1. `requireUser()` → uid, role.
2. Zod validation (FR-142).
3. **Media verification**: each `storagePath` is checked with the Admin SDK for existence, size, and **magic-byte signature**; the client `contentType` is ignored in favour of the sniffed type (FR-008). A mismatch → `UPLOAD_SIGNATURE_MISMATCH` and the item is dropped; if that leaves no evidence and no text → `EMPTY_REPORT`.
4. **Duplicate search**: one `geoCells array-contains` query (≤ 50 candidates) + `classifyDuplicate()` for each (FR-040 … FR-048). Skipped when there is no location, with `duplicateStatus: 'none'` and reason recorded.
5. **AI triage** (FR-020 … FR-029): Gemini call with a 20 s hard timeout, `responseSchema` enforced, Zod validation, one repair attempt, then a deterministic keyword fallback. **A failure here never fails the request** (FR-029).
6. **Write** in one `runTransaction`: `incidents/{id}` (with `reference` uniqueness retry), `incidents/{id}/statusHistory/created`, `incidents/{id}/reports/{reportId}`; plus `aiRuns/{runId}` (outside the transaction).
7. **Notifications** (fire-and-forget, non-blocking, FR-107): `critical_incident_alert` (if critical) / `incident_created` to dispatchers; `duplicate_suggested` to dispatchers when `potential_duplicate`.
8. **Audit**: `incident.create`.

**Response `201`**
```json
{
  "success": true,
  "data": {
    "incident": {
      "incidentId": "r7Kp2mQ9xL4nT8vB3cD6",
      "reference": "CG-7QK4M2",
      "status": "new",
      "category": "traffic_accident",
      "urgency": "critical",
      "urgencySource": "ai",
      "summary": "Two-car collision blocking the right lane; one person trapped inside the second car.",
      "peopleAffected": 2,
      "requiredResources": [{ "resourceId": "res_ambulance", "quantity": 1 }],
      "safetyFlags": ["medical_critical", "injured_trapped"],
      "triageSource": "ai",
      "aiConfidence": 0.83,
      "aiNeedsReview": false,
      "location": { "lat": 17.4478, "lng": 78.4874, "accuracyM": 34, "accuracyGrade": "high", "source": "gps", "placeName": "Service Road, near Secunderabad Metro Gate 1" },
      "duplicateStatus": "none",
      "duplicateOf": null,
      "slaTargetMin": 5,
      "slaState": "on_track",
      "reportCount": 1,
      "evidenceCount": 1,
      "createdAt": "2026-09-26T10:05:31.000Z",
      "updatedAt": "2026-09-26T10:05:31.000Z"
    },
    "duplicate": null
  },
  "meta": { "requestId": "req_7Kd2mQ9xL4n", "timestamp": "2026-09-26T10:05:31.000Z" }
}
```

**Response `201` with a duplicate candidate** (`data.duplicate` populated):
```json
{
  "incident": { "…": "…", "duplicateStatus": "potential_duplicate" },
  "duplicate": {
    "status": "potential_duplicate",
    "primaryIncidentId": "r5Ab1cD2eF3gH4iJ5kL6",
    "primaryReference": "CG-3PL8QW",
    "score": 0.78,
    "breakdown": {
      "distanceM": 142, "timeDeltaMin": 3, "categoryMatch": true,
      "categoryGroupMatch": true, "textSimilarity": 0.68,
      "matchedKeywords": ["car", "stuck", "help"],
      "decision": "potential_duplicate", "reasons": ["within_radius", "category_match"],
      "algorithmVersion": "dedupe-v1"
    },
    "canLink": true
  }
}
```

**Errors**

| Code | Status | Cause |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Zod failure, `details` lists fields |
| `EMPTY_REPORT` | 422 | No text ≥ 20 chars and no valid media (FR-002) |
| `UPLOAD_NOT_FOUND` | 422 | A `storagePath` does not exist |
| `UPLOAD_SIGNATURE_MISMATCH` | 415 | Bytes do not match any allowed type |
| `UPLOAD_TOO_LARGE` | 413 | Exceeds 5 MB image / 15 MB audio |
| `UPLOAD_FORBIDDEN_PATH` | 403 | Path does not match the pattern or was not issued to this user |
| `LOCATION_OUT_OF_RANGE` | 400 | Impossible coordinates |
| `RATE_LIMIT_EXCEEDED` | 429 | FR-015 |
| `AI_UNAVAILABLE` | *never* | Triaged falls back; this code never reaches the client for creation (FR-029) |
| `DB_UNAVAILABLE` | 503 | Firestore unreachable after retries |
| `INTERNAL_ERROR` | 500 | Bug; details suppressed |

**Client behaviour on success:** navigate to `/track?ref=CG-XXXXXX`, `role="status"` success message with a copy button and a "share" action (US-001).

### 3.2 `GET /api/incidents` — list incidents (FR-070, FR-120, FR-121, FR-124)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `citizen` ⇒ **forced** filter `reporterUid == self`, other filters ignored (never applied). `responder` ⇒ own incidents **plus** `assigneeUid == self` **plus** unassigned incidents in radius when `status == available` (FR-124). `dispatcher`/`admin` ⇒ all. |
| Rate limit | 120 / min |

**Query parameters**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `status` | `IncidentStatus` (repeatable) | active set `new,triaged,verified,assigned,en_route,on_scene` | |
| `urgency` | enum (repeatable) | — | |
| `category` | enum (repeatable) | — | |
| `verified` | `true\|false\|any` | `any` | `false` ⇒ `verifiedAt == null` |
| `slaState` | `on_track\|at_risk\|breached` | — | computed from `slaTargetMin` and `verifiedAt` |
| `unassigned` | `true\|false` | — | `assigneeUid == null` |
| `from` / `to` | ISO date | last 30 days | max span 365 days |
| `q` | string ≤ 60 chars | — | token search over `searchTokens` (`array-contains` per token, then intersect in code; capped at 3 tokens) |
| `center` | `"lat,lng"` | — | with `radiusM` (≤ 2000) for the duplicate-style view |
| `sort` | `newest\|oldest\|urgency\|sla\|distance` | `newest` | `distance` requires `center` |
| `limit` | int 1–100 | 25 | FR-121 |
| `cursor` | string | — | opaque |
| `includeDeleted` | `true` | `false` | dispatcher/admin only, audited (FR-123) |

**Response `200`**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "incidentId": "r7Kp2mQ9xL4nT8vB3cD6",
        "reference": "CG-7QK4M2",
        "status": "assigned",
        "category": "traffic_accident",
        "urgency": "critical",
        "urgencySource": "ai",
        "triageSource": "ai",
        "aiConfidence": 0.83,
        "aiNeedsReview": false,
        "summary": "Two-car collision blocking the right lane; one person trapped inside the second car.",
        "location": { "lat": 17.4478, "lng": 78.4874, "accuracyM": 34, "accuracyGrade": "high", "source": "gps", "placeName": "Service Road, near Secunderabad Metro Gate 1" },
        "reporterCount": 2,
        "evidenceCount": 3,
        "assignee": { "uid": "u_4Kd8sTn", "displayName": "Yusuf Khan", "status": "busy" },
        "verification": "human_verified",
        "slaTargetMin": 5,
        "slaState": "on_track",
        "ageMin": 4,
        "createdAt": "2026-09-26T10:05:31.000Z",
        "updatedAt": "2026-09-26T10:09:12.000Z",
        "distanceM": null
      }
    ],
    "page": { "nextCursor": "r5Ab1cD2eF3gH4iJ5kL6", "hasMore": true, "limit": 25 }
  },
  "meta": { "…": "…" }
}
```

List rows intentionally **omit** `originalText`, `requiredResources`, `safetyFlags` details, and `reporterUid` for non-privileged callers (data minimisation, NFR-027).

**Errors:** `VALIDATION_FAILED` (bad param) · `INVALID_CURSOR` · `CURSOR_COMBINATION_INVALID` (e.g. `sort=distance` without `center`) · `FORBIDDEN` (citizen passing `includeDeleted`) · `RATE_LIMIT_EXCEEDED`.

### 3.3 `GET /api/incidents/:id` — incident detail (FR-075, FR-122)

| | |
| --- | --- |
| Auth | Required |
| Authorization | Same visibility rule as the list. A citizen requesting someone else's incident gets **404**, never 403. |
| Rate limit | 120 / min |
| Query | `expand` = comma list from `reports,history,resources,dispatch,ai,duplicates`; default `reports,history,dispatch` |

**Response `200`** — `data.incident` is the full incident, plus:

```json
{
  "data": {
    "incident": { "…full field set, including originalText, safetyFlags, requiredResources, duplicateBreakdown, searchTokens omitted…" },
    "reporter": { "uid": "u_9fJ2kLmQ", "displayName": "Priya Nair" },
    "reports": [
      { "reportId": "rep_8Dn2Kq", "kind": "original", "reporter": { "uid": "u_9fJ2kLmQ", "displayName": "Priya Nair" },
        "text": "…", "createdAt": "…", "similarityToPrimary": null,
        "media": [ { "mediaId": "med_a91", "kind": "image", "contentType": "image/jpeg", "sizeBytes": 184320,
                     "width": 1280, "height": 960, "uploadedAt": "…", "scanStatus": "clean",
                     "signedUrl": "https://firebasestorage.googleapis.com/v0/b/…?X-Goog-Signature=…" } ] }
    ],
    "history": [
      { "eventId": "ev_1", "eventType": "created", "fromStatus": null, "toStatus": "new", "actor": { "uid": "u_9fJ2kLmQ", "displayName": "Priya Nair", "role": "citizen" }, "createdAt": "…" },
      { "eventId": "ev_2", "eventType": "ai_triaged", "toStatus": "triaged", "actor": { "uid": "system", "role": "system" }, "metadata": { "confidence": 0.83, "urgency": "critical", "category": "traffic_accident", "fallback": false }, "createdAt": "…" }
    ],
    "dispatch": { "dispatchId": "dsp_2Qm8Kx", "status": "accepted", "responder": { "uid": "u_4Kd8sTn", "displayName": "Yusuf Khan" }, "dispatchedBy": "u_disp01", "distanceM": 640, "capabilityMatch": true, "dispatchedAt": "…", "acceptedAt": "…" },
    "resources": [ { "linkId": "rl_1", "resourceId": "res_ambulance", "name": "Ambulance", "quantity": 1, "status": "committed" } ],
    "ai": { "runId": "ai_5Xq91LmTz", "model": "gemini-2.5-flash", "promptVersion": "triage-v3", "confidence": 0.83, "outcome": "success", "fallbackUsed": false, "latencyMs": 3120, "safetyFlags": ["medical_critical"], "explanation": "Model found explicit language of entrapment and distress (score 0.83). Urgency was raised to critical by rule critical-flag 'medical_critical'." },
    "duplicates": { "potential": [ { "incidentId": "…", "reference": "CG-…", "score": 0.78, "breakdown": { "…": "…" } } ], "mergedFrom": [ "CG-3PL8QW" ] },
    "permissions": ["incident:verify", "incident:assign", "incident:merge", "incident:status:en_route"]
  }
}
```

`permissions` is a **server-computed capability list for this specific resource** (not a global role list) — the UI uses it to render exactly the actions available, while the API re-checks every action independently.

**Signed media URLs:** generated with a 15-minute expiry, only for `scanStatus == 'clean'` media the caller may see, and never returned to a `responder` for `locationText`/reporter identity. Responders receive media but **never** `reporter.displayName`, `reporter.uid`, or `reports[].text` (FR-068 — only the primary text is redacted to a summary).

**Errors:** `INCIDENT_NOT_FOUND` (404) · `VALIDATION_FAILED` · `RATE_LIMIT_EXCEEDED` · `DB_UNAVAILABLE`.

### 3.4 `PATCH /api/incidents/:id` — edit fields (FR-039, FR-073)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`/`admin`: any field below. `reporter`: only `location` and only while `status ∈ {new, triaged}` and the incident is theirs. `responder`: nothing. |
| Rate limit | 60 / hour |

**Request body** (all optional; unknown keys rejected by `.strict()`)
```json
{
  "summary": "Two-car collision, one person trapped (dispatcher rewrite)",
  "urgency": "critical",
  "category": "traffic_accident",
  "location": { "lat": 17.4479, "lng": 78.4876, "accuracyM": 12, "source": "manual_pin", "text": "Service Road, gate 1", "placeId": "ChIJ…" },
  "resolutionNote": "Patient stabilised and handed to ambulance crew."
}
```

Server-enforced rules:
- `summary` ≤ 240 chars; setting it sets `summaryEditedBy` and forces `urgencySource: 'human'`.
- Changing `urgency` by a human sets `urgencySource: 'human'` and clears `aiNeedsReview`.
- Changing `location` **recomputes `geoCells`, `accuracyGrade`, and re-runs duplicate detection** server-side; a new `duplicateStatus` is returned in `meta.duplicate`.
- `urgency` change **recomputes `slaTargetMin`** and clears `slaBreachedAt` if the new target has not yet been breached.
- Every field change is diffed and written to `auditLogs` (`incident.update`, `before`/`after` whitelisted fields only).

**Response `200`:** `{ "incident": { …updated… } }` + `meta.duplicate` when location changed.
**Errors:** `INCIDENT_NOT_FOUND` · `FORBIDDEN` (field not permitted for this role) · `VALIDATION_FAILED` · `INVALID_STATUS_TRANSITION` (rejected when the incident is `closed`) · `RATE_LIMIT_EXCEEDED`.

### 3.5 `POST /api/incidents/:id/triage` — re-run AI triage (FR-020, FR-028, FR-029)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`, `admin`. A `reporter` may request re-triage on their own `new`/`triaged` incident via a "re-analyse" affordance (allowed because it is not a privileged mutation, and it is rate limited). |
| Rate limit | 20 / hour |
| Request | `{ "reason": "dispatcher requested re-triage after new evidence", "includeNewEvidence": true }` |
| Behaviour | Re-runs [09](./09_AI_GEMINI_SPECIFICATION.md) triage on the primary report (plus all linked reports when `includeNewEvidence`), writes `aiRuns`, updates `category`/`urgency`/`summary`/`safetyFlags`/`aiConfidence`/`aiRunId`, appends a `statusHistory` `ai_triaged` event, and sets `status = triaged` when it was `new`. **Never** changes `status` beyond `new → triaged`, never verifies, never dispatches. |
| Response `200` | `{ "ai": { "runId", "model", "promptVersion", "confidence", "outcome", "fallbackUsed", "latencyMs", "explanation" }, "incident": { "category", "urgency", "summary", "safetyFlags", "aiConfidence", "aiNeedsReview", "status" }, "changes": [ { "field": "urgency", "from": "high", "to": "critical" } ] }` |
| Errors** | `INCIDENT_NOT_FOUND` · `INVALID_STATUS_TRANSITION` · `RATE_LIMIT_EXCEEDED` · `AI_UNAVAILABLE` (only when the fallback is explicitly disabled by config, for dispatcher testing) |
| Audit | `incident.update` with `reason` |

### 3.6 `POST /api/incidents/:id/dispatch` — assign a responder (FR-053, FR-065, FR-074)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`, `admin` only. `responder` self-claim uses `POST /api/dispatches/:id/claim` instead. |
| Rate limit | 30 / hour |
| Idempotency | `Idempotency-Key` recommended; re-dispatching the same responder to the same incident returns `200` with the existing dispatch |

**Request body**
```json
{ "responderUid": "u_4Kd8sTn", "mode": "manual", "note": "Use the service road gate", "replaceExisting": true }
```
- `responderUid` must exist in `responders`, have `verification == 'verified'` (FR-064), `status ∈ {available, busy}` (with `replaceExisting` needed if busy at max load), and be inside `serviceRadiusM` of the incident **or** have a `homeBase` within range (a warning, not a rejection, if outside).
- `note` ≤ 280 chars.
- `replaceExisting` (default `false`): when `false` and an active dispatch exists → `409 ALREADY_ASSIGNED` with the current assignee in `details`.

**Transaction (§12.6 of [07](./07_DATABASE_SCHEMA.md)):** close the previous active dispatch as `withdrawn` (reason "reassigned"), create the new `dispatches/{id}` with `status: 'active'`, `expiresAt = now + 120 s`, set `incidents.assigneeUid`/`assignmentMode`, set `responders.status = 'busy'` and increment `activeIncidentCount`, append `statusHistory` (`assigned`), and (outside the transaction) write exactly one `incident_assigned` notification guarded by `dedupeKey` (FR-108) plus `responder_unavailable` if the previous assignee is being withdrawn.

**Response `201`**
```json
{
  "success": true,
  "data": {
    "dispatch": { "dispatchId": "dsp_2Qm8Kx", "incidentId": "r7K…", "responderUid": "u_4Kd8sTn", "status": "active", "mode": "manual", "distanceM": 640, "etaSec": 180, "capabilityMatch": true, "expiresAt": "2026-09-26T10:09:00.000Z", "dispatchedAt": "2026-09-26T10:07:00.000Z" },
    "incident": { "incidentId": "r7K…", "status": "assigned", "assigneeUid": "u_4Kd8sTn" },
    "withdrawn": null
  },
  "meta": { "…": "…" }
}
```

**Errors:** `INCIDENT_NOT_FOUND` · `RESPONDER_NOT_FOUND` · `RESPONDER_NOT_VERIFIED` · `RESPONDER_UNAVAILABLE` · `RESPONDER_AT_CAPACITY` · `ALREADY_ASSIGNED` (409) · `INVALID_STATUS_TRANSITION` (409 — cannot assign an incident in `new`, `triaged`, `resolved`, `closed`, `cancelled`, `false_alarm`, or `merged`) · `VALIDATION_FAILED` · `RATE_LIMIT_EXCEEDED`.

### 3.7 `GET /api/incidents/:id/dispatch/candidates` — ranked responders (FR-065, FR-074)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`, `admin` |
| Rate limit | 60 / min |
| Query | `requiredResourceId` (repeatable, optional filter) · `radiusM` (default from `config/responderDefaultRadiusM`, max 20000) · `capabilityRequired` (`true` default) |
| Behaviour | Reads `responders` where `status == available && verification == verified`, `limit(60)`, then filters in code: Haversine ≤ radius, capability coverage of `incidents.requiredResources`, `activeIncidentCount < maxConcurrentIncidents`, `lastLocationAt` not older than 15 min (else `staleLocation: true`, sorted last). Ranks by `distanceM` ascending, then `lastLocationAt` descending. Returns ≤ 10. |
| Response `200` | `{ "candidates": [ { "responder": { "uid", "displayName", "status", "capabilities", "activeIncidentCount", "lastLocationAt" }, "location": { "lat", "lng", "accuracyGrade" }, "distanceM": 640, "etaSec": 180, "capabilityMatch": true, "missingResources": [], "staleLocation": false, "rank": 1 } ], "consideredCount": 34, "truncated": false }` |
| Errors** | `INCIDENT_NOT_FOUND` · `LOCATION_REQUIRED` (422 — no incident location means no distance ranking; returns a first-page-by-freshness list instead) · `RATE_LIMIT_EXCEEDED` |

### 3.8 `PATCH /api/incidents/:id/status` — lifecycle transition (FR-050 … FR-058)

| | |
| --- | --- |
| Auth | Required |
| Authorization | Per the transition table in [07](./07_DATABASE_SCHEMA.md) §4.3 |
| Rate limit | 60 / hour |
| Idempotency | Repeating the same transition returns `200` with `meta.noop: true` |

**Request body**
```json
{
  "status": "en_route",
  "reason": null,
  "note": "Two cars, one casualty conscious. Bringing the kit.",
  "resolutionCode": null,
  "clientActionId": "a_91f2"
}
```

Server logic:
1. Load the incident.
2. `assertTransitionAllowed(current, target, actorRole, isAssignee)` — from the table; anything not explicitly allowed ⇒ `409 INVALID_STATUS_TRANSITION` with `details.allowed = [...]`.
3. Role/assignment assertions (FR-055, FR-056).
4. `resolved` ⇒ `resolutionCode` required from the controlled list (FR-054).
5. Timestamp side effects: `en_route` sets `respondedAt` (first time only); `on_scene` sets `arrivedAt`; `resolved` sets `resolvedAt`; `closed` sets `closedAt`.
6. SLA evaluation: compute `slaState` from `verifiedAt ?? createdAt` + `slaTargetMin`; on first `breached`, set `slaBreachedAt` and emit one `sla_breached` notification.
7. Transactional write of the incident + `statusHistory` event (FR-052).
8. Notifications: `status_changed` to dispatchers; `incident_resolved` to reporter + assignee + dispatchers on `resolved`.
9. Audit: `incident.status_change` with `before`/`after` = `{ status }` and the `reason`.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "incident": { "incidentId": "r7K…", "status": "en_route", "assigneeUid": "u_4Kd8sTn", "respondedAt": "2026-09-26T10:09:12.000Z", "slaState": "on_track", "updatedAt": "2026-09-26T10:09:12.000Z" },
    "allowedNext": ["on_scene", "resolved", "cancelled", "false_alarm"]
  },
  "meta": { "requestId": "req_…", "timestamp": "…", "noop": false }
}
```

`allowedNext` lets the client render exactly one primary action without duplicating the transition table (US-012).

**Errors:** `INCIDENT_NOT_FOUND` · `INVALID_STATUS_TRANSITION` (409) · `RESOLUTION_CODE_REQUIRED` (422) · `INVALID_RESOLUTION_CODE` (400) · `FORBIDDEN` (a responder acting on an incident not assigned to them) · `TRANSITION_NOT_ALLOWED_YET` (409 — e.g. `on_scene` before `en_route`) · `RATE_LIMIT_EXCEEDED` · `DB_UNAVAILABLE`.

### 3.9 `POST /api/incidents/:id/merge` — confirm a duplicate (FR-046, FR-047)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`, `admin` only (FR-046) |
| Rate limit | 20 / hour |
| Request | `{ "primaryIncidentId": "r5Ab1cD2eF3gH4iJ5kL6", "reason": "Same collision, reported twice 3 minutes apart" }` |
| Validation | `primaryIncidentId !== :id`; `reason` 10–280 chars |
| Behaviour | Transaction ([07](./07_DATABASE_SCHEMA.md) §12.6): set `secondary.mergedIntoId/mergedBy/mergedAt`, `secondary.status = 'merged'`, `secondary.duplicateStatus = 'confirmed_duplicate'`, `secondary.duplicateOfIncidentId = primary`; copy the secondary's `reports` into the primary with `kind = 'duplicate_link'`, `linkedBy`, `linkReason`; increment `primary.reportCount`/`linkedReportCount`; refresh `primary.urgency` = max(urgency) and `primary.safetyFlags` = union; append `merged_in` to the secondary and `merged` to the primary; write `auditLogs` `incident.merge`. `mergeUndoUntil = now + 24 h` is recorded in the `metadata` of both history events (FR-047). |
| Response `200` | `{ "primary": { "incidentId", "reference", "reportCount", "linkedReportCount", "urgency" }, "secondary": { "incidentId", "reference", "status": "merged", "mergedIntoId" }, "undoAvailableUntil": "2026-09-27T10:12:00.000Z" }` |
| Errors | `INCIDENT_NOT_FOUND` · `SELF_MERGE_NOT_ALLOWED` (400) · `MERGE_BLOCKED_ACTIVE_ASSIGNMENT` (409 — the secondary has an active responder; unassign first) · `VALIDATION_FAILED` · `FORBIDDEN` · `RATE_LIMIT_EXCEEDED` |

`POST /api/incidents/:id/merge/undo` reverses it within 24 h: `dispatcher`/`admin`, `reason` required, audit `incident.merge_revert`.

`POST /api/incidents/:id/duplicates/dismiss` records `duplicateStatus = 'separate_incident'` with `duplicateDismissedBy` and a reason (FR-048), so the algorithm stops suggesting the same pair.

### 3.10 `DELETE /api/incidents/:id` — soft delete (FR-123)

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher` (with reason), `admin` (with or without reason) |
| Request body | `{ "reason": "Duplicate of CG-3PL8QW, entered in error" }` (required, 10–280 chars) |
| Behaviour | Sets `deletedAt/deletedBy/deleteReason`; moves media to `quarantine/`; appends `statusHistory` `deleted`; audit `incident.delete`; hides the row everywhere |
| Response `200` | `{ "incidentId": "…", "deletedAt": "…" }` |
| Errors** | `INCIDENT_NOT_FOUND` · `REASON_REQUIRED` (400) · `FORBIDDEN` · `INCIDENT_ALREADY_DELETED` (409) |
| Restore** | `POST /api/incidents/:id/restore`, `dispatcher`/`admin`, audit `incident.restore` |

### 3.11 `GET /api/incidents/:id/export` — CSV (FR-118, FR-059)

`dispatcher`/`admin`. Query `ids` (≤ 200) or the current filters. Returns `text/csv` with a `Content-Disposition` filename. Exported columns: reference, category, urgency, status, verification, slaState, createdAt, verifiedAt, dispatchedAt, arrivedAt, resolvedAt, lat, lng, accuracyGrade, placeName, reportCount, assigneeName, resolutionCode. **Never** exports reporter identity, IP hashes, or free text.

### 3.12 `POST /api/incidents/:id/reports` — add information to an existing incident (FR-012)

> Added by consistency audit amendment A-1. Required by FR-012 / US-006; the UI route `/track?ref=…` and the incident-detail "add information" action both call it. It was missing from the first draft of this document.

| | |
| --- | --- |
| Auth | Required |
| Authorization | The **owning reporter** (while `status ∈ {new, triaged}` and within 2 h of `createdAt`) or a `dispatcher`/`admin` (any time). A responder cannot add reports. |
| Rate limit | 10 / hour / uid |
| Request | `{ "text": "Adding a second photo, the car is smoking now", "media": [ { "mediaId": "med_b22", "storagePath": "staging/u_9fJ2kLmQ/med_b22.jpg", "contentType": "image/jpeg", "sizeBytes": 90112 } ], "kind": "supplement" }` |
| Validation | `text` 20–2000 chars when present; `kind ∈ supplement\|correction`; media rules identical to `POST /api/incidents` (≤ 3 images, ≤ 1 audio, staging path owned by the caller). `kind: "correction"` MUST include text |
| Behaviour | The same pipeline as incident creation minus the AI-triage step: verify media (magic bytes, size), create `incidents/{id}/reports/{reportId}` with `kind`, move staged files to `incidents/{id}/supplements/{reportId}/{mediaId}.{ext}`, increment `reportCount` and `evidenceCount` transactionally, append a `statusHistory` `evidence_added` event, notify dispatchers (`status_changed` is wrong here — a new `incident_updated` notification type is **not** added in v1; dispatchers see the change via the realtime listener) |
| Response `201` | `{ "report": { "reportId", "incidentId", "kind", "text", "media": [ … ], "createdAt" }, "incident": { "incidentId", "reference", "reportCount", "evidenceCount", "updatedAt" } }` |
| Errors | `INCIDENT_NOT_FOUND` (also returned when the incident is not the caller's — no existence oracle) · `INVALID_STATUS_TRANSITION` (409, incident already `verified`) · `REPORT_WINDOW_CLOSED` (422, older than 2 h) · `EMPTY_REPORT` · `UPLOAD_SIGNATURE_MISMATCH` · `UPLOAD_FORBIDDEN_PATH` · `RATE_LIMIT_EXCEEDED` |
| Audit | `incident.update` with `reason: "reporter_supplement"` |

> A supplement is **never** merged into `originalText`. Corrections are displayed alongside the original; the verbatim original is immutable (FR-003, §3.1).

### 3.13 `GET /api/incidents/by-reference` — resolve a citizen reference (FR-011)

> Added by consistency audit amendment A-1. Required by the `/track` page, which must not enumerate incidents and must not accept a raw incidentId from the URL.

| | |
| --- | --- |
| Auth | Required |
| Authorization | Same visibility rules as `GET /api/incidents/:id`. A citizen may only resolve **their own** reference |
| Rate limit | 120 / min (a citizen typing a reference repeatedly must not burn the read budget) |
| Query | `ref` (required, `^CG-[0-9A-HJKMNP-TV-Z]{6}$`, Crockford-style base32 excluding I/L/O/U) |
| Behaviour | `where('reference','==',ref).limit(1)`, then apply the resource gate |
| Response `200` | Identical in shape to `GET /api/incidents/:id` with `expand=reports,history` (no `dispatch` for a citizen) |
| Response `404` | `INCIDENT_NOT_FOUND` with a **neutral** message — identical body whether the reference does not exist or belongs to another user (US-005 acceptance criterion 4) |
| Errors | `VALIDATION_FAILED` (malformed `ref`) · `INCIDENT_NOT_FOUND` · `RATE_LIMIT_EXCEEDED` |
| Audit | Not audited (a read). Abusive repeated lookups are rate-limited and detectable |

> **Why a dedicated endpoint instead of `GET /api/incidents?q=CG-7QK4M2`:** the `q` path searches `searchTokens` with an `array-contains` intersection, which is 1 read per token plus a client-side intersect, and it returns *many* candidates. A reference lookup must be one exact indexed read with a strict visibility gate.

---

## 4. Responders

### 4.1 `GET /api/responders`

| | |
| --- | --- |
| Auth | Required |
| Authorization | `dispatcher`/`admin`: all fields. `responder`: own record only. `citizen`: `403 FORBIDDEN` |
| Query | `status`, `verification`, `capability` (resourceId), `center`, `radiusM` (≤ 20000), `stale` (`true` = `lastLocationAt` older than 15 min), `q`, `limit` (≤ 100, default 50), `cursor` |
| Response `200` | `{ "items": [ { "uid", "displayName", "verification", "status", "capabilities", "serviceRadiusM", "activeIncidentCount", "maxConcurrentIncidents", "lastLocationAt", "lastLocationAccuracyGrade", "staleLocation", "location": { "lat", "lng" } \| null, "stats": { "totalAssignments", "acceptedAssignments", "avgResponseSec" } (admin/dispatcher only) } ], "page": { … } }` |
| Notes | `phone` is **never** returned by this endpoint; it is included only in the single-responder endpoint for dispatcher/admin |
| Errors | `FORBIDDEN` · `VALIDATION_FAILED` · `RATE_LIMIT_EXCEEDED` |

### 4.2 `GET /api/responders/:id`

`dispatcher`/`admin` (full) or the responder themselves. Includes `phone`, `certifications`, `verificationNote`, `homeBase`.

### 4.3 `PATCH /api/responders/:id`

| | |
| --- | --- |
| Auth | Required |
| Authorization | Self: `status`, `capabilities` (self-declared, subject to admin re-check), `serviceRadiusM`, `phone`, `notifPrefs`. Dispatcher: `status`, `capabilities`, `serviceRadiusM`, `homeBase`, `note`. Admin: everything **except** `verification` (which has its own route). |
| Request | `{ "status": "available", "capabilities": ["res_ambulance", "res_first_aid"], "serviceRadiusM": 5000, "phone": "+919876543210", "homeBase": { "lat": 17.45, "lng": 78.48 } }` |
| Validation | `status ∈ available\|busy\|offline`; `capabilities` must all exist in `resources`; `serviceRadiusM ∈ [500, 50000]`; `phone` must match `^\+[1-9]\d{7,14}$`; setting `status` updates `responderLocations.status` in the same batch |
| Response `200` | `{ "responder": { … } }` |
| Audit** | `responder.update` with before/after |
| Errors** | `RESPONDER_NOT_FOUND` · `FORBIDDEN` (field/role) · `VALIDATION_FAILED` · `INVALID_CAPABILITY` · `RESPONDER_AT_CAPACITY` (setting `available` while at `maxConcurrentIncidents` is allowed but the responder stays out of the candidate list) |

### 4.4 `PATCH /api/responders/:id/location` — heartbeat (FR-066)

| | |
| --- | --- |
| Auth | Required |
| Authorization | The responder **themselves** only (`uid` must equal the token uid), or `dispatcher`/`admin` for manual correction. Writing any `responderUid` other than the caller's ⇒ `403 FORBIDDEN`. |
| Rate limit | 120 / hour, and the server **rejects** updates whose `capturedAt` is less than 20 s after the previously stored `capturedAt` with `429 HEARTBEAT_TOO_FREQUENT` (a stale-read abuse guard) |
| Request | `{ "lat": 17.4491, "lng": 78.4901, "accuracyM": 22, "headingDeg": 214, "speedMps": 4.2, "source": "gps", "status": "available", "capturedAt": "2026-09-26T10:08:40.000Z" }` |
| Validation | coords in range; `accuracyM ∈ [0, 5000]`; `capturedAt` ≤ now + 60 s; `source ∈ gps\|manual` |
| Behaviour | Upserts `responderLocations/{uid}` with `receivedAt = server now`, `accuracyGrade`, `stale = false`; updates `responders.{uid}.{status, lastLocationAt, lastLocationAccuracyGrade}`; sets `activeIncidentId` from the active dispatch. **If the responder's status is `offline`, the write is stored but `stale` is forced `true`** (FR-066) |
| Response `200` | `{ "location": { "receivedAt", "accuracyGrade", "stale" }, "nextHeartbeatSec": 60 }` |
| Errors** | `RESPONDER_NOT_FOUND` · `FORBIDDEN` · `HEARTBEAT_TOO_FREQUENT` (429 + `Retry-After`) · `VALIDATION_FAILED` · `LOCATION_OUT_OF_RANGE` · `RATE_LIMIT_EXCEEDED` |
| Privacy** | Visibility limited to `dispatcher`/`admin` ([07](./07_DATABASE_SCHEMA.md) §13) |

### 4.5 `POST /api/responders/:id/verify` and `POST /api/responders/:id/reject` (FR-063)

| | |
| --- | --- |
| Auth | Required. **Admin only.** |
| Request** | `verify`: `{ "note": "First-aid certification verified (ID 44-2210)", "capabilities": ["res_ambulance","res_first_aid"] }` · `reject`: `{ "note": "Certification could not be verified" }` |
| Behaviour** | Sets `verification`, `verifiedBy`, `verifiedAt`, `verificationNote`; transitions `users/{uid}.status` to `active` (approve) or `suspended` (reject); writes `auditLogs` `responder.verify` / `responder.reject`; notifies the responder (`responder_verified` / `account_suspended`) |
| Response `200`** | `{ "responder": { … } }` |
| Errors** | `RESPONDER_NOT_FOUND` · `FORBIDDEN` · `ALREADY_VERIFIED` (409) · `VALIDATION_FAILED` · `INVALID_CAPABILITY` · `REASON_REQUIRED` (400) |

### 4.6 `GET /api/responders/:id/incidents`

The responder's assignments. `status ∈ active, accepted, withdrawn, completed`; default `active, accepted`. Cursor paginated, ≤ 100. A responder sees only incidents where they are or were the assignee; a dispatcher sees those plus the full incident.

---

## 5. Dispatches

### 5.1 `GET /api/dispatches`

`responder` (own only) · `dispatcher`/`admin` (filter by `responderUid`, `incidentId`, `status`, `from`, `to`, `limit`, `cursor`). Fields as in [07](./07_DATABASE_SCHEMA.md) §8, plus `responder: {uid, displayName, status}`, `incident: {incidentId, reference, status, urgency, category, summary, location}`.

### 5.2 `POST /api/dispatches/:id/claim`

Self-service claim for `available` responders (P1).

**Auth** `responder` · **Rate limit** 20/hour · **Request** `{ "note": "I am 2 minutes away" }`
**Behaviour** Transaction: only if `dispatches.status == 'active'`, `expiresAt > now`, the responder is `verified`+`available`, and the incident has no other `accepted` dispatch. Sets `status = 'accepted'`, `acceptedAt`, `responders.status = 'busy'`, `activeIncidentCount += 1`, `incidents.status = 'assigned'` when it was `verified`; notifies the dispatcher.
**Errors** `DISPATCH_NOT_FOUND` · `DISPATCH_EXPIRED` (409) · `DISPATCH_ALREADY_ACCEPTED` (409) · `RESPONDER_UNAVAILABLE` · `RESPONDER_AT_CAPACITY` · `FORBIDDEN`.

### 5.3 `POST /api/dispatches/:id/withdraw`

`dispatcher`/`admin` (reason required) or the assigned `responder` before acceptance (reason required). Sets `status = 'withdrawn'`, decrements the responder's `activeIncidentCount`, restores `responders.status` when it drops to 0, returns the incident to `verified`, emits `responder_unavailable` to the dispatchers who assigned it, audit `incident.unassign`.

### 5.4 `GET /api/dispatches/summary`

Dispatcher KPI payload: `availableCount`, `busyCount`, `offlineCount`, `unverifiedCount`, `staleLocationCount`, `byCapability: { [resourceId]: number }`, `avgAcceptSec`. One read each over `responders` (≤ 100 docs, `limit`), used by the dashboard tiles.

---

## 6. Notifications

### 6.1 `GET /api/notifications`

**Auth** any role · **Rate limit** 120/min
**Query** `unread` (`true\|false`), `type` (repeatable), `limit` (≤ 100, default 25), `cursor`, `since` (ISO)
**Response `200`** `{ "items": [ { "notificationId", "type", "severity", "title", "body", "incidentId", "link", "read", "createdAt", "actor": { "uid", "displayName" } \| null } ], "unreadCount": 4, "page": { … } }`
Always `where('recipientUid','==',token.uid)`. **Never** accepts a `recipientUid` parameter (FR-103).

### 6.2 `PATCH /api/notifications/:id` — mark read

**Auth** any role, own notification only. Request `{ "read": true }` → 200 `{ "notification": { "notificationId", "read", "readAt" } }`. Errors `NOTIFICATION_NOT_FOUND` (404) · `FORBIDDEN`.

### 6.3 `POST /api/notifications/read-all`

Request `{ "types": ["incident_assigned", "sla_breached"] }` (optional filter) → `writeBatch` of ≤ 200 docs → 200 `{ "updated": 12 }`. Errors `BATCH_TOO_LARGE` (422) when more than 200 match (client retries in pages).

### 6.4 `POST /api/notifications` — internal / test dispatch (FR-107)

**Auth** `admin` only. A normal user **cannot** call this to spam others.
**Request** `{ "recipientUid": "u_4Kd8sTn", "type": "critical_incident_alert", "severity": "critical", "title": "…", "body": "…", "incidentId": null, "link": null }`
**Validation** `recipientUid` exists; `type` in the controlled list; `title` ≤ 90; `body` ≤ 240; **the title/body are plain text only** — no HTML is accepted or rendered (XSS defence, [24](./24_THREAT_MODEL_SECURITY.md) T-09).
**Behaviour** Transaction on `dedupeKey = type:recipientUid:incidentId:bucket` so replays produce one notification (FR-108). Then attempts enabled out-of-band channels through the `NotificationChannel` interface; failures are logged and retried at most twice, and **never** fail this request (FR-107).
**Response `201`** `{ "notification": { … }, "deduped": false, "channels": { "inApp": "sent" } }`
**Errors** `FORBIDDEN` · `RECIPIENT_NOT_FOUND` · `VALIDATION_FAILED` · `UNSUPPORTED_NOTIFICATION_TYPE` · `RATE_LIMIT_EXCEEDED`

### 6.5 `DELETE /api/notifications/:id`

Soft-expire: sets `expiresAt = now`. `admin` or the recipient. Audit optional (not in the mandatory list).

---

## 7. Analytics

### 7.1 `GET /api/analytics`

**Auth** `dispatcher`, `admin` (FR-117); others ⇒ `403 FORBIDDEN`. **Rate limit** 30/min.
**Query**

| Param | Default | Notes |
| --- | --- | --- |
| `from` / `to` | last 7 days | max span 365 days; both inclusive, `APP_TIMEZONE` day buckets |
| `granularity` | `day` | `day` or `week` |
| `include` | `totals,category,trend,response,risk,responders` | comma list; `risk` only when `features.riskZones` is enabled |
| `center` / `radiusM` | — | optional geospatial restriction (≤ 20 km) |
| `format` | `json` | `csv` returns `text/csv` (FR-118) |

**Response `200`**
```json
{
  "success": true,
  "data": {
    "range": { "from": "2026-09-19", "to": "2026-09-26", "timezone": "Asia/Kolkata", "granularity": "day", "source": "rollup" },
    "totals": {
      "total": 148, "active": 11, "critical": 26, "high": 41, "medium": 55, "low": 26,
      "resolved": 119, "cancelled": 6, "falseAlarm": 9, "merged": 3,
      "meanTimeToVerifySec": 214, "meanTimeToDispatchSec": 402, "meanTimeToResolveSec": 1480,
      "slaCompliancePct": 88.4, "duplicateRatePct": 12.1, "aiFallbackRatePct": 3.2,
      "meanAiConfidence": 0.79, "reportsPerIncident": 1.24
    },
    "byCategory": [ { "category": "traffic_accident", "count": 41, "critical": 9 } ],
    "trend": [ { "bucket": "2026-09-19", "created": 18, "resolved": 15, "critical": 3, "meanResolveSec": 1620 } ],
    "response": { "buckets": [ { "label": "0–5 min", "count": 22 }, { "label": "5–15 min", "count": 31 } ], "byUrgency": { "critical": { "p50Sec": 180, "p90Sec": 420 }, "high": { "p50Sec": 640, "p90Sec": 1500 } } },
    "risk": { "zones": [ { "zoneId": "rz_9z4g0h_2026w38", "centre": { "lat": 17.4478, "lng": 78.4874 }, "radiusM": 500, "score": 78, "severity": "critical", "incidentCount": 11, "criticalCount": 5, "dominantCategory": "traffic_accident", "computedAt": "2026-09-26T03:00:00.000Z" } ], "computedAt": "…" },
    "responders": [ { "uid": "u_4Kd8sTn", "displayName": "Yusuf Khan", "assignments": 12, "accepted": 11, "avgResponseSec": 214, "avgResolveSec": 920 } ]
  },
  "meta": { "requestId": "req_…", "timestamp": "…" }
}
```

**Aggregation strategy (FR-116).** `source` tells the client which path was used:
- `range.to` older than 48 h ⇒ `source: "rollup"` — reads `analyticsDaily` for each day in range (1 read/day, ≤ 366 reads, `limit`-free range read).
- Otherwise ⇒ `source: "live"` — scans incidents in range with `limit(500)` and aggregates in code. If the count reaches the cap, the response sets `truncated: true` and `range.advisory: "partial data"`.
- `risk` ⇒ reads `riskZones` (≤ 100) and never recomputes on a GET.
- `csv` ⇒ identical computation, streamed as `text/csv`.

**Errors** `FORBIDDEN` · `VALIDATION_FAILED` (bad range, span > 365 d, `radiusM` > 20000) · `RISK_DISABLED` (422 when `include=risk` while `features.riskZones === false`) · `RATE_LIMIT_EXCEEDED` · `DB_UNAVAILABLE`.

### 7.3 `GET /api/dashboard/summary` — dispatcher KPI tiles (FR-078)

> Added by consistency audit amendment A-1. FR-078 requires live KPI tiles; deriving them from a 50-row queue listener produces wrong numbers whenever the queue is truncated, so the dashboard needs a server-side count.

| | |
| --- | --- |
| Auth | Required. `dispatcher`, `admin` (full). `responder` gets their own scope below. `citizen` ⇒ `403`. |
| Rate limit | 120 / min |
| Query | `center`, `radiusM` (optional, ≤ 20000) to scope counts to a viewport |
| Behaviour | Up to 5 **aggregate-free** `count()`-free queries (Firestore has no `COUNT`, so these are capped `limit(1)` reads whose `size` is 0/1 — see the honesty note). Practical implementation: one capped `get()` per metric with `limit(1)` to answer "is there at least one", plus a single `getAll`-style capped read per metric capped at `limit(25)` for exact numbers, and the `analyticsDaily` rollup for anything older than 48 h |
| Response `200` | `{ "asOf": "2026-09-26T10:12:00.000Z", "window": "live", "tiles": { "active": 11, "unassigned": 6, "critical": 4, "slaBreached": 2, "availableResponders": 3, "staleResponderLocations": 1, "potentialDuplicates": 2, "aiNeedsReview": 1 }, "truncated": false, "notes": [] }` |
| Responder scope | `{ "tiles": { "myActive": 1, "myAvailable": true }, ... }` — no platform counts |
| Honesty note | The response MUST set `truncated: true` and add a `notes` entry when any underlying count hit its cap, and the UI MUST display a "partial count" affordance. Returning a plausible-looking wrong number is worse than saying "at least 25" |
| Errors | `FORBIDDEN` · `VALIDATION_FAILED` · `RATE_LIMIT_EXCEEDED` · `DB_UNAVAILABLE` |

### 7.2 `POST /api/analytics/recompute` (admin)

Triggers an immediate rollup refresh or a risk-zone recomputation. **Auth** `admin`; **Rate limit** 5/hour; **Request** `{ "target": "daily" | "risk", "from": "2026-09-19", "to": "2026-09-26" }`; **Response `202`** `{ "jobId": "job_…", "status": "queued" }`. Intended for the demo (the Vercel Cron schedule may only fire once per day on the Hobby plan — see [19](./19_DEPLOYMENT_DEVOPS.md) §7). Audited as `analytics.recompute`.

---

## 8. Uploads & location services

### 8.1 `POST /api/uploads/sign` — request an upload authorisation (FR-007, FR-008)

| | |
| --- | --- |
| Auth | Required. Roles: `citizen`, `responder`, `dispatcher`, `admin` |
| Rate limit | 30 / hour |
| Request** | `{ "kind": "image" \| "audio", "contentType": "image/jpeg", "sizeBytes": 184320, "sha256": "9f2b…" (optional, client-computed for integrity), "clientWidth": 1280, "clientHeight": 960, "durationSec": null, "intent": "report" }` |
| Validation** | `contentType` must be in the allow-list for `kind` ([15](./15_FILE_STORAGE_SPECIFICATION.md) §2); `sizeBytes` ≤ 5 242 880 (image) or ≤ 15 728 640 (audio); `clientWidth`/`clientHeight` 1–12000; `durationSec` ≤ 120 for audio; **`intent` must be `report`** in v1 |
| Response `201`** | `{ "upload": { "mediaId": "med_a91", "storagePath": "staging/u_9fJ2kLmQ/med_a91.jpg", "token": "eyJ…", "expiresAt": "2026-09-26T10:35:31.000Z", "maxSizeBytes": 5242880, "requiredContentType": "image/jpeg" }, "nextStep": "PUT the raw bytes to `uploadUrl` with Content-Type set to requiredContentType, then POST /api/incidents" }` |
| Notes** | Files are written to **`staging/{uid}/{mediaId}.{ext}`**, not to the final incident path, because the incident ID does not exist yet. `POST /api/incidents` **moves** the verified file into `incidents/{incidentId}/reports/{reportId}/{mediaId}.{ext}` using the Admin SDK (`copy`+`delete`, or `move` when available), then re-issues a read URL. A staging file not claimed within 30 minutes is swept. `storagePath` in the `POST /api/incidents` body is therefore the **staging path**, and it MUST begin `staging/{uid}/` or already be the final path for a re-upload. |
| Errors** | `VALIDATION_FAILED` · `UNSUPPORTED_MEDIA_TYPE` (415) · `UPLOAD_TOO_LARGE` (413) · `RATE_LIMIT_EXCEEDED` · `STORAGE_UNAVAILABLE` (503) |

**The client never receives a Storage service-account credential.** It receives a short-lived V4 signed URL scoped to one object with `PUT` only.

### 8.2 `POST /api/uploads/finalize`

Optional. After a successful PUT the client calls this so the server can sniff magic bytes **before** the incident is created, giving a fast failure.

**Auth** required · **Rate limit** 30/hour · **Request** `{ "mediaId": "med_a91" }` → server reads the first 4 KiB, determines the real type, compares it with the declared type, measures the actual size, and returns `{ "media": { "mediaId", "kind", "verifiedContentType": "image/jpeg", "actualSizeBytes": 184320, "sha256": "9f2b…", "scanStatus": "clean", "width": 1280, "height": 960, "durationSec": null } }`.
**Errors** `MEDIA_NOT_FOUND` · `UPLOAD_SIGNATURE_MISMATCH` (415) · `UPLOAD_TOO_LARGE` (413) · `UPLOAD_INCOMPLETE` (409 — the object exists but is 0 bytes or the size differs by more than 1 % from the declaration) · `UPLOAD_QUARANTINED` (422 — magic bytes indicate an executable/archive) · `STORAGE_UNAVAILABLE`

### 8.3 `GET /api/uploads/:mediaId/url`

Returns a fresh 15-minute signed **read** URL for verified media the caller is allowed to see. **Auth** required · **Rate limit** 120/min · **Errors** `MEDIA_NOT_FOUND` · `MEDIA_NOT_VERIFIED` (422) · `UPLOAD_FORBIDDEN_PATH` · `FORBIDDEN`.

> There is **no** public or unauthenticated media URL. Storage rules make every object readable only by the incident visibility path, and all downloads are short-lived signed URLs issued by the server after an authorization check.

### 8.4 `POST /api/geocode/reverse` — coordinates → place (FR-033, FR-035)

> Added by consistency audit amendment A-1. FR-035 requires **server-side** reverse geocoding and [12](./12_MAP_LOCATION_SYSTEM.md) mandates it for manual pins; it was missing from the first draft of this document.

| | |
| --- | --- |
| Auth | Required |
| Rate limit | 60 / minute per uid, plus a global local guard `GEOCODING_RPM_LOCAL` (default 30, see [21](./21_ENVIRONMENT_VARIABLES.md)) so we never exhaust the Google Geocoding quota |
| Request | `{ "lat": 17.4479, "lng": 78.4876, "accuracyM": 12, "source": "manual_pin" }` |
| Validation | coords in range; `accuracyM ∈ [0, 5000]`; `source ∈ gps\|manual_pin` |
| Behaviour | Calls the Google Geocoding API with the **server** key. Returns **two** strings at different granularities: `placeName` (street level — stored on the incident, displayed to dispatchers) and `coarseArea` (`locality`/`sublocality`/`administrative_area_level_2` only — this is the **only** location text ever sent to Gemini, [09](./09_AI_GEMINI_SPECIFICATION.md) §4.1). Cached in-process by a hashed coordinate grid key for 30 days |
| Response `200` | `{ "placeName": "Service Road, near Secunderabad Metro Gate 1", "coarseArea": "Secunderabad", "placeId": "ChIJ…", "components": { "locality": "Secunderabad", "sublocality": "…", "adminArea2": "Secunderabad" }, "accuracyNote": "reverse geocoded result is approximate and may not match the exact incident point" }` |
| Response when the API cannot geocode | `200` with `{ "placeName": null, "coarseArea": null, "placeId": null }` and `meta.degraded: "geocoding_unavailable"` — **never** an error, because a missing label must not block report submission (FR-029 principle) |
| Errors | `VALIDATION_FAILED` · `LOCATION_OUT_OF_RANGE` · `RATE_LIMIT_EXCEEDED` · `GEOCODE_FAILED` (only for a 4xx from Google, e.g. a key-restriction failure) |
| Privacy | The response is not cached in any shared store. The raw API response body is never logged; only the hashed coordinate and the returned `coarseArea` are logged |

### 8.5 `GET /api/geocode/forward` — text → candidate places (FR-033, FR-087)

| | |
| --- | --- |
| Auth | Required |
| Rate limit | 30 / minute per uid (shared with the reverse guard) |
| Query | `q` (required, 3–120 chars), `center` (optional `"lat,lng"` for `locationBias`), `limit` (1–5, default 5) |
| Behaviour | Google Places Autocomplete (Text Search / Autocomplete) with the **server** key. Used by the "type an address" fallback and by the dispatcher's location search |
| Response `200` | `{ "candidates": [ { "placeId": "ChIJ…", "description": "Service Road, Secunderabad, Telangana", "mainText": "Service Road", "secondaryText": "Secunderabad", "location": { "lat": 17.4479, "lng": 78.4876 } } ], "inputTerms": [] }` |
| Errors | `VALIDATION_FAILED` · `RATE_LIMIT_EXCEEDED` · `GEOCODE_FAILED` · `LOCATION_OUT_OF_RANGE` |
| Client rule | The client MUST debounce by ≥ 300 ms and MUST send no more than one request per 300 ms while typing (FR-087) |

### 8.6 Geocoding honesty notes

| Note | Detail |
| --- | --- |
| Google Geocoding is not authoritative | In informal settlements and on unnamed service roads it frequently returns a nearby named street. The UI MUST label every reverse-geocoded value as approximate ([12](./12_MAP_LOCATION_SYSTEM.md) §7) |
| `placeName` is a label, not evidence | It is displayed next to the coordinates, never as a replacement for them, and it is never used for distance calculations |
| Cost | Geocoding is billed per request on the Google side. Every call is rate-limited locally and cached; the budget alert in [19](./19_DEPLOYMENT_DEVOPS.md) §13 covers this API |
| A `DECISION REQUIRED` remains | Whether to add a Firestore-backed `geocodeCache` collection. **Recommendation: no.** The 30-day in-process cache plus per-minute guards are sufficient at hackathon scale, and a new collection is a schema change to [07](./07_DATABASE_SCHEMA.md) for no functional gain |

---

## 9. Reference data

### 9.1 `GET /api/resources`

Public to any authenticated user. Returns the active catalogue: `{ "items": [ { "resourceId", "name", "category", "icon", "unit", "urgencyAffinity" } ] }`. `limit` ≤ 100. Cached client-side for 1 h.

### 9.2 `GET /api/config`

Returns the client-safe subset of `config/app` **only**: `appName`, `appTimezone`, `slaMinutes`, `features`, `realtime`, `notifications.channels`, `duplicate.radiusM` (for the "duplicate zone" ring), `categoryGroups`. **Never** returns `retention`, admin-only keys, or anything from the environment.

### 9.3 `GET /api/health`

Unauthenticated liveness probe. `{ "status": "ok", "uptimeSec": 4210, "version": "1.0.0", "checks": { "firestore": "ok", "gemini": "ok", "storage": "ok" } }` where each check is a cheap ping with a 1.5 s budget, cached for 30 s. Returns 200 or 503. **Never** reveals credentials, bucket names, project IDs, or stack traces.

---

## 10. Admin

| Method | Path | Auth | Purpose | Key request fields | Key errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/admin/users` | `admin` | List users with filters | `role`, `status`, `q`, `from`, `to`, `limit`, `cursor` | — |
| GET | `/api/admin/users/:id` | `admin` | Full user + responder record + recent audit | — | `USER_NOT_FOUND` |
| PATCH | `/api/admin/users/:id/role` | `admin` | Change role (FR-133) | `{ "role": "dispatcher", "reason": "…" }` | `REASON_REQUIRED`, `SELF_ROLE_CHANGE_FORBIDDEN` (400 — you may not change your own role), `ROLE_ESCALATION_GUARD` (403 — a non-super-admin may not grant `admin`), `ALREADY_ROLE` (409) |
| PATCH | `/api/admin/users/:id/status` | `admin` | Enable/suspend | `{ "status": "suspended", "reason": "…" }` | `REASON_REQUIRED`, `SELF_DISABLE_FORBIDDEN` |
| POST | `/api/admin/users/:id/reset-claims` | `admin` | Re-sync custom claims after drift | `{ "reason": "…" }` | `REASON_REQUIRED` |
| GET | `/api/admin/audit-logs` | `admin` (dispatcher read-only) | Filtered audit | `actorUid`, `action`, `entityType`, `entityId`, `from`, `to`, `limit` (≤ 100, default 50), `cursor`, `format=csv` | `FORBIDDEN` |
| GET | `/api/admin/config` | `admin` | Full `config/app` including retention | — | `FORBIDDEN` |
| PATCH | `/api/admin/config` | `admin` | Update tunables (US-033) | `{ "duplicate": { "duplicateRadiusM": 750 }, "slaMinutes": { "critical": 7 }, "reason": "…" }` | `VALIDATION_FAILED` (range violations with `details`), `REASON_REQUIRED`, `CONFIG_CHANGE_LOCKED` (a key that is env-only) |
| GET | `/api/admin/responders` | `admin` | Verification queue | `verification`, `limit`, `cursor` | — |
| GET | `/api/admin/system/health` | `admin` | Cost/limit snapshot: Firestore reads/writes used, listener count by collection, AI failure rate, `aiRuns` failures last 24 h | — | `FORBIDDEN` |
| POST | `/api/admin/maintenance/*` | `admin` | Explicit, individually audited jobs: `sweep-expired-dispatches`, `sweep-staging-uploads`, `purge-closed-locations`, `recompute-analytics` | `{ "reason": "…" }` | `MAINTENANCE_DISABLED` (422 unless `ENABLE_MAINTENANCE_JOBS=true`; the gate is the **env** var, not a `config/app` key — `config/app` has no `features.maintenance` field) |

**`PATCH /api/admin/users/:id/role` behaviour (FR-133, NFR-015):** in a transaction, update `users/{uid}.role`, write `auditLogs` `user.role_change` with before/after/reason, then set the Firebase Auth custom claims `role`. A claim failure marks `users/{uid}.roleChangePending = true` and returns `202` with `{ "user": …, "claimsSynchronised": false }`. The authorization layer treats the **Firestore** role as authoritative; the claim exists only so Security Rules can read it, and the affected user must call `getIdToken(true)` for it to take effect (documented in the UI).

---

## 11. Cross-reference: endpoint → FR coverage

| Endpoint | FR implemented |
| --- | --- |
| `POST /api/incidents` | FR-001…FR-019, FR-020…FR-029, FR-030…FR-037, FR-040…FR-048 |
| `POST /api/incidents/:id/reports` | FR-012, FR-039, FR-052 |
| `GET /api/incidents/by-reference` | FR-010, FR-011 |
| `GET /api/incidents` | FR-070, FR-071, FR-072, FR-120, FR-121, FR-124 |
| `GET /api/incidents/:id` | FR-075, FR-122, FR-059, FR-068 |
| `PATCH /api/incidents/:id` | FR-039, FR-073, FR-042 |
| `POST /api/incidents/:id/triage` | FR-020, FR-024, FR-028, FR-029 |
| `POST /api/incidents/:id/dispatch` | FR-053, FR-065, FR-074, FR-108 |
| `GET /api/incidents/:id/dispatch/candidates` | FR-062, FR-065, FR-074 |
| `PATCH /api/incidents/:id/status` | FR-050…FR-058 |
| `POST /api/incidents/:id/merge` | FR-041, FR-046, FR-047, FR-048 |
| `DELETE /api/incidents/:id` | FR-123 |
| `GET /api/incidents/:id/export` | FR-118 |
| `GET/PATCH /api/responders*` | FR-060…FR-069 |
| `PATCH /api/responders/:id/location` | FR-066, FR-081 |
| `POST /api/responders/:id/verify` | FR-063, FR-064 |
| `GET/POST /api/dispatches*` | FR-053, FR-065, FR-074 |
| `GET/PATCH/POST /api/notifications*` | FR-100…FR-108 |
| `GET /api/analytics` | FR-110…FR-118 |
| `GET /api/dashboard/summary` | FR-078 |
| `POST /api/geocode/reverse`, `GET /api/geocode/forward` | FR-033, FR-035, FR-087 |
| `POST /api/uploads/*` | FR-005…FR-008 |
| `POST /api/me/*`, `/api/auth/event` | FR-001, FR-132, FR-135 |
| `/api/admin/*` | FR-130…FR-136, FR-042, FR-133 |
| All | FR-140…FR-147 |

---

## 12. Security requirements applied to every route (normative checklist)

1. `export const runtime = 'nodejs'`.
2. `requireUser()` or an explicit documented public exception.
3. Role check with a **server-side** role source.
4. Resource-level visibility check (does this caller own/serve this incident?).
5. `Origin`/`Referer` check for non-GET.
6. Rate limit.
7. Zod validation of body, query, and params — `params` are validated too.
8. No user input interpolated into a Firestore field path, a Storage path, a Gemini prompt string, or an HTML string.
9. Errors return catalogue codes only; no stack traces, no raw exception text.
10. `requestId` generated and returned on every response, including errors.
11. Privileged mutations write an `auditLogs` entry inside the same operation.
12. Responses set `Cache-Control: no-store` when they contain user-specific data.
13. `Content-Security-Policy` is set at the edge/middleware; route handlers never return HTML with interpolated data.
14. `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Permissions-Policy` (`geolocation=(self)`, `microphone=(self)`, `camera=(self)`) are set in `middleware.ts`.
15. No endpoint returns another user's data even with a valid role — visibility is always resource-scoped.

---

## 13. Amendment history

| Amendment | Date | Change | Reason |
| --- | --- | --- | --- |
| A-1 | v1.0.1 | **Added** `POST /api/incidents/:id/reports` (§3.12), `GET /api/incidents/by-reference` (§3.13), `GET /api/dashboard/summary` (§7.3), `POST /api/geocode/reverse` (§8.4), `GET /api/geocode/forward` (§8.5). §8 retitled "Uploads & location services". The maintenance gate clarified to `ENABLE_MAINTENANCE_JOBS`. | Consistency audit found FR-011, FR-012, FR-033, FR-035, FR-078, and FR-087 with no endpoint to satisfy them — a required screen (`/track`) and a required dashboard element (KPI tiles) had no API |
| A-2 | v1.0.1 | `new → triaged` is now `system`/dispatcher/admin, not dispatcher/admin only, matching [07](./07_DATABASE_SCHEMA.md) §4.3 and [09](./09_AI_GEMINI_SPECIFICATION.md) §6.4 | The AI triage step writes this transition; the original table made it unreachable |
| A-3 | v1.0.1 | `incidents.dispatchedAt` added to the incident document ([07](./07_DATABASE_SCHEMA.md) §4.1) so `meanTimeToDispatchSec` is computable without a join | [14](./14_ANALYTICS_SPECIFICATION.md) needs it inside the 500-doc live-scan budget |

> Every amendment is recorded here rather than applied silently. A reader holding v1.0 of this document should be able to tell exactly what changed and why.

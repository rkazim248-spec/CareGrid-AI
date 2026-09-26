# 17 — Validation Rules

**Project:** CareGrid AI
**Document type:** Field-level input contract
**Status:** Baseline v1.0 — normative for every request field on every endpoint
**Related:** [08 API Specification](./08_API_SPECIFICATION.md), [16 Error Handling](./16_ERROR_HANDLING.md), [06 Backend Architecture](./06_BACKEND_ARCHITECTURE.md), [07 Database Schema](./07_DATABASE_SCHEMA.md), [15 File Storage](./15_FILE_STORAGE_SPECIFICATION.md), [01 PRD](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md), [22 User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md)

---

## 0. Philosophy

| # | Rule | Where it is enforced | Why |
| ---: | --- | --- | --- |
| 1 | **Validate at the edge for UX.** The same Zod schema runs in the browser on blur/submit so a citizen learns about a 19-character description before pressing a button. | `validators/*` imported by the form | Fast feedback, no wasted round trip |
| 2 | **Validate authoritatively on the server.** The browser result is a convenience, never a control. | `lib/api/validate.ts` in every route | NFR-015, FR-142. A client can send anything |
| 3 | **Never trust the client.** Not a role, not a `contentType`, not a `storagePath`, not a coordinate, not a `limit`, not a `Content-Type` header. | schema `.strict()`, ownership checks, magic bytes | FR-008, [22](./22_USER_ROLES_PERMISSIONS.md) §2 |
| 4 | **Validate before any side effect.** Zod parse happens before the first Firestore, Storage, Maps, or Gemini call. | Pipeline step 7 of [06](./06_BACKEND_ARCHITECTURE.md) §3.1 | FR-142. A malformed body must cost one CPU pass, not a database round trip |
| 5 | **One schema, two runtimes.** `validators/*` imports no Firestore, no `process.env`, no React. | ESLint boundary rules | NFR-025: a route must have a Zod schema exported and referenced in [08](./08_API_SPECIFICATION.md) |
| 6 | **Validate `params` too.** A dynamic segment is user input. | `parseParams` | [08](./08_API_SPECIFICATION.md) §12.7 |
| 7 | **Reject what is out of range; never silently repair it.** The one documented exception is `limit` on read-only list routes (§10). | — | A repaired value is a value the user did not choose |
| 8 | **Reject unknown keys and unknown query parameters.** | `.strict()` / `unrecognized_keys` | A typo in a filter is a filter that silently does not apply — in an emergency queue that is a safety problem. §9 |
| 9 | **Report every issue, not just the first.** | `formatZodIssues` | One round trip, one error summary |
| 10 | **Field paths are dotted and index-aware.** | `formatZodIssues` | The client can attach a message to the exact input |

---

## 1. The Zod layer

### 1.1 File organisation

| File | Owns | Depends on |
| --- | --- | --- |
| `validators/common.ts` | Shared primitives: trimmed string, bounded int, ISO datetime, timezone, email, E.164 phone, Firestore id, media id, storage path, geohash, colour hex, base32 reference, ISO date, pagination | `zod`, `config/*` |
| `validators/messages.ts` | The English message table keyed by issue code (§11) | — |
| `validators/enums.ts` | **The single source** for `IncidentStatus`, `Urgency`, `IncidentCategory` (11), `SafetyFlag` (13), `ResolutionCode` (6), `NotificationType` (12), `Role` (4), `UserStatus` (4), `VerificationStatus` (4), `ResponderStatus` (3), `SlaState` (3), `AccuracyGrade` (4), `GeoSource` (4), `AuditAction`, `DispatchStatus` (5), `DispatchMode` (3), `TriageSource`, `UrgencySource`, `ResourceCategory` (8), `ResourceUnit` (5), `NotificationSeverity` (3), `MediaKind` (2), `ReportKind` (4), `ContentType` (6) | `zod`, `config/*` |
| `validators/auth.ts` | `POST /api/auth/event` body | `common`, `enums` |
| `validators/incident.ts` | Incident create, patch, triage, status, merge, delete, restore, dismiss, export, params, `expand` | `common`, `enums`, `geo` |
| `validators/report.ts` | `incidentReports` create (supplement/correction) and the `text` + `media` pair shared with create | `common`, `incident` |
| `validators/dispatch.ts` | Assign, withdraw, claim, list filters, candidates, summary | `common`, `enums`, `geo` |
| `validators/responder.ts` | Responder list/detail filters, self/dispatcher/admin patches, heartbeat, verify, reject | `common`, `enums`, `geo` |
| `validators/notification.ts` | List filters, mark-read, read-all, admin send | `common`, `enums` |
| `validators/analytics.ts` | Query, recompute, rollup window | `common`, `geo` |
| `validators/upload.ts` | Sign, finalize, media id, size caps, MIME allow-lists, duration, dimensions | `common`, `enums`, `config/limits` |
| `validators/admin.ts` | Users list, role, status, reset-claims, audit-log filters, config patch, maintenance job | `common`, `enums` |
| `validators/ai.ts` | Re-exports `aiTriageOutputSchema` so client and server share one definition ([09](./09_AI_GEMINI_SPECIFICATION.md) §3) | `common`, `enums` |
| `validators/geo.ts` | Coordinates, accuracy, `center` `"lat,lng"`, radius, `geoCells`, geohash pattern | `common` |
| `validators/config.ts` | The client-safe config projection and the admin config patch with per-key ranges | `common`, `enums` |
| `validators/query.ts` | Shared query parsing: boolean tri-state, repeatable enum, ISO date, cursor token, limit with the single clamp | `common`, `enums` |
| `validators/index.ts` | Barrel. The only import path route handlers use | all |

### 1.2 Schema construction rules

| Rule | Detail |
| --- | --- |
| Every object schema that reaches a route is `.strict()` | An extra key is `unrecognized_keys` → 400. This is the primary defence against a client that sends `role`, `status: 'verified'`, or `assigneeUid` ([08](./08_API_SPECIFICATION.md) §12.7) |
| Enums are `z.enum(enumTuple)` derived from `validators/enums.ts` | Never a second inline list ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §5.1.6) |
| Role-conditional schemas are **factory functions** | `createIncidentBodySchema(ctx)` so `skipTriage` can be forbidden by role inside the schema. Call sites get a type, not a cast |
| No `z.any()`, no `.passthrough()` on input | §13 |
| No `z.coerce.*` on any field where a wrong type is a bug | Coercion is limited to the documented cases in §2.4 |
| Refinements that need the request context are `superRefine`, not `refine` | `.superRefine((v, ctx) => …)` so multiple issues accumulate |
| Schemas are pure and side-effect free | No `refine` that performs I/O |

### 1.3 Naming convention

| Kind | Convention | Example |
| --- | --- | --- |
| Body | `<verb><Noun>BodySchema` | `createIncidentBodySchema` |
| Query | `<noun>QuerySchema` | `incidentListQuerySchema` |
| Params | `<noun>ParamsSchema` | `incidentIdParamsSchema` |
| Output (rare; the serialiser owns DTOs) | `<noun>ResponseSchema` | `healthResponseSchema` |

`ErrorCode` and the `issue` codes are generated from the catalogue so `ApiErrorDetail.issue` is a union, not a `string`.

---

## 2. Shared primitives

### 2.1 `validators/common.ts`

```ts
export const trimmedString = (min: number, max: number) =>
  z.string().transform(s => s.trim())
    .pipe(z.string().min(min, MSG_TOO_SHORT).max(max, MSG_TOO_LONG));

export const boundedInt = (min: number, max: number) =>
  z.number().int(MSG_NOT_INTEGER).min(min).max(max);

export const isoUtc = (opts: { maxPastMs?: number; maxFutureMs: number; field: string }) =>
  z.string().regex(ISO_8601_UTC_RE, MSG_ISO)
    .transform(s => new Date(s))
    .superRefine((d, ctx) => { /* not in future, not too old */ });

export const ianaTimezone = () => z.string().refine(isValidTimeZone, MSG_TIMEZONE).max(64);

export const email = () => z.email({ error: MSG_EMAIL }).max(254).transform(s => s.toLowerCase().trim());

export const e164Phone = () => z.string().regex(/^\+[1-9]\d{7,14}$/, MSG_PHONE);

export const firestoreId = (field = 'id') =>
  z.string().regex(/^[A-Za-z0-9]{20}$/, MSG_ID).describe(`Firestore auto-ID, ${field}`);

export const mediaId = () => z.string().regex(/^med_[A-Za-z0-9]{2,32}$/, MSG_MEDIA_ID);

export const reportId = () => z.string().regex(/^rep_[A-Za-z0-9]{2,32}$/, MSG_REPORT_ID);

export const dispatchId = () => z.string().regex(/^dsp_[A-Za-z0-9]{2,32}$/, MSG_DISPATCH_ID);

export const base32Ref = () => z.string().regex(/^CG-[0-9A-HJKMNP-TV-Z]{6}$/, MSG_REF);

export const geohash6 = () => z.string().regex(/^[0-9b-hjkmnp-z]{6}$/, MSG_GEOHASH);

export const hexColor = () => z.string().regex(/^#[0-9a-f]{6}$/i, MSG_COLOUR);

export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, MSG_DATE)
  .refine(isRealCalendarDate, MSG_DATE);

export const isoDuration = (maxSec: number) => z.coerce.number().int().min(0).max(maxSec);

export const base32Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  // Crockford: no I, L, O, U
```

### 2.2 The datetime primitive

| Rule | Implementation |
| --- | --- |
| Format | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z\|\+00:00)$/` — UTC only, **or** an explicit offset that is normalised to UTC |
| Storage | Firestore `Timestamp` (UTC) — FR-143 |
| Display | The client formats with `APP_TIMEZONE` — NFR-146, FR-146. **The server never returns a local-time string.** |
| "Not in the future" | `d.getTime() - Date.now() <= maxFutureMs`; violation → `issue: 'in_future'` |
| "Not too old" | `Date.now() - d.getTime() <= maxPastMs`; violation → `issue: 'too_old'` |
| Future tolerance | `reportedAt`: **+5 min** ([08](./08_API_SPECIFICATION.md) §3.1). `capturedAt`: **+60 s** ([08](./08_API_SPECIFICATION.md) §4.4) |
| Past tolerance | `reportedAt`: **24 h**. `capturedAt`: no documented bound — see D-17-9 |
| NaN | A `Date` that parses to `NaN` (e.g. `2026-02-31`) fails the regex plus an `isNaN` guard → `issue: 'invalid_format'` |

### 2.3 The reference pattern

`CG-` + 6 characters from `base32Alphabet`. The generator (`lib/incidents/reference.ts`) and this validator import the same alphabet constant, so a reference produced by the server always matches the schema and a reference typed by a citizen is checked against the same rule. Confusing characters (`I`, `L`, `O`, `U`) are excluded, matching the examples in [07](./07_DATABASE_SCHEMA.md) (`CG-7QK4M2`, `CG-3PL8QW`).

### 2.4 Coercion — the complete allow-list

| Field | Coercion | Justification |
| --- | --- | --- |
| All body/query strings | Trim leading/trailing whitespace | FR-003: length is measured "after trimming" |
| `email` | Lowercase | [07](./07_DATABASE_SCHEMA.md) §3: stored lowercase |
| `durationSec`, `sizeBytes`, `clientWidth`, `clientHeight`, `*Limit`, `*Count` in **query strings only** | `Number(string)` then integer/bounds check | A query string is text; a JSON number is already a number. A body number that arrives as a string is a **bug** and is rejected (`invalid_type`), never coerced |
| Booleans in query strings | `"true"`/`"false"`/`"1"`/`"0"`; anything else → `invalid_enum_value` | `verified=any` is a tri-state, so the parser is a tri-state, not a boolean |
| Repeatable enums (`status`, `urgency`, `category`, `type`, `action`) | A single value or a repeated key (`?status=new&status=triaged`) or a comma list | Both shapes appear in dispatcher filter bars |
| Timestamps | ISO string → `Date` → `Timestamp.fromDate` | FR-143 |
| Nothing else | — | A silent coercion of a bad enum to a default is forbidden (§13) |

---

## 3. Enum source of truth

Every enum below is defined **once** in `validators/enums.ts` and consumed by the schema, the UI filter bars, the prompts, and the serialiser. The values are the ones in [07](./07_DATABASE_SCHEMA.md) §4 and [08](./08_API_SPECIFICATION.md).

| Enum | Values |
| --- | --- |
| `IncidentStatus` | `new`, `triaged`, `verified`, `assigned`, `en_route`, `on_scene`, `resolved`, `closed`, `cancelled`, `false_alarm`, `merged` (11) |
| `Urgency` | `critical`, `high`, `medium`, `low` |
| `IncidentCategory` | `medical`, `fire`, `traffic_accident`, `flood`, `heatwave`, `severe_storm`, `missing_person`, `violence_crime`, `infrastructure`, `community_aid`, `other` (11) |
| `SafetyFlag` | `self_harm`, `violence`, `medical_critical`, `child_at_risk`, `gas_leak`, `fire`, `flood_rising`, `crowd_panic`, `possible_duplicate`, `low_confidence`, `unclear_location`, `injured_trapped`, `electrical_hazard` (13) |
| `ResolutionCode` | `resolved_safe`, `false_positive`, `transferred_to_authority`, `no_assistance_needed`, `duplicate`, `withdrawn_by_reporter` (6) |
| `NotificationType` | `incident_created`, `incident_verified`, `incident_assigned`, `critical_incident_alert`, `status_changed`, `incident_resolved`, `duplicate_suggested`, `responder_unavailable`, `sla_breached`, `responder_verified`, `role_changed`, `account_suspended` (12) |
| `Role` | `citizen`, `responder`, `dispatcher`, `admin` |
| `UserStatus` | `active`, `suspended`, `pending_verification`, `disabled` |
| `VerificationStatus` | `unverified`, `pending`, `verified`, `rejected` |
| `ResponderStatus` | `available`, `busy`, `offline` |
| `SlaState` | `on_track`, `at_risk`, `breached` |
| `AccuracyGrade` | `high`, `medium`, `low`, `unknown` |
| `GeoSource` | `gps`, `manual_pin`, `address_text`, `none` |
| `DispatchStatus` | `active`, `accepted`, `withdrawn`, `completed`, `expired` |
| `DispatchMode` | `auto_suggest`, `manual`, `self_claimed` |
| `MediaKind` | `image`, `audio` |
| `ImageContentType` | `image/jpeg`, `image/png`, `image/webp` |
| `AudioContentType` | `audio/webm`, `audio/mp4`, `audio/mpeg` |
| `ReportKind` | `original`, `duplicate_link`, `supplement`, `correction` |
| `NotificationSeverity` | `info`, `warning`, `critical` |
| `IncidentSort` | `newest`, `oldest`, `urgency`, `sla`, `distance` |
| `AnalyticsGranularity` | `day`, `week` |
| `AnalyticsSection` | `totals`, `category`, `trend`, `response`, `risk`, `responders` |
| `AnalyticsTarget` | `daily`, `risk` |
| `VerifiedFilter` | `true`, `false`, `any` |
| `ExportFormat` | `json`, `csv` |
| `AuthEventType` | `login`, `logout`, `login_failed` |
| `AuthProvider` | `password`, `google` |
| `AuthEventReason` | `INVALID_PASSWORD`, `USER_NOT_FOUND`, `USER_DISABLED`, `NETWORK` |
| `MaintenanceJob` | `sweep-expired-dispatches`, `sweep-staging-uploads`, `purge-closed-locations`, `recompute-analytics` |
| `TriageSource` | `ai`, `fallback`, `manual` |
| `UrgencySource` | `ai`, `human`, `fallback` |
| `AiOutcome` | `success`, `validation_failed`, `timeout`, `error`, `blocked` |
| `ScanStatus` | `clean`, `pending`, `quarantined` |
| `UploadIntent` | `report` (v1) |

> An `enum` failure is always `issue: 'invalid_enum_value'` with **no** `value` echo. Echoing the rejected value teaches a client what a category looks like, and the taxonomy is not secret but there is no reason to send it back.

---

## 4. Cross-field rules

These are `superRefine` checks, not per-field checks. Each reports against the field the user must change.

| # | Rule | Trigger | `field` | `issue` | Code | FR |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | At least one evidence channel | `text` trimmed length < 20 (or absent) **and** `media` empty (or every item rejected) | `text` | `no_evidence_channel` | `EMPTY_REPORT` (422) | FR-002 |
| 2 | Text length when present | trimmed length 20–2000 | `text` | `too_short` / `too_big` | `VALIDATION_FAILED` | FR-003 |
| 3 | Evidence caps | ≤ 3 images, ≤ 1 audio, ≤ 3 items total | `media` | `too_many_images` / `too_many_audio` / `too_many_items` | `VALIDATION_FAILED` | FR-005, FR-006 |
| 4 | `source = 'address_text'` needs a typed address | `location.source === 'address_text'` and `location.text` missing or < 3 | `location.text` | `required_for_source` | `VALIDATION_FAILED` | FR-031, FR-033 |
| 5 | `source = 'none'` means no coordinates | `location.source === 'none'` and any of `lat`/`lng`/`accuracyM`/`placeId` is non-null | `location.lat` (and siblings) | `must_be_null` | `VALIDATION_FAILED` | FR-031, FR-034 |
| 6 | `source ∈ {gps, manual_pin, address_text}` needs coordinates | `lat`/`lng` absent while `source` is not `none` | `location.lat` | `required_for_source` | `VALIDATION_FAILED` | FR-031 |
| 7 | `status = 'resolved'` needs a resolution code | `status === 'resolved'` and `resolutionCode` null/absent | `resolutionCode` | `required_for_status` | `RESOLUTION_CODE_REQUIRED` (422) | FR-054 |
| 8 | A resolution code only with `resolved` | `resolutionCode` present and `status !== 'resolved'` | `resolutionCode` | `not_allowed_for_status` | `VALIDATION_FAILED` | FR-054 |
| 9 | `sort = 'distance'` needs a centre | `sort === 'distance'` and `center` absent | `center` | `required_for_sort` | `CURSOR_COMBINATION_INVALID` (400) | FR-070, FR-071 |
| 10 | A centre needs a radius | `center` present and `radiusM` absent | `radiusM` | `defaulted` → clamped to the default | (accepted) | FR-037 |
| 11 | `from ≤ to` | `from > to` | `from` | `invalid_range` | `VALIDATION_FAILED` | FR-121 |
| 12 | Range span cap | `to − from > 365 d` (analytics, incidents) | `to` | `span_too_large` | `VALIDATION_FAILED` | FR-116, FR-121 |
| 13 | Merge target differs from the source | `primaryIncidentId === :id` | `primaryIncidentId` | `must_differ` | `SELF_MERGE_NOT_ALLOWED` (400) | FR-046 |
| 14 | Reason present where required | `reason` absent, empty, or < 10 chars on a privileged action | `reason` | `required` / `too_short` | `REASON_REQUIRED` (400) | FR-133 |
| 15 | `replaceExisting` semantics | `replaceExisting === true` and an active dispatch exists | — | (accepted; the transaction performs the swap) | — | FR-053 |
| 16 | `intent` must be `report` in v1 | any other value | `intent` | `invalid_enum_value` | `VALIDATION_FAILED` | FR-009 |
| 17 | `sort` must be in the allowed set for the caller | a citizen sends `sort=urgency` (accepted but ignored) or `sort=distance` without `center` | `sort` | `requires` | `CURSOR_COMBINATION_INVALID` | FR-124 |
| 18 | `includeDeleted` is privileged | a non-dispatcher sends it | `includeDeleted` | `forbidden_param` | `FORBIDDEN` (403) | FR-123 |
| 19 | `include=risk` needs the flag | `include` contains `risk` and `features.riskZones === false` | `include` | `feature_disabled` | `RISK_DISABLED` (422) | FR-114 |
| 20 | Audio duration cap | `kind === 'audio'` and `durationSec > 120` | `durationSec` | `too_big` | `VALIDATION_FAILED` | FR-006 |
| 21 | `clientActionId` shape | replay ids from the offline queue | `clientActionId` | `invalid_format` | `VALIDATION_FAILED` | US-014 |
| 22 | No `recipientUid` on read | `GET /api/notifications?recipientUid=…` | `recipientUid` | `unrecognized_keys` | `VALIDATION_FAILED` (400) | FR-103 |
| 23 | Idempotency key shape | header `Idempotency-Key` | header | `invalid_format` | `VALIDATION_FAILED` (400) | [08](./08_API_SPECIFICATION.md) §3.1 |
| 24 | Cursor/sort stability | a cursor is presented with a changed `sort` or a changed filter set | `cursor` | `filter_changed` | `CURSOR_COMBINATION_INVALID` (400) | FR-121 |

### 4.1 The `limit` decision — clamp or error

**Decision: reject, with exactly one exception.**

| Situation | Behaviour |
| --- | --- |
| `limit` is not an integer, is `NaN`, is `≤ 0`, or is **non-numeric** | `400 VALIDATION_FAILED`, `issue: 'invalid_type'` / `'not_integer'`. No repair. |
| `limit > max` on a **read-only list route** | **Clamped to `max`**, and the effective value is echoed in `data.page.limit`. `meta.limitClamped: true` is added to `meta`. One `info` log line. |
| `limit > max` anywhere else (any body field, `ids` array length, a write payload) | `400 VALIDATION_FAILED`, `issue: 'too_big'` |

Rationale: a clamped `limit` on a `GET` is harmless — the response is smaller than asked, the client learns the real number, and a dashboard auto-refresh with a bad parameter degrades instead of erroring in front of a dispatcher at 3 a.m. Every other out-of-range value is either a user choice that must be respected (`radiusM`, `from`/`to`) or a request that would cost more than intended, so those are refused loudly. The clamp is the **only** clamp in the system; it is asserted by a unit test that fails if a second `.clamp()` or `||` default appears in a schema.

---

## 5. Field tables — every endpoint

Columns: **Field** · **Loc** (body/query/params) · **Type** · **Req** · **Rules** · **Coercion / default** · **Error** (`code` + `issue`) · **FR**.

`—` in Req means optional. "conditional" means the rule is in §4.

### 5.1 `POST /api/me/bootstrap`

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `displayName` | body | string | ✔ | trimmed 2–60 chars | trim | `VALIDATION_FAILED` `too_short` / `too_big` | [08](./08_API_SPECIFICATION.md) §2.1 |
| `timezone` | body | string | ✔ | valid IANA zone, ≤ 64 chars; must equal `APP_TIMEZONE` or be a valid alternative | trim | `VALIDATION_FAILED` `invalid_format` | FR-146 |

No other key is accepted. `role`, `status`, and `email` are not in the schema and can never be set here.

### 5.2 `GET /api/me`

No request fields. `params`: none.

### 5.3 `PATCH /api/me`

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `displayName` | body | string | — | trimmed 2–60 | trim | `VALIDATION_FAILED` | FR-001 |
| `timezone` | body | string | — | IANA, ≤ 64 | trim | `VALIDATION_FAILED` | FR-146 |
| `locale` | body | string | — | ISO-639-1, `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/`, ≤ 16 | trim, lowercase | `VALIDATION_FAILED` | FR-004 |
| `notifPrefs.inApp` | body | boolean | — | real boolean, never `"true"` | none | `VALIDATION_FAILED` `invalid_type` | FR-105 |
| `notifPrefs.email` | body | boolean | — | real boolean | none | `VALIDATION_FAILED` | FR-105 |
| `notifPrefs.sms` | body | boolean | — | real boolean; if `true` while `ENABLE_SMS_NOTIFICATIONS` is false, the write succeeds and the channel stays disabled | none | — | FR-105, DEC-14 |
| `notifPrefs.whatsapp` | body | boolean | — | real boolean; same rule as `sms` | none | — | FR-106 |

`role`, `status`, `verification`, and `email` are **absent from the schema**; sending them is `unrecognized_keys` → 400. This is the enforcement of "never trust the client" for the most dangerous field in the system.

### 5.4 `POST /api/auth/event`

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `type` | body | enum | ✔ | `login` \| `logout` \| `login_failed` | — | `VALIDATION_FAILED` `invalid_enum_value` | FR-132, FR-135 |
| `provider` | body | enum | ✔ | `password` \| `google` | — | `VALIDATION_FAILED` | [08](./08_API_SPECIFICATION.md) §2.4 |
| `reason` | body | enum | ✔ | `INVALID_PASSWORD` \| `USER_NOT_FOUND` \| `USER_DISABLED` \| `NETWORK`; **required when `type === 'login_failed'`**, forbidden otherwise | — | `VALIDATION_FAILED` `required_for_type` | FR-135 |

The response never reveals whether a user exists; the reason enum is client-supplied and is recorded as an assertion, not a fact.

### 5.5 `POST /api/incidents` — create

`Idempotency-Key` **header**: optional, ≤ 64 chars, `/^[A-Za-z0-9_-]{1,64}$/`. Invalid → `400 VALIDATION_FAILED`, `details[0].field = "Idempotency-Key"`.

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `text` | body | string \| null | conditional | trimmed 20–2000 chars; required when `media` is empty; `null` allowed **only** with ≥ 1 media item. Stored **verbatim** — no rewriting, no trimming in the stored value beyond the outer whitespace used for the length check | trim for the length check | `VALIDATION_FAILED` `too_short` / `too_big`; `EMPTY_REPORT` when nothing else survives | FR-002, FR-003 |
| `media` | body | array | — | ≤ 3 items; ≤ 3 images; ≤ 1 audio; default `[]` | — | `VALIDATION_FAILED` `too_many_images` / `too_many_audio` / `too_many_items` | FR-005, FR-006 |
| `media[].mediaId` | body | string | ✔ | `/^med_[A-Za-z0-9]{2,32}$/`; must be unique within the array | — | `VALIDATION_FAILED` `invalid_format` | FR-005 |
| `media[].kind` | body | enum | ✔ | `image` \| `audio` | — | `VALIDATION_FAILED` | FR-005, FR-006 |
| `media[].storagePath` | body | string | ✔ | staging: `^staging/[A-Za-z0-9_-]{1,128}/med_[A-Za-z0-9]{2,32}\.(jpg\|jpeg\|png\|webp\|webm\|mp4\|mp3\|m4a)$`, **or** final: `^incidents/[A-Za-z0-9]{20}/(reports\|supplements)/[A-Za-z0-9]{2,}/[A-Za-z0-9_.-]+$`. Must have been issued to this uid by `POST /api/uploads/sign` within `STAGING_UPLOAD_SWEEP_MIN` (30 min) | — | `UPLOAD_FORBIDDEN_PATH` (403) `invalid_format` / `not_owned`; `UPLOAD_NOT_FOUND` (422) | FR-007, FR-008 |
| `media[].contentType` | body | string | ✔ | must be in the allow-list for `kind` **as declared**; the server still sniffs the bytes and prefers the sniffed type | — | `UNSUPPORTED_MEDIA_TYPE` (415) | FR-005, FR-006, FR-008 |
| `media[].sizeBytes` | body | int | ✔ | ≤ 5 242 880 for `image`, ≤ 15 728 640 for `audio`; ≥ 1 | — | `UPLOAD_TOO_LARGE` (413) `too_big` | FR-005, FR-006 |
| `media[].sha256` | body | string | — | `/^[a-f0-9]{64}$/i`, optional client-computed integrity hint | lowercase | `VALIDATION_FAILED` `invalid_format` | FR-008 |
| `location` | body | object \| null | — | absent ⇒ `source: 'none'`, `geo: null`, `accuracyGrade: 'unknown'` | default `null` | — | FR-031, FR-033, FR-034 |
| `location.lat` | body | number \| null | conditional | `-90 ≤ lat ≤ 90`; must be `null` when `source = 'none'` | no coercion | `LOCATION_OUT_OF_RANGE` (400) `too_small` / `too_big`; `VALIDATION_FAILED` `must_be_null` | FR-031 |
| `location.lng` | body | number \| null | conditional | `-180 ≤ lng ≤ 180`; same null rule | no coercion | `LOCATION_OUT_OF_RANGE` (400) | FR-031 |
| `location.accuracyM` | body | number \| null | conditional | `0 ≤ accuracyM ≤ 1000`; `null` ⇒ `accuracyGrade: 'unknown'` | no coercion | `VALIDATION_FAILED` `too_big`; `LOCATION_OUT_OF_RANGE` (400) | FR-032 |
| `location.source` | body | enum | conditional | `gps` \| `manual_pin` \| `address_text` \| `none`; default `gps` when `lat`/`lng` are present and `source` is absent | default `gps` | `VALIDATION_FAILED` `invalid_enum_value` | FR-031 |
| `location.text` | body | string \| null | conditional | trimmed 3–200 chars; **required when `source = 'address_text'`**; must be `null` when `source = 'none'` | trim | `VALIDATION_FAILED` `required_for_source` / `too_short` / `too_big` / `must_be_null` | FR-033, FR-035 |
| `location.placeId` | body | string \| null | — | Google `place_id`, `/^[A-Za-z0-9_-]{1,64}$/`; must be `null` when `source = 'none'` | — | `VALIDATION_FAILED` `invalid_format` / `must_be_null` | FR-035 |
| `reportedAt` | body | ISO datetime \| null | — | not more than **24 h** in the past, not more than **5 min** in the future; default = server now | ISO → `Timestamp` | `VALIDATION_FAILED` `in_future` / `too_old` / `invalid_format` | [08](./08_API_SPECIFICATION.md) §3.1, [07](./07_DATABASE_SCHEMA.md) §4.1 |
| `language` | body | string | — | ISO-639-1 `/^[a-z]{2,3}$/`, ≤ 5; default `en` | trim, lowercase | `VALIDATION_FAILED` `invalid_format` | FR-004 |
| `skipTriage` | body | boolean | — | default `false`; **`true` is accepted only for `dispatcher`/`admin`** and forces `triageSource: 'manual'`, `aiConfidence: 0` | no coercion; body `"true"` is rejected | `VALIDATION_FAILED` `forbidden_field` (see D-17-4) | [08](./08_API_SPECIFICATION.md) §3.1, FR-021 |

`params`: none. `query`: none.

**Anti-far-tampering.** A `source: 'gps'` claim with `accuracyM: 0` and coordinates on the other side of the world is **flagged, not rejected** — see §7.3.

### 5.6 `GET /api/incidents` — list

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `status` | enum, repeatable | — | `IncidentStatus`; ≤ 7 values; combined with `sort` it must be servable by an index | active set `new,triaged,verified,assigned,en_route,on_scene` | `VALIDATION_FAILED` `invalid_enum_value` | FR-070, FR-124 |
| `urgency` | enum, repeatable | — | `Urgency`; ≤ 4 | none | `VALIDATION_FAILED` | FR-070 |
| `category` | enum, repeatable | — | `IncidentCategory`; ≤ 11 | none | `VALIDATION_FAILED` | FR-070 |
| `verified` | enum | — | `true` \| `false` \| `any` | `any` | `VALIDATION_FAILED` | FR-070 |
| `slaState` | enum, repeatable | — | `on_track` \| `at_risk` \| `breached` | none | `VALIDATION_FAILED` | FR-057 |
| `unassigned` | boolean | — | `true` ⇒ `assigneeUid == null`; `false` ⇒ ignored (an incident always has an assignee) | none | `VALIDATION_FAILED` | FR-070 |
| `from` / `to` | ISO date | — | inclusive; `from ≤ to`; span ≤ 365 days | last 30 days | `VALIDATION_FAILED` `invalid_range` / `span_too_large` | FR-121 |
| `q` | string | — | trimmed 1–60 chars; tokenised; ≤ 3 tokens used (a 4th token is a client bug and is rejected, not silently dropped) | none | `VALIDATION_FAILED` `too_long` / `too_many_tokens` | FR-070 |
| `center` | string | — | `"lat,lng"`, each in range, exactly one comma, no spaces required | none | `VALIDATION_FAILED` `invalid_format` | FR-037 |
| `radiusM` | int | — | 1–**2000** for this endpoint; requires `center` | 500 when `center` is present | `VALIDATION_FAILED` `too_big` | FR-037 |
| `sort` | enum | — | `newest` \| `oldest` \| `urgency` \| `sla` \| `distance`; `distance` **requires** `center` | `newest` | `CURSOR_COMBINATION_INVALID` (400) `requires` | FR-071 |
| `limit` | int | — | 1–100; **clamped** to 100 (§4.1) | 25 | `VALIDATION_FAILED` `invalid_type` / `not_integer` | FR-121 |
| `cursor` | string | — | opaque token: base64url of `{ docId, createdAt, filterHash }`, ≤ 512 chars; the server re-resolves the document | none | `INVALID_CURSOR` (400) `unresolvable` | FR-121 |
| `includeDeleted` | boolean | — | `dispatcher`/`admin` only; always audited | `false` | `FORBIDDEN` (403) `forbidden_param` | FR-123 |

**Forced filters by role** (never a validation error — the server applies them and reports them in `data.forcedFilters`): a `citizen` always gets `reporterUid == self`; a `responder` gets own ∪ assigned ∪ in-radius-unassigned-when-`available`. A citizen sending `status=closed` gets their own closed incidents, not everyone's.

### 5.7 `GET /api/incidents/:id`

| Param | Loc | Type | Req | Rules | Default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `id` | params | string | ✔ | `/^[A-Za-z0-9]{20}$/` | — | `VALIDATION_FAILED` `invalid_format` | — |
| `expand` | query | csv enum | — | from `reports,history,resources,dispatch,ai,duplicates`; unknown tokens rejected; duplicates de-duplicated; ≤ 6 | `reports,history,dispatch` | `VALIDATION_FAILED` `invalid_enum_value` | FR-075 |

### 5.8 `PATCH /api/incidents/:id`

`params.id`: `/^[A-Za-z0-9]{20}$/`.
All body fields optional. `.strict()`. **The allowed field set depends on the caller's role**, implemented as three schemas from one base:

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `summary` | body | string | — | trimmed 1–240; setting it sets `summaryEditedBy` and forces `urgencySource: 'human'` | trim | `VALIDATION_FAILED` `too_big` | FR-073 |
| `urgency` | body | enum | — | `Urgency`; setting it sets `urgencySource: 'human'`, clears `aiNeedsReview`, recomputes `slaTargetMin`, and clears `slaBreachedAt` if the new target is not yet breached | — | `VALIDATION_FAILED` | FR-026, FR-057, FR-073 |
| `category` | body | enum | — | `IncidentCategory` (11) | — | `VALIDATION_FAILED` `invalid_enum_value` | FR-025, FR-073 |
| `location` | body | object | — | Same field set and rules as `POST /api/incidents` §5.5. Changing it recomputes `geoCells`, `accuracyGrade`, and re-runs duplicate detection server-side | — | as §5.5 | FR-039, FR-042 |
| `resolutionNote` | body | string \| null | — | trimmed ≤ 280; may be sent before `resolved` (a dispatcher annotating early) | trim | `VALIDATION_FAILED` `too_big` | FR-054 |

| Caller | Permitted fields |
| --- | --- |
| `dispatcher`, `admin` | `summary`, `urgency`, `category`, `location`, `resolutionNote` |
| `reporter` (own incident, `status ∈ {new, triaged}`) | `location` only |
| `responder` | none — any body key is `forbidden_field` → `VALIDATION_FAILED` (400) with `field` set to the offending key |

An empty body `{}` is rejected with `VALIDATION_FAILED` / `issue: 'empty_update'` (400): a no-op PATCH would still cost a rate-limit token and an audit row.

### 5.9 `POST /api/incidents/:id/triage`

| Field | Loc | Type | Req | Rules | Default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 chars; written to the audit entry | trim | `REASON_REQUIRED` (400) `required` | FR-133 |
| `includeNewEvidence` | body | boolean | — | real boolean; when `true`, all linked reports are included in the triage input | `false` | `VALIDATION_FAILED` `invalid_type` | FR-028 |

`params.id`: `/^[A-Za-z0-9]{20}$/`. A `reporter` may call this on their own `new`/`triaged` incident only.

### 5.10 `POST /api/incidents/:id/dispatch`

| Field | Loc | Type | Req | Rules | Default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `responderUid` | body | string | ✔ | `/^[A-Za-z0-9_-]{1,128}$/`; must exist in `responders`; `verification === 'verified'`; `status ∈ {available, busy}`; `activeIncidentCount < maxConcurrentIncidents` unless `replaceExisting` | — | `RESPONDER_NOT_FOUND` (404); `RESPONDER_NOT_VERIFIED` (409); `RESPONDER_UNAVAILABLE` (409); `RESPONDER_AT_CAPACITY` (409) | FR-064, FR-065, FR-074 |
| `mode` | body | enum | — | `auto_suggest` \| `manual` \| `self_claimed` | `manual` | `VALIDATION_FAILED` | FR-074 |
| `note` | body | string \| null | — | trimmed ≤ 280; plain text, no HTML | trim | `VALIDATION_FAILED` `too_big` | FR-074 |
| `replaceExisting` | body | boolean | — | real boolean; when `false` and an active dispatch exists → `409 ALREADY_ASSIGNED` with `details[0].value = { uid, displayName }` | `false` | `ALREADY_ASSIGNED` (409) | FR-053 |

Header `Idempotency-Key`: optional, same pattern as §5.5.
Out-of-radius is a **warning in the response**, never a rejection ([08](./08_API_SPECIFICATION.md) §3.6): `data.outsideServiceRadius: true` when the distance exceeds `serviceRadiusM` and no `homeBase` is in range.

### 5.11 `GET /api/incidents/:id/dispatch/candidates`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `requiredResourceId` | repeatable string | — | `/^res_[a-z0-9_]{2,40}$/`; ≤ 6; must exist and be `active` | none | `VALIDATION_FAILED`; `RESOURCE_REQUIRED` (422) if unknown | FR-065 |
| `radiusM` | int | — | 1–**20000** (this route's cap is 20 km, unlike `/api/incidents`' 2000 m) | `config.responderDefaultRadiusM`, else 5000 | `VALIDATION_FAILED` `too_big` | FR-065 |
| `capabilityRequired` | boolean | — | real boolean | `true` | `VALIDATION_FAILED` | FR-065 |

An incident with `geo === null` does **not** fail validation; the service returns a first-page-by-freshness list with `unranked: true` ([08](./08_API_SPECIFICATION.md) §3.7). `LOCATION_REQUIRED` (422) is returned only when the caller explicitly demanded a distance ordering that cannot be produced.

### 5.12 `PATCH /api/incidents/:id/status`

| Field | Loc | Type | Req | Rules | Default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `status` | body | enum | ✔ | `IncidentStatus` (11); must be reachable from the current status for this actor | — | `INVALID_STATUS_TRANSITION` (409) `not_allowed_from`; `TRANSITION_NOT_ALLOWED_YET` (409) `sequence_violation` | FR-050, FR-051, FR-055 |
| `reason` | body | string \| null | conditional | trimmed 10–280; **required** for `false_alarm`, `cancelled`, and any dispatcher skip; optional otherwise | — | `REASON_REQUIRED` (400) | FR-133, FR-056 |
| `note` | body | string \| null | — | trimmed ≤ 280; plain text; stored on the `statusHistory` event | trim | `VALIDATION_FAILED` `too_big` | FR-052 |
| `resolutionCode` | body | enum \| null | conditional | `ResolutionCode` (6); **required when `status === 'resolved'`**, forbidden otherwise | `null` | `RESOLUTION_CODE_REQUIRED` (422); `INVALID_RESOLUTION_CODE` (400) | FR-054 |
| `clientActionId` | body | string \| null | — | `/^a_[a-f0-9]{8,32}$/`; the offline-queue replay id; a repeat with the same id is a no-op | `null` | `VALIDATION_FAILED` `invalid_format` | US-014 |

The response returns `data.allowedNext` so the client renders one primary action without duplicating the transition table (US-012).

### 5.13 `POST /api/incidents/:id/merge`

| Field | Loc | Type | Req | Rules | Default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `primaryIncidentId` | body | string | ✔ | `/^[A-Za-z0-9]{20}$/`; must not equal `:id`; must be visible to the caller | — | `SELF_MERGE_NOT_ALLOWED` (400) `must_differ`; `INCIDENT_NOT_FOUND` (404) | FR-046 |
| `reason` | body | string | ✔ | trimmed 10–280 | trim | `REASON_REQUIRED` (400) | FR-046, FR-133 |

The secondary must not have an active dispatch → `MERGE_BLOCKED_ACTIVE_ASSIGNMENT` (409).

### 5.14 `POST /api/incidents/:id/merge/undo`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | :-: | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280; the operation is refused after 24 h | `REASON_REQUIRED` (400); `INVALID_STATUS_TRANSITION` (409) when `mergedAt` is older than 24 h | FR-047 |

### 5.15 `POST /api/incidents/:id/duplicates/dismiss`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `otherIncidentId` | body | string | ✔ | `/^[A-Za-z0-9]{20}$/`; must not equal `:id` | `VALIDATION_FAILED` | FR-048 |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-048 |

### 5.16 `DELETE /api/incidents/:id`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | :-: | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280; **required for `dispatcher`**; optional for `admin` ([08](./08_API_SPECIFICATION.md) §3.10) | `REASON_REQUIRED` (400) | FR-123, FR-133 |

### 5.17 `POST /api/incidents/:id/restore`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | :-: | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-123 |

### 5.18 `GET /api/incidents/:id/export`

| Param | Type | Req | Rules | Error | FR |
| --- | --- | :-: | --- | --- | --- |
| `ids` | csv of firestore ids | — | ≤ **200** ids, each `/^[A-Za-z0-9]{20}$/`, de-duplicated; when absent, the current filter set is used | `VALIDATION_FAILED` `too_big` / `invalid_format` | FR-118 |

The response is `text/csv`. Exported columns are fixed and never include reporter identity, IP hashes, or free text ([08](./08_API_SPECIFICATION.md) §3.11).

### 5.19 `GET /api/responders`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `status` | repeatable enum | — | `available` \| `busy` \| `offline`; ≤ 3 | none | `VALIDATION_FAILED` | FR-061 |
| `verification` | repeatable enum | — | `unverified` \| `pending` \| `verified` \| `rejected`; ≤ 4 | none | `VALIDATION_FAILED` | FR-063 |
| `capability` | string | — | `/^res_[a-z0-9_]{2,40}$/`; must exist and be `active` | none | `VALIDATION_FAILED`; `RESOURCE_REQUIRED` (422) | FR-062 |
| `center` | string | — | `"lat,lng"` | none | `VALIDATION_FAILED` | FR-037 |
| `radiusM` | int | — | 1–**20000** | 20000 when `center` is present | `VALIDATION_FAILED` `too_big` | FR-037 |
| `stale` | boolean | — | `true` ⇒ `lastLocationAt` older than `STALE_LOCATION_MIN` (15 min) | none | `VALIDATION_FAILED` | US-022 |
| `q` | string | — | trimmed ≤ 60; matches `displayName` prefix | none | `VALIDATION_FAILED` | FR-061 |
| `limit` | int | — | 1–100, clamped | **50** | `VALIDATION_FAILED` | FR-121 |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` | FR-121 |

### 5.20 `GET /api/responders/:id`

`params.id`: `/^[A-Za-z0-9_-]{1,128}$/` (a uid, not a Firestore auto-ID). No query fields.

### 5.21 `PATCH /api/responders/:id`

Three role-conditional schemas over one base. Fields absent from the caller's schema are `forbidden_field` → 400.

| Field | Loc | Type | Self (`responder`) | Dispatcher | Admin | Rules | Error | FR |
| --- | --- | --- | :-: | :-: | :-: | --- | --- | --- |
| `status` | body | enum | ✔ | ✔ | ✔ | `available` \| `busy` \| `offline`; setting it also updates `responderLocations.status` in the same batch | `VALIDATION_FAILED` | FR-061 |
| `capabilities` | body | string[] | ✔ | ✔ | ✔ | ≤ 12 entries, each `/^res_[a-z0-9_]{2,40}$/`, de-duplicated, each must exist and be `active`; self-declared values are re-checked by an admin | `INVALID_CAPABILITY` (422) `unknown_resource` | FR-062 |
| `serviceRadiusM` | body | int | ✔ | ✔ | ✔ | **500–50000** | `VALIDATION_FAILED` `too_small` / `too_big` | FR-062 |
| `phone` | body | string \| null | ✔ | — | ✔ | E.164 `/^\+[1-9]\d{7,14}$/`; `null` clears it; never returned by the list route | `VALIDATION_FAILED` `invalid_format` | FR-068 |
| `notifPrefs` | body | object | ✔ | — | ✔ | same shape as §5.3 | `VALIDATION_FAILED` | FR-105 |
| `homeBase` | body | `{lat,lng}` \| null | — | ✔ | ✔ | coordinate ranges; stored with `homeBaseGeoCells`; `null` clears it | `LOCATION_OUT_OF_RANGE` (400) | FR-062 |
| `note` | body | string \| null | — | ✔ | ✔ | trimmed ≤ 280; a dispatcher note about the responder | `VALIDATION_FAILED` | §4 |

`verification` is **not in any of the three schemas** — it has its own endpoints (§5.23, §5.24), so a compromised admin session that can change profiles still cannot silently self-verify ([22](./22_USER_ROLES_PERMISSIONS.md) §4.3).

### 5.22 `PATCH /api/responders/:id/location` — heartbeat

| Field | Loc | Type | Req | Rules | Coercion | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `lat` | body | number | ✔ | `-90 ≤ lat ≤ 90` | no coercion | `LOCATION_OUT_OF_RANGE` (400) | FR-066 |
| `lng` | body | number | ✔ | `-180 ≤ lng ≤ 180` | no coercion | `LOCATION_OUT_OF_RANGE` (400) | FR-066 |
| `accuracyM` | body | int | ✔ | **0–5000** (note: wider than the 1000 m incident cap) | no coercion | `VALIDATION_FAILED` `too_big` | FR-066 |
| `headingDeg` | body | number \| null | — | `0 ≤ headingDeg < 360`; `null` when unavailable | no coercion | `VALIDATION_FAILED` | [07](./07_DATABASE_SCHEMA.md) §7.2 |
| `speedMps` | body | number \| null | — | `0 ≤ speedMps ≤ 120`; `null` when unavailable | no coercion | `VALIDATION_FAILED` | [07](./07_DATABASE_SCHEMA.md) §7.2 |
| `source` | body | enum | ✔ | `gps` \| `manual` | — | `VALIDATION_FAILED` | FR-066 |
| `status` | body | enum | ✔ | `available` \| `busy` \| `offline`; must equal the caller's own responder status for a self-write | — | `VALIDATION_FAILED` / `FORBIDDEN` (403) | FR-061 |
| `capturedAt` | body | ISO datetime | ✔ | not more than **60 s** in the future; must be at least 20 s **after** the stored `capturedAt` | ISO → `Timestamp` | `HEARTBEAT_TOO_FREQUENT` (429) + `Retry-After`; `VALIDATION_FAILED` `in_future` | FR-066, [08](./08_API_SPECIFICATION.md) §4.4 |

`params.id` must equal the token uid for a self-write; otherwise `FORBIDDEN` (403). An `offline` responder's write is **stored** with `stale: true` forced — that is behaviour, not a validation error (FR-066).

### 5.23 `POST /api/responders/:id/verify`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `note` | body | string | ✔ | trimmed 10–280; stored as `verificationNote` and written to the audit entry | `REASON_REQUIRED` (400) | FR-063 |
| `capabilities` | body | string[] | — | same rules as §5.21; replaces the catalogue-backed list | `INVALID_CAPABILITY` (422) | FR-062 |

`verification` is already `verified` → `ALREADY_VERIFIED` (409).

### 5.24 `POST /api/responders/:id/reject`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `note` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-063 |

### 5.25 `GET /api/responders/:id/incidents`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `status` | repeatable enum | — | `active` \| `accepted` \| `withdrawn` \| `completed`; `expired` is excluded from the responder view | `active,accepted` | `VALIDATION_FAILED` | FR-053 |
| `limit` | int | — | 1–100, clamped | 25 | `VALIDATION_FAILED` | FR-121 |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` | FR-121 |

### 5.26 `GET /api/dispatches`

| Param | Type | Req | Rules | Error | FR |
| --- | --- | :-: | --- | --- | --- |
| `responderUid` | string | — | `/^[A-Za-z0-9_-]{1,128}$/`; a `responder` may only pass their own uid — any other value is `forbidden_param` | `VALIDATION_FAILED` / `FORBIDDEN` (403) | FR-124 |
| `incidentId` | string | — | `/^[A-Za-z0-9]{20}$/` | `VALIDATION_FAILED` | — |
| `status` | repeatable enum | — | `DispatchStatus` (5) | `VALIDATION_FAILED` | FR-053 |
| `from` / `to` | ISO date | — | inclusive, span ≤ 365 d | `VALIDATION_FAILED` | FR-121 |
| `limit` / `cursor` | int / string | — | 1–100 (clamped) / opaque; default 25 | `VALIDATION_FAILED` / `INVALID_CURSOR` | FR-121 |

### 5.27 `POST /api/dispatches/:id/claim`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `note` | body | string \| null | — | trimmed ≤ 280 | `VALIDATION_FAILED` `too_big` | FR-065 |

`params.id`: `/^dsp_[A-Za-z0-9]{2,32}$/`. State preconditions produce `DISPATCH_NOT_FOUND`, `DISPATCH_EXPIRED`, `DISPATCH_ALREADY_ACCEPTED`, `RESPONDER_UNAVAILABLE`, `RESPONDER_AT_CAPACITY`, `FORBIDDEN` — none of which are schema issues.

### 5.28 `POST /api/dispatches/:id/withdraw`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-133 |

### 5.29 `GET /api/dispatches/summary`

No request fields.

### 5.30 `GET /api/notifications`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `unread` | boolean | — | real boolean; `false` is a filter, not "all" | none | `VALIDATION_FAILED` | FR-104 |
| `type` | repeatable enum | — | `NotificationType` (12) | none | `VALIDATION_FAILED` | FR-101 |
| `limit` | int | — | 1–100, clamped | 25 | `VALIDATION_FAILED` | FR-121 |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` | FR-121 |
| `since` | ISO datetime | — | not in the future | none | `VALIDATION_FAILED` `in_future` | FR-100 |

`recipientUid` is **not** a parameter. Sending it is `unrecognized_keys` → 400, and even if it were accepted the query is hard-coded to the token uid (FR-103).

### 5.31 `PATCH /api/notifications/:id`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `read` | body | boolean | ✔ | real boolean; `true` sets `read` + `readAt`; `false` clears `readAt` | `VALIDATION_FAILED` `invalid_type` | FR-104 |

`params.id`: `/^[A-Za-z0-9]{20}$/`.

### 5.32 `POST /api/notifications/read-all`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `types` | enum[] | — | ≤ 12 distinct `NotificationType`; when omitted, all unread for the recipient | — | `VALIDATION_FAILED` | FR-104 |

More than 200 matches → `BATCH_TOO_LARGE` (422) with `details[0].value = { matched: n }`; the client pages.

### 5.33 `POST /api/notifications` — admin only

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `recipientUid` | body | string | ✔ | must resolve to an existing user | `RECIPIENT_NOT_FOUND` (422) | FR-108 |
| `type` | body | enum | ✔ | `NotificationType` (12) | `UNSUPPORTED_NOTIFICATION_TYPE` (422) | FR-101 |
| `severity` | body | enum | — | `info` \| `warning` \| `critical`; default `info` | `VALIDATION_FAILED` | FR-102 |
| `title` | body | string | ✔ | trimmed 1–**90** chars; plain text. Any `<` or `>` is **rejected**, not escaped | `VALIDATION_FAILED` `invalid_format` | FR-102, T-09 |
| `body` | body | string | ✔ | trimmed 1–**240** chars; plain text; same rejection rule | `VALIDATION_FAILED` | FR-102 |
| `incidentId` | body | string \| null | — | `/^[A-Za-z0-9]{20}$/` | `VALIDATION_FAILED` | — |
| `link` | body | string \| null | — | internal route, `^/[A-Za-z0-9/_-]{1,120}$`; an absolute URL or a `javascript:` value is rejected | `VALIDATION_FAILED` `invalid_format` | FR-102 |

### 5.34 `DELETE /api/notifications/:id`

No body. `params.id`: `/^[A-Za-z0-9]{20}$/`.

### 5.35 `GET /api/analytics`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `from` / `to` | ISO date | — | `YYYY-MM-DD` in `APP_TIMEZONE`; inclusive; `from ≤ to`; **span ≤ 365 days** | last 7 days | `VALIDATION_FAILED` `span_too_large` / `invalid_range` | FR-116 |
| `granularity` | enum | — | `day` \| `week`; `week` buckets are ISO weeks starting Monday | `day` | `VALIDATION_FAILED` | FR-112 |
| `include` | csv enum | — | from `totals,category,trend,response,risk,responders`; de-duplicated; `risk` requires the feature flag | all six | `VALIDATION_FAILED`; `RISK_DISABLED` (422) | FR-114, FR-117 |
| `center` | string | — | `"lat,lng"` | none | `VALIDATION_FAILED` | FR-114 |
| `radiusM` | int | — | 1–**20000** | none | `VALIDATION_FAILED` `too_big` | FR-114 |
| `format` | enum | — | `json` \| `csv` | `json` | `VALIDATION_FAILED` | FR-118 |

`role`: `citizen` and `responder` are refused at step 3 of the pipeline with `FORBIDDEN` (403) before any query is built (FR-117). That is an authorisation failure, not a validation failure.

### 5.36 `POST /api/analytics/recompute`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `target` | body | enum | ✔ | `daily` \| `risk` | `VALIDATION_FAILED` | FR-115 |
| `from` / `to` | body | ISO date | ✔ | `YYYY-MM-DD`; `from ≤ to`; span ≤ 365 d | `VALIDATION_FAILED` | FR-115 |
| `reason` | body | string | — | trimmed ≤ 200; recorded on the job and the audit row | `VALIDATION_FAILED` | FR-133 |

### 5.37 `POST /api/uploads/sign`

| Field | Loc | Type | Req | Rules | Coercion / default | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- | --- |
| `kind` | body | enum | ✔ | `image` \| `audio` | — | `VALIDATION_FAILED` | FR-005, FR-006 |
| `contentType` | body | enum | ✔ | must be in the allow-list **for `kind`**: `image/jpeg\|image/png\|image/webp` for `image`; `audio/webm\|audio/mp4\|audio/mpeg` for `audio` | — | `UNSUPPORTED_MEDIA_TYPE` (415) | FR-005, FR-006 |
| `sizeBytes` | body | int | ✔ | `1 ≤ sizeBytes ≤ 5 242 880` (`image`) or `≤ 15 728 640` (`audio`), from `UPLOAD_MAX_IMAGE_BYTES` / `UPLOAD_MAX_AUDIO_BYTES` | no coercion | `UPLOAD_TOO_LARGE` (413) | FR-005, FR-006 |
| `sha256` | body | string \| null | — | `/^[a-f0-9]{64}$/i` | lowercase | `VALIDATION_FAILED` | FR-008 |
| `clientWidth` | body | int \| null | — | **1–12000**; required for `kind === 'image'` | — | `VALIDATION_FAILED` `required_for_kind` | FR-005 |
| `clientHeight` | body | int \| null | — | 1–12000; required for `image` | — | `VALIDATION_FAILED` | FR-005 |
| `durationSec` | body | int \| null | — | `0 ≤ durationSec ≤ 120`; **required for `kind === 'audio'`**, forbidden for `image` | `z.coerce.number()` (a recorder reports a float) | `VALIDATION_FAILED` `too_big` / `forbidden_for_kind` | FR-006 |
| `intent` | body | enum | ✔ | must be `report` in v1 | — | `VALIDATION_FAILED` `invalid_enum_value`; `FEATURE_DISABLED` (422) if the mirroring feature flag is off | FR-009 |

### 5.38 `POST /api/uploads/finalize`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `mediaId` | body | string | ✔ | `/^med_[A-Za-z0-9]{2,32}$/`; must belong to a staging object issued to this uid and not yet swept | `MEDIA_NOT_FOUND` (404) | FR-008 |

### 5.39 `GET /api/uploads/:mediaId/url`

`params.mediaId`: `/^med_[A-Za-z0-9]{2,32}$/`. No query fields.

### 5.40 `GET /api/resources`

| Param | Type | Req | Rules | Default | Error |
| --- | --- | :-: | --- | --- | --- |
| `limit` | int | — | 1–100, clamped | when absent, the whole active catalogue is returned | `VALIDATION_FAILED` |

### 5.41 `GET /api/config`

No request fields. The response is a **projection allow-list**: `appName`, `appTimezone`, `slaMinutes`, `features`, `realtime`, `notifications.channels`, `duplicate.radiusM`, `categoryGroups`. `retention`, admin-only keys, and anything from the environment are never present ([08](./08_API_SPECIFICATION.md) §9.2).

### 5.42 `GET /api/health`

No request fields. No authentication.

### 5.43 `GET /api/admin/users`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `role` | repeatable enum | — | `Role` (4) | none | `VALIDATION_FAILED` | FR-132 |
| `status` | repeatable enum | — | `UserStatus` (4) | none | `VALIDATION_FAILED` | FR-132 |
| `q` | string | — | trimmed ≤ 60; matches `displayName` or `email` prefix | none | `VALIDATION_FAILED` | FR-132 |
| `from` / `to` | ISO date | — | inclusive, span ≤ 365 d, applied to `createdAt` | none | `VALIDATION_FAILED` | — |
| `limit` | int | — | 1–100, clamped | 25 (D-17-11) | `VALIDATION_FAILED` | FR-121 |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` | FR-121 |

### 5.44 `GET /api/admin/users/:id`

`params.id`: `/^[A-Za-z0-9_-]{1,128}$/`. No query fields.

### 5.45 `PATCH /api/admin/users/:id/role`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `role` | body | enum | ✔ | `Role` (4) | `VALIDATION_FAILED` | FR-133 |
| `reason` | body | string | ✔ | trimmed 10–280; written to the audit row | `REASON_REQUIRED` (400) | FR-133 |

Guards that are **authorisation**, not schema: `SELF_ROLE_CHANGE_FORBIDDEN` (400), `ROLE_ESCALATION_GUARD` (403), `ALREADY_ROLE` (409), `USER_NOT_FOUND` (404).

### 5.46 `PATCH /api/admin/users/:id/status`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | :-: | :-: | --- | --- | --- |
| `status` | body | enum | ✔ | `active` \| `suspended` \| `disabled` | `VALIDATION_FAILED` | FR-132 |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-133 |

`SELF_DISABLE_FORBIDDEN` (400) when the target is the caller.

### 5.47 `POST /api/admin/users/:id/reset-claims`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-133 |

### 5.48 `GET /api/admin/audit-logs`

| Param | Type | Req | Rules | Default | Error | FR |
| --- | --- | :-: | --- | --- | --- | --- |
| `actorUid` | string | — | `/^[A-Za-z0-9_-]{1,128}$/`; `"system"` is a legal value | none | `VALIDATION_FAILED` | FR-134 |
| `action` | repeatable enum | — | `AuditAction`; ≤ 12 values | none | `VALIDATION_FAILED` | FR-134 |
| `entityType` | repeatable enum | — | `incident` \| `user` \| `responder` \| `dispatch` \| `config` \| `auth` \| `notification` | none | `VALIDATION_FAILED` | FR-134 |
| `entityId` | string | — | `/^[A-Za-z0-9_-]{1,64}$/` | none | `VALIDATION_FAILED` | FR-134 |
| `from` / `to` | ISO datetime | — | inclusive, span ≤ 365 d, applied to `createdAt` | none | `VALIDATION_FAILED` | FR-134 |
| `limit` | int | — | 1–100, clamped | **50** | `VALIDATION_FAILED` | FR-134 |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` | FR-134 |
| `format` | enum | — | `json` \| `csv` | `json` | `VALIDATION_FAILED` | FR-118 |

There is **no** delete parameter, because no role may delete an audit row (row 59, [22](./22_USER_ROLES_PERMISSIONS.md) §3).

### 5.49 `GET /api/admin/config`

No request fields. Returns the **full** `config/app`, including `retention`.

### 5.50 `PATCH /api/admin/config`

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-133 |
| `duplicate.duplicateRadiusM` | body | int | — | 100–2000 | `VALIDATION_FAILED` `too_small` / `too_big` | FR-042, US-033 |
| `duplicate.duplicateTimeWindowMin` | body | int | — | 60–4320 (1 h – 72 h) | `VALIDATION_FAILED` | FR-042 |
| `duplicate.textSimilarityConfirm` | body | number | — | 0.2–0.9 | `VALIDATION_FAILED` | FR-043 |
| `duplicate.duplicatePotentialThreshold` | body | number | — | 0.2–0.95 | `VALIDATION_FAILED` | FR-044 |
| `duplicate.duplicateMaxCandidates` | body | int | — | 10–200 | `VALIDATION_FAILED` | FR-037 |
| `duplicate.algorithmVersion` | body | string | — | `/^[a-z0-9-]{1,32}$/`; changing it is a deliberate act and is audited | `VALIDATION_FAILED` | FR-049 |
| `slaMinutes.critical` | body | int | — | 1–1440 | `VALIDATION_FAILED` | FR-026, FR-057 |
| `slaMinutes.high` | body | int | — | 1–1440 | `VALIDATION_FAILED` | FR-026 |
| `slaMinutes.medium` | body | int | — | 1–1440 | `VALIDATION_FAILED` | FR-026 |
| `slaMinutes.low` | body | int | — | 1–10080 | `VALIDATION_FAILED` | FR-026 |
| `risk.weightDensity` / `risk.weightSeverity` / `risk.halfLifeDays` / `risk.windowDays` | body | number/int | — | weights 0–1; `halfLifeDays` 1–365; `windowDays` 1–365 | `VALIDATION_FAILED` | FR-114, FR-115 |
| `features.*` | body | boolean | — | any documented feature flag | `VALIDATION_FAILED` | — |
| `retention.locationPurgeDays` | body | int | — | 30–365; ≥ 90 is required by NFR-028, so values < 90 are rejected unless `ENABLE_SHORT_RETENTION` is set (**`DECISION REQUIRED`**) | `VALIDATION_FAILED` | NFR-028 |
| `retention.auditDays` | body | int | — | ≥ 365 | `VALIDATION_FAILED` | FR-136 |
| any environment-sourced key | body | any | — | absent from the schema ⇒ `unrecognized_keys` | `VALIDATION_FAILED` | US-033 |

A partially-valid patch is rejected whole: `config/app` is a singleton and a half-applied config is worse than a rejected one. Every range violation is reported at once, so an admin sees all four bad fields in one round trip (US-033 AC3).

### 5.51 `GET /api/admin/responders`

| Param | Type | Req | Rules | Default | Error |
| --- | --- | :-: | --- | --- | --- |
| `verification` | repeatable enum | — | `unverified` \| `pending` \| `verified` \| `rejected`; default `pending` | `pending` | `VALIDATION_FAILED` |
| `limit` | int | — | 1–100, clamped | 25 | `VALIDATION_FAILED` |
| `cursor` | string | — | opaque | none | `INVALID_CURSOR` |

### 5.52 `GET /api/admin/system/health`

No request fields.

### 5.53 `POST /api/admin/maintenance/[job]`

`params.job`: `MaintenanceJob` enum. An unknown job name is `VALIDATION_FAILED` — it is a whitelist, not a free string, so a typo cannot reach the job dispatcher.

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `reason` | body | string | ✔ | trimmed 10–280 | `REASON_REQUIRED` (400) | FR-133 |

`MAINTENANCE_DISABLED` (422) is returned when `ENABLE_MAINTENANCE_JOBS !== 'true'` or `config.features.maintenance !== true`. This is checked **after** validation, so a malformed job request is a 400 and a well-formed but disabled job is a 422.

### 5.54 `GET /api/cron/[job]`

`params.job`: `daily` \| `sweep-expired-dispatches` \| `sweep-staging-uploads` \| `purge-closed-locations` \| `recompute-risk`. No query fields. Authentication is `Authorization: Bearer ${CRON_SECRET}` compared in constant time; failure is `AUTH_REQUIRED` (401) and is rate limited to **10 per IP per hour** (FR-135).

### 5.55 `params` on every route

| Param | Pattern | Routes | Error on mismatch |
| --- | --- | --- | --- |
| `:id` (incident) | `/^[A-Za-z0-9]{20}$/` | all `/api/incidents/:id…` | `VALIDATION_FAILED` `invalid_format` |
| `:id` (responder / user) | `/^[A-Za-z0-9_-]{1,128}$/` | `/api/responders/:id…`, `/api/admin/users/:id…` | `VALIDATION_FAILED` `invalid_format` |
| `:id` (dispatch) | `/^dsp_[A-Za-z0-9]{2,32}$/` | `/api/dispatches/:id…` | `VALIDATION_FAILED` `invalid_format` |
| `:id` (notification) | `/^[A-Za-z0-9]{20}$/` | `/api/notifications/:id` | `VALIDATION_FAILED` `invalid_format` |
| `:mediaId` | `/^med_[A-Za-z0-9]{2,32}$/` | `/api/uploads/:mediaId/url` | `VALIDATION_FAILED` `invalid_format` |
| `:job` | `MaintenanceJob` enum | `/api/admin/maintenance/:job` | `VALIDATION_FAILED` `invalid_enum_value` |

A param that fails its pattern returns `400`, not `404`. A malformed id is a client bug; a well-formed id that does not exist is a `404`.

### 5.56 `POST /api/incidents/:id/reports` — supplement / correction

`DECISION REQUIRED` (D-06-6 in [06](./06_BACKEND_ARCHITECTURE.md)): this endpoint is referenced by [07](./07_DATABASE_SCHEMA.md) §16 and by FR-012 / US-006 but is **not specified** in [08](./08_API_SPECIFICATION.md). The recommended shape, to be added to [08](./08_API_SPECIFICATION.md) before it is built:

| Field | Loc | Type | Req | Rules | Error | FR |
| --- | --- | --- | :-: | --- | --- | --- |
| `kind` | body | enum | ✔ | `supplement` \| `correction` | `VALIDATION_FAILED` | FR-012 |
| `text` | body | string \| null | conditional | trimmed 20–2000; required when `media` is empty; stored as a **new** report document — never overwriting `originalText` | `EMPTY_REPORT` (422) | FR-003, FR-012 |
| `media` | body | array | — | same caps as §5.5 (≤ 3 images, ≤ 1 audio, ≤ 3 items) | `VALIDATION_FAILED` | FR-005, FR-006 |

Owner-only, pre-verification, within 2 h of submission (US-006), 10 / h.

---

## 6. Sanitisation policy

The question "strip, reject, or escape?" has one answer per category. Getting this wrong is either a security hole or data loss.

| Category | Policy | Why |
| --- | --- | --- |
| **Incident description (`text`), `summary`, `resolutionNote`, `note`, `location.text`, notification `title`/`body`** | **Stored verbatim. Never stripped, never escaped, never HTML-encoded.** The only transformation applied is the outer trim used for the length check; the stored value is the reporter's exact words | FR-003: "MUST be stored verbatim (no silent rewriting)". Evidence integrity matters more than convenience |
| **Rendering that verbatim text** | **React text interpolation only.** `dangerouslySetInnerHTML` is forbidden anywhere in `app/`, `features/`, `components/` (a lint rule, [20](./20_PROJECT_FOLDER_STRUCTURE.md) §5.1). `{'<'}` renders as text; the DOM contains no element | React escapes by default. This is the entire XSS defence, and it is stronger than escaping because there is nothing to get wrong |
| **Fields that must contain no markup at all** (notification `title`/`body`, `link`) | **Rejected**, not escaped. A `<` or `>` is a `VALIDATION_FAILED` | These are rendered in surfaces that also build HTML-ish affordances and are frequently generated by tooling. Rejecting is unambiguous, and the field is not free text (T-09) |
| **User input used in a URL** (`link`, `placeId`) | **Rejected** unless it matches a strict pattern (`^/[A-Za-z0-9/_-]{1,120}$`; `^[A-Za-z0-9_-]{1,64}$`). No `javascript:`, no absolute URL, no protocol-relative `//` | Prevents an open redirect and a `javascript:` link in a notification |
| **User input used in a Firestore field path or Storage path** | **Never.** `:id` is pattern-checked to an auto-ID, `mediaId` to a fixed prefix, and `storagePath` to a full anchored regex. A path segment is never interpolated from free text | [08](./08_API_SPECIFICATION.md) §12.8 |
| **User input interpolated into a Gemini prompt** | Wrapped in `<citizen_report>` tags, NFKC-normalised, control characters and zero-width/bidi characters stripped, classic override markers defanged, PII redacted, flood-guarded — and treated as data, never as instructions | [09](./09_AI_GEMINI_SPECIFICATION.md) §4.3 |
| **Control characters and zero-width characters in any field** | **Accepted in stored text** (a reporter may genuinely use a line break or a non-Latin script) and **stripped only in the AI-bound copy** | Stripping on write would violate FR-003; the AI copy is where the injection risk lives |
| **SQL, HTML, and shell metacharacters** | No SQL in the project. No shell. HTML is handled by React escaping | — |
| **Line-ending normalisation** | `\r\n` → `\n` **in the AI-bound copy only**. The stored value keeps the original bytes | Keeps the text similarity function and the model's tokenizer sane without touching evidence |

**Why "store verbatim, render as text" is the correct policy for incident descriptions.** An emergency description is evidence and testimony. If we silently strip `<`, normalise whitespace, or rewrite anything, a dispatcher reading the report is no longer reading what the witness wrote, and a later dispute about what was reported cannot be settled. Sanitising on write also produces the worst of both worlds: data loss, plus a false sense of safety, because the dangerous sink is the renderer, not the storage. React's text interpolation makes the stored bytes inert by construction, so the correct place to intervene is the renderer — and the renderer is under our control in every surface, including any future one, because the lint rule forbids the alternative globally. For the two narrow fields where markup is genuinely unwanted and the content is not free text (notification title and body, generated by an admin or by us), rejection is chosen over escaping because a rejected request is visible and debuggable, while an escaped one silently mutates a string a person will read aloud in a control room.

---

## 7. File validation

> Cross-reference: the full storage specification is [15](./15_FILE_STORAGE_SPECIFICATION.md), which may not exist yet. The rules below are the authoritative validation contract and must be mirrored there. The magic-byte table and the signed-URL mechanics belong in [15](./15_FILE_STORAGE_SPECIFICATION.md); the bounds belong here.

### 7.1 Allow-list

| `kind` | Allowed declared types | Enforced env var | Cap |
| --- | --- | --- | --- |
| `image` | `image/jpeg`, `image/png`, `image/webp` | `UPLOAD_MAX_IMAGE_BYTES` = 5 242 880 | 5 MB, ≤ 3 per report |
| `audio` | `audio/webm`, `audio/mp4`, `audio/mpeg` | `UPLOAD_MAX_AUDIO_BYTES` = 15 728 640 | 15 MB, ≤ 1 per report, ≤ 120 s |

Nothing else. No `image/svg+xml` (scriptable), no `application/*`, no `text/*`. A type outside the list is `UNSUPPORTED_MEDIA_TYPE` (415) at `/api/uploads/sign` and again at create.

### 7.2 Magic bytes (sniffed, never declared)

The declared `contentType` is used for the allow-list check only. The **stored** `contentType` is the sniffed one (FR-008).

| Sniffed signature | Detected type | Mismatch result |
| --- | --- | --- |
| `FF D8 FF` | `image/jpeg` | a `.png` declaration with JPEG bytes → `UPLOAD_SIGNATURE_MISMATCH` (415) |
| `89 50 4E 47 0D 0A 1A 0A` | `image/png` | as above |
| `52 49 46 46 … 57 45 42 50` (`RIFF….WEBP`) | `image/webp` | as above |
| `1A 45 DF A3` (EBML) plus a `webm` doc-type string | `audio/webm` | — |
| `….ftyp` box with `isom`/`M4A ` | `audio/mp4` | — |
| `49 44 33` (`ID3`) or `FF FB`/`FF F3`/`FF F2` | `audio/mpeg` | — |
| `4D 5A` (`MZ`), `7F 45 4C 46` (ELF), `50 4B 03 04` (ZIP/office), `7B 5C` | executable / archive / unknown container | `UPLOAD_QUARANTINED` (422) |
| nothing recognised | unknown | `UPLOAD_QUARANTINED` (422) |

Only the first 4 KiB is read (`GET /api/uploads/finalize`, §8.2 of [08](./08_API_SPECIFICATION.md)).

### 7.3 Size, count, and completeness

| Check | Rule | Error |
| --- | --- | --- |
| Declared vs actual size | must differ by ≤ 1 % | `UPLOAD_INCOMPLETE` (409) |
| Zero bytes | rejected | `UPLOAD_INCOMPLETE` (409) |
| Actual over cap | the **actual** size wins over the declaration | `UPLOAD_TOO_LARGE` (413) |
| Count per report | ≤ 3 images, ≤ 1 audio, ≤ 3 total, enforced on the array itself and again after verification | `VALIDATION_FAILED` |
| Staging lifetime | an unclaimed staging object is swept after `STAGING_UPLOAD_SWEEP_MIN` (30) | `UPLOAD_NOT_FOUND` (422) |
| Dimensions | `clientWidth`/`clientHeight` 1–12000 at sign; the server trusts them only as a hint, and the value stored is what the client declared with `width`/`height` recorded for display | `VALIDATION_FAILED` |

### 7.4 Path rules

| Rule | Pattern | Enforced where |
| --- | --- | --- |
| Staging path | `^staging/[A-Za-z0-9_-]{1,128}/med_[A-Za-z0-9]{2,32}\.(jpg\|jpeg\|png\|webp\|webm\|mp4\|mp3\|m4a)$` | `POST /api/incidents` |
| Final path | `^incidents/[A-Za-z0-9]{20}/(reports\|supplements)/[A-Za-z0-9]{2,}/[A-Za-z0-9_.-]+$` | `POST /api/incidents` (re-upload) |
| Ownership | the first path segment after `staging/` must be the token uid | `UPLOAD_FORBIDDEN_PATH` (403) |
| Extension vs sniffed type | must agree (`.jpg` ↔ JPEG, etc.); a `.jpg` holding PNG bytes is a mismatch, not a rename | `UPLOAD_SIGNATURE_MISMATCH` (415) |
| No traversal | `..`, `/./`, `%2e`, a double slash, or a null byte anywhere in the path is rejected before Storage is touched | `UPLOAD_FORBIDDEN_PATH` (403) |
| Quarantine | a quarantined object is moved to `quarantine/{mediaId}.{ext}` and is never attachable | `UPLOAD_QUARANTINED` (422) |

---

## 8. Geospatial validation

### 8.1 Coordinate rules

| Field | Range | Applies to | Error |
| --- | --- | --- | --- |
| `lat` | `-90 … 90` inclusive | incident, responder heartbeat, `homeBase`, `center` | `LOCATION_OUT_OF_RANGE` (400) |
| `lng` | `-180 … 180` inclusive | same | `LOCATION_OUT_OF_RANGE` (400) |
| `accuracyM` (incident) | `0 … 1000` | `POST/PATCH /api/incidents` | `VALIDATION_FAILED` `too_big` |
| `accuracyM` (heartbeat) | `0 … 5000` | `PATCH /api/responders/:id/location` | `VALIDATION_FAILED` `too_big` |
| `radiusM` (duplicate-style view) | `1 … 2000` | `GET /api/incidents` | `VALIDATION_FAILED` `too_big` |
| `radiusM` (ranking, directory, analytics) | `1 … 20000` | candidates, responders, analytics | `VALIDATION_FAILED` `too_big` |
| `serviceRadiusM` | `500 … 50000` | `PATCH /api/responders/:id` | `VALIDATION_FAILED` |
| `headingDeg` | `0 ≤ h < 360` | heartbeat | `VALIDATION_FAILED` |
| `speedMps` | `0 … 120` | heartbeat | `VALIDATION_FAILED` |
| `center` query | `"lat,lng"`, exactly one comma, both in range, no whitespace-only parts | any `center` query | `VALIDATION_FAILED` `invalid_format` |

`accuracyGrade` is **derived, never supplied**: `high ≤ 50`, `medium ≤ 200`, `low ≤ 1000`, `unknown` otherwise (FR-032). A client that sends `accuracyGrade` gets `unrecognized_keys`.

### 8.2 `source` semantics

| `source` | `lat`/`lng` | `accuracyM` | `text` | `placeId` | Meaning |
| --- | --- | --- | --- | --- | --- |
| `gps` | required, non-null | required, 0–1000 | `null` | `null` | device fix |
| `manual_pin` | required, non-null | required, 0–1000 | optional | optional | a dispatcher or citizen dropped a pin (FR-033) |
| `address_text` | required, non-null | `null` ⇒ `unknown` | **required**, 3–200 chars | `null` | typed address; reverse-geocoded server-side (FR-035) |
| `none` | must be `null` | must be `null` | must be `null` | must be `null` | unknown location; the incident is flagged `LOCATION UNKNOWN` in every dispatcher view and sorts above `low` accuracy (FR-034) |

### 8.3 Anti-far-tampering — flag, do not reject

A device can be spoofed, and a phone in the wrong hemisphere is more often a bug than an attack. The system therefore **validates plausibility but never rejects on it**:

| Signal | Threshold | Action |
| --- | --- | --- |
| `source: 'gps'` with `accuracyM` exactly `0` | `accuracyM < 1` | Add `low_confidence` to the AI view; set `geo.accuracyGrade` to `unknown` regardless of the other rules; record `farTamperSuspected: true` in the `statusHistory` `created` event `metadata` |
| `source: 'gps'` with `accuracyM: 0` **and** a point more than 50 km from the reporter's previous known fix, or from the coarse `APP_TIMEZONE` locality when one exists | > 50 km jump | Add the `unclear_location` safety flag (R6) and force `aiNeedsReview`; the incident is still created |
| `source: 'gps'` with `accuracyM` 1–1000 but a point in the ocean on a precision-6 cell that contains no land anywhere within 25 km | heuristic | `GEOCODE_FAILED` is recorded; `placeName` stays `null`; the incident is created |
| Coordinate exactly `0,0` | `lat === 0 && lng === 0` | Treated as **valid** coordinates (a real place) but the dispatcher UI shows "Location looks unusual" — some devices emit `0,0` as a null fix |

> The rule is: **a report is never lost because its location looks wrong.** Location quality affects ranking, confidence, and the "needs review" badge; it does not gate the write. A rejected report is a lost emergency, and no amount of geospatial tidiness is worth that risk. This is why `LOCATION_OUT_OF_RANGE` is limited to *impossible* values (out of the coordinate domain) and not to *implausible* ones.

### 8.4 Manual pin vs GPS

| | GPS | Manual pin |
| --- | --- | --- |
| Trust | The device's `latitude/longitude/accuracy` | A lat/lng chosen by a human on a map |
| `accuracyGrade` | derived from `accuracyM` | always `unknown` unless the map reports a precision, in which case it is derived the same way |
| `placeId` | `null` | present when the pin resolved to a Google place |
| `text` | `null` | optional, 3–200 chars |
| Deduplication | identical | identical — a manual pin at the same coordinates produces the same `geoCells` and participates in duplicate detection normally |
| Trust signal shown in the UI | "GPS, accurate to 34 m" | "Pin dropped by a person" |

A dispatcher moving a pin sets `source: 'manual_pin'` and forces `urgencySource`/triage flags to `human` in the audit trail, because a human has now overridden the evidence ([07](./07_DATABASE_SCHEMA.md) §4.3).

### 8.5 Geohash

`geoCells` is **server-computed only** (FR-036) and is never accepted from a client — an `incidents.geoCells` key in a request body is `unrecognized_keys`. Each entry matches `/^[0-9b-hjkmnp-z]{6}$/` and the array is exactly 10 entries ([07](./07_DATABASE_SCHEMA.md) §9.2). Any duplicate-candidate query that receives a `geoCells` value from anywhere other than `lib/geo/geo-cells.ts` is a bug.

---

## 9. Query parameters

| Aspect | Decision | Justification |
| --- | --- | --- |
| Unknown parameters | **Rejected** with `unrecognized_keys` → 400 | A silently-ignored filter is a filter that is not applied. `?staus=verified` in a dispatcher queue returns unverified incidents while the UI shows a "verified" chip. In an emergency queue, a wrong result set is worse than an error |
| Repeated parameters | **Accepted** for enum filters (`status`, `urgency`, `category`, `type`, `action`, `entityType`, `verification`) and for `requiredResourceId` | Dispatcher filter bars naturally produce repeats; the alternative (a comma list only) breaks with any value containing a comma, and our enums have none |
| Comma-separated values | **Accepted** for the same enums, and for `include`, `expand` | Convenience for hand-written URLs and CSV exports |
| Mixed repeated + comma | **Merged and de-duplicated**; the resulting count is bounds-checked | — |
| Booleans | `true`/`false`/`1`/`0` only; a tri-state enum where `any` exists (`verified`) | `"yes"`, `"on"`, `""` are rejected rather than guessed |
| Numbers | `Number(value)`, then integer/bounds check; `1e3` is accepted as `1000`; `1,000` is rejected; `Infinity`/`NaN` are rejected | A locale-formatted number in a URL is a client bug |
| Dates | ISO-8601 only. `from`/`to` on incident and dispatch lists accept a full datetime; `from`/`to` on analytics accept `YYYY-MM-DD` day buckets in `APP_TIMEZONE` | Analytics buckets are day-aligned local dates ([07](./07_DATABASE_SCHEMA.md) §11.7); mixing a datetime there would silently shift a bucket |
| Empty value | `?q=` is `VALIDATION_FAILED` `too_short`, not "no filter" | An empty box that clears a filter should omit the parameter, not send an empty one |
| Duplicate scalar parameter | Last value wins **except** for enum arrays, which merge | — |
| Array length cap | enum arrays ≤ 12, `ids` ≤ 200, `expand` ≤ 6 | Prevents a URL that builds an unindexable Firestore `in` clause (30-value limit) |
| `recipientUid` on notification reads | **Not a parameter at all** | FR-103. Rejected as an unknown key |
| Page size | `limit`, default per route, max 100, clamped (§4.1) | FR-121 |

---

## 10. Rate limits and request size as validation

These are enforcement rather than schema rules, but they bound the cost of malformed input, so they are specified here too.

| Control | Value | Where | Interaction with validation |
| --- | --- | --- | --- |
| JSON body size | 1 MB default (`maxBytes` on `parseJsonBody`) | every body route | Checked **before** parsing, so a 4 MB body costs one length comparison |
| Evidence bytes | 0 bytes through the function | direct-to-Storage | FR-007, DEC-08. The 4.5 MB Vercel limit is never reached |
| Rate limit | per [08](./08_API_SPECIFICATION.md) §1.9 | `lib/api/ratelimit.ts` | Runs **before** Zod, so a burst of malformed requests consumes one bucket entry each and no database query beyond the bucket itself |
| Bucket key | `sha256(subject + '\|' + routeKey + '\|' + windowBucket)` | — | Keyed on the **route class**, not on the params, so an attacker cannot create unlimited buckets by varying `cursor` or `status` |
| `POST /api/incidents` | 5 / h **and** 20 / 24 h | FR-015 | Both rules evaluated; the failing one sets `Retry-After` |
| Heartbeat | 120 / h plus a 20 s `capturedAt` floor | FR-066 | The floor is a **field** rule (§5.22), not just a bucket |
| Cron route | 10 / IP / h | FR-135 | Prevents a misconfigured scheduler from flooding |
| `q` tokens | ≤ 3 per search | FR-070 | Bounds the `array-contains` fan-out behind the free-text search |
| Cursor token | ≤ 512 chars, base64url | FR-121 | A hostile cursor cannot become a document ID of arbitrary length |
| `includeDeleted` / `include=risk` | feature-gated | FR-123, FR-114 | Cheaper than a 403 from the database and produces a better message |
| Analytics span | ≤ 365 days | FR-116 | Rejected before the rollup window is computed |
| Export `ids` | ≤ 200 | FR-118 | Matches the `writeBatch`/CSV memory ceiling |

---

## 11. The validation error response

### 11.1 Shape

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the details you entered need attention.",
    "details": [
      { "field": "text",                     "issue": "too_short" },
      { "field": "media[1].sizeBytes",       "issue": "too_big", "value": { "max": 5242880 } },
      { "field": "location.lat",             "issue": "too_small" },
      { "field": "reportedAt",               "issue": "in_future" },
      { "field": "role",                     "issue": "unrecognized_keys" }
    ],
    "requestId": "req_7Kd2mQ9xL4n"
  }
}
```

### 11.2 `field` formatting rules

| Source | `field` |
| --- | --- |
| Top-level object key | `text` |
| Nested object | `location.lat`, `location.text` |
| Array element | `media[1].sizeBytes` (1-based, matching what the user sees) |
| Array of objects | `notifPrefs.sms` |
| Root-level failure (whole body) | `body` |
| Query parameter | the parameter name, e.g. `limit`, `sort` |
| Path parameter | `id`, `job`, `mediaId` |
| Header | the header name, e.g. `Idempotency-Key` |
| An absent optional key that failed `required_for_*` | the key that should have been present, e.g. `resolutionCode` |

### 11.3 `issue` vocabulary

| `issue` | Raised by | Client presentation |
| --- | --- | --- |
| `invalid_type` | wrong JSON type | inline, generic |
| `required` | a missing required key | inline, generic |
| `too_small` / `too_big` | numeric or length bound | inline, specific (uses `value.min` / `value.max`) |
| `not_integer` | `1.5` for a page size | inline |
| `invalid_format` | regex failure | inline, specific |
| `invalid_enum_value` | a value outside the closed set | inline: "Choose one of the listed options." |
| `unrecognized_keys` | an unknown key in a strict object | inline on the form, plus a `console.warn` in development naming the key — a client sending `role` is a security-relevant bug, and it should be loud |
| `invalid_json` | `JSON.parse` failure | form-level banner |
| `empty_update` | a PATCH with no recognised field | form-level banner |
| `forbidden_field` / `forbidden_param` / `forbidden_for_kind` | a field this caller may not set | inline, with a "this option is not available to your role" message |
| `required_for_source` / `required_for_status` / `required_for_kind` / `required_for_type` / `required_for_sort` | cross-field rules (§4) | inline on the field that must change |
| `must_be_null` | a field that must be null for the chosen `source` | inline |
| `invalid_range` / `span_too_large` | `from`/`to` | inline on `to` |
| `too_old` / `in_future` | datetime bounds | inline |
| `must_differ` | self-merge | inline |
| `too_many_items` / `too_many_images` / `too_many_audio` / `too_many_tokens` | array caps | inline |
| `invalid_combination` | a `superRefine` failure with no more specific code | inline on the first offending field |
| `feature_disabled` | a flag-gated capability | toast; the control is disabled with the reason as helper text |

`value` carries only the bound that was violated (`{ min: 20 }`, `{ max: 2000 }`, `{ max: 5242880 }`) or a documented conflict object (§1.5 of [16](./16_ERROR_HANDLING.md)). It never echoes the rejected input, except for the conflict codes where the current server state is genuinely useful (`{ from, to, allowed }`).

---

## 12. i18n of validation messages

**v1 is English only** ([01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) §9). The structure is nevertheless built for translation from day one.

| Layer | Language | What it holds |
| --- | --- | --- |
| `issue` (Zod issue code + our cross-field codes) | **Language-neutral** | A stable machine token. Never translated. |
| `field` (dotted path) | **Language-neutral** | A path into the request. Never translated. |
| The English sentence | Localisable | Derived from `issue` + `value` via `validators/messages.ts` |
| UI labels, buttons, headings | Localisable | `features/*/copy.ts` |

```ts
// validators/messages.ts
export const MESSAGES: Record<IssueCode, string | ((p: Bounds) => string)> = {
  too_short: ({ min }) => `We need at least ${min} characters.`,
  too_big:   ({ max }) => `That is longer than we can accept. The limit is ${max}.`,
  // …
};
```

The resolution point is one function, `lib/api/validate.ts` → `resolveMessage(issue, value)`, so a future `messages/{locale}.json` keyed by `issue` replaces one file. The **response envelope does not change shape** when that happens: only the human string differs, and the `issue` and `field` a client branches on stay identical. A locale is selected by `Accept-Language` on the server **and** by the client bundle, and a missing translation falls back to English rather than showing a raw code. UI-side field errors use the same table through the same function, so an inline message and a toast can never disagree.

---

## 13. Test matrix

Every numeric bound in this document has at least one test. `tests/unit/validators/*.test.ts` unless noted.

| Rule | Test | Type | Assertion |
| --- | --- | --- | --- |
| `text` 19 / 20 / 2000 / 2001 chars | `incident.test.ts` | unit | 19 → `too_short`; 20 → pass; 2000 → pass; 2001 → `too_big` |
| `text` is stored verbatim | `create-incident.test.ts` | integration | leading/trailing spaces preserved in the stored document; inner whitespace preserved |
| `text` only whitespace | same | unit | trims to 0 → `too_short` |
| empty report, no media | same | integration | `EMPTY_REPORT`, 422 |
| 4 images / 2 audio / 4 items | same | unit | `too_many_images` / `too_many_audio` / `too_many_items` |
| image 5 242 880 / 5 242 881 bytes | same | unit | pass / `UPLOAD_TOO_LARGE` |
| audio 15 728 640 / 15 728 641 | same | unit | pass / `UPLOAD_TOO_LARGE` |
| `durationSec` 120 / 121 | `upload.test.ts` | unit | pass / `too_big` |
| `durationSec` on an image | same | unit | `forbidden_for_kind` |
| `clientWidth` 1 / 12000 / 12001 | same | unit | pass / pass / `too_big` |
| `contentType` mismatch per kind | same | unit | `UNSUPPORTED_MEDIA_TYPE` |
| `intent: 'sms'` | same | unit | `invalid_enum_value` (FR-009) |
| staging path of another uid | same | integration | `UPLOAD_FORBIDDEN_PATH`, 403 |
| `..` in the path | same | unit | `UPLOAD_FORBIDDEN_PATH` |
| `.png` extension with JPEG bytes | `finalize-upload.test.ts` | integration | `UPLOAD_SIGNATURE_MISMATCH`, 415, `scanStatus: 'quarantined'` |
| `MZ` header (executable) | same | integration | `UPLOAD_QUARANTINED`, 422 |
| 0-byte object | same | integration | `UPLOAD_INCOMPLETE`, 409 |
| actual vs declared ±1 % boundary | same | integration | 0.9 % → pass; 1.1 % → `UPLOAD_INCOMPLETE` |
| expired staging object (31 min) | same | integration | `UPLOAD_NOT_FOUND`, 422 |
| `lat` −90 / 90 / 90.1 | `geo.test.ts` | unit | pass / pass / `LOCATION_OUT_OF_RANGE` |
| `lng` −180 / 180 / 180.1 | same | unit | pass / pass / `LOCATION_OUT_OF_RANGE` |
| `accuracyM` 0 / 1000 / 1001 (incident) | same | unit | pass / pass / `too_big` |
| `accuracyM` 0 / 5000 / 5001 (heartbeat) | same | unit | pass / pass / `too_big` |
| `accuracyGrade` derived at 50 / 51 / 200 / 201 / 1000 / 1001 | `accuracy-grade.test.ts` | unit | `high`/`medium`/`medium`/`low`/`low`/`unknown` (FR-032) |
| `source: 'none'` with a coordinate | `geo.test.ts` | unit | `must_be_null` |
| `source: 'address_text'` without text | same | unit | `required_for_source` |
| `source: 'gps'` without coordinates | same | unit | `required_for_source` |
| `reportedAt` −23 h / −25 h | `incident.test.ts` | unit | pass / `too_old` |
| `reportedAt` +4 min / +6 min | same | unit | pass / `in_future` |
| `capturedAt` +59 s / +61 s | `responder.test.ts` | unit | pass / `in_future` |
| `capturedAt` 19 s / 21 s after the stored value | `location-heartbeat.test.ts` | integration | `HEARTBEAT_TOO_FREQUENT`, 429, `Retry-After` |
| `phone` `+919876543210` / `919876543210` / `+0919876543210` | `responder.test.ts` | unit | pass / `invalid_format` / `invalid_format` |
| `serviceRadiusM` 499 / 500 / 50000 / 50001 | same | unit | `too_small` / pass / pass / `too_big` |
| `capabilities` with an unknown `resourceId` | same | integration | `INVALID_CAPABILITY`, 422 |
| `verification` in `PATCH /api/responders/:id` | same | unit | `forbidden_field` |
| `role` / `status` in `PATCH /api/me` | `me.test.ts` | unit | `unrecognized_keys` |
| `role` / `assigneeUid` in `POST /api/incidents` | `incident.test.ts` | unit | `unrecognized_keys` (the anti-bribe test) |
| `status: 'resolved'` without `resolutionCode` | same | unit | `required_for_status` |
| `resolutionCode` with `status: 'en_route'` | same | unit | `not_allowed_for_status` |
| `resolutionCode: 'fixed'` | same | unit | `invalid_enum_value` → `INVALID_RESOLUTION_CODE`, 400 |
| `reason` 9 / 10 / 280 / 281 chars | `admin.test.ts` | unit | `REASON_REQUIRED` / pass / pass / `too_big` |
| `primaryIncidentId === :id` | `duplicates.test.ts` | integration | `SELF_MERGE_NOT_ALLOWED`, 400 |
| `limit` 0 / 1 / 100 / 101 / `"abc"` / `""` | `query.test.ts` | unit | `not_integer` / pass / pass / clamped to 100 / `invalid_type` / `invalid_type` |
| **only one clamp exists** | `query.test.ts` | unit | a static assertion that the validator modules contain exactly one clamp site |
| `from` > `to` | same | unit | `invalid_range` |
| span 365 d / 366 d | same | unit | pass / `span_too_large` |
| `sort=distance` without `center` | `incident.test.ts` | integration | `CURSOR_COMBINATION_INVALID`, 400 |
| `center` `"17.44,78.48"` / `"17.44"` / `"91,0"` | `geo.test.ts` | unit | pass / `invalid_format` / `invalid_format` |
| `radiusM` 2000 / 2001 (incidents) | `incident.test.ts` | unit | pass / `too_big` |
| `radiusM` 20000 / 20001 (candidates) | `dispatch.test.ts` | unit | pass / `too_big` |
| `q` 60 / 61 chars | `query.test.ts` | unit | pass / `too_long` |
| `q` with 3 / 4 tokens | same | unit | pass / `too_many_tokens` |
| unknown query param `staus` | same | integration | `unrecognized_keys`, 400 |
| `verified=maybe` | same | unit | `invalid_enum_value` |
| `includeDeleted=true` as a citizen | `incident.test.ts` | integration | `FORBIDDEN`, 403 |
| `recipientUid` on `GET /api/notifications` | `notification.test.ts` | unit | `unrecognized_keys` |
| `recipientUid` in a URL query | same | integration | `unrecognized_keys`, 400 |
| `unread` filter | same | integration | only unread returned |
| notification `title` 90 / 91 chars | same | unit | pass / `too_big` |
| notification `title` with `<b>` | same | unit | `invalid_format` (rejected, not escaped) |
| notification `link` `/incidents/abc` vs `https://evil` | same | unit | pass / `invalid_format` |
| `read-all` with 200 / 201 matches | same | integration | pass / `BATCH_TOO_LARGE`, 422 |
| `types` with an unknown type | same | unit | `invalid_enum_value` |
| analytics span 365 / 366 d | `analytics.test.ts` | unit | pass / `span_too_large` |
| `granularity=week` bucket alignment | same | unit | ISO weeks, Monday start |
| `include=risk` with the flag off | same | integration | `RISK_DISABLED`, 422 |
| `format=csv` | same | integration | `text/csv`, `Content-Disposition` present |
| `duplicateRadiusM` 99 / 100 / 2000 / 2001 | `config.test.ts` | unit | `too_small` / pass / pass / `too_big` |
| `duplicateTimeWindowMin` 59 / 60 / 4320 / 4321 | same | unit | `too_small` / pass / pass / `too_big` |
| `textSimilarityConfirm` 0.19 / 0.2 / 0.9 / 0.91 | same | unit | `too_small` / pass / pass / `too_big` |
| `duplicatePotentialThreshold` 0.19 / 0.2 / 0.95 / 0.96 | same | unit | bounds |
| `slaMinutes.critical` 0 / 1 / 1440 / 1441 | same | unit | bounds |
| `retention.auditDays` 364 / 365 | same | unit | `too_small` / pass (FR-136) |
| an env-sourced key in the config patch | same | unit | `unrecognized_keys` |
| a config patch with 4 bad fields | same | integration | **all four** reported in one response (US-033 AC3) |
| `job=unknown-job` | `admin.test.ts` | unit | `invalid_enum_value` |
| maintenance with the flag off | same | integration | `MAINTENANCE_DISABLED`, 422, **after** validation |
| `:id` 19 / 20 / 21 chars | `params.test.ts` | unit | `invalid_format` / pass / `invalid_format` |
| `:id` 20 chars but non-existent | `incident.test.ts` | integration | 400 vs 404 distinction |
| `:mediaId` without the `med_` prefix | `upload.test.ts` | unit | `invalid_format` |
| `Idempotency-Key` 64 / 65 chars | `incident.test.ts` | integration | pass / `VALIDATION_FAILED` |
| malformed JSON body | same | integration | `invalid_json`, 400 — **not** 500 |
| body over 1 MB | same | integration | `field: "body"`, 400 |
| `Content-Type: text/plain` with a JSON body | same | integration | parsed and validated normally |
| **Zod runs before any DB call** | `tests/integration/api/assertions.ts` | integration | with Firestore stubbed to throw if touched, a malformed body still returns 400 (FR-142) |
| a non-privileged caller sending `skipTriage` | `incident.test.ts` | integration | `forbidden_field`, 400 |
| a dispatcher sending `skipTriage` | same | integration | accepted, `triageSource: 'manual'`, `aiConfidence: 0` |
| a responder sending any field to `PATCH /api/incidents/:id` | same | integration | `forbidden_field` |
| an empty PATCH body | same | integration | `empty_update`, 400 |
| `geoCells` in any request body | same | unit | `unrecognized_keys` (server-computed only, FR-036) |
| `accuracyGrade` in a request body | `geo.test.ts` | unit | `unrecognized_keys` (derived, FR-032) |
| `slaState` in a request body | `incident.test.ts` | unit | `unrecognized_keys` (derived) |
| `aiNeedsReview` in a request body | same | unit | `unrecognized_keys` (derived) |
| `x-request-id` valid / hostile | `context.test.ts` | integration | honoured when `/^[A-Za-z0-9_-]{8,64}$/`; otherwise regenerated |
| every code in [16](./16_ERROR_HANDLING.md) §3 is reachable or documented as internal | `errors.test.ts` | unit | the catalogue and the client table are identical, and no code is unreferenced |

---

## 14. Anti-patterns — forbidden

| # | Anti-pattern | Why it is forbidden | Instead |
| ---: | --- | --- | --- |
| 1 | **Validating only on the client** | The client is the attack surface. NFR-015 | The same schema on the server, in every route, before any side effect |
| 2 | `z.any()` | Disables the schema. NFR-022 forbids `any` | `z.unknown()` + `superRefine`, or a concrete type |
| 3 | `.passthrough()` on an input schema | An unknown key reaches the domain layer, so `role` or `status: 'verified'` can be smuggled in | `.strict()` |
| 4 | **Validating after a side effect** | A malformed request has already written, notified, or charged a rate-limit token | Pipeline step 7 before step 9 ([06](./06_BACKEND_ARCHITECTURE.md) §3.1) |
| 5 | Silently coercing a bad enum to a default (`z.enum([...]).catch('other')`) | A filter for `urgency=critical` that quietly becomes `other` shows a dispatcher the wrong queue | Reject. `catch()` on an enum is banned; `category` is mapped to `other` **only** by the AI rules, where it is recorded in `categoryRaw` (FR-025) |
| 6 | `JSON.parse` without `try/catch` | A truncated body is a 500 instead of a 400 | `parseJsonBody` wraps it and returns `invalid_json` |
| 7 | **Trusting the `Content-Type` header** for behaviour | A client controls it | Parse the body as JSON when the route expects JSON; treat a mismatch as a hint, not a contract. Reject only `multipart/form-data` on a JSON route |
| 8 | Trusting a declared `contentType` | FR-008 exists precisely because it is forgeable | Magic bytes win; the declared type is only allow-list-checked |
| 9 | Trusting a declared `sizeBytes` | Same | The measured object size wins (FR-008) |
| 10 | Validating only `params` or only `body` | A hostile query string is still input | `parseParams` + `parseSearchParams` + `parseJsonBody`, all three |
| 11 | Interpolating user input into a Firestore field path or Storage path | Path traversal, or reading another user's evidence | Anchored regexes and prefixes (§7.4) |
| 12 | Trimming, escaping, or "cleaning" `text` on write | Violates FR-003 and destroys evidence | Store verbatim; render as React text |
| 13 | `dangerouslySetInnerHTML` anywhere | Converts stored verbatim text into an XSS sink | React text interpolation; a lint rule forbids the alternative |
| 14 | Rejecting a report because its **location** looks implausible | A rejected report is a lost emergency | Flag it (§8.3) and create the incident |
| 15 | Rejecting a report because the **AI** failed | FR-029 | Fallback, `low_confidence`, "needs review" |
| 16 | Rejecting the whole submission because one media item failed | A citizen with two good photos and one bad file still has an emergency | Per-item `details`, continue, `EMPTY_REPORT` only if nothing is left |
| 17 | A `limit` above `max` accepted silently without an echo | The client cannot tell its page is smaller than requested | The single documented clamp, echoed in `data.page.limit` plus `meta.limitClamped` |
| 18 | More than one clamp anywhere in `validators/` | "Clamp quietly" spreads | A unit test asserts exactly one clamp site |
| 19 | Silently dropping an unknown query parameter | A filter that is not applied | Reject (US-005-class harm) |
| 20 | A `catch` that repairs a value into range | The user did not choose that value | Reject |
| 21 | Validating a stored enum on read to "protect" the database | Reads are already typed by the serialiser; a re-parse on every read costs CPU on every list | Validate on write; on read, narrow with a type guard and log an anomaly |
| 22 | Returning the rejected value in `details[].value` | Feeds the client the shape of the closed set and, for text fields, the user's own input back into a place it may be logged | `value` carries bounds or documented state only (§1.5 of [16](./16_ERROR_HANDLING.md)) |
| 23 | `Infinity`/`NaN` passing a `.max()` check | `NaN` comparisons are always false, so `z.number().max(5)` does not reject `NaN` | An explicit `Number.isFinite` guard in `boundedInt` |
| 24 | A schema defined in a route file | It cannot be shared with the client form, and it will drift | `validators/<domain>.ts`, referenced by both ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §5.1) |
| 25 | A second copy of an enum literal list | Enums drift and filters break silently ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §5.1.6) | `validators/enums.ts` only |
| 26 | A regex built by string interpolation from user input | A ReDoS and an injection vector | Only the static patterns in §2.1, with a length cap before the match |

---

## 15. Open decisions carried by this document

| ID | Decision needed | Why it is open | Recommendation |
| --- | --- | --- | --- |
| D-17-1 | Text-similarity threshold: FR-043 says "threshold 0.45 default"; [07](./07_DATABASE_SCHEMA.md) §9.5 gives `textSimilarityConfirm` default `0.60` | Two different defaults in two normative documents | `0.60` is what the pseudocode in [07](./07_DATABASE_SCHEMA.md) §9.4 implements and is the stricter, safer value. Amend FR-043 to say 0.60. The **validation range is 0.2–0.9** in both readings |
| D-17-2 | `UPLOAD_INVALID_SIGNATURE` (US-002 AC5) vs `UPLOAD_SIGNATURE_MISMATCH` ([08](./08_API_SPECIFICATION.md) §3.1) | Two codes for one condition | `UPLOAD_SIGNATURE_MISMATCH`, 415. Amend US-002 AC5 |
| D-17-3 | `VALIDATION_EMPTY_REPORT` (FR-002) vs `EMPTY_REPORT` ([08](./08_API_SPECIFICATION.md) §3.1, 422) | Two codes for one condition | Emit `EMPTY_REPORT`; amend FR-002 |
| D-17-4 | A non-privileged caller sending `skipTriage: true` — `400 VALIDATION_FAILED` (`forbidden_field`) or `403 FORBIDDEN`? | [08](./08_API_SPECIFICATION.md) §3.1 does not say | `400` + `forbidden_field`, because the field is invalid **for that caller** and the message is more actionable than a generic permission denial. Document in [08](./08_API_SPECIFICATION.md) §3.1 |
| D-17-5 | The "7 active statuses" of [07](./07_DATABASE_SCHEMA.md) §12.1 vs the 6-value default set in [08](./08_API_SPECIFICATION.md) §3.2 | The seventh status is not named | The seventh is `resolved` (still visible on the map while awaiting closure). Name it in [07](./07_DATABASE_SCHEMA.md) §12.1 and keep the queue default at the 6 active statuses |
| D-17-6 | `UPLOAD_SIGNATURE_MISMATCH` is `415` in [08](./08_API_SPECIFICATION.md) §3.1 and `POST /api/uploads/finalize`, while `UPLOAD_QUARANTINED` is `422` | The distinction between "declared type is not allowed" and "bytes are not a permitted file" is subtle | Keep 415 for a declared type outside the allow-list and for a type/bytes disagreement; keep 422 for bytes that indicate an executable or archive. No change needed, but record it so the two are not "harmonised" later by mistake |
| D-17-7 | Unstated pagination defaults for `GET /api/admin/users` and `GET /api/admin/responders` | [08](./08_API_SPECIFICATION.md) §10 lists `limit` and `cursor` without a default | 25 / max 100, consistent with every other list route. Amend [08](./08_API_SPECIFICATION.md) §10 |
| D-17-8 | `retention.locationPurgeDays` below 90 | NFR-028 requires ≥ 90 days; [07](./07_DATABASE_SCHEMA.md) §11.8 has no lower bound | Reject values below 90 in the admin config schema. An admin who genuinely needs a shorter retention is making a privacy decision that should be a code change, not a slider |
| D-17-9 | `capturedAt` past bound on the heartbeat | [08](./08_API_SPECIFICATION.md) §4.4 bounds only the future (+60 s) | Add a 15-minute past bound (`too_old`) so a device with a wrong clock cannot pin a responder as "not stale" for hours. This is an addition to the documented rule and needs amending into [08](./08_API_SPECIFICATION.md) §4.4 |
| D-17-10 | `POST /api/incidents/:id/reports` is not in [08](./08_API_SPECIFICATION.md) | FR-012 and US-006 need it; §5.56 gives the recommended shape | Add it to [08](./08_API_SPECIFICATION.md) §3 and §11 before building |
| D-17-11 | The reference alphabet | [07](./07_DATABASE_SCHEMA.md) §4.1 says "6 base32 chars" without naming the alphabet | Crockford base32 (no `I`, `L`, `O`, `U`), consistent with the worked examples. Record the constant in [07](./07_DATABASE_SCHEMA.md) |
| D-17-12 | `mid` vs `until` names for range bounds | `from`/`to` on incidents, dispatches, audit, users; `from`/`to` as `YYYY-MM-DD` on analytics | Keep as is. The analytics route's day-bucket semantics are the important distinction and are already documented in §5.35 |
| D-17-13 | Whether `q` should cap at 3 tokens or silently use the first 3 | [08](./08_API_SPECIFICATION.md) §3.2 says "capped at 3 tokens" without saying what happens at 4 | Reject at 4 (`too_many_tokens`) so a search that is not doing what the user asked is visible rather than quietly partial |
| D-17-14 | The `Vary`/cache policy for `GET /api/config` | It is not user-specific, so `no-store` is not obviously required, but [08](./08_API_SPECIFICATION.md) §12.12 requires `no-store` for user-specific payloads only | `no-store` for v1 anyway. The config document can contain tenant-specific values later, and a stale SLA target in a browser cache is a worse failure than a few extra bytes |

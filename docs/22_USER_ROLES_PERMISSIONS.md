# 22 — User Roles & Permissions

**Project:** CareGrid AI
**Status:** Baseline v1.0 — normative for the permission matrix, role assignment, and enforcement
**Related:** [01 PRD §4](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md), [10 Authorization & Security](./10_AUTHORIZATION_SECURITY.md), [07 Database Schema §13](./07_DATABASE_SCHEMA.md)

---

## 1. Roles

| Role | Firebase claim value | What they are | How they get it |
| --- | --- | --- | --- |
| **Citizen** | `citizen` | A member of the public reporting or viewing an incident | Default on sign-up |
| **Responder** | `responder` | Registered, admin-verified volunteer relief worker | `admin` sets `users/{uid}.role = 'responder'`; responder is `pending_verification` until `responders/{uid}.verification = 'verified'` |
| **Dispatcher** | `dispatcher` | Emergency operations staff working the incident queue | `admin` role change, reason required (FR-133) |
| **Administrator** | `admin` | Platform owner with user, responder, config, and audit control | Bootstrapped manually; never self-assignable |

Supporting non-role attributes (they are **not** roles):

| Attribute | Values | Meaning |
| --- | --- | --- |
| `users.status` | `active`, `pending_verification`, `suspended`, `disabled` | Account-level gate, orthogonal to role |
| `responders.verification` | `unverified`, `pending`, `verified`, `rejected` | Responder-specific gate; `verified` is required for assignment (FR-064) |
| `responders.status` | `available`, `busy`, `offline` | Availability, not authority |

`status != 'active'` ⇒ **every** API call except `POST /api/me/bootstrap` and `GET /api/me` returns `403 ACCOUNT_UNAVAILABLE`.

---

## 2. The authoritative role source (NFR-015)

> **The client can never grant, change, or assert a role. Roles live in `users/{uid}.role` and are read on the server from the Admin SDK on every request. The Firebase Auth custom claim is a *mirror* used only by Security Rules.**

```
                      ┌────────────────────────────────────────────┐
  client ──ID token──►│ requireUser()                              │
                      │  1. verifyIdToken(token)                   │
                      │  2. db.get(users/{uid})                    │
                      │  3. role = userDoc.role   ◄── AUTHORITATIVE│
                      │  4. if (token.claims.role !== role) →      │
                      │        403 ROLE_MISMATCH + audit          │
                      │  5. if (userDoc.status !== 'active') →     │
                      │        403 ACCOUNT_UNAVAILABLE             │
                      └────────────────────────────────────────────┘
```

| Rule | Detail |
| --- | --- |
| Server authority | `users/{uid}.role` — read fresh per request, not from the token |
| Claim mirror | `setCustomUserClaims({ role })` after a role change, best-effort, with a pending-marker retry |
| Drift detection | A claim/role mismatch is a `403`, not a silent override. It is audited as `auth.role_mismatch` |
| Client affordance | `GET /api/me` returns a **server-computed** `permissions[]` array. The UI renders buttons from it. The API re-checks every action regardless |
| Never trust | A role sent in a request body, query string, header, or custom header has **no effect** |
| No caching of role in `localStorage` | Role is read from the token/claims only; the authoritative check is server-side |

---

## 3. Permission matrix — capabilities

`●` full · `◐` scoped/conditional · `○` read-only, redacted · `—` denied

| # | Capability | Citizen | Responder | Dispatcher | Admin | FR |
| --- | --- | :-: | :-: | :-: | :-: | --- |
| **Reporting** |
| 1 | Create incident | ● | ● | ● | ● | FR-001 |
| 2 | Add supplement to own incident | ● | ● | ● | ● | FR-012 |
| 3 | Cancel own incident before verification | ● | ● | — | — | FR-019 |
| 4 | Cancel any incident | — | — | ● | ● | FR-056 |
| **Incident reading** |
| 5 | Read own incidents | ● | ● | ● | ● | FR-124 |
| 6 | Read incidents assigned to self | ● | ● | ● | ● | FR-124 |
| 7 | Read unassigned incidents in radius (when `available`) | — | ◐ | ● | ● | FR-124 |
| 8 | Read all incidents (any location) | — | — | ● | ● | FR-124 |
| 9 | Read incident `originalText` | ● own | ◐ summary only | ● | ● | FR-068 |
| 10 | Read reporter identity (uid, display name) | ● own | — | ● | ● | FR-068, NFR-027 |
| 11 | Read `locationText` (typed address) | ● own | — | ● | ● | FR-068 |
| 12 | Read archived / soft-deleted incidents | — | — | ● | ● | FR-123 |
| 13 | Read AI triage panel with model metadata | — | ○ | ● | ● | FR-075 |
| **Lifecycle** |
| 14 | Verify | — | — | ● | ● | FR-056 |
| 15 | Mark false alarm | — | — | ● | ● | FR-056 |
| 16 | Set `en_route` | — | ◐ assigned only | ● | ● | FR-055 |
| 17 | Set `on_scene` | — | ◐ assigned only | ● | ● | FR-055 |
| 18 | Set `resolved` (with `resolutionCode`) | — | ◐ assigned only | ● | ● | FR-054, FR-055 |
| 19 | Set `closed` | — | — | ● | ● | FR-056 |
| 20 | Force status override with reason | — | — | ● | ● | FR-051 |
| **Editing** |
| 21 | Edit `summary` / `urgency` / `category` | — | — | ● | ● | FR-073 |
| 22 | Edit `location` | ● own, pre-verify | — | ● | ● | FR-039 |
| 23 | Edit AI-influenced fields | — | — | ● | ● | FR-073 |
| **Duplicates** |
| 24 | See duplicate suggestions | ◐ own | — | ● | ● | FR-045 |
| 25 | Confirm a merge | — | — | ● | ● | FR-046 |
| 26 | Undo a merge (within 24 h) | — | — | ● | ● | FR-047 |
| 27 | Dismiss a duplicate as separate | — | — | ● | ● | FR-048 |
| **Dispatch** |
| 28 | See ranked candidate responders | — | — | ● | ● | FR-074 |
| 29 | Assign a responder | — | — | ● | ● | FR-074 |
| 30 | Unassign / withdraw | — | ◐ own assignment | ● | ● | FR-053 |
| 31 | Claim an open dispatch | ◐ `responder` only | ● | ● | ● | §5 |
| 32 | Read all dispatches | — | ◐ own | ● | ● | §5 |
| **Responders** |
| 33 | Read own responder profile | — | ● | ● | ● | FR-060 |
| 34 | Set own availability / capabilities / radius | — | ● | ● | ● | FR-061, FR-062 |
| 35 | Read the responder directory | — | — | ● | ● | FR-061 |
| 36 | Read responder phone number | — | — | ● | ● | FR-068 |
| 37 | Edit any responder profile | — | — | ● | ● | §4 |
| 38 | Verify / reject a responder | — | — | — | ● | FR-063 |
| 39 | See responder performance stats | — | — | ● | ● | FR-069 |
| **Locations** |
| 40 | Submit own location | ● | ● | ● | ● | FR-030 |
| 41 | Write `responderLocations` for self | — | ● | ● | ● | FR-066 |
| 42 | Write `responderLocations` for another responder | — | — | ● | ● | §4 |
| 43 | Read responder live locations | — | — | ● | ● | FR-081, NFR-027 |
| 44 | Read the live map (incidents) | ○ counts only | ◐ in-radius + assigned | ● | ● | FR-088 |
| **Notifications** |
| 45 | Read own notifications | ● | ● | ● | ● | FR-103 |
| 46 | Mark own notifications read | ● | ● | ● | ● | FR-104 |
| 47 | Send a notification to another user | — | — | — | ● | [08](./08_API_SPECIFICATION.md) §6.4 |
| **Analytics** |
| 48 | Read operational analytics | — | — | ● | ● | FR-117 |
| 49 | Read risk zones | — | ○ | ● | ● | FR-117 |
| 50 | Recompute analytics / risk | — | — | — | ● | FR-115 |
| 51 | Export CSV | — | — | ● | ● | FR-118 |
| **Administration** |
| 52 | List users | — | — | — | ● | FR-132 |
| 53 | Change a user's role | — | — | — | ● | FR-133 |
| 54 | Enable / suspend an account | — | — | — | ● | FR-132 |
| 55 | Read the audit log | — | — | ○ (read-only) | ● | FR-134 |
| 56 | Read / write `config/app` | — | — | ○ (read) | ● | US-033 |
| 57 | Run maintenance jobs | — | — | — | ● | [08](./08_API_SPECIFICATION.md) §10 |
| 58 | Soft-delete / restore an incident | — | — | ● | ● | FR-123 |
| 59 | **Delete an audit log entry** | — | — | — | **—** | FR-131 |
| 60 | Create or promote a dispatcher | — | — | — | ● | FR-133 |
| 61 | Change own role | — | — | — | **—** | FR-133 |

**Row 59 and row 61 are hard denials for every role, including admin.** They are the two permissions that must never be granted.

---

## 4. Scoped-permission details (◐ rows)

### 4.1 Responder incident access (rows 7, 9, 16, 17, 18, 31)

```
A responder may access an incident I if:
  I.assigneeUid == self                                   (assigned / previously assigned)
  OR ( self.status == 'available'
       AND I.status IN {new, triaged, verified}
       AND distance(self.location, I.geo) <= self.serviceRadiusM
       AND I.evidenceCount > 0 )                           (in-radius unassigned)
```

Field-level redaction for a responder viewing a non-assigned incident:

| Redacted | Replaced with |
| --- | --- |
| `reporterUid`, `reporter.displayName`, `reporter.email` | omitted |
| `reports[].text` | omitted for non-original reports; the original text is replaced with `summary` |
| `locationText` | omitted |
| `ipHash` | omitted |
| `ai.rawOutputHash`, `ai.model`, `ai.promptVersion` | omitted (they carry no operational value for a responder) |

### 4.2 Dispatcher overrides (rows 20, 37, 42, 58)

A dispatcher's `PATCH` is allowed on any field the responder could change, plus `summary`, `urgency`, `category`, `location`, and `status`. A status override that skips a state (e.g. `triaged → on_scene`) is permitted for a dispatcher **only with a `reason` ≥ 10 chars**, and is recorded in `statusHistory.metadata.skippedStates = ["verified","assigned"]` so the audit trail shows the jump. A responder may not skip states (FR-055, `TRANSITION_NOT_ALLOWED_YET`).

### 4.3 Admin-only guarantees

| Guarantee | Mechanism |
| --- | --- |
| Only an admin can grant `dispatcher` or `admin` | `PATCH /api/admin/users/:id/role` is `admin`-only; a `dispatcher` token on this route is `403` |
| An admin cannot change their own role | `SELF_ROLE_CHANGE_FORBIDDEN` (row 61) — prevents accidental or malicious self-lockout/lock-in |
| An admin cannot disable their own account | `SELF_DISABLE_FORBIDDEN` |
| An admin cannot delete an audit log | No endpoint exists and Firestore rules deny `delete` (row 59) |
| Every privileged action needs a reason | `REASON_REQUIRED`, enforced in the Zod schema and audited (FR-133) |
| Responder verification is a distinct capability | Separate endpoints ([08](./08_API_SPECIFICATION.md) §4.5) so a compromised admin session that can change roles still cannot silently self-verify a responder — and both actions are audited separately |

---

## 5. Object-level (resource) authorization

Role alone is never sufficient. Every data access passes **two** gates:

```
Gate 1 — role:        may this ROLE perform this ACTION type?
Gate 2 — ownership:   may this USER perform it on THIS resource?
```

| Resource | Gate 2 rule |
| --- | --- |
| `incidents/{id}` read | Own (`reporterUid == uid`) · assigned (`assigneeUid == uid`) · in-radius unassigned (responder + available) · any (dispatcher/admin) |
| `incidents/{id}` write | Own + pre-verification + limited fields (citizen) · assigned + specific transitions (responder) · any (dispatcher/admin) |
| `incidents/{id}/reports` | Inherits the parent's read gate; create requires the parent to be own + pre-verification |
| `incidents/{id}/statusHistory` | Inherits the parent's read gate; **no** write access from any client (server-only) |
| `dispatches/{id}` | `responderUid == uid` · dispatcher/admin |
| `responders/{uid}` | Self · dispatcher/admin (with field-level redaction for `phone`, `verificationNote`) |
| `responderLocations/{uid}` | Self writes · dispatcher/admin reads · **no other role reads** |
| `notifications/{id}` | `recipientUid == uid` only. There is no `?recipientUid=` parameter |
| `users/{uid}` | Self (redacted) · admin |
| `auditLogs/{id}` | `admin` read; `dispatcher` read; **no writes at all** |
| `aiRuns/{id}` | dispatcher/admin read; no writes |
| `config/app` | All authenticated read the client-safe subset; admin reads and writes the full document |
| `rateLimits/{key}` | No client access (server-mediated) |
| `analyticsDaily/{date}` | dispatcher/admin read |
| `riskZones/{id}` | dispatcher read; admin read/write |

**Non-existence opacity (US-005):** when Gate 2 fails on a read, the server returns `404 INCIDENT_NOT_FOUND` — identical to a genuinely missing document. `403` is returned only when Gate 1 (role) fails for an action that does not depend on the resource existing.

---

## 6. Enforcement layers (defence in depth)

| Layer | Mechanism | Catches |
| --- | --- | --- |
| 1. UI affordance | Buttons rendered from `GET /api/me` `permissions[]` and the per-incident `permissions[]` | Prevents accidental misuse; not a security boundary |
| 2. API route | `requireUser()` + `assertRole()` + `assertResourceAccess()` in **every** handler | The real boundary (NFR-015) |
| 3. Server-side data shaping | Field-level redaction in the response serialiser (`lib/api/serialize.ts`) | Prevents leaking PII even when the query legitimately read it |
| 4. Firestore Security Rules | Role claim + ownership + field allow-lists | Client-SDK writes and any read that bypasses the API |
| 5. Storage Security Rules | Path-derived ownership: `incidents/{id}/...` readable only under the incident's visibility | Direct Storage access |
| 6. Audit log | Every privileged mutation recorded, append-only | Detection and accountability, not prevention |

> A bug in the UI (layer 1) is caught by 2–5. A bug in a route handler (layer 2) is caught by 4–5. A bug in both 2 and 4 is caught by 6. No single layer is trusted.

---

## 7. Firestore Security Rules (readable form; the file is the source of truth)

```js
rules_version = '2';
service firebase.firestore {
  match /databases/{database}/documents {

    function isSignedIn()  { return request.auth != null; }
    function role()        { return request.auth.token.role; }         // claim mirror
    function isAdmin()     { return isSignedIn() && role() == 'admin'; }
    function isDispatch()  { return isSignedIn() && (role() == 'dispatcher' || isAdmin()); }
    function isResponder() { return isSignedIn() && role() == 'responder'; }
    function isOps()       { return isDispatch() || isResponder(); }
    function isSelf(uid)   { return isSignedIn() && request.auth.uid == uid; }

    // ---- users -------------------------------------------------------
    match /users/{uid} {
      allow read: if isSelf(uid) || isDispatch();
      // Only the server (Admin SDK, which bypasses rules) may write this.
      allow write: if false;
    }

    match /profiles/{uid} {
      allow read:   if isSignedIn() && (isSelf(uid) || isDispatch());
      allow create, update: if isSelf(uid)
        && request.resource.data.keys().hasOnly(['displayName','timezone','locale','notifPrefs','updatedAt']);
      allow delete: if false;
    }

    // ---- incidents ---------------------------------------------------
    match /incidents/{id} {
      function reporter()   { return resource.data.reporterUid; }
      function assignee()   { return resource.data.assigneeUid; }
      function notDeleted() { return resource.data.deletedAt == null; }
      function canRead() {
        return isDispatch()
          || (isSignedIn() && reporter() == request.auth.uid)
          || (isSignedIn() && assignee() == request.auth.uid);
        // NOTE: in-radius responder visibility is enforced in the API, not here —
        // rules cannot evaluate distance. Such incidents are delivered to the
        // responder by the API (server read), not by a direct client listener.
      }
      function canCreate() {
        return isSignedIn()
          && request.resource.data.reporterUid == request.auth.uid
          && request.resource.data.reporterAnon == false
          && request.resource.data.keys().hasOnly([/* server-owned field allow-list */])
          && request.resource.data.status == 'new';
      }
      function mutableFields() {
        return request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['location','locationText','geo','geoCells','placeName','placeId',
                    'updatedAt','searchTokens','locationAccuracyGrade']);
      }
      allow get, list: if canRead() && notDeleted();
      allow create: if canCreate();
      // A citizen may only adjust location on their own unverified incident.
      allow update: if isDispatch()
        || (isSignedIn() && reporter() == request.auth.uid
            && notDeleted() && resource.data.status in ['new','triaged'] && mutableFields());
      allow delete: if false;                       // soft delete only, server-side (FR-123)

      match /reports/{rid} {
        allow read: if canRead();
        allow create: if isDispatch()
          || (isSignedIn() && resource.data.reporterUid == request.auth.uid
              && get(/databases/$(database)/documents/incidents/$(id)).data.reporterUid == request.auth.uid);
        allow update, delete: if false;
      }
      match /statusHistory/{eid} { allow read: if canRead(); allow write: if false; }
      match /resources/{lid}    { allow read: if canRead(); allow write: if isDispatch(); }
    }

    // ---- responders --------------------------------------------------
    match /responders/{uid} {
      function safePublic() {
        return request.resource.data.keys()
          .hasOnly(['uid','displayName','status','capabilities','verification','serviceRadiusM',
                    'activeIncidentCount','maxConcurrentIncidents','lastLocationAt',
                    'lastLocationAccuracyGrade','photoURL']);
      }
      allow get: if isDispatch() || isSelf(uid);
      allow list: if isDispatch();                       // citizens cannot enumerate responders
      allow create, delete: if false;                    // server-created
      allow update: if isSelf(uid)
        ? request.resource.data.diff(resource.data).affectedKeys()
            .hasOnly(['status','capabilities','serviceRadiusM','phone','notifPrefs','updatedAt'])
          : isAdmin() || isDispatch();                   // dispatchers may not touch verification fields
    }

    match /responderLocations/{uid} {
      allow read: if isDispatch();                        // responders read only their own via API
      allow write: if isSelf(uid)
        && request.resource.data.diff(resource.data).affectedKeys()
            .hasOnly(['geo','accuracyM','accuracyGrade','headingDeg','speedMps','source',
                      'status','activeIncidentId','capturedAt','receivedAt','stale'])
        && request.resource.data.uid == uid;
      // Rate limiting is enforced server-side (token bucket); rules cannot count requests.
    }

    // ---- dispatches ---------------------------------------------------
    match /dispatches/{did} {
      allow read: if isDispatch() || (isResponder() && resource.data.responderUid == request.auth.uid);
      allow write: if false;                              // server-mediated only
    }

    // ---- notifications -------------------------------------------------
    match /notifications/{nid} {
      allow read: if isSignedIn() && resource.data.recipientUid == request.auth.uid;
      allow create, delete: if false;                     // server-mediated
      allow update: if isSignedIn() && resource.data.recipientUid == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read','readAt']);
    }

    // ---- reference / telemetry / config --------------------------------
    match /resources/{rid}  { allow read: if isSignedIn(); allow write: if isAdmin(); }
    match /riskZones/{rid}  { allow read: if isOps();     allow write: if isAdmin(); }
    match /aiRuns/{rid}     { allow read: if isDispatch(); allow write: if false; }
    match /auditLogs/{lid}  { allow read: if isDispatch(); allow write: if false; }  // append-only (FR-131)
    match /analyticsDaily/{d} { allow read: if isDispatch(); allow write: if false; }
    match /rateLimits/{k}   { allow read, write: if false; }
    match /config/{cid} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /{document=**} { allow read, write: if false; }   // deny by default
  }
}
```

**Rules tests that MUST exist** ([18](./18_TESTING_QA_PLAN.md) §7): every row of §3, plus explicit negative tests for rows 59 and 61, plus "a citizen cannot read `auditLogs`", "a responder cannot read another responder's `responderLocations`", "a citizen cannot list `incidents` without a `reporterUid` filter", and "a client cannot write `incidents` with `status: 'verified'`".

### 7.1 Storage rules (shape)

```js
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function signedIn() { return request.auth != null; }
    function isOps()    { return signedIn() && (request.auth.token.role in ['dispatcher','admin']); }
    function mine(uid)  { return signedIn() && request.auth.uid == uid; }

    // Staging: the uploader may write/read only their own; nobody else.
    match /staging/{uid}/{mediaId}.{ext} {
      allow read:  if mine(uid);
      allow write: if mine(uid)
        && request.resource.size <= 15 * 1024 * 1024
        && (request.resource.contentType.matches('image/(jpeg|png|webp)')
            || request.resource.contentType.matches('audio/(webm|mp4|mpeg)'));
      allow delete: if mine(uid);
    }

    // Final evidence: server-written. Clients get access only via short-lived signed URLs
    // issued by the API after a resource-level authorization check.
    match /incidents/{incidentId}/{sub}/{rid}/{mediaId}.{ext} {
      allow read, write, delete: if false;
    }
    match /quarantine/{mediaId}.{ext} { allow read, write: if false; }
  }
}
```

---

## 8. Role assignment and change procedure (FR-133)

### 8.1 Bootstrap (first admin)

The very first `admin` is created **out of band** — by running `scripts/create-admin.ts` with the service account, which sets `users/{uid}.role = 'admin'` and the custom claim. There is no self-service path, and no endpoint that can create the first admin (a chicken-and-egg guard that would otherwise be a privilege-escalation vector).

### 8.2 Normal role change

```
Admin opens /admin/users → selects user → "Change role"
  → dialog 1: choose new role + type a reason (≥ 10 chars)
  → dialog 2: explicit confirmation naming the user and both roles
  → POST /api/admin/users/:id/role  { role, reason }
Server (transaction):
  users/{uid}.role = newRole;  updatedAt = now; roleChangedAt = now; roleChangedBy = adminUid
  auditLogs: user.role_change { before, after, reason, requestId }
Then (outside the transaction, retried up to 3 times):
  setCustomUserClaims(uid, { role: newRole })
  on success: users/{uid}.roleChangePending = false
  on failure:  users/{uid}.roleChangePending = true   → 202 response, alert logged
Affected user: UI shows "Your permissions changed — refresh to apply", calls getIdToken(true)
```

| Guard | Code | Rationale |
| --- | --- | --- |
| Cannot change own role | `SELF_ROLE_CHANGE_FORBIDDEN` | Row 61 |
| Reason ≥ 10 chars | `REASON_REQUIRED` | FR-133 auditability |
| Role unchanged | `ALREADY_ROLE` (409) | No-op noise in the audit log |
| Target account must exist | `USER_NOT_FOUND` | |
| Granting `admin` is audited at `warning` severity | — | Admin creation is a reviewable event |
| Downgrading a dispatcher with open dispatches | Allowed, but the response lists the affected dispatches so the admin can reassign first | Prevents orphaned incidents |

### 8.3 Account suspension

`PATCH /api/admin/users/:id/status` → `suspended` requires a reason, writes `user.disable`, sends an in-app `account_suspended` notification (best-effort), and revokes all outstanding ID tokens by setting `users/{uid}.tokensValidAfter = now` (tokens issued before that are rejected by `verifyIdToken` with `checkRevoked: true`). **Note:** token revocation requires the Admin SDK check and therefore affects the API layer; Firestore rules still allow an old token to read its own user doc until it expires, which is why all privileged data reads are server-mediated. Honest residual risk, documented.

---

## 9. Role → UI surface map

| Role | Default landing page after login | Navigation |
| --- | --- | --- |
| `citizen` | `/report` | Report, My reports, Track, Notifications, Profile, Settings |
| `responder` | `/dashboard` (responder variant) | Dashboard, My assignments, Map, Availability, Notifications, Profile, Settings |
| `dispatcher` | `/dashboard` | Dashboard, Incidents, Map, Dispatches, Responders, Analytics, Notifications, Audit log (read), Profile, Settings |
| `admin` | `/admin` | Everything above plus Admin (Users, Responders, Incidents, Audit logs, Settings), plus a "system health" tile |

Route protection ([05](./05_FRONTEND_ARCHITECTURE.md) §7) hides links a role cannot use, and a direct URL access to a forbidden page renders a `403` state — never a redirect loop and never a partially rendered page.

---

## 10. Permission test matrix (summary; full plan in [18](./18_TESTING_QA_PLAN.md))

| Test class | Count | Examples |
| --- | --- | --- |
| API role denial | 1 per matrix row with a `—` | Citizen → `POST /dispatch` ⇒ 403 |
| API scope denial | 1 per ◐ rule | Responder B → PATCH incident assigned to A ⇒ 403 |
| Cross-user data leakage | 1 per "not mine" resource | Citizen A → `GET` citizen B's incident ⇒ **404** |
| Rules unit tests | ≥ 60 assertions | Every rules branch in §7 |
| Role-change guards | 4 | self-role, self-disable, reason, already-role |
| Audit completeness | 1 per privileged action (12) | Each produces exactly one audit row |
| Non-existence opacity | 2 | Missing incident vs other user's incident ⇒ identical body |
| Claim drift | 1 | Stale claim + new Firestore role ⇒ 403 `ROLE_MISMATCH` |
| Suspension | 2 | Suspended user's token ⇒ 403 `ACCOUNT_UNAVAILABLE` |

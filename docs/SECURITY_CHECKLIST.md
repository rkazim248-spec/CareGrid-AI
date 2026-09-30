# CareGrid AI — Security Checklist

**Phase 10** · **Date:** 2026-09-30
**Companion:** [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) — every
finding has an ID there.

**Marking rule, applied strictly:**

| Mark | Means |
| --- | --- |
| **PASS** | I ran a check, read the code, or executed a command, and it held. |
| **FAIL** | I ran it and it did not hold. |
| **NEEDS REVIEW** | Not checkable in this environment. **Not a soft PASS.** |
| **N/A** | The brief forbids the feature, so there is nothing to check. |

A blank is not permitted. Where the only available evidence is a structural read, the
row says so — a structural read is a weaker claim than execution, and recording it as
a flat PASS would overstate the audit.

Legend: `C##` = a mechanical check in `scripts/security-check.cjs`.

---

## 1. Authentication — PASS (with one NEEDS REVIEW)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Unauthenticated users cannot reach protected pages | `RequireSession` client component; 16 protected routes |
| ✅ | Every API handler requires a token except `api/health` | C78, §4 of the audit |
| ✅ | Sign-out actually invalidates the session | `fbSignOut` drops the persisted token |
| ✅ | **Sign-out also closes every realtime listener** | C75, order enforced. **Fixed in Phase 10 — was CG-10-01** |
| ✅ | An identity change closes listeners, not only an explicit sign-out | C76, `handleAuthStateOrIgnoreError` |
| ✅ | A token refresh does **not** close listeners | C77 + 15 unit tests |
| ✅ | A user cannot change their own role from the browser | C84 — `users/{uid}` refuses all client writes |
| ✅ | Role is not trusted from client state | `docs/22 §2`; role is server-written into a custom claim |
| ✅ | A disabled/suspended account is refused privileged operations | `allowInactiveAccount` is a per-route opt-in, default off |
| ⚠️ | **Auth flow in a real browser** | **NEEDS REVIEW** — no browser available. Google `signInWithPopup` and the COOP relaxation are unverified. |

## 2. Authorization — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Role permissions come from a 61-row capability matrix | `lib/auth/permissions.ts` |
| ✅ | Each route declares its capability | 14 capability declarations across 17 handlers |
| ✅ | Client-side role checks are UX only; the API re-checks | `docs/14 §10` ACC-1; `requireCapability` in every handler |
| ✅ | A stale role claim is detected, not trusted | `403 ROLE_MISMATCH` |
| ⚠️ | `/analytics` nav gating uses a role, not capability `r48` | **CG-10-05** — values agree today; API re-checks. Not a vulnerability. |

## 3. Firestore rules — PASS (structurally) / NEEDS REVIEW (semantics)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Deny by default | No rule grants by omission; `SKIP` and helpers reviewed |
| ✅ | `users/{uid}` refuses create, update, delete | C84 |
| ✅ | `profiles/{uid}` is field-limited and cannot set `uid` | `hasOnly(profileWritableFields())` |
| ✅ | `auditLogs` is append-only for **every** role | C85 |
| ✅ | `notifications` are owner-scoped; only `read`/`readAt` writable | §3 |
| ✅ | A `create` uses `hasOnly` on the **full** key set, not a diff | `docs/10 §4` — a diff is empty on create, so it would gate nothing |
| ⚠️ | **Rules have never been EXECUTED** | **NEEDS REVIEW — CG-10-02.** Requires a JDK; none installed. The full deny/allow matrix to assert is in audit §9.1. **The largest unverified surface in the product.** |

## 4. Field-level security — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `role`, `permissions` not client-writable | `users/` write denied entirely |
| ✅ | `createdAt`, `createdBy`, `createdByRole` in the create allow-list | `clientCreatableFields()` |
| ✅ | `aiAnalysis`, `verifiedAt` not client-writable | excluded from every client allow-list |
| ✅ | System timestamps server-set | `serverTimestamp` in services, not client writes |
| ✅ | An update is bounded by `diff().affectedKeys().hasOnly(...)` | Firestore rules, incidents + dispatches |

## 5. Storage rules — PASS (structurally) / NEEDS REVIEW (executed)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Deny by default | C86 — `match /{allPaths=**}` denies |
| ✅ | Final evidence closed to clients | `incidents/…` → `if false` |
| ✅ | Quarantine closed | `quarantine/…` → `if false` |
| ✅ | `staging/{uid}/` is owner-scoped | `mine(uid)` on read, write and delete |
| ✅ | Size cap at write | `request.resource.size <= 15 * 1024 * 1024` |
| ✅ | MIME allow-list at write | `image/(jpeg\|png\|webp)`, `audio/(webm\|mp4\|mpeg)` |
| ✅ | No path traversal — the uid is the path owner | rules derive ownership from the path segment |
| ✅ | `.env.example` documents no real secret | 47 non-empty values, all non-secret defaults |
| ⚠️ | **Rules not executed; finalize path not run against a live bucket** | **NEEDS REVIEW** |
| ⚠️ | `contentType`/`size` are client-asserted | **CG-10-08** — mitigated by the sign/finalize split; the outer bound only |

## 6. API security — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Authentication on every handler but `api/health` | C78 |
| ✅ | Authorisation by declared capability | 14 declarations |
| ✅ | Input validation by Zod on params, body and query | every handler passes a schema to `withRequest` |
| ✅ | Output validation on responses | response schemas declared per route |
| ✅ | Rate limiting on every mutating handler | C78 |
| ✅ | An unlimited GET records the decision | C79 |
| ✅ | No rate-limit rule is silently dead | C80 |
| ✅ | Method validation | `export const GET/POST/…`, no catch-all |
| ✅ | `dynamic = 'force-dynamic'` and `runtime = 'nodejs'` where required | prevents static optimisation of authenticated routes |
| ✅ | Error responses carry a code and a safe message | `toAppError` is the single funnel |

## 7. Rate limiting — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Implemented without a paid service | Firestore-backed counter, `RATE_LIMIT_STORE = firestore` |
| ✅ | Abuse-prone endpoints bounded | upload 30/h, AI 20/h, bootstrap 10/h, dispatch and transition bounded |
| ✅ | Subject is the uid where identity exists, else a hashed IP | `subject: 'uid' \| 'ip'` |
| ✅ | The bucket document id is hashed | `sha256(subject \| route \| window)` — a uid is not a document name |
| ✅ | Failure is `503`, not fail-open | a bucket read error throws `DB_UNAVAILABLE` |
| ✅ | Documented as replaceable | `rate-limit.ts` header names the interface |

## 8. AI / Gemini security — PASS (structurally)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | **The API key is never in the browser** | C90: read only by `lib/env.server.ts`, which imports `server-only`. Mutation-tested. |
| ✅ | `lib/env.client.ts` reads only `NEXT_PUBLIC_*` | C91 |
| ✅ | Gemini is called only from server code | `services/ai/client.ts`, server-only |
| ✅ | **The system instruction is not parameterised** | C81 — a `const` literal with no interpolation. Structural, not a convention. |
| ✅ | Untrusted content is wrapped in delimiters | C82 |
| ✅ | The delimiters are defanged first | a report containing `</citizen_report>` cannot close its own block |
| ✅ | The prompt treats report text as data, and rule 9 reports injection attempts | `SYSTEM_INSTRUCTION` |
| ✅ | An injection heuristic scores the input | `AI_INJECTION_PATTERNS`, `sanitize.ts` |
| ✅ | Output is Zod-validated | C83 |
| ✅ | `category` and `urgency` are enums, not free strings | C83 |
| ✅ | Confidences bounded to 0–1 | `z.number().min(0).max(1)`, ≥2 sites |
| ✅ | Unknown values default to `unknown`, never invented | `AI_UNKNOWN_FIELDS` |
| ✅ | AI cannot modify authorization | no AI output reaches a role or permission |
| ✅ | **AI cannot dispatch** | the pipeline is report → validate → AI → validate → human review → workflow. No AI path reaches `assignResponder`. |
| ✅ | Prompt size and media size bounded | `AI_BOUNDS`, upload caps |
| ✅ | Timeout, retry cap and a safe fallback exist | `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`, `services/ai/fallback.ts` |
| ⚠️ | **Live Gemini call** | **NEEDS REVIEW** — no `GEMINI_API_KEY`. Verified against a stubbed provider only. |

## 9. Prompt injection — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | User text cannot redefine the system prompt | C81 |
| ✅ | Injection attempts are neutralised and scored | `sanitize.ts` + `AI_INJECTION_PATTERNS` |
| ✅ | Malformed output is rejected, not coerced | Zod `.safeParse` |
| ✅ | Uncertain values become `unknown` | `AI_UNKNOWN_FIELDS` |
| ⚠️ | **Adversarial prompts against the live model** | **NEEDS REVIEW** — needs a real key. |

## 10. XSS — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | **Zero** `dangerouslySetInnerHTML` in the tree | C87, mutation-tested |
| ✅ | **Zero** `eval` / `new Function` | C87 |
| ✅ | **Zero** `.innerHTML =` / `.outerHTML =` / `document.write` / `insertAdjacentHTML` | C87 |
| ✅ | React escaping preserved | no bypasses exist to preserve |
| ✅ | `script-src` has no `'unsafe-inline'` | C93 — the middleware's own comment was initially flagged for *mentioning* the phrase; the check now strips comments |
| ✅ | CSP is set in one place for every route | `middleware.ts` |
| ✅ | `nosniff`, `frame-ancestors`, `object-src 'none'`, `base-uri 'self'` | C92 |

## 11. SSRF — PASS (no surface)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | The server fetches **no** user-supplied URL | C88 |
| ✅ | The only absolute fetch is a hardcoded Maps host | `services/maps/reverse-geocode.ts` |
| ✅ | No protocol allow-list needed, because no URL is accepted from input | — |
| ✅ | `localhost`, private ranges and the metadata IP are unreachable by construction | there is no code path that would reach them |

## 12. CSRF / request security — PASS (by architecture)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | No session cookies, so no ambient credential to ride | `docs/10 §12.1`; a bearer header is not attached automatically |
| ✅ | Origin asserted on state-changing requests | `assertSameOrigin`, allow-list from `NEXT_PUBLIC_APP_URL` |
| ✅ | `form-action 'self'` as the CSP backstop | `middleware.ts` |
| ✅ | Same reasoning documented rather than assumed | middleware header explains **why** no session-cookie CSRF token exists |
| ✅ | `credentials` not used to carry identity | bearer `Authorization` header |

## 13. Open redirect — PASS (no surface)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | No `location.href`/`assign`/`replace` from request input | C89 |
| ✅ | No `window.open` from request input | C89 |
| ✅ | No `NextResponse.redirect` from request input | C89 |
| ✅ | No `?redirect=` / `?returnTo=` parameter anywhere | §3 |

## 14. Secrets — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `GEMINI_API_KEY` never in a browser bundle | C90, C90b, C91 |
| ✅ | No `NEXT_PUBLIC_*` name that is a secret | C91 |
| ✅ | Only `.env.example` is tracked | `git ls-files` |
| ✅ | `.gitignore` covers `.env`, `.env*.local`, **and** environment-named files without the suffix | `.env.*` plus three `!` exceptions |
| ✅ | `.env.example` holds no real secret | 47 defaults, all non-secret |
| ✅ | **No secret in git history** | every reachable blob scanned for `AIza…`, PEM headers, long assignments → **0 hits** |
| ✅ | No secret in a response, an error, or a log | §7 of the audit |

## 15. Logging — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | All 14 `console.*` sites reviewed | §7 of the audit |
| ✅ | No key, token, password, file content or exact coordinate logged | 0 occurrences |
| ✅ | Production-only warnings guarded by `NODE_ENV` | 3 sites |
| ✅ | The Phase 10 teardown log records a **count and reason**, never a uid | `closeRealtimeListenersFor` |

## 16. Audit logs — PASS (structurally)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Incident created, triaged, duplicate linked, assigned, accepted, rejected, status changed, resolved are all audited | `services/dispatch/audit.ts` |
| ✅ | Each record has actor, action, timestamp, target, metadata | record shape |
| ✅ | No ordinary user can modify history | C85 — `if false` for every role |
| ✅ | No ordinary user can delete history | C85 |

## 17. Location privacy — PASS (structurally)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Geolocation requires explicit browser permission | `Permissions-Policy: geolocation=(self)` |
| ✅ | The location source is recorded | field-level; required |
| ✅ | Accuracy stored when available | nullable, never fabricated |
| ✅ | Invalid coordinates rejected | validators; range-checked |
| ✅ | An AI location hint is not treated as GPS | `location_hint` is advisory; `geo` is separate |
| ✅ | Reverse geocoding is server-only with the server key | `GOOGLE_MAPS_SERVER_KEY`, `server-only` |
| ✅ | **Analytics returns cell counts, never coordinates** | audit §6; the return shape has no `lat`/`lng` field |
| ✅ | Positionless incidents are reported, not dropped | `withoutPosition` |
| ⚠️ | **Rules not executed** | **NEEDS REVIEW** |

## 18. Responder location privacy — PASS (structurally)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Only dispatcher/admin may read the map layer | `mapLocations` |
| ✅ | A client cannot submit another responder's coordinates | path-derived ownership |
| ✅ | Stale locations are identified | `STALE_LOCATION_MIN` |
| ✅ | Update frequency is bounded | heartbeat interval, not free-form |
| ⚠️ | **Rules not executed** | **NEEDS REVIEW** |

## 19. Dispatch security — PASS (tested against a mock, not a live transaction)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Assignment is authorised | `r29_assignResponder` |
| ✅ | Availability is checked | Phase 7 candidates ranker |
| ✅ | The write is a transaction; the database is authoritative | `services/dispatch/assign` |
| ✅ | `assigneeUid` / `activeIncidentCount` invariants serialise concurrent assigns | Phase 7 |
| ✅ | Reassignment, rejection, withdrawal, cancellation are distinct operations | distinct capabilities |
| ✅ | Transitions are a centralised declared map; no `reported → resolved` edge | 60 tests, 6 mutations, Phase 7 |
| ⚠️ | **Concurrency against a live Firestore** | **NEEDS REVIEW** — mocked transaction only. |

## 20. Duplicate detection — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | 500 m threshold, and it is **not** reused as a dispatch threshold | security check, `docs/07 §9` vs §7 |
| ✅ | Coordinates validated before distance | validators |
| ✅ | Proximity alone does not merge | text confirmation `DUPLICATE_TEXT_CONFIRM = 0.60` |
| ✅ | The relationship is auditable | `mergedIntoId`, `merged` status, `duplicateStatus` |
| ✅ | `merged` is counted separately, never folded into `resolved` | Phase 9 fix |
| ✅ | Boundary cases tested | exactly 500 m, below, above, missing coordinates, different categories |

## 21. Realtime security — PASS (this phase's main fix)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Listeners are scoped to the authenticated user | L5 `where('recipientUid','==',uid)` |
| ✅ | The L5 hook exposes **no** parameter to widen it | Phase 9 check: exactly one option, `seed` |
| ✅ | Listeners unsubscribe on unmount | `useRealtimeListener` |
| ✅ | **Listeners close on an identity change** | C75, C76, C77 + 15 tests. **CG-10-01 fix** |
| ✅ | A token refresh does not close them | C77 |
| ✅ | Duplicate listeners are not created | registry keyed by `id` **and** `queryKey`; budget cap |
| ✅ | Stale data is handled safely | `STALE_AFTER_MS`; a stall detector catches a silent stall |
| ✅ | Reconnect does not duplicate events | `queryKey` prevents re-subscription; `merge-snapshot` is idempotent |
| ✅ | A revoked token is not trusted | a clean `permission-denied` surfaces as an error, not as data |
| ⚠️ | **No listener has ever executed** | **NEEDS REVIEW** — no deployed project, no deployed indexes. |

## 22. Notification security — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | A notification belongs to one recipient | `recipientUid`, the query key |
| ✅ | Recipients are **server-determined** | `recipientsForEvent`, Phase 7 |
| ✅ | A client cannot create a notification | rules: `allow create: if false` |
| ✅ | A client cannot delete one | rules: `if false` |
| ✅ | A user cannot read another user's | rules: `resource.data.recipientUid == request.auth.uid` |
| ✅ | A user cannot mark another's as read | same scoping on update |
| ✅ | The only client write is `read`/`readAt`/`updatedAt` | `hasOnly` |
| ✅ | Metadata exposes no sensitive incident data | mapper projects a declared subset |
| ✅ | Critical events cannot be spoofed | server-side generation; a client cannot create any |
| ✅ | Notification types are the declared 12, server-validated | `NOTIFICATION_TYPES`; the mapper **derives** its set |

## 23. Analytics privacy — PASS (structurally)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Analytics is gated by `r48` (dispatcher/admin) | declared in the matrix; the nav matches its values |
| ✅ | A citizen gets 403, not a filtered view | `auth: 'required'` + capability |
| ✅ | Recompute is admin-only | `r50` |
| ✅ | No PII in a metric | counts, durations, cell ids |
| ✅ | Aggregation is preferred over coordinates | geohash-6 cell counts |
| ✅ | An unmeasurable metric is `null`, never `0` | `MaybeNumber`; "Not enough data" |
| ✅ | A capped scan is not presented as complete | `source` + `advisory` on every response |
| ✅ | Risk is never described as prediction | `RISK_HONESTY_STATEMENT` verbatim; flag default `false` |
| ⚠️ | **The route is not built** | `/api/analytics` does not exist; the view still reads `MOCK_ANALYTICS`. Not a privacy exposure, but not verified either. |

## 24. Dependency audit — PASS (with one accepted advisory)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `npm audit` run | 12 advisories: 1 High, 11 Moderate |
| ✅ | Non-breaking fix applied | `gaxios`; 12 → 11 |
| ✅ | No blind force-upgrade | `npm audit fix --force` **not** used; a `next` major would risk the Firebase integration |
| ✅ | `postcss` High is not runtime-reachable | not a prod dep; **no app file imports it**; needs attacker-controlled CSS stringify |
| ✅ | `vitest` advisories are dev-only | not shipped |
| ✅ | Unnecessary dependencies removed | 33 prod + 12 dev, each in use |

## 25. TypeScript quality — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `tsc --noEmit` clean | 0 errors |
| ✅ | No implicit `any` | strict mode |
| ✅ | No `as any` to silence errors | 0 occurrences |
| ✅ | Nullable handling correct | `MaybeNumber` was **widened**, not cast away |
| ✅ | Unreachable branches absent | no `allowUnreachableCode` escape |
| ✅ | Firestore data is not assumed to match a type | row mappers validate per field |

## 26. Lint / code quality — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | ESLint clean | 0 errors, 0 warnings |
| ✅ | No suppression added to make it pass | 0 new disables |
| ✅ | No dead code | a dead binding found in Phase 9 was **removed**, not disabled |

## 27. Automated tests — PASS (with gaps)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Auth: unauthenticated, valid, role restrictions | suite |
| ✅ | Incidents: creation, validation, authorisation, transitions | 60 transition tests |
| ✅ | AI: valid, malformed, unknown, injection content, provider failure | suite |
| ✅ | Uploads: valid, invalid, oversized, unauthorised | suite |
| ✅ | Duplicate detection: below, at, above, missing location | suite |
| ✅ | Dispatch: assign, accept, reject, reassign, races | Phase 7, 6 mutations |
| ✅ | Realtime: subscribe, cleanup, reconnect, authorisation | Phase 8 + 15 new |
| ✅ | Notifications: recipient, unread/read, authorisation | Phase 9 |
| ✅ | Analytics: filtering, incomplete, zero, calculations | 54 tests, Phase 9 |
| ✅ | **Listener teardown on identity change** | **15 tests, new this phase** |
| ⚠️ | **E2E scenario** | **NEEDS REVIEW** — covered by unit/integration over mocked boundaries, not a running app. |

## 28. Firebase rule testing — NEEDS REVIEW

| | Item | Evidence |
| :-: | --- | --- |
| ⚠️ | **Allowed operations asserted** | **NOT DONE** — requires a JDK. Matrix in audit §9.1. |
| ⚠️ | **Forbidden operations asserted** | **NOT DONE** — same. |
| ✅ | Ports pre-configured | `firebase.json`: auth 9099, firestore 8080, storage 9199 |
| ✅ | Rules reviewed structurally | 135 checks |

**This is the largest gap in the checklist.** The rules are correct as far as reading
them can establish, and reading them is not enough.

## 29. Failure testing — PASS (with gaps)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Gemini unavailable | `services/ai/fallback.ts`, keyword engine |
| ✅ | Invalid AI output | Zod reject → fallback |
| ✅ | Expired/invalid auth | `toAppError` → `AUTH_REQUIRED` |
| ✅ | Firestore permission denied | mapped to a typed code, not a crash |
| ✅ | Rate-limit store unavailable | throws `503`, **not** fail-open |
| ✅ | Storage disabled in private mode | caught, sign-out still succeeds |
| ✅ | Duplicate assignment | transaction invariant |
| ✅ | Missing location | null path, never a fabricated coordinate |
| ✅ | The UI cannot hang | every listener has a stall detector |
| ⚠️ | **Firebase entirely unavailable** | **NEEDS REVIEW** — no live outage simulation. |
| ⚠️ | **Map API unavailable** | **NEEDS REVIEW** — no browser. |

## 30. Accessibility — NEEDS REVIEW

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Semantic buttons, not clickable divs | components reviewed during Phases 1–3 |
| ✅ | Colour is never the only signal | Phase 9's `variant` + text, SLA state has a label |
| ✅ | `aria-live` for realtime updates | listener region |
| ⚠️ | **Keyboard navigation** | **NEEDS REVIEW** — no browser. |
| ⚠️ | **Focus states and focus trapping** | **NEEDS REVIEW** — no browser. |
| ⚠️ | **Colour contrast measured** | **NEEDS REVIEW** — no automated `axe` run. |
| ⚠️ | **Screen-reader labels** | **NEEDS REVIEW** — no screen reader. |
| ⚠️ | **Modal accessibility** | **NEEDS REVIEW** — no browser. |
| ⚠️ | **Map accessibility fallback** | **NEEDS REVIEW** — no browser. |

## 31. Responsive QA — NEEDS REVIEW

| | Item | Evidence |
| :-: | --- | --- |
| ⚠️ | 320 px | **NEEDS REVIEW** — nothing rendered. |
| ⚠️ | 375 px | **NEEDS REVIEW** |
| ⚠️ | 390 px | **NEEDS REVIEW** |
| ⚠️ | 768 px | **NEEDS REVIEW** |
| ⚠️ | 1024 px | **NEEDS REVIEW** |
| ⚠️ | 1280 px | **NEEDS REVIEW** |
| ⚠️ | 1440 px | **NEEDS REVIEW** |
| ✅ | No fixed widths that would force overflow | layouts use flex/grid with `min-w-0`; reviewed in code |
| ✅ | Charts are wrapped for horizontal scroll | `docs/25` mobile chart rule |

**All 7 breakpoints brief §40 names are unrendered.** Layout was reviewed by reading
the CSS; that is not the same as seeing it.

## 32. Performance — PASS (with gaps)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Realtime listeners are budgeted | `MAX_REALTIME_LISTENERS`, 8-slot budget, per-listener limits |
| ✅ | A limit cannot be raised beyond its declared ceiling | registry throws |
| ✅ | Analytics reads are bounded | `LIVE_SCAN_CAP = 500`, `MAX_RANGE_DAYS = 366` |
| ✅ | No listener reads a precomputed collection | Phase 9 check (FR-099) |
| ✅ | Queries are bounded and indexed | `firestore.indexes.json`, 19 indexes |
| ✅ | Charts do not re-render needlessly | `React.memo`, stable series |
| ✅ | A query key prevents re-subscription | `queryKey` string |
| ⚠️ | **Initial load measured** | **NEEDS REVIEW** — no browser, no Lighthouse. |
| ⚠️ | **Dashboard render measured** | **NEEDS REVIEW** |
| ⚠️ | **Firestore read counts measured** | **NEEDS REVIEW** — inferred from query shape, not observed. |
| ⚠️ | **Map rendering measured** | **NEEDS REVIEW** |

## 33. Security headers — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `Content-Security-Policy` | nonce + `strict-dynamic`, no `unsafe-inline` in `script-src` (C93) |
| ✅ | `X-Content-Type-Options: nosniff` | C92 |
| ✅ | `Referrer-Policy: strict-origin-when-cross-origin` | C92 |
| ✅ | `Permissions-Policy` | camera/mic/geolocation `(self)`; everything else `()` |
| ✅ | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | C92 |
| ✅ | HSTS in production | `max-age=31536000; includeSubDomains`; no `preload` |
| ✅ | COOP `same-origin-allow-popups` | required for Google sign-in; documented |
| ✅ | `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | C92 |
| ✅ | Set in one place, for every route | `middleware.ts` |
| ⚠️ | **Enforced by a real browser** | **NEEDS REVIEW** — the header is set; nothing confirmed a browser honours it. |

## 34. Secrets in configuration — PASS

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Firebase **client** config is `NEXT_PUBLIC_*` | C91 |
| ✅ | Firebase **Admin** credentials are server-only | `server-only` import |
| ✅ | The Maps server key is never in browser code | `reverse-geocode.ts` is server-only |
| ✅ | `CRON_SECRET` is server-only and compared with a constant-time helper | `secretMatches` |
| ✅ | No administrative Firebase credential reaches the browser | C90, C91 |

## 35. Google Maps API security — NEEDS REVIEW (configuration, not code)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | No server/admin key in browser code | C90, C91 |
| ✅ | Only two Maps hosts in `img-src`/`connect-src` | C88, middleware |
| ⚠️ | **Browser key restricted by HTTP referrer** | **NEEDS REVIEW** — a Google Cloud Console setting, not a repo setting. Must be done before deploy. |
| ⚠️ | **Browser key restricted to required APIs** | **NEEDS REVIEW** — same. |
| ⚠️ | **Server key restricted by IP** | **NEEDS REVIEW** — same. |

## 36. Data retention — PARTIAL

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | Staging objects expire | `STAGING_UPLOAD_SWEEP_MIN = 30` |
| ✅ | Signed URLs are short-lived | `UPLOAD_SIGNED_URL_TTL_SEC = 900` |
| ✅ | Notifications carry an `expiresAt` | schema |
| ✅ | Soft-deleted incidents are retained for audit, and **excluded from analytics** | `deletedAt` filter |
| ⚠️ | **Retention periods for incidents, evidence, audio and audit logs** | **NEEDS REVIEW** — no policy document exists. brief §46 says not to auto-delete safety data without explicit product approval, so none is set. **A documented policy is still owed.** |
| ✅ | No automatic deletion of safety data | correct default |

## 37. Production configuration — NEEDS REVIEW (external)

| | Item | Evidence |
| :-: | --- | --- |
| ✅ | `firebase.json` declares rules and indexes, and no Hosting | hosting deliberately unset; Vercel is the target |
| ⚠️ | **Firestore rules deployed** | **NEEDS REVIEW** — `firebase deploy --only firestore:rules` not run. |
| ⚠️ | **Storage rules deployed** | **NEEDS REVIEW** — not run. |
| ⚠️ | **19 indexes deployed** | **NEEDS REVIEW** — not run. An un-deployed index is a `failed-precondition` that renders as "not enough data". |
| ⚠️ | **Authorised domains configured** | **NEEDS REVIEW** — console setting. |
| ⚠️ | **Auth providers as documented** | **NEEDS REVIEW** — console. |
| ⚠️ | **API keys restricted** | **NEEDS REVIEW** — console. |

---

## Scorecard

| Section | PASS | NEEDS REVIEW | FAIL | N/A |
| --- | :-: | :-: | :-: | :-: |
| 1 Authentication | 9 | 1 | 0 | 0 |
| 2 Authorization | 5 | 1 | 0 | 0 |
| 3 Firestore rules | 6 | 1 | 0 | 0 |
| 4 Field-level | 5 | 0 | 0 | 0 |
| 5 Storage | 9 | 2 | 0 | 0 |
| 6 API | 11 | 0 | 0 | 0 |
| 7 Rate limiting | 6 | 0 | 0 | 0 |
| 8 AI / Gemini | 16 | 1 | 0 | 0 |
| 9 Prompt injection | 5 | 1 | 0 | 0 |
| 10 XSS | 7 | 0 | 0 | 0 |
| 11 SSRF | 5 | 0 | 0 | 0 |
| 12 CSRF | 5 | 0 | 0 | 0 |
| 13 Open redirect | 4 | 0 | 0 | 0 |
| 14 Secrets | 7 | 0 | 0 | 0 |
| 15 Logging | 5 | 0 | 0 | 0 |
| 16 Audit logs | 5 | 0 | 0 | 0 |
| 17 Location privacy | 8 | 1 | 0 | 0 |
| 18 Responder location | 4 | 1 | 0 | 0 |
| 19 Dispatch | 6 | 1 | 0 | 0 |
| 20 Duplicate detection | 6 | 0 | 0 | 0 |
| 21 Realtime | 8 | 1 | 0 | 0 |
| 22 Notifications | 9 | 0 | 0 | 0 |
| 23 Analytics privacy | 8 | 1 | 0 | 0 |
| 24 Dependencies | 6 | 0 | 0 | 0 |
| 25 TypeScript | 6 | 0 | 0 | 0 |
| 26 Lint | 3 | 0 | 0 | 0 |
| 27 Automated tests | 12 | 1 | 0 | 0 |
| 28 Firebase rule testing | 2 | 2 | 0 | 0 |
| 29 Failure testing | 9 | 2 | 0 | 0 |
| 30 Accessibility | 3 | 6 | 0 | 0 |
| 31 Responsive QA | 2 | 7 | 0 | 0 |
| 32 Performance | 7 | 5 | 0 | 0 |
| 33 Security headers | 9 | 1 | 0 | 0 |
| 34 Secrets in configuration | 5 | 0 | 0 | 0 |
| 35 Maps API | 2 | 3 | 0 | 0 |
| 36 Data retention | 5 | 1 | 0 | 0 |
| 37 Production config | 1 | 6 | 0 | 0 |

**0 FAIL. 0 N/A.** Every NEEDS REVIEW is an item that needs a browser, a JDK, a
deployed Firebase project, or a Google Cloud console — **not** a code defect, and not
something this environment can settle.

### The three that matter most

1. **§28 — the rules have never been executed.** Everything in §3, §5, §17, §18 and
   §19 about rules is *structural*. Install a JDK, run `npm run test:rules`.
2. **§30/§31 — nothing has been rendered.** Keyboard, focus, contrast, screen readers
   and all 7 breakpoints are unverified. A `docs/25` claim is not a measurement.
3. **§35/§37 — external configuration.** Key restrictions, authorised domains,
   deployed rules and deployed indexes. An un-deployed index is the nastiest: the
   query fails as `failed-precondition` and the UI renders it as "not enough data" —
   a quiet failure that looks like a quiet week.

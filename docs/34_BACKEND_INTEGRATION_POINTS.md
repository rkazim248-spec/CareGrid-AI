# 34 — Backend integration points

**Project:** CareGrid AI
**Document type:** Where every future integration connects
**Status:** Written after Phase 3 (the backend foundation). Every path in it exists today.
**Audience:** Whoever starts Phase 4, and anyone reviewing whether the foundation is real
**Related:** [08 API Specification](./08_API_SPECIFICATION.md) · [09 AI / Gemini Specification](./09_AI_GEMINI_SPECIFICATION.md) · [12 Map & Location](./12_MAP_LOCATION_SYSTEM.md) · [13 Notification System](./13_NOTIFICATION_SYSTEM.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [30.4 Phase 3 Foundation](./30.4_PHASE_3_FOUNDATION.md)

---

## 0. Why this document exists

Phase 3's whole purpose was to make the next integration a five-step operation rather than a
refactor. This is the proof, and it is written down so nobody has to read the code to find it.

**The test of whether the abstraction is real:** adding a real provider later must not require
touching a route handler, a component, or a service. If connecting Gemini required editing
`app/api/incidents/route.ts`, the abstraction did not exist — it was a comment.

```text
  1. Create the environment variable      (docs/21 §2 already names it)
  2. Add the secret locally                (.env.local, git-ignored)
  3. Add the secret to Vercel              (project environment)
  4. Implement the provider adapter        (ONE file, behind an existing interface)
  5. Call it through the backend           (the service already calls the interface)
```

Nothing outside the provider directory changes. Sections 1-7 below say exactly which file is
which step.

---

## 1. Gemini — Phase 4

### 1.1 Where it connects

| Concern | Exact location | Exists |
| --- | --- | --- |
| The secret is read | `lib/env.server.ts` → `geminiConfig()`, `geminiStatus()` | Yes |
| The adapter | `services/integrations/gemini/index.ts` | Yes, non-functional |
| The interface | `lib/integrations/contracts.ts` → `TriageProvider` | Yes |
| The business logic | `services/ai/triage.ts` → `triageIncident()` | Yes |
| The sanitisation boundary | `services/ai/triage.ts` → `toTriageRequest()` | Yes |
| The probe endpoint | `app/api/ai/triage/route.ts` | Yes |
| **The prompt** | `services/ai/prompts.ts` | **No — Phase 4** |
| **The JSON output schema** | `services/ai/schema.ts` | **No — Phase 4** |
| **The SDK client** | `services/integrations/gemini/client.ts` | **No — Phase 4** |
| **The deterministic rules R1-R10** | `services/ai/rules.ts` | **No — Phase 4** |
| **The keyword fallback engine** | `services/ai/fallback.ts` | **No — Phase 4** |

### 1.2 What Phase 4 edits

**Exactly one directory.** `services/integrations/gemini/` plus, optionally, new files in
`services/ai/`. No route, no component, no validator changes, and no new environment variable
(`GEMINI_API_KEY` is already declared and read).

```text
services/integrations/gemini/index.ts   replace UnconfiguredGeminiProvider.triage()
services/integrations/gemini/client.ts  NEW — lazy, memoised GoogleGenAI
services/ai/prompts.ts                  NEW — the triage-v3 prompt, PROMPT_VERSION already defined
services/ai/schema.ts                   NEW — the output contract, validated by validators/ai.ts
services/ai/rules.ts                    NEW — R1-R10, pure and unit-testable
services/ai/fallback.ts                 NEW — the keyword engine
```

### 1.3 What Phase 4 must NOT do

These are not style preferences; each is a prohibition with a documented failure mode.

| Prohibition | Why | Where |
| --- | --- | --- |
| Add a field to `TriageResult` for a coordinate, a casualty count, or a resource | docs/09 §1.2 forbids the model from producing any of them, and a schema that accepts one is an invitation | `lib/integrations/contracts.ts` |
| Route a `TriageResult` to a dispatch or a lifecycle transition beyond `new → triaged` | MUST NOT 8. The AI never dispatches | `services/ai/triage.ts` |
| Let `triageIncident()` throw at its caller | FR-029: a report is never blocked by the AI | `services/ai/triage.ts` |
| Put a raw SDK error in a response | It may carry an API key and a request id. Throw `AppError` | `services/integrations/gemini/client.ts` |
| Read `process.env` in the adapter | It would be a second reader, and `scripts/security-check.cjs` fails the build | anywhere |
| Return a fabricated category or urgency when the call fails | A fabricated triage decision on a real emergency | `services/ai/triage.ts` |
| Change `PROMPT_VERSION` without updating the golden files | `aiRuns.promptVersion` stops meaning anything | `services/ai/prompts.ts` |

### 1.4 The dependency decision

`@google/genai`. Approved in [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md); the deprecated
`@google/generative-ai` is not used (MUST 3). Not installed today because it has no caller, and
a dependency with no caller is a dependency nobody has justified.

### 1.5 How to know it worked

Without touching a route or a component:

```bash
# 1. add GEMINI_API_KEY to .env.local
curl -X POST localhost:3000/api/ai/triage \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"A man has collapsed near the bus stop and is not responding."}'
# 2. triage.source flips from "fallback" to "ai", needsReview reflects the
#    confidence, and providerAvailable is true.
```

That is the whole acceptance test, and it exists today in its failing form.

---

## 2. Google Maps — Phase 6

| Concern | Exact location | Exists |
| --- | --- | --- |
| The server secret is read | `lib/env.server.ts` → `googleMapsConfig()`, `googleMapsStatus()` | Yes |
| The browser key is read | `lib/env.client.ts` → `getPublicMapsConfig()` | Yes |
| The adapter | `services/integrations/google-maps/index.ts` | Yes, non-functional |
| The interface | `lib/integrations/contracts.ts` → `GeocodingProvider` | Yes |
| **The Geocoding API calls** | `services/integrations/google-maps/geocoding.ts` | **No — Phase 6** |
| **The map component** | `components/map/live-map.tsx` | **No — Phase 6** |

### 2.1 The two keys, and why they are two files

| Key | Read by | Restricted by | In the browser? |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | `lib/env.client.ts` | HTTP referrers | Yes, by necessity |
| `GOOGLE_MAPS_SERVER_KEY` | `lib/env.server.ts` | IP addresses (Vercel egress) | **Never** |

The browser key loads the Maps JavaScript API, so it is public by construction and is protected
by referrer and API restriction. The server key is billed per call and must never ship.
`serverEnvProblems()` treats a `NEXT_PUBLIC_*` value containing `-----BEGIN` as a configuration
fault, and `scripts/security-check.cjs` fails the build on the same condition.

### 2.2 The failure mode this foundation is protecting against

**A geocoder that returns `0, 0` when it has no key puts a fabricated location in the middle of
the Indian Ocean on a real emergency report, and sends every responder there.**

`toGeoPoint()` rejects an out-of-range coordinate as `null` rather than rendering it, and the
unconfigured provider throws `MAPS_UNAVAILABLE` rather than returning a point. Both are asserted
in `tests/unit/api/integrations.test.ts`.

### 2.3 The list fallback is already the documented behaviour

docs/12 §9 makes the list the mandatory fallback when the map cannot load.
`getPublicMapsConfig().mapsProblem` carries the sentence, so the failure is a rendered state and
not a blank panel.

---

## 3. Twilio (SMS and WhatsApp) — Phase 9

| Concern | Exact location | Exists |
| --- | --- | --- |
| The three secrets are read | `lib/env.server.ts` → `twilioConfig()`, `twilioStatus()` | Yes |
| The channels | `services/integrations/twilio/index.ts` | Yes, non-functional |
| The interface | `lib/integrations/contracts.ts` → `NotificationChannel` | Yes |
| **The SDK calls** | `services/integrations/twilio/sms.ts`, `whatsapp.ts` | **No — Phase 9** |
| **The in-app channel** | `services/notifications/` | **No — Phase 9** |

### 3.1 What exists today, and it is not nothing

- `availableChannels()` returns `['in_app']`. **In-app is unconditional.** Turning off SMS must
  not turn off every user-visible alert.
- `PATCH /api/me` **refuses** `notifPrefs.sms: true` and `.whatsapp: true` with
  `422 NOTIFICATION_DISABLED`, naming the field.
- `GET /api/me` **forces** both to `false` in the response, so a document written by any other
  path still reports the truth.
- The profile switches are rendered disabled with the server's own sentence as the reason.

A stored preference the system cannot honour is worse than not offering the switch: it looks
saved and then silently fails on every send, which is the failure mode a user cannot debug.

### 3.2 The refusal is `422`, not `502` or `503`

The answer is **permanent for this deployment**. A `502` or a `503` would make a well-behaved
client retry a send that can never succeed.

### 3.3 The cost note

SMS is billed per segment and WhatsApp per conversation. A flood is a bill. `dedupeKey` (FR-108)
means one notification is one message, and the rate limit on `POST /api/notifications` is the
backstop.

---

## 4. The incident system — docs/30 Phase 3 (database + incidents)

| Concern | Exact location | Exists |
| --- | --- | --- |
| Collection names | `config/collections.ts`, `config/collections.ts` `SUB_COLLECTIONS` | Yes |
| Firestore → DTO + redaction | `lib/server/serialize.ts` | Yes |
| Route pipeline | `lib/server/route.ts` → `withRequest` | Yes |
| Authorization | `lib/server/permissions.ts` → `requireCapability` | Yes |
| Rate limiting | `lib/server/rate-limit.ts` | Yes |
| Validation primitives | `validators/common.ts`, `validators/query.ts` | Yes |
| **Lifecycle table** | `lib/incidents/lifecycle.ts` | **No — Phase 3/4** |
| **The create pipeline** | `services/incidents/create-incident.ts` | **No** |
| **The incident routes** | `app/api/incidents/**` | **No** |

The pipeline a new incident route gets, with no new plumbing:

```ts
export const POST = withRequest(
  {
    body: createIncidentBodySchema,   // validators/incident.ts
    auth: 'required',
    rateLimit: 'incidents.create',    // RATE_LIMIT_RULES
    params: undefined,
  },
  async (ctx) => {
    requireCapability(ctx.user, 'r01_createIncident', { requestId: ctx.requestId });
    return { status: 201, data: serializeIncident(await createIncident(ctx.body, ctx)) };
  },
);
```

### 4.1 Where the documents disagree, and which won

The Phase 3 brief asked for a `lib/repositories/` layer. **It was not built**, and the reason is
recorded rather than quietly ignored:

- docs/20 §1 P3: `lib/` is PURE — no Firebase, no `fetch`, no React. A repository that touches
  Firestore breaks that.
- docs/06 §2.2: `lib/*` may not import `firebase-admin`. Only `lib/firebase/*` may.
- docs/06 §5.1: **services own transactions.** There is no repository layer in the architecture.
- docs/32 MUST 2: no inverting a layer; MUST 14: a layer added "for later" is a layer nobody
  justified.

So in this project `services/` **is** the data-access layer, and
`lib/server/serialize.ts` is the pure Firestore→DTO mapping that a repository would otherwise
have absorbed. Building `lib/repositories/` would have added a layer the documentation forbids,
in a directory the documentation declares pure.

---

## 5. Realtime — docs/30 Phase 6+

| Concern | Exact location | Exists |
| --- | --- | --- |
| `connect-src` allows `wss://*.firebaseio.com` | `middleware.ts` | **Yes, pre-declared** |
| The client Firebase SDK | `lib/firebase/client.ts`, `lib/firebase/auth.ts` | Yes |
| The listener budget (8 per client, every query limited) | docs/11 §read-budget | Phase 6 |
| The listener registry | `lib/firebase/listener-registry.ts` | Phase 6 |

The CSP already permits the WebSocket transport, so a realtime listener in Phase 6 will not be
blocked by a policy change under deadline. That is the whole reason the host is pre-declared.

---

## 6. CSP items that still have to be added

Already in `middleware.ts` and pre-declared for a feature that does not exist yet:

| Directive | Host | For |
| --- | --- | --- |
| `script-src` | `https://maps.googleapis.com`, `https://maps.gstatic.com` | Phase 6 map |
| `img-src` | the same two, plus `firebasestorage.googleapis.com` | map tiles, evidence |
| `media-src` | `blob:`, `https://firebasestorage.googleapis.com` | voice reports |
| `connect-src` | `https://maps.googleapis.com` | geocoding from the browser |
| `worker-src`, `child-src` | `blob:` | Firestore listeners, the map |

**Still to add, with the exact text:**

| When | Directive | Value | Why |
| --- | --- | --- | --- |
| Phase 9 | `report-uri` | `report-uri /api/cron/csp-report` | docs/10 §15.2. Not declared now: the endpoint does not exist, and declaring it would point every browser at a 404 on every page. The receiving endpoint is `CRON_SECRET`-gated, treats reports as untrusted input, caps them at 4 KiB, and never renders them. |
| Phase 6 | `script-src` | (verify) | If the Maps loader is loaded by a nonce-bearing bundle module, `strict-dynamic` already covers it and no host entry is needed. The two hosts are pre-declared so that question is never answered under deadline. |

**Do not loosen these to make something work:**

- `script-src` must never gain `'unsafe-inline'`. It defeats the policy.
- `script-src-attr` must stay `'none'`. A nonce cannot cover an inline `onclick`.
- `img-src` must not become `https:`. That permits exfiltration to any host.
- `Cross-Origin-Opener-Policy` must stay `same-origin-allow-popups`. `same-origin` severs the
  window handle `signInWithPopup` needs and breaks Google sign-in with nothing in the console.
- `Permissions-Policy` must keep `camera=(self)` and `microphone=(self)`. `()` blocks image
  evidence and voice reporting at the browser, permanently, for reasons invisible in the code
  that uses them. **This was a real Phase 2 bug, found in Phase 3.**

---

## 7. One-page summary

| Integration | Secret(s) | Adapter to implement | Interface | Called from | Phase |
| --- | --- | --- | --- | --- | --- |
| **Gemini** | `GEMINI_API_KEY` | `services/integrations/gemini/index.ts` | `TriageProvider` | `services/ai/triage.ts` | 4 |
| **Google Maps (server)** | `GOOGLE_MAPS_SERVER_KEY` | `services/integrations/google-maps/index.ts` | `GeocodingProvider` | services, Phase 6 | 6 |
| **Google Maps (browser)** | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | `components/map/live-map.tsx` | (none; the SDK) | the map | 6 |
| **Twilio SMS** | the Twilio triple | `services/integrations/twilio/index.ts` | `NotificationChannel` | `services/notifications/` | 9 |
| **Twilio WhatsApp** | the Twilio triple | `services/integrations/twilio/index.ts` | `NotificationChannel` | `services/notifications/` | 9 |
| **Incidents** | — | `services/incidents/**` | plain functions | `app/api/incidents/**` | 3/4 |
| **Realtime** | — | `lib/firebase/listener-registry.ts` | `onSnapshot` | features | 6 |
| **Uploads** | — | `services/uploads/**` | signed URLs | `app/api/uploads/**` | 5 |

Every row's "Secret(s)" column names variables that are **already declared** in `.env.example`
and **already read** by `lib/env.server.ts`. None of them requires a new environment variable to
be added in a later phase, and none is a placeholder.

---

## 8. Honest limitations of this foundation

Stated here rather than discovered later.

| # | Limitation | Consequence | Where it is recorded |
| --- | --- | --- | --- |
| 1 | The rate-limit bucket needs a transaction and a running Firestore, so the bucket itself is not unit-tested | The rule table, the key hashing, the IP handling, and the constant-time compare **are** tested; the increment is not | `tests/unit/api/rate-limit.test.ts` names this; the transaction test is Phase 10 (`tests/integration/`) |
| 2 | No route is exercised over HTTP in CI | An ordering or header bug that only appears at runtime would not be caught here | `tests/unit/api/route-pipeline.test.ts` asserts the pipeline order and the headers **from the source**, which is the level at which those mistakes are made |
| 3 | The AI, Maps, and Twilio adapters are non-functional | Each returns a typed, non-fatal error naming the missing variable | `tests/unit/api/integrations.test.ts` |
| 4 | `GET /api/health` reports configuration, not operational readiness | It cannot tell you Firestore is down | Deliberate: a health check that blocks on four third parties reports their outages as ours. Phase 9 adds the 1.5 s pings with the documented 30 s cache |
| 5 | The `NEXT_PUBLIC_` publishing check reads the source tree, not the built bundle | A `next.config.ts` `env:` block could still publish a secret | docs/21 §6 specifies a bundle check (`scripts/check-bundle.ts`); Phase 10 |
| 6 | `notificationReads` is in `config/collections.ts` but not yet in `firestore.rules` | It is CLOSED, not open, because of the deny-by-default catch-all, so it surfaces in Phase 9 development | `config/collections.ts` says so; `tests/unit/api/environment.test.ts` cross-references the table against the rules file |
| 7 | The `validators/` barrel does not yet export a `registry` domain | No registry endpoint exists | docs/20 §2 lists it; a schema with no route is dead code |
| 8 | Phase 3 introduced and then fixed a bug where the rate limiter made `GET /api/health` return 503 in an unconfigured deployment | Fixed, and the gate is now asserted in `tests/unit/api/route-pipeline.test.ts` | [30.4 §5.4](./30.4_PHASE_3_FOUNDATION.md) — recorded because "Phase 3 found and fixed its own regression" is more useful than a clean record that hides it |
| 9 | The rate limit runs **before** the role gate, keyed on the unverified `sub` | A caller with no permission can burn another subject's quota by hitting a route it is refused | [30.4 §6 D-4](./30.4_PHASE_3_FOUNDATION.md). The key reason: the uid does not exist until after authentication. Marked **provisional**; Phase 4 revisits it when `POST /api/incidents` and its 5/h + 20/day limits exist |

**Do not delete these limitations from this document.** They are the honest boundary of what has
been verified.

# 26 — Performance Requirements

**Project:** CareGrid AI
**Document type:** Non-functional performance specification (source of truth for every budget in the project)
**Status:** Baseline v1.0 — approved for implementation
**Related documents:** [01 PRD §7 NFR table](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) · [02 Technical Requirements Document](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) · [03 System Architecture](./03_SYSTEM_ARCHITECTURE.md) · [07 Database Schema §15](./07_DATABASE_SCHEMA.md) · [08 API Specification](./08_API_SPECIFICATION.md) · [09 AI / Gemini Specification](./09_AI_GEMINI_SPECIFICATION.md) · [12 Map & Location System](./12_MAP_LOCATION_SYSTEM.md) · [18 Testing & QA Plan](./18_TESTING_QA_PLAN.md) · [23 Data Flow Diagrams](./23_DATA_FLOW_DIAGRAMS.md)

---

## 0. The one-paragraph version

> The scarce resource in CareGrid AI is **not** server CPU — it is **Firestore operations**, because Firestore is priced per operation and the demo runs on a free daily allowance. Every performance decision in this document is therefore a **read** decision. Second-order scarce resources are: the Gemini request quota (which is why AI is never on the critical path), the Google Maps monthly credit (which costs real money if it is exceeded), and the mobile client's main thread on a low-end Android (which is why `/report` has a hard 140 KB gzip budget). Nothing here optimises for a benchmark; every number traces to an FR or an NFR.

### 0.1 Budget ownership

| Budget | Owner | Measured in | Failing it means |
| --- | --- | --- | --- |
| NFR-001/002 LCP/INP | Frontend | Lighthouse CI on every PR | CI red; the PR cannot merge |
| Per-route JS bundle | Frontend | `next build` output, size-analyser, CI threshold | CI red |
| API p95 latency (excluding AI) | Backend | Load script, [26 §11](#11-load-test-plan) | Release blocker |
| AI p95 latency | AI layer | `aiRuns.latencyMs` | `GET /api/admin/system/health` flags it; media dropped from the AI call |
| Firestore reads per dispatcher session-hour (NFR-007) | Database | Load script + Firestore usage dashboard | Queue/map limits are reduced; the daily allowance is at risk |
| Listener count per client (FR-091) | Frontend | Lint rule + a unit test on the hook | CI red |
| Maps credit | Maps | Google Cloud budget alert | **Real money** ([02 §7.5](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) |

### 0.2 How to read a percentage in this document

Every latency target is stated at a specific percentile, on a specific connection, on a specific device class. A target without those three qualifiers is not a target. Where the PRD states a target without a percentile, this document supplies the p95 interpretation and says so.

---

## 1. Targets table — every NFR, with the number we commit to

| NFR | PRD target | Committed measurement | Percentile / condition | Verified by | Where |
| --- | --- | --- | --- | --- | --- |
| **NFR-001** | LCP on `/dashboard` ≤ 2.5 s | LCP ≤ **2.5 s** | p75, desktop, simulated 4G, warm server region, Lighthouse CI mobile-throttled desktop preset | Lighthouse CI | §2.1 |
| **NFR-002** | Interactive on `/report` ≤ 3.0 s | INP ≤ **200 ms** and TTI-equivalent ≤ **3.0 s** | p75, mid-range Android, simulated 4G | Lighthouse CI + a Playwright run on a throttled profile | §2.1 |
| **NFR-003** | `POST /api/incidents` server time excluding AI ≤ 800 ms | ≤ **800 ms** | p95, warm instance, demo data volume | Load script | §4.1 |
| **NFR-004** | Gemini triage ≤ 8 s p95, hard timeout 20 s | ≤ **8 s** p95; hard abort at **20 000 ms** | p95 over ≥ 30 runs | `aiRuns.latencyMs` distribution | §4.2 |
| **NFR-005** | Map interactive ≤ 3 s after script load | SDK loaded and first frame rendered ≤ **3.0 s**; `/map` LCP ≤ 3.5 s | p75, 4G, warm HTTP cache for the SDK | Lighthouse CI + manual | §7 |
| **NFR-006** | Realtime propagation ≤ 3 s | **≤ 3 s** end to end: server commit → client render | p95 | Instrumented load script + manual observation | §6 |
| **NFR-007** | ≤ 4 000 document reads per dispatcher session-hour | ≤ **4 000** | Per 60-minute session, cumulative | Load script + Firestore usage dashboard | §5.4 |
| **NFR-008** | 10 concurrent dispatchers | **10** sustained, all actions working | Load test | Load script | §11.3 |
| **NFR-009** | 50 citizens submitting per minute burst | **50/min** for 10 minutes | Load test | Load script | §11.3 |
| **NFR-010** | 50 000 incidents stored | **50 000** | 3-year hackathon-scale horizon; query budgets must not depend on total count | Firestore + analytics rollups | §5.6 |
| **NFR-011** | 99.5% design target, best effort | Report, do not gate on it | — | Vercel status + Firebase status | §10.3 |
| **NFR-012** | Map, AI, and realtime failure each degrade gracefully | Each of the three has a tested degraded path | — | E2E + manual fault injection | §9.4 |
| **NFR-013** | No secret in the client bundle | **0** | CI gate | `gitleaks` + a build-output scan + a lint rule | §10.4 |
| **NFR-014** | Firestore and Storage rules deployed and tested | **100%** rules tests pass on every PR | — | `@firebase/rules-unit-testing` against the emulator | §10.4 |
| **NFR-015** | Server-side authorization on every route | **100%** of routes | Per-request `users/{uid}` read; never a client role | Unit + integration tests, one per permission-matrix row | §9.1 |
| **NFR-016** | Rate limiting on all write endpoints | **100%** of write routes | — | Integration test per route class | §9.2 |
| **NFR-017** | WCAG 2.1 AA, 0 serious violations | **0** serious, **0** critical | Automated axe + manual keyboard audit | E2E axe + manual | §9.5 |
| **NFR-018** | Full keyboard operability of report form, queue, map list fallback | **100%** | Manual + Playwright keyboard-only runs | Manual audit | §9.5 |
| **NFR-019** | `prefers-reduced-motion` respected | Required | — | Manual + a media-query test | §9.5 |
| **NFR-020** | Viewports 360, 390, 768, 1024, 1440 px; no horizontal scroll at 360 | **0** overflow at any of the five | — | Playwright screenshot per viewport | §2.4 |
| **NFR-021** | Touch targets ≥ 44 × 44 px | **100%** of primary actions | — | Manual + a DOM assertion in E2E | §2.4 |
| **NFR-022** | `strict: true`, zero `any` in `app/ features/ services/ lib/` | **0** | — | `tsc --noEmit` + ESLint | §10.4 |
| **NFR-023** | ESLint + Prettier clean | **0** errors | — | CI | §10.4 |
| **NFR-024** | No component over 400 lines in `features/` or `components/` | Enforced | — | Custom ESLint rule / review | §10.4 |
| **NFR-025** | Every API route exports a Zod schema referenced in [08](./08_API_SPECIFICATION.md) | **100%** | — | Review + a schema-export test | §10.4 |
| **NFR-026** | Total infrastructure cost $0 | **$0** | Conditional on the Maps budget alert | [02 §7](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) | §12 |
| **NFR-027** | Reporter identity not exposed to responders | Enforced | — | Integration test per redaction rule | §9.1 |
| **NFR-028** | Precise location not retained > 90 days after closure | **90 days** | Plus an admin extension | `purge-closed-locations` job | §8.4 |
| **NFR-029** | No proprietary lock-in beyond Firebase/Google, documented | Documented | — | ADR register | [03 §13](./03_SYSTEM_ARCHITECTURE.md) |
| **NFR-030** | Structured logs with `requestId`; client reporter default-disabled | Required | — | `GET /api/admin/system/health` + log format check | §10.2 |

---

## 2. Page-load budget

### 2.1 Core Web Vitals per route

LCP, INP, and CLS are measured at **p75 over field data** in production; in CI they are measured in **Lighthouse** (lab data), which is stricter and more variable. The Lighthouse thresholds below are therefore tighter than the p75 targets in §1 — that is intentional, so CI catches a regression before field data does.

| Route | Role | LCP p75 (field) | LCP CI (lab) | INP p75 | CLS p75 | JS budget (gzip) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/report` | citizen | ≤ 1.8 s | ≤ **1.8 s** | ≤ **200 ms** | ≤ **0.05** | **≤ 140 KB** | NFR-002. The form must be interactive ≤ 3.0 s on a mid-range Android. No map, no chart, no listener |
| `/track?ref=CG-XXXXXX` | citizen | ≤ 1.5 s | ≤ 1.5 s | ≤ 200 ms | ≤ 0.05 | ≤ 110 KB | Public-facing, no listener (FR-095) |
| `/dashboard` | dispatcher | ≤ **2.5 s** | ≤ **2.5 s** | ≤ **200 ms** | ≤ **0.10** | ≤ **200 KB** | NFR-001. **The map is not in this bundle** (FR-086). RSC does the first read |
| `/map` | dispatcher | ≤ 3.5 s | ≤ 3.5 s | ≤ 250 ms | ≤ 0.10 | ≤ 120 KB shell + **≤ 180 KB lazy chunk** | NFR-005. The Maps SDK is fetched after first paint |
| `/incidents/[id]` | all | ≤ 2.0 s | ≤ 2.0 s | ≤ 200 ms | ≤ 0.05 | ≤ 160 KB | Detail with timeline, AI panel, evidence |
| `/responders` | responder/dispatcher | ≤ 2.0 s | ≤ 2.0 s | ≤ 200 ms | ≤ 0.05 | ≤ 150 KB | Mostly server-rendered list |
| `/analytics` | dispatcher/admin | ≤ 2.5 s | ≤ 2.5 s | ≤ 300 ms | ≤ 0.10 | ≤ 190 KB | Recharts is dynamically imported; charts paint into a skeleton |
| `/admin/audit-logs` | admin | ≤ 2.0 s | ≤ 2.0 s | ≤ 200 ms | ≤ 0.05 | ≤ 150 KB | Filterable table with CSV export |
| `/login` | all | ≤ 1.2 s | ≤ 1.2 s | ≤ 150 ms | ≤ 0.05 | ≤ 95 KB | Auth is client-side; no listener (FR-095) |

### 2.2 JavaScript bundle budget — the numbers are hard

| # | Budget | Limit (gzip) | Applies to | Enforced by |
| --- | --- | --- | --- | --- |
| B-1 | **Initial shared JS** on every route | **≤ 220 KB** | React 19, Next runtime, Tailwind CSS, shadcn/ui primitives actually used, the Firebase client SDK, `lib/validation`, `date-fns` (tree-shaken) | `next build` size report + a CI threshold |
| B-2 | **`/report` route total** (shared + route) | **≤ 140 KB** | `react-hook-form` + resolver, `zod`, geolocation hook, `MediaRecorder` hook, IndexedDB draft, local action queue | CI threshold |
| B-3 | **`/map` lazy chunk** | **≤ 180 KB** | `@vis.gl/react-google-maps` + the map components + marker/cluster code. **Not** in the initial bundle | CI threshold + a bundle-analyser assertion that `/map` code is absent from `/dashboard` |
| B-4 | `/dashboard` route total | ≤ 200 KB | Queue table, KPI tiles, filter bar, bulk actions | CI |
| B-5 | `/analytics` Recharts chunk | ≤ 110 KB | Recharts 3 and the chart components, dynamically imported | CI |
| B-6 | Single dependency budget | ≤ 90 KB gzip | Any single npm package in a client chunk, except the Firebase SDK | Bundle-analyser warning that fails on the top 3 offenders |
| B-7 | Per-symbol budget | ≤ 12 KB gzip | Any single exported symbol in a client chunk | Bundle-analyser report, reviewed |

**How these are measured.** `next build` emits per-route first-load JS. A CI step compares the emitted sizes against this table and exits non-zero on a breach. Because the same numbers appear in the PR description, a regression is a code-review conversation, not a surprise.

**What is deliberately in B-1 and why it cannot be removed:**

| Package | Why it is in the shared bundle |
| --- | --- |
| `react`, `react-dom`, Next client runtime | Non-negotiable |
| `firebase` (auth + firestore) | The session and the listeners are used on every authenticated surface. Firestore is the realtime transport (ADR-009) |
| Tailwind CSS output | One stylesheet; the class purge is the size control |
| shadcn/ui primitives in use | Dialog, popover, select, combobox, toast anchor. Each is copied in, so each is auditable |
| `zod` | Shared between the client form resolvers and the server schemas. The client cost is real and accepted — it buys one source of validation truth (FR-142) |
| `date-fns` | Tree-shaken to the ~6 functions used for `APP_TIMEZONE` display. Importing from `date-fns` root is a lint error; subpath imports are required |

**What must be dynamically imported (never in an initial chunk):**

| Module | Why | Loaded when |
| --- | --- | --- |
| `components/map/*` + `@vis.gl/react-google-maps` | FR-086: the map MUST NOT be in the initial bundle of `/dashboard` | `/map` route only, after first paint |
| `recharts` + `features/analytics/**` | Bundle weight with no value on first paint | `/analytics` and the analytics tab of `/dashboard` |
| `pdf`/export helpers | Not used in v1 | — |
| `lib/duplicates/score.ts` on the client | Only the *explanation* is rendered client-side; the scoring itself is server-only | n/a |

### 2.3 Asset budgets

| Asset | Limit | Notes |
| --- | --- | --- |
| Above-the-fold images on `/report`, `/dashboard` | 0 | The report form has no imagery; the dashboard has icons only |
| A `lucide-react` icon | ≤ 1 KB gzip each | Tree-shaken; only referenced icons are bundled |
| Custom font files | **0** (system font stack) | A web font on the report route is a direct LCP regression on a low-end Android for zero brand value at 360 px |
| A chart SVG | ≤ 150 KB DOM-serialised | Bounded by the 366-day API max span |
| Marker cluster DOM nodes | ≤ **150** | See §7.3 |
| Audio captured in the browser | ≤ 15 MB, ≤ 120 s | Client stops recording at 120 s with a visible message (US-003 criterion 2) |

### 2.4 Responsiveness and touch performance

| Viewport | Requirement | Assertion |
| --- | --- | --- |
| 360 px | No horizontal scroll, keyboard closed, one-handed report completion in ≤ 30 s | Playwright screenshot at 360×640 + `document.scrollWidth <= innerWidth` |
| 390 px | Same | Screenshot |
| 768 px | Two-column where useful, no overflow | Screenshot |
| 1024 px | Sidebar + content | Screenshot |
| 1440 px | Maximum content width; the queue may use the full width | Screenshot |
| Touch | Every primary action ≥ 44 × 44 px; the record button ≥ 56 px | DOM assertion in E2E over `[data-testid="primary-action"]` |
| Scroll | No `content-visibility` trickery that breaks find-in-page or the a11y tree | Review |

---

## 3. Server rendering and the first-paint read

| Surface | Render strategy | Data source | Budget |
| --- | --- | --- | --- |
| `/report` | Static shell + a client form island | none on the server beyond the session check | 0 Firestore reads on first paint |
| `/track` | Dynamic, `no-store` | 1 incident read + 1 status-history range read | ≤ 25 reads |
| `/dashboard` | Dynamic, `no-store` | RSC: queue `limit(50)`, KPI aggregate `limit(20)`, responder snapshot `limit(50)` | **≤ 120 reads** ([07 §15](./07_DATABASE_SCHEMA.md)) |
| `/map` | Dynamic shell, map island lazy | RSC: config + resources only; incidents arrive via the viewport listener | ≤ 20 reads |
| `/incidents/[id]` | Dynamic, `no-store` | 1 incident + subcollection ranges, all bounded | ≤ 40 reads |
| `/analytics` | Dynamic, `no-store` | 1 rollup read per day in range, or a bounded live scan | ≤ 366 reads |
| `/admin/audit-logs` | Dynamic, `no-store` | 1 bounded, filtered range query | ≤ 50 reads |

**Why the dashboard does not fetch from the client:** the first read happens on the server with the Admin SDK, where the role is already authoritative, so there is no "unauthenticated flash, then a 403" sequence and no extra round trip. This is the single largest LCP lever available and it costs one server read.

**The 120-read first paint is the number to watch.** It is composed of 50 (queue) + 20 (KPI window) + 50 (responder snapshot). If the queue grows, this number does **not** grow — the `limit(50)` is fixed. If the responder count grows past 50, the candidate ranking still reads ≤ 60 ([07 §12.1](./07_DATABASE_SCHEMA.md)) but the *snapshot* used for the "available responders" tile must stay capped. Cap it and label the tile "showing 50 of N" if N is larger.

---

## 4. API latency budget

### 4.1 Per-endpoint budgets (AI excluded where stated)

All budgets are **p95 on a warm instance** with demo-scale data (≈ 3 000 incidents, 60 responders, 14 days of rollups). Cold-start latency is measured separately and reported, never hidden.

| Endpoint | p50 | **p95** | p99 | Dominant cost | Excludes |
| --- | --- | --- | --- | --- | --- |
| `POST /api/me/bootstrap` | 90 ms | **250 ms** | 500 ms | 1 read + 2 writes | — |
| `GET /api/me` | 70 ms | **200 ms** | 400 ms | 2 reads | — |
| `POST /api/uploads/sign` | 60 ms | **180 ms** | 350 ms | Signed-URL generation (local HMAC) | The client's `PUT` |
| `POST /api/uploads/finalize` | 140 ms | **400 ms** | 800 ms | Storage `stat` + first 4 KiB read | — |
| `GET /api/uploads/:mediaId/url` | 60 ms | **160 ms** | 300 ms | Signed-URL generation + 1 authorization read | — |
| `GET /api/incidents?limit=25` | 120 ms | **350 ms** | 700 ms | 25 reads | — |
| `GET /api/incidents?limit=100` | 220 ms | **600 ms** | 1 100 ms | 100 reads | — |
| `GET /api/incidents/:id` | 180 ms | **500 ms** | 900 ms | Incident + 3 subcollection ranges + signed URLs | Gemini content download for an image |
| **`POST /api/incidents`** | **420 ms** | **800 ms** (NFR-003) | 1 500 ms | 1 user read + ≤ 50 duplicate candidates + transaction + Storage verify + reverse geocode | **AI triage** — budgeted in §4.2 |
| `PATCH /api/incidents/:id` | 180 ms | **450 ms** | 800 ms | 1 read + transaction + duplicate re-run when location changes | — |
| `PATCH /api/incidents/:id/status` | 150 ms | **400 ms** | 750 ms | 1–2 reads + 2 writes in a transaction | Notification fan-out (fire-and-forget) |
| `POST /api/incidents/:id/dispatch` | 220 ms | **550 ms** | 950 ms | 2–3 reads + 3 writes in a transaction | Fan-out |
| `GET /api/incidents/:id/dispatch/candidates` | 180 ms | **500 ms** | 900 ms | ≤ 60 reads + in-process Haversine ranking | — |
| `POST /api/incidents/:id/merge` | 300 ms | **700 ms** | 1 200 ms | 2 incident reads + report copy + 2 history rows + audit | — |
| `POST /api/incidents/:id/triage` | — | **≤ 1 200 ms** overhead | — | The same pipeline as creation | **AI** — see §4.2 |
| `GET /api/responders` | 140 ms | **380 ms** | 700 ms | ≤ 50 reads | — |
| `PATCH /api/responders/:id/location` | 130 ms | **350 ms** | 650 ms | 1 read + upsert of 2 documents | — |
| `GET /api/dispatches/summary` | 150 ms | **420 ms** | 750 ms | ≤ 100 reads over `responders` | — |
| `GET /api/notifications` | 100 ms | **280 ms** | 500 ms | 25 reads + an unread count | — |
| `POST /api/notifications/read-all` | 160 ms | **450 ms** | 800 ms | `writeBatch` ≤ 200 | — |
| `GET /api/analytics` (rollup, 30 d) | 200 ms | **500 ms** | 900 ms | ~30 rollup reads | — |
| `GET /api/analytics` (live, ≤ 48 h) | 400 ms | **1 200 ms** | 2 000 ms | ≤ 500 reads | — |
| `POST /api/analytics/recompute` | **202 immediately** | `< 50 ms` | — | Enqueues; the work happens after the response | — |
| `GET /api/admin/audit-logs` | 150 ms | **400 ms** | 700 ms | 1 bounded filtered range query | — |
| `GET /api/health` | 20 ms | **80 ms** | 200 ms | Cached 30 s; each check ≤ 1.5 s on a cache miss | — |
| `GET /api/admin/system/health` | 300 ms | **900 ms** | 1 500 ms | Aggregates `aiRuns`, quota counters, and Firestore estimates | — |
| `GET /api/incidents/:id/export` | 500 ms | **1 500 ms** | 3 000 ms | ≤ 200 ids + CSV serialisation, streamed | — |

### 4.2 The AI call, budgeted separately

**The AI call is never counted inside NFR-003.** It is budgeted, timed, and reported on its own, because it depends on a third party we do not control and because FR-029 requires the request to succeed without it.

| Stage | Budget | Mechanism |
| --- | --- | --- |
| `buildTriageInput` + sanitise | ≤ 50 ms | Pure, in-process |
| Storage download of evidence (Admin SDK) | ≤ 1 500 ms p95 | Up to 3 × 5 MB images + 15 MB audio, in parallel |
| Base64 encode + budget check | ≤ 300 ms | ~1.37× the byte count; drop images in reverse order above 15 MB |
| `generateContent` — **text only** | ≤ 3 000 ms p95 | `gemini-2.5-flash` |
| `generateContent` — text + 1 image | ≤ 5 000 ms p95 | |
| `generateContent` — text + 3 images | ≤ 8 000 ms p95 | **NFR-004** |
| `generateContent` — text + audio | ≤ 7 000 ms p95 | Disabled when quota headroom < 50% |
| Zod validation | ≤ 20 ms | |
| Repair attempt (on failure only) | ≤ 3 000 ms | Temperature 0, only the Zod issue paths |
| Safety rules + normalise | ≤ 30 ms | Pure |
| `logAiRun` | ≤ 120 ms | Outside the incident transaction |
| **Hard abort** | **20 000 ms** | `AbortSignal.timeout(20_000)` — the total AI budget |
| **Total request budget, including AI** | ≤ **9.0 s p95**, hard ceiling ~21 s | Must fit the function-duration limit — `DECISION REQUIRED` DR-01 |
| Retries | 3, exponential backoff 1 s / 2 s / 4 s, **429 and 503 only** | Never on a 400 |

**What the user experiences while the AI runs.** The `POST /api/incidents` request is in flight for up to 9 s. The `/report` form must therefore show a deterministic, honest progress state — "Analysing your report" with the reference reserved — and must **not** imply that the report is lost. If the request exceeds 20 s the server has already returned a fallback-triaged incident, so the client never sees a 20 s spinner. This is a UX requirement created by the performance budget, and it belongs in the report flow's acceptance criteria.

**Degradation ladder for AI latency:**

| Condition | Action |
| --- | --- |
| p95 > 8 s for 3 consecutive runs | Drop audio from the call; log it |
| p95 > 12 s | Text-only triage; images deferred to a dispatcher-triggered re-triage |
| Any single run > 20 s | Hard abort → fallback, `outcome: 'timeout'`, `triageError: 'AI_TIMEOUT'` |
| Fallback rate > 20% sustained | Per [09 §9.1](./09_AI_GEMINI_SPECIFICATION.md), the demo runs on the keyword fallback **honestly** rather than faked |

### 4.3 Cold starts

| Measurement | Budget | Note |
| --- | --- | --- |
| First invocation after ≥ 5 min idle, p95 | ≤ **2 500 ms** | Vercel function cold start plus module init |
| First invocation after ≥ 5 min idle, p99 | ≤ 5 000 ms | |
| Warm invocation overhead | ≤ 40 ms | — |
| Mitigation | — | Keep the module graph small; `firebase-admin` initialisation is lazy and memoised per instance; the Gemini SDK is constructed on first use, not at import |

The load script (§11) **excludes** a documented warm-up phase and reports both numbers. Hiding cold starts in an average is how a p95 target becomes a lie.

### 4.4 Timeouts, in one place

| Call | Timeout | Source |
| --- | --- | --- |
| Global request handler | `REQUEST_TIMEOUT_MS` = 15 000 | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| Gemini | `GEMINI_TIMEOUT_MS` = 20 000, hard | [09](./09_AI_GEMINI_SPECIFICATION.md) §12 |
| Google Maps server APIs | 8 000 | [08 §1.1](./08_API_SPECIFICATION.md) |
| Firestore write / transaction | 5 000 | [08 §1.1](./08_API_SPECIFICATION.md) |
| Storage stat / read for verification | 5 000 | Derived; must be below the request budget |
| Function max duration | 25 000 target for the triage route | `DECISION REQUIRED` DR-01 |

**Rule:** no timeout may exceed its caller's budget, and a timeout must always be caught and mapped to a catalogue code — never allowed to become an unhandled rejection.

---

## 5. Firestore read budget

### 5.1 The free-tier arithmetic — stated honestly

> **VERIFY REQUIRED.** The Firestore Spark-plan daily read allowance is *documented at time of writing as a specific figure that this document deliberately does not restate*, because quotas change and a wrong number here would be worse than an honest instruction to check. The check is: run the rehearsal load (§11), then read **Firebase console → Usage & billing → Document reads**, day by day, and confirm the total lands under the allowance with headroom. The mitigations below are what make that safe, and they are architecture, not tuning.

```
Worst realistic demo day (from §5.5, 10 dispatchers × 6 h, 3 demo incidents + a seeded backlog)

  60 dispatcher session-hours × 4 000 reads/hour ceiling   =  240 000 reads
  10 dispatcher first paints (× ~120)                      =    1 200 reads
   1 analytics view, 7-day range, from rollups             =       30 reads
   3 incident creations (× ≤ 51)                           =      153 reads
  ≈ 241 000 reads on the heaviest demo day.

  The architecture's contribution to keeping this bounded:
    · limit() on every query                            — the single largest lever
    · ≤ 8 listeners per client (FR-091)                  — caps attach cost
    · analyticsDaily rollups, 1 read per day (FR-116)    — decouples analytics from volume
    · duplicateMaxCandidates 50, or 25 with a live listener
    · map viewport ≤ 150 incidents over ≤ 9 cell queries
    · candidate responders ≤ 60
    · no polling anywhere (FR-090)
```

### 5.2 Reads per operation — the worked table from [07 §15](./07_DATABASE_SCHEMA.md)

This is the authoritative per-operation estimate and it is reproduced, not re-derived.

| Operation | Reads | Writes | Notes |
| --- | --- | --- | --- |
| `POST /api/incidents` (create) | **1–2** (user, duplicate candidates ≤ 50) | **3** (incident, history, report) **+ 1** `aiRuns` | The duplicate search is the dominant cost |
| `PATCH /api/incidents/:id/status` | **1–2** | **2** (incident, history) | Inside a transaction |
| `POST /api/incidents/:id/dispatch` | **2–3** | **3** (dispatch, incident, history) **+ notifications** | |
| `GET /api/incidents?limit=25` | **25** | 0 | |
| `/dashboard` first paint (RSC) | **~120** | 0 | queue 50 + KPIs 20 + responder snapshot 50 |
| Live queue listener, 1 h idle | **~50** initial **+ N × changes** | 0 | Listening to 50 documents = 1 read each on attach |
| `GET /api/analytics?days=30` | **~30** (rollups) | 0 | FR-116 |
| Duplicate `potential_duplicate` creation | **1 + ≤ 50** | **3 + 1** | Candidates capped to 25 when a listener is active |

### 5.3 Reads per client operation — the client-side view

| Client operation | Reads | Note |
| --- | --- | --- |
| Open `/dashboard` (RSC) | ~120 | Server-side, but it is our quota |
| Attach the queue listener | 50 | `limit(50)` |
| Attach the map listener | ≤ 150 × ≤ 9 cells | Capped; a wide viewport is the expensive case |
| Attach the notification listener | 50 | `limit(50)` |
| Attach the responder-assignments listener | ≤ 25 | |
| One incident status change seen by 3 dispatcher clients | 3 | 1 read per client per change — **this is why fan-out costs multiply** |
| One incident status change seen by 1 client | 1 | |
| Responder location heartbeat (own doc) | 1 write, 0 reads from the listener unless open | |
| Media upload | 0 Firestore reads | Bytes go straight to Storage; `POST /api/incidents` does a Storage verify, not a read |
| A filter change on `/dashboard` | 0, **if** it filters the attached window | A filter needing a new query is a deliberate `GET /api/incidents` at ≤ 100 reads |

### 5.4 Reads per dispatcher session-hour — the NFR-007 budget

Target: **≤ 4 000 reads per 60-minute session**, measured in the load script.

| Component of the session | Reads | Assumption |
| --- | --- | --- |
| First paint (RSC) | 120 | one time |
| Queue listener attach | 50 | one time |
| Notification listener attach | 50 | one time |
| **Steady-state queue changes** | ≤ 2 000 | 1 read per changed document per listener; assumes ≤ ~33 incident mutations/hour visible to this client |
| **Notification listener changes** | ≤ 800 | 1 read per new notification |
| **Manual actions**: 30 × (`GET /api/incidents` at 25) | 750 | a dispatcher refreshing or paginating |
| **Manual actions**: 10 × candidates (≤ 60) | 600 | opening the assign panel |
| **Incident detail opens**: 20 × ≤ 40 | 800 | |
| **Map viewport changes**: 10 × ≤ 150 | 1 500 | the expensive item; mitigated by debouncing panning and by the list fallback |
| **Misc**: config, resources, me, health | 130 | |
| **Total** | **≈ 6 800** | **OVER BUDGET** |

The naive composition is over budget. That is the point of writing the arithmetic out. The mitigations, in the order they should be applied:

| # | Mitigation | Effect | Requirement |
| --- | --- | --- | --- |
| M-1 | Debounce map viewport queries to ≥ 400 ms after `idle`, and **do not re-query while a listener is already attached to those cells** | Cuts "map viewport changes" from 1 500 to ~300 | §7.4 |
| M-2 | Cap the map listener at **150 documents total across all cells**, not 150 per cell | A wide viewport costs one 150-read attach, not nine | FR-037, [07 §12.5](./07_DATABASE_SCHEMA.md) |
| M-3 | `GET /api/incidents` default `limit` stays 25; a "load more" is user-initiated | Removes the 750 if the dispatcher does not paginate | FR-121 |
| M-4 | Candidates cache: the assign panel reuses a ranking computed ≤ 30 s ago for the same `(incidentId, radiusM, capabilityRequired)` triple, for ≤ 10 s of wall clock | Cuts "candidates" from 600 to ~180 | A 10-second in-process cache is safe because a serverless instance is per-request for a cache that lives in a route; **the cache must be per-request only** — see the honesty note below |
| M-5 | Incident detail subcollection ranges are bounded to 25 `reports`, 50 `statusHistory`, 10 `resources` | Caps detail reads at 40 rather than "however many" | §3 |
| M-6 | The queue listener is `limit(50)` and filters are applied client-side to that window | Already counted | FR-092, L-03 in [03 §14](./03_SYSTEM_ARCHITECTURE.md) |

**Honest note on M-4:** there is no valid cross-request cache on Vercel ([03 §10.1](./03_SYSTEM_ARCHITECTURE.md)), so M-4 is not really available. The real mitigation is **M-4′: the candidate panel opens at most once per incident per user interaction**, i.e. the panel is not polled and is not re-fetched on filter changes. Recorded here so nobody "optimises" a cache into existence later.

Revised total: 120 + 50 + 50 + 2 000 + 800 + 750 + 180 + 800 + 300 + 130 = **≈ 5 180**. Still over 4 000 under the worst-case assumptions. The remaining lever is the **steady-state change rate**, which is a *traffic* property, not a code property:

| Lever | Effect | Where |
| --- | --- | --- |
| L-A: `statusHistory` is a **subcollection** and is never read by a listener | A status change does not fan out 1 read per history row to every client | [07 §6](./07_DATABASE_SCHEMA.md) |
| L-B: `incidents` is the only collection the queue listener touches | A change costs 1 read, not 1 read per subcollection | ADR-010 |
| L-C: Accept a 30-minute average session with a documented 4 000-read target for **active** sessions | A session-hour where the dispatcher is idle costs ~220 reads, not 4 000 | This document, NFR-007 |
| L-D: The "steady-state 2 000" assumption is the single most sensitive number | Halve the observed mutation rate and the budget is met with headroom | Measured in the load script |

**Conclusion to record in the phase plan:** NFR-007 is achievable for an *active* dispatcher session and is comfortably met for an idle one. If a demo day genuinely exceeds 4 000 reads for an hour-long active session, the honest fix is to reduce the map listener cap from 150 to 75, not to pretend the arithmetic works. Flagged as **DR-19**.

### 5.5 Reads per day under demo load

| Scenario | Sessions | Reads/session-hour | Total reads |
| --- | --- | --- | --- |
| **Rehearsal day** — 3 dispatchers × 3 h, 1 demo incident flow repeated 10× | 9 session-hours | 4 000 | 36 000 |
| **Demo day** — 4 dispatchers × 6 h, 2 responders × 6 h, 6 citizens × 15 min | 24 + 12 + 1.5 | 4 000 / 1 200 / 400 | 96 000 + 14 400 + 600 = **111 000** |
| **Worst realistic day** — 10 dispatchers × 6 h, full NFR-008 concurrency | 60 | 4 000 | 240 000 |

All three must be checked against the console after the rehearsal. If the worst-case figure is uncomfortably close to the allowance, the *architecture* response is the degradation ladder in [03 §12.3](./03_SYSTEM_ARCHITECTURE.md), not a hope.

### 5.6 Reads must not depend on total incident count (NFR-010)

| Query | Reads at 500 incidents | Reads at 50 000 incidents |
| --- | --- | --- |
| Queue, `limit(50)` | 50 | 50 |
| Analytics, 7-day rollup | 7 | 7 |
| Analytics, 30-day rollup | 30 | 30 |
| Analytics, 365-day rollup | 365 | 365 |
| Duplicate candidates, `limit(50)` | ≤ 50 | ≤ 50 |
| Dispatcher map viewport | ≤ 150 | ≤ 150 |
| Candidate responders | ≤ 60 | ≤ 60 |
| History page 1, `limit(25)` | 25 | 25 |
| **Admin "all users" page 1** | 25 | 25 |

**The only query that scales with volume is the live analytics scan** for a range ending less than 48 h ago, and it is hard-capped at `limit(500)` with `truncated: true` and a `partial data` advisory. That cap is what makes NFR-010 achievable.

### 5.7 Read-budget guard rails in code

| Guard | Value | Where enforced |
| --- | --- | --- |
| Max `limit()` on any client listener | 200 | `hooks/useRealtime*` throws in development |
| Max `limit()` on any server query | 500 | `services/firestore/*` wrapper |
| Map viewport | ≤ 150 incidents, ≤ 9 cell queries, ≤ 25 km span | `services/geo/viewport.ts` |
| Candidate responders | ≤ 60 | `services/dispatch/candidates.ts` |
| Duplicate candidates | ≤ 50 (25 with a live listener) | `services/duplicates/findCandidates.ts` |
| Listeners per client | ≤ 8 | `hooks/useRealtime*` registry; throws in development, logs a warning in production |
| `deletedAt == null` on every default query | Required | Review checklist + a custom lint rule + rules tests |

---

## 6. Write budget

### 6.1 Writes per operation

| Operation | Incident write | History write | Report write | Audit write | Other | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Create incident | 1 | 1 | 1 | 1 (`incident.create`) | 1 `aiRuns` | **5** |
| Status change | 1 | 1 | — | 1 (`incident.status_change`) | 0–3 notifications | **3–5** |
| Assign responder | 1 | 1 | — | 1 (`incident.assign`) | 1 dispatch + 1 responder + 1–2 notifications | **5–7** |
| Withdraw | 1 | 1 | — | 1 (`incident.unassign`) | 1 dispatch + 1 responder + notifications | **5–7** |
| Merge | 1 (primary) + 1 (secondary) | 2 | 1 (copy) + 1 (source delete) | 1 (`incident.merge`) | 0 | **7** |
| Dismiss duplicate | 1 | 0 | — | 1 | 0 | **2** |
| Notification | — | — | — | — | 1 per recipient, deduped | 1–3 |
| Rate limit, per limited request | — | — | — | — | **1** | 1 |
| Responder heartbeat | — | — | — | — | 1 `responderLocations` + 1 `responders` | **2** |
| Mark notification read (batch) | — | — | — | — | ≤ 200 | ≤ 200 |
| `auth.login_failed` | — | — | — | 1 | — | 1 |

### 6.2 Steady-state write rate for a demo day

```
Incident creations          10 × 5 writes                                      =     50
Status transitions          10 × 4 incidents × 4 transitions = 160 × ~4 writes  =    640
Dispatch and withdraw       20 × 6 writes                                      =    120
Merges and dismissals       10 × ~6 writes                                     =     60
Rate-limit writes           10 incidents × 6 limited calls +                  =
                            40 status changes + 20 dispatch + 30 heartbeats  =    100
                            60 reads + 10 triage + 20 sign-in uploads          =    100
Notifications               200                                                =    200
Audit rows                  250 (one per privileged action)                    =    250
Responder heartbeats        4 responders × 6 h × 60/hour = 1 440 × 2 writes   =  2 880
                                                                                 ───────
                                                                    total ≈  4 300 writes
```

**The heartbeat dominates, and that is a design fact worth stating:** 4 responders sending a location every 60 seconds produce more writes than every other demo activity combined. Mitigations, all required:

| Mitigation | Effect | Requirement |
| --- | --- | --- |
| Heartbeat **only** while the responder is `available` or `busy` AND the tab is visible AND geolocation permission is granted | 3 of 4 responders idle in the demo → ~50% reduction | FR-066 |
| `RESPONDER_HEARTBEAT_SEC` = 60 default; the client may back off to 300 s when `document.hidden` for > 60 s | Further reduction | `STALE_LOCATION_MIN` = 15 tolerates it |
| The server rejects a heartbeat whose `capturedAt` is < 20 s after the previous one (`HEARTBEAT_TOO_FREQUENT`) | Bounds the abusive case | [08 §4.4](./08_API_SPECIFICATION.md) |
| Heartbeat writes **2 documents** (`responderLocations` and the denormalised fields on `responders`) | A known cost of denormalisation; documented rather than hidden | ADR-010 |
| `status: 'offline'` responders stop writing entirely and the server forces `stale: true` | Correctness *and* cost | FR-066 |

### 6.3 Document-size and write-cost hygiene

| Rule | Value | Why |
| --- | --- | --- |
| `incidents` document target | ≤ 1 KB of *growth-prone* fields | Firestore charges per document written; unbounded data belongs in a subcollection |
| Unbounded data in subcollections | `incidentReports`, `statusHistory`, `incidents/{id}/resources` | [07 §2](./07_DATABASE_SCHEMA.md) |
| Hard document limit | 1 MiB | Platform limit; never approached by design |
| `writeBatch` limit | 500 docs | Mark-read is capped at 200 (`BATCH_TOO_LARGE`) |
| Transaction write rate | 20 writes/s | Bulk operations are chunked and queued |
| Deletion | Costs 1 write/doc | A further reason for soft delete (ADR-018) |

---

## 7. Realtime cost control

### 7.1 Rules (normative, lint- and test-enforced)

| # | Rule | Requirement | Enforcement |
| --- | --- | --- | --- |
| RT-1 | **Every listener query has a `limit()`** | FR-092 | `hooks/useRealtime*` requires a `limit` argument; throws without one |
| RT-2 | **≤ 8 concurrent listeners per client** | FR-091 | A listener registry; the 9th throws in development and warns in production |
| RT-3 | **`unsubscribe()` on unmount and on role change** | FR-092 | A single `useEffect` cleanup; a unit test asserts `unsubscribe` is called |
| RT-4 | `includeMetadataChanges: true` only where the UI shows a pending state | FR-093 | A required argument at the hook level |
| RT-5 | No listener on login, marketing, or `/track` | FR-095 | Review + a test that no `useRealtime*` is imported by those routes |
| RT-6 | **No listener for analytics** | FR-099 | The analytics feature imports no realtime hook |
| RT-7 | Never attach to an unbounded collection | FR-092 | RT-1 |
| RT-8 | Reconnect with exponential backoff and jitter, and show a "reconnecting" indicator | FR-094 | `useRealtime*` |
| RT-9 | Mutation acknowledgements are awaited; a failure toasts with a retry | FR-098 | `useResilientAction` |
| RT-10 | Client-side filtering of the attached window, not re-querying per filter | [03 §9.4](./03_SYSTEM_ARCHITECTURE.md) | Queue feature design |

### 7.2 Listener inventory — the complete list, with costs

| # | Route | Role | Collection and query | `limit()` | Attach reads | Purpose |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/dashboard` | dispatcher/admin | `incidents`, `deletedAt == null`, `status in [7]`, `orderBy updatedAt desc` | 50 | 50 | Live queue |
| 2 | `/dashboard` | dispatcher/admin | `responders`, `status in [available, busy]` | 50 | 50 | KPI tiles + the "stale location" count |
| 3 | `/dashboard` | dispatcher/admin | `notifications`, `recipientUid == self` | 50 | 50 | Bell + unread count |
| 4 | `/map` | dispatcher/admin | `incidents` per viewport cell, `status in [7]` | ≤ 150 total across ≤ 9 cells | ≤ 150 | Markers |
| 5 | `/map` | dispatcher/admin | `responderLocations`, `status in [available, busy]` | 60 | 60 | Responder markers |
| 6 | `/dashboard` (responder variant) | responder | `dispatches`, `responderUid == self`, `status in [active, accepted]` | 25 | 25 | Active assignments |
| 7 | any authenticated shell | all | `notifications`, `recipientUid == self` | 50 | 50 | The bell, on every role's pages |
| 8 | `/responders` | responder | own `responders/{uid}` doc | 1 | 1 | Availability toggle state |

**Peak concurrent listeners:** 5 on `/dashboard` (rows 1+2+3+7 merged where possible) and 5 on `/map` (rows 4+5+3+7). The cap of 8 leaves headroom for the responder view (6+7+8) and for a future presence listener. Row 7 is shared, not duplicated — the bell is mounted once in the authenticated layout.

### 7.3 Realtime propagation latency budget (NFR-006)

| Stage | p50 | **p95** | Owner |
| --- | --- | --- | --- |
| Server transaction commits | 30 ms | 90 ms | Firestore |
| Firestore change notification → client stream | 180 ms | **1 200 ms** | Firestore listen channel |
| Client `onSnapshot` handler → normalise | 5 ms | 25 ms | `hooks/useRealtime*` |
| Normalise → React render committed | 40 ms | **180 ms** | React 19 |
| **Total, commit to paint** | 255 ms | **≈ 1.5 s** | — |
| Margin to the 3 s requirement | — | **1.5 s** | Headroom for a busy project and a slow device |

The margin exists on purpose. On a low-end Android the render stage can be 3× slower, which still lands under 3 s. If it does not, the mitigation is to reduce the row count being re-rendered (virtualise the queue above 30 rows) rather than to raise the target.

**Measurement:** the load script writes a known change and the client-side hook records `performance.now()` when the row's `updatedAt` changes. The delta is the p95.

### 7.4 Fan-out multiplication, stated

One incident status change is read by **every attached client listener that covers that document**, and by nothing else (ADR-010, L-01/L-02 in §5.4). So:

```
reads per change = number of connected clients with a covering listener
```

| Concurrent viewers | Reads per change | Note |
| --- | --- | --- |
| 1 dispatcher | 1 | |
| 3 dispatchers (a plausible demo) | 3 | |
| 3 dispatchers + 2 responders whose listener covers it | ≤ 5 | Responders only cover assigned or in-radius incidents |
| 1 dispatcher with the map open on the same cell | +1 | The map listener is a *second* listener on the same document |

**This is the strongest argument for RT-10 and for the 50-row cap:** the read cost of a change is proportional to the number of listening clients, and there is no way to reduce it other than by listening to fewer documents. Hence §5.4's L-03 limitation is accepted, not hidden.

---

## 8. Map, image, and audio performance

### 8.1 Map load budget (NFR-005)

| Stage | Budget p75 | Mechanism |
| --- | --- | --- |
| Route shell paint (no map) | ≤ 1.2 s | The map is not in the shell |
| Dynamic chunk fetch for the map component | ≤ 300 ms | Route-level `next/dynamic` |
| Maps SDK script load | ≤ 2 000 ms | Preconnect + `preload` to `maps.googleapis.com`; the SDK is not in our bundle |
| SDK `init` + first tile request | ≤ 1 500 ms | |
| **Map interactive** | **≤ 3.0 s after script load** | NFR-005 |
| **Full `/map` LCP** | **≤ 3.5 s** | §2.1 |

**Bundle rule (FR-086):** the map is dynamically imported and **must not** appear in `/dashboard`'s initial chunk. This is asserted in CI by inspecting the build output for the map module in the `/dashboard` chunk list. A regression fails the build.

### 8.2 Marker budget

| Rule | Value | Reason |
| --- | --- | --- |
| Max markers rendered at once | **150** | Matches the Firestore viewport cap; more is both slow and a read-budget risk |
| Clustering | **Force-enabled above 20 markers**; toggleable above that (FR-082) | Rendering 150 `AdvancedMarkerElement`s is where the frame rate dies |
| Responder markers | `available` green, `busy` amber, `offline` hidden by default (FR-081) | Fewer markers, and an operational truth |
| Marker style | Colour by urgency, **shape** by status | FR-080; also makes the map readable without colour vision |
| Selected-incident ring | 500 m circle | FR-084, and it visualises the dedup radius |
| Viewport query debounce | ≥ **400 ms** after `idle` | §5.4 M-1 |
| Viewport span cap | 25 km | Beyond that the user is looking at a region, not a city; the query would be 9 cells and 150 docs anyway |
| Resize handling | Debounced, `ResizeObserver` | A resize storm would otherwise trigger a query per frame |

**Viewport query mechanics, honestly stated:** `in` **cannot** be combined with `array-contains`, so a viewport spanning a 3×3 geohash-6 block costs **up to 9 sequential queries**, not 1 ([07 §12.1](./07_DATABASE_SCHEMA.md)). Mitigations: cells are deduped from the bounds; the total across all cells is capped at 150 documents; and when a listener is already attached to a cell, the query for that cell is **skipped**.

### 8.3 Reverse geocoding and Places

| Call | Budget | Frequency control |
| --- | --- | --- |
| Reverse geocode on incident creation | ≤ 800 ms p95, 8 s hard timeout | Once per incident. **Not** retried on failure; `placeName` is simply null |
| Places Autocomplete (client) | ≤ 300 ms p95 | Debounced ≥ 300 ms; a request is never issued per keystroke (FR-087) |
| Place details on pin drop | ≤ 500 ms p95 | Once per pin |
| Failure behaviour | `MAPS_UNAVAILABLE` (502) on the server path; the incident is still created | The client shows a non-blocking message and offers a manual address text |

**Cost control:** each reverse geocode is one Geocoding API request. At demo scale (10 incidents) this is negligible. The **Maps JavaScript API load** is the metered item, and it is bounded by the number of `/map` page views plus the 30-day budget alert.

### 8.4 Image and audio performance

| Aspect | Decision | Rationale |
| --- | --- | --- |
| Client-side downscale before upload | Yes, when the file exceeds a threshold, using `createImageBitmap` + `canvas` | Cuts upload bytes on a metered mobile connection, and it needs no server dependency |
| Client-reported `width`/`height` | Recorded on `MediaRef` | Honest: not server-verified. Labeled as client-reported wherever it is displayed |
| Server-side transcode / resize / thumbnailing | **None — no `sharp`** | [02 §6.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md), ADR-016 |
| Display optimisation | Next's image component for any *displayed* image; the raw evidence file is fetched through a signed URL and rendered with `width`/`height` set to prevent layout shift | CLS budget |
| Lazy image display | `loading="lazy"` on evidence thumbnails below the fold | LCP |
| Audio | Recorded with `MediaRecorder`; hard stop at 120 s with a visible message; never auto-played | US-003 |
| Audio in the AI call | Disabled when Gemini quota headroom < 50% | §4.2 |

**Why we do not add `sharp`, in one paragraph:** `sharp` is a native binary that must exist in the Vercel build image for every function, which is a whole class of "works locally, fails on deploy" failure. It costs CPU and latency on every upload, for a benefit the demo does not show. Next's built-in image optimisation already covers the *display* case. What we lose is a server-side guarantee about image dimensions — accepted, and recorded on the field as client-reported. What we keep is a $0 cost and a dependency tree with no native modules. See ADR-016 for the full trade-off, including the polyglot-file limitation of signature-only validation.

**Image/audio read cost:** every evidence view is a fresh 15-minute signed URL, so each view is a Storage egress event. The budget is `evidenceCount × views`; at demo scale (≈ 9 media objects, a handful of views each) this is immaterial. A production version would need thumbnails, which is precisely the `sharp` conversation.

### 8.5 Location purge (NFR-028)

`purge-closed-locations` runs daily (or admin-triggered) and, for every incident closed longer than `config.retention.locationPurgeDays` (default 90), sets `geo = null` and removes `geoCells`. It preserves the incident, its history, its audit row, and its category/urgency/outcome. It is a **location** purge, not a data purge; the location-bearing fields are `geo`, `geoCells`, and — if the reporter typed it — `locationText`, which the same job removes for a closed incident unless an admin has extended retention.

---

## 9. Correctness-under-failure performance

### 9.1 Authorization cost

NFR-015 requires a server-authoritative role read on **every** protected request. That is exactly **1 extra read** (`users/{uid}`) per request, on top of the endpoint's own reads. It is included in every budget in §4.1 and it is **not** negotiable — it is the security model. Do not "optimise" it with a token-claim cache; a cached role is a stale role, and a stale role after a suspension is a security bug, not a latency win.

### 9.2 Rate limiting cost

One `runTransaction` on a `rateLimits/{key}` document per limited request: **1 read + 1 write**, ~25–60 ms. Included in §4.1. §13 of [23](./23_DATA_FLOW_DIAGRAMS.md) documents the flow; the relevant performance property is that it is a single-document transaction, so it does not contend with incident writes.

### 9.3 Notification fan-out cost

Fire-and-forget **after** the response is generated. Measured cost: 1–3 writes. Measured latency impact on the caller: **0 ms** (FR-107). If the fan-out is slow, the only symptom is a notification arriving late.

### 9.4 Degradation timing

| Failure | Time to detect | Time to degrade | User-visible |
| --- | --- | --- | --- |
| Gemini timeout | 20 000 ms (hard) | immediate, on abort | "Needs review" badge; report succeeded |
| Gemini 429 | ~300 ms | immediate | Fallback; `AI_QUOTA` recorded |
| Maps SDK script failure | ~5 000 ms (script `onerror`) | immediate on `onerror` | List fallback + "Retry map" |
| Maps server API failure | 8 000 ms (timeout) | immediate | `placeName` null; no user-facing error on the report form |
| Firestore listener network loss | ~1 000 ms | immediate | "Reconnecting…" banner; snapshot retained |
| Firestore unavailable | 3 retries ≈ 2 000 ms | then `503` | Retry toast with the `requestId` |
| Storage unavailable | 5 000 ms | `503 STORAGE_UNAVAILABLE` on sign/finalize | Per-file retry; text-only reporting continues |
| Rate-limit store unavailable | 2 000 ms | **allow the request**, log | None |

### 9.5 Accessibility is a performance requirement too

An accessible interface is measurably slower to build and faster to use. These are treated as performance work, not polish:

| Requirement | Performance relevance | Check |
| --- | --- | --- |
| NFR-017, 0 serious axe violations | A violation in a hidden mobile state is still a violation | axe runs in E2E on every route, including the drawer and dialog states |
| NFR-018, full keyboard operability | A focus trap that leaks costs the user seconds per dialog | Manual + Playwright `keyboard` runs |
| NFR-019, `prefers-reduced-motion` | Animations cost frames on a low-end device | The only non-essential animation is the live-row highlight, which respects the preference |
| Visible focus rings | Never `outline: none` without a replacement | Review |
| 44 × 44 px targets | Bigger targets mean fewer mis-taps during an emergency | DOM assertion in E2E |

---

## 10. Monitoring and measurement — free tools only

> **No paid APM.** No Sentry, no Datadog, no New Relic, no LogRocket. `SENTRY_DSN` exists in the env template as an **optional, default-disabled** hook so the plug-in point is real (NFR-030), and the zero-cost posture is a hard requirement (NFR-026).

### 10.1 The measurement stack

| Signal | Tool | Cost | What it answers |
| --- | --- | --- | --- |
| Server logs | Vercel function logs, structured JSON with `requestId` | $0 (free log volume is sufficient at demo scale) | Which route, which status code, which `requestId`, how long |
| LCP / INP / CLS | **Lighthouse CI** on every PR and nightly | $0 | Regression before merge, per route, per build |
| E2E + a11y | **Playwright** + axe | $0 | Flows, roles, and accessibility |
| Firestore usage | **Firebase console → Usage & billing** | $0 | The number that actually threatens the $0 claim |
| Auth usage | Firebase console → Authentication → Usage | $0 | Sign-in and email-sending quota |
| Storage usage | Firebase console → Storage → Usage | $0 | Stored bytes and egress |
| AI usage | **AI Studio → Usage** dashboard | $0 | RPM/RPD consumption, error rate |
| Maps usage and **cost** | **Google Cloud Console → Billing → Budgets + Usage** | $0 (the alert is what makes it $0) | Whether the credit is at risk |
| AI and quota health, in-product | **`GET /api/admin/system/health`** | $0 | See §10.2 |
| Liveness | **`GET /api/health`** (unauthenticated, cached 30 s) | $0 | Uptime + a cheap Firestore/Gemini/Storage ping |
| Rehearsal load | The load script in §11, run locally with the free tier | $0 | The real read/write counts for a demo day |

### 10.2 `GET /api/admin/system/health` — the in-product dashboard

`admin`-only. This is the single page that answers "is the $0 claim still true and is the AI healthy?".

| Group | Field | Source | Alert condition |
| --- | --- | --- | --- |
| **Firestore** | Estimated reads in the last hour, by route where logged | Counted server-side from the structured log, or a `counters` document written by the rate-limit/audit services | > 3 000/h with 1 active session |
| | Estimated writes in the last hour | As above | > 1 000/h |
| | `rateLimits` document count | 1 aggregation query, `limit(500)` | Growing without bound → `expiresAt`/TTL not working |
| | Index health | Static: the expected 11 `incidents` composites | Any missing index (a failed query in logs) |
| **Realtime** | Listener count by collection, as a **declared maximum** from the client registry heartbeat | Client posts its count; server stores the max | Any client reporting > 8 |
| **AI** | 24 h success rate | `aiRuns` where `outcome == 'success'` / total, `limit(500)` | < 95% ([09 §9.1](./09_AI_GEMINI_SPECIFICATION.md)) |
| | 24 h fallback rate | `fallbackUsed == true` / total | > 5% warn, > 20% alert |
| | p50 / p95 `latencyMs` | `aiRuns.latencyMs` | p95 > 8 s |
| | Token totals from `usageMetadata` | `aiRuns.promptTokens` + `responseTokens` | Informational |
| | `aiRuns` failures in the last 24 h | Count | Any sustained non-zero |
| | Local quota guard headroom | `GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT` vs the client's reported usage | < 50% → drop audio |
| **Storage** | Staging object count older than 30 min | Storage list with a prefix | > 0 → the sweep is not running |
| **Config** | `config.app` `updatedAt`, `schemaVersion` | 1 read | Stale schema version |
| **Deployment** | `VERCEL_GIT_COMMIT_SHA`, uptime | Env + process uptime | — |

**Cost:** the endpoint must itself stay cheap. It uses **bounded** queries (`limit(500)`), never a listener, and never scans `incidents`. Budget: ≤ 900 ms p95, and at most ~1 500 reads when called. It is a page an admin opens deliberately, not a heartbeat.

### 10.3 Availability

NFR-011 is a **design target, best effort**, on free tiers. It is not measured as an SLO and it is not gated on a build. What we do instead:

| Practice | Detail |
| --- | --- |
| Record provider status during the demo | Vercel status page + Firebase status page, checked at T−1 h and T+1 h |
| Honest incident report | If something degrades mid-demo, say so and show the degraded path. The product's whole premise is trust |
| Documented degradation | Every optional dependency has a designed degraded state ([03 §12.3](./03_SYSTEM_ARCHITECTURE.md)) |
| No availability alerting on a free tier | Would require a paid uptime service. Manual check is the honest answer |

### 10.4 CI gates

| Gate | Command | Enforces | Fails the build? |
| --- | --- | --- | :-: |
| Typecheck | `tsc --noEmit` | NFR-022 | ✔ |
| Lint | `npm run lint` | NFR-022, NFR-023, NFR-024, the `NEXT_PUBLIC_` import rule, the no-`any` rule | ✔ |
| Format | `npm run format:check` | NFR-023 | ✔ |
| Unit + integration | `npm run test` | FR-049, the AI safety rules, the lifecycle table, the duplicate gates | ✔ |
| Rules | `npm run test:rules` | NFR-014, FR-131, the two hard denials | ✔ |
| E2E (Chromium) | `npm run test:e2e` | NFR-017, NFR-018, NFR-020, NFR-021, NFR-012 | ✔ |
| **Bundle budget** | `scripts/check-bundle-budget.mjs` | §2.2 B-1…B-7 | ✔ |
| **Listener rules** | a unit test over the `useRealtime*` registry | FR-091, FR-092 | ✔ |
| Lighthouse CI | `npx lhci autorun` | NFR-001, NFR-002 | ✔ |
| Secret scan | `gitleaks detect --no-git` | NFR-013 | ✔ |
| Client-bundle secret scan | scan `.next/static` for `-----BEGIN`, `AIza`, and a non-empty `NEXT_PUBLIC_FIREBASE_API_KEY=` | NFR-013 | ✔ |
| **Route → Zod schema** | a test that every `route.ts` exports a schema referenced in [08](./08_API_SPECIFICATION.md) | NFR-025 | ✔ |
| Build | `npm run build` | — | ✔ |
| Full browser matrix | Playwright, Chromium + Firefox + WebKit | §2.4, §9.5 | Nightly only |
| Load rehearsal | the §11 script against the dev project | NFR-003, NFR-007, NFR-008, NFR-009 | Manual, before the demo |

---

## 11. Load-test plan

### 11.1 Tooling

**A plain Node script**, not k6. Rationale: the flows need a **Firebase ID token** and a **Firestore listen stream** to be meaningful, and reproducing that in k6 means either a bespoke authenticator or an approximation that tests the wrong thing. A Node script using the real `firebase` and `firebase-admin` SDKs measures the real thing.

Why not k6 at all: it is a better general-purpose load tool and we would fight it on three specific things — Firebase Auth, the Firestore listen channel, and the signed-URL upload path. The load we care about is application-shaped, not HTTP-primitive-shaped. *(If a future version needs protocol-level load generation, k6 with a service-account token from `FIREBASE_PRIVATE_KEY` is the fallback — a `DECISION REQUIRED` if the script proves insufficient.)*

Dev dependencies for the script: none beyond `node:assert`, `undici` (built into Node 22 as `fetch`), and the already-present Firebase SDKs.

```
scripts/load/
  run.ts               # orchestrator, CLI flags, report writer
  scenarios/submit.ts  # citizen report submission, incl. the signed-URL upload
  scenarios/dashboard.ts# dispatcher first paint + queue actions
  scenarios/realtime.ts # write-then-observe propagation latency
  scenarios/analytics.ts# rollup read + a live-scan read
  scenarios/heartbeat.ts# responder location heartbeat at RESPONDER_HEARTBEAT_SEC
  report.ts            # p50/p95/p99, reads, writes, and a pass/fail per target
  README.md
```

CLI:

```bash
node --experimental-strip-types scripts/load/run.ts \
  --env dev \
  --scenario all \
  --dispatchers 10 \
  --citizens 50 \
  --duration 600 \
  --warmup 60 \
  --out reports/load-<timestamp>.json
```

### 11.2 Measurement method

| Concern | Method |
| --- | --- |
| Authentication | Sign in as seeded demo users once; reuse the ID tokens. Token refresh is measured separately, not conflated into request latency |
| Warm-up | A documented `--warmup` phase, excluded from the percentiles and reported separately (§4.3) |
| Data | A snapshot of the dev project seeded with 3 000 incidents, 60 responders, 14 days of `analyticsDaily`, taken **before** each run so every run is comparable |
| Client-side reads | Counted by instrumenting the Firestore client SDK's listener callbacks in the script; reconciled against the console |
| Server-side reads | Counted from the structured logs (`requestId`, route, readCount if the service wrapper logs it) |
| Percentiles | Computed from the full sample, not a rolling window |
| Repeatability | 3 runs; the report states the median run and the spread |
| Do not measure | The AI call inside NFR-003. It is reported as a separate line |

### 11.3 Scenarios

| # | Scenario | Shape | Targets asserted | NFR |
| --- | --- | --- | --- | --- |
| S-1 | **Citizen submit** | 50 citizens, one submission each, spread over 60 s, then a sustained 50/min for 10 min. Each submission: text-only, then a variant with 1 image, then a variant with image + audio. Full signed-URL flow | `POST /api/incidents` ≤ 800 ms p95 excluding AI; no `5xx`; rate limiter permits 5/h and 20/day so the burst is **expected** to produce `429 RATE_LIMIT_EXCEEDED` past 5 — the script must account for that and use ≥ 50 distinct uids | NFR-003, NFR-009 |
| S-2 | **Dispatcher first paint** | 10 dispatchers, 1 `/dashboard` RSC render every 30 s for 10 min | ≤ 120 reads per render; p95 ≤ 700 ms; the 4 000/h budget tracked cumulatively | NFR-001, NFR-007, NFR-008 |
| S-3 | **Queue actions** | 10 dispatchers each verifying, assigning, and transitioning 4 incidents per hour | `PATCH /status` ≤ 400 ms p95; `POST /dispatch` ≤ 550 ms p95; zero `409 INVALID_STATUS_TRANSITION` for legal actions | NFR-003, NFR-008 |
| S-4 | **Realtime propagation** | 1 writer emits a status change every 2 s for 5 min; 10 dispatcher clients listen and record the time to render | ≤ 3 s p95 commit-to-paint (NFR-006); reads-per-change equals the listener count, not more | NFR-006, FR-090 |
| S-5 | **Duplicate search under load** | 60 submissions from 6 distinct coordinates inside one geohash-6 cell | ≤ 51 reads per creation; no duplicate query ever exceeds `limit(50)`; the 25-candidate cap applies when a listener is active | FR-040, FR-037 |
| S-6 | **Analytics** | 10 dispatchers, alternating a 7-day rollup view and a 365-day rollup view | 7-day ≤ 7 reads; 365-day ≤ 366 reads; p95 ≤ 900 ms | FR-116 |
| S-7 | **Live analytics scan** | 10 dispatchers requesting a 24 h range, 5 in CSV format | Cap at 500 reads; `truncated` set correctly; CSV streams without buffering the whole set | FR-116, FR-118 |
| S-8 | **Responder heartbeat** | 8 responders heartbeating at 60 s for 30 min, half with the tab hidden | ~2 writes per heartbeat; hidden tabs back off; `HEARTBEAT_TOO_FREQUENT` never fires for a compliant client | FR-066, §6.2 |
| S-9 | **Rate limit correctness** | One uid hammering a write route; 20 parallel requests within one window | Exactly the limit is admitted; the rest are `429` with `Retry-After`; no more than the limit is ever admitted | FR-015, NFR-016 |
| S-10 | **Storage throughput** | 20 concurrent uploads of a 4.9 MB image and a 14 MB audio clip | No request to an API route exceeds 4.5 MB (**assert the platform limit is never approached**); `finalize` ≤ 400 ms p95 | FR-007 |
| S-11 | **Error-path resilience** | 10% of requests sent with an expired token, a wrong role, a malformed body, a forbidden path | Correct catalogue code and status for every case; no `500`; `requestId` present in every response | FR-140, FR-141, NFR-015 |
| S-12 | **Cold start** | 60 s idle, then 20 sequential requests | Cold p95 ≤ 2 500 ms; reported separately from warm p95 | §4.3 |

### 11.4 What the report must contain

| Field | Why |
| --- | --- |
| Per-scenario p50 / p95 / p99 for each endpoint | Targets are percentile-based |
| Reads and writes per operation, measured | Compared against the §5.2 and §6.1 tables |
| Cumulative reads per dispatcher session-hour, split by component | Compared against NFR-007's 4 000 |
| Total reads and writes for the whole run | Compared against the console the next day |
| Cold vs warm, separated | §4.3 |
| AI latency percentiles, reported separately | NFR-004 |
| Every non-2xx response with its catalogue code | An unexpected `500` is a release blocker |
| A pass/fail line per target in §1 | A run either met the contract or it did not |

### 11.5 Exit criteria for a release

| # | Criterion |
| --- | --- |
| 1 | S-1, S-2, S-3, S-4, S-9 pass with no `5xx` |
| 2 | NFR-003 met at p95 with AI excluded |
| 3 | NFR-007 met for the S-2 profile, or §5.4's documented mitigation set is applied and re-measured |
| 4 | NFR-006 met at p95 |
| 5 | Lighthouse CI green on the three most important routes |
| 6 | The bundle budget check passes on every route |
| 7 | The rehearsal run's read total is comfortably under the console allowance, verified **after** the run in the Firebase console |
| 8 | A single report artifact is attached to the phase plan, including the AI latency and fallback rate |

---

## 12. Cost impact of the performance budget

| Budget | Cost effect |
| --- | --- |
| Firestore reads ≤ 4 000/session-hour | Keeps the demo day at ≈ 111 000–240 000 reads, which is what makes the $0 claim checkable |
| Write budget with the heartbeat mitigation | ≈ 4 300 writes/day instead of ≈ 7 200 |
| Listener cap of 8, queue cap of 50 | Bounds the *multiplicative* read cost of a single change |
| Analytics from rollups | A 365-day view costs 365 reads instead of a 50 000-incident scan |
| AI budgeted separately with a mandatory fallback | Gemini quota is a **hard** gate on feature richness, not a cost. Demo usage ≈ 15% of our own `GEMINI_RPD_LIMIT` |
| Map lazy-loaded and credit-bounded | The only budget whose breach costs **money**. Bound by a hard budget alert ([02 §7.5](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md)) |
| No polling anywhere | Fewer Vercel invocations **and** fewer Firestore reads than the obvious alternative |
| Client-side downscale instead of server-side `sharp` | Saves Vercel function CPU and removes a native dependency; costs upload bytes on a metered connection |

---

## 13. Optimisation checklist, mapped to files

Ordered by expected impact per unit of effort. Each item names the files it touches.

| # | Optimisation | Files | Budget effect | Status |
| --- | --- | --- | --- | --- |
| O-01 | One `array-contains` query for duplicate candidates, never 10 | `services/duplicates/findCandidates.ts` | −45 reads per creation vs. a naive fan-out | Required |
| O-02 | Cap duplicate candidates at 50, or 25 when a live listener is active | `services/duplicates/findCandidates.ts` | −25 reads on the busiest path | Required |
| O-03 | `limit(50)` on the queue listener; client-side filtering of that window | `hooks/useRealtimeQueue.ts`, `features/dispatch/queue/*` | Attach 50 reads, not 500 | Required |
| O-04 | One shared listener registry enforcing ≤ 8 and mandatory unsubscribe | `hooks/useRealtime*` | Prevents an unbounded read leak | Required |
| O-05 | Analytics from `analyticsDaily`; the live scan capped at 500 with `truncated` | `services/analytics/rollup.ts`, `app/api/analytics/route.ts` | 7–366 reads instead of up to 50 000 | Required |
| O-06 | `deletedAt == null` on every default query (review + lint + rules tests) | all `services/**`, `eslint-rules/no-query-without-soft-delete.ts` | Correctness, and it shrinks result sets | Required |
| O-07 | RSC first paint for `/dashboard` with a bounded read set (~120) | `app/dashboard/page.tsx`, `features/dispatch/queue/loaders.ts` | Removes a round trip; LCP | Required |
| O-08 | Single fire-and-forget fan-out with a `dedupeKey` transaction | `services/notifications/*` | −1 write per duplicate notification (FR-108) | Required |
| O-09 | Subcollections for unbounded data | `incidents/{id}/reports`, `.../statusHistory` | Keeps `incidents` writes small | Required |
| O-10 | `getIdToken` reuse, refreshed only on `401` | `lib/api/client.ts` | Avoids a token refresh per request | Required |
| O-11 | Lazy-load the map; assert its absence from `/dashboard`'s chunk | `app/map/page.tsx`, `components/map/*`, `scripts/check-bundle-budget.mjs` | −180 KB from `/dashboard` (FR-086) | Required |
| O-12 | Dynamic import for Recharts | `features/analytics/charts/*` | −110 KB from the shell | Required |
| O-13 | Map viewport debounce ≥ 400 ms and skip cells already covered by a listener | `hooks/useMapViewport.ts`, `services/geo/viewport.ts` | −1 200 reads/session-hour (§5.4 M-1) | High value |
| O-14 | Force clustering above 20 markers; cap at 150 markers | `components/map/MarkerLayer.tsx` | Frame rate, and it prevents reading 500 documents to draw 500 pins | High value |
| O-15 | Heartbeat only when visible + available + permitted; back off when hidden | `hooks/useResponderHeartbeat.ts` | −1 500 writes/day | High value |
| O-16 | Client-side image downscale before upload | `features/reporting/media/*` | Upload bytes; Gemini payload | Medium |
| O-17 | System font stack; **zero** web fonts on the report route, asserted in CI | `app/layout.tsx`, `app/globals.css`, `scripts/check-bundle-budget.mjs` | Directly serves NFR-002 on a low-end Android | Medium |
| O-18 | No font swap after first paint (`font-display` is irrelevant because there is no font file) | `app/globals.css` | Removes the FOUT/FOIT class of LCP regression entirely | Low cost |
| O-19 | Cache `GET /api/resources` client-side for 1 h (already specified) | `lib/api/cache/resources.ts` | −1 read per session | Medium |
| O-20 | Cache `GET /api/config` client-side with a short TTL, and `React cache()` for intra-request dedup | `lib/api/cache/config.ts`, per-request loaders | Small but free | Medium |
| O-21 | `GET /api/health` cached 30 s with a 1.5 s per-check budget | `app/api/health/route.ts` | A cheap liveness probe | Medium |
| O-22 | 30 s default for `includeMetadataChanges` decisions; never global | `hooks/useRealtime*` | Extra read deltas avoided | Medium |
| O-23 | Virtualise the dispatcher queue above 30 rows | `features/dispatch/queue/IncidentTable.tsx` | Render time on a low-end device; p95 propagation headroom | Medium |
| O-24 | `date-fns` **subpath imports only**; lint-enforced | `eslint-rules/no-date-fns-root-import.ts` | Keeps `date-fns` tree-shakeable in B-1 | Low cost, high value |
| O-25 | Bounded `statusHistory` (50) and `reports` (25) on the detail page | `features/incidents/detail/loaders.ts` | Caps detail reads at 40 | Low cost, high value |
| O-26 | Cursor pagination, never `offset` | `lib/api/pagination.ts` | Stable results under live writes (ADR-017) | Correctness |
| O-27 | Prefetch the assign panel's candidate request on hover/focus of the row | `features/dispatch/assign/*` | Perceived latency only | Nice |
| O-28 | `preconnect` to `maps.googleapis.com` and `firebasestorage.googleapis.com` | `app/layout.tsx` | Saves DNS + TLS on first use | Nice |
| O-29 | `loading="lazy"` on evidence thumbnails; explicit `width`/`height` on every image | `features/incidents/detail/Evidence*` | CLS | Nice |
| O-30 | `AbortController` on every client fetch, cancelled on unmount and on filter change | `lib/api/client.ts` | Wasted reads and 4×/5× fetches on fast typing | Nice |

**Deliberately not on the list, and why:**

| Not doing | Why |
| --- | --- |
| Adding `sharp` | [02 §6.2](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md), ADR-016. A native dependency for a demo-scale benefit |
| Adding a server-state cache library | ADR-009. It would create a fourth source of truth |
| Adding a CDN cache in front of `/api/*` | §14.2 — user data must never be cached |
| Adding a background job queue | ADR-015 |
| Optimising the AI prompt for tokens | The cost signal is the **quota**, not money, and 15% of `GEMINI_RPD_LIMIT` is comfortable. Prompt quality matters for accuracy, not for this budget |
| Micro-optimising React render paths | The measurable problem is the read budget, not the render budget, until profiling says otherwise |

---

## 14. Caching strategy

### 14.1 What is cached, and where

| # | What | Where | Key | TTL / invalidation | Correctness requirement |
| --- | --- | --- | --- | --- | --- |
| C-1 | `GET /api/resources` | Client memory + `localStorage` | Endpoint + locale | **1 h** | The catalogue is reference data; admin deactivates by `active: false`, never deletes |
| C-2 | `GET /api/config` (the client-safe subset) | Server: `React cache()` per request; client: memory | Endpoint | Per request (server), 5 min (client) | Feature flags may change; a 5-minute staleness is acceptable and the UI must tolerate a missing optional feature |
| C-3 | `config/app` | `React cache()` for the duration of one request | `config/app` | One request | Multiple components in one render share one read |
| C-4 | `users/{uid}` in `requireUser` | `React cache()` **per request only** | uid | One request | **Never** across requests. A cross-request cache would make a suspended user's token still valid for the cache window — a security bug (NFR-015) |
| C-5 | The assigned-candidate ranking | **None.** Reuse only within one request | — | — | §5.4 M-4′: Vercel is stateless, so a cross-request cache does not exist |
| C-6 | Static assets under `/_next/static` | Vercel CDN | Content hash | Immutable | Content-hashed filenames make this safe forever |
| C-7 | Route segment data with no user specificity (if any segment ever becomes static) | Next's full-route cache | Route path | `revalidate` or `dynamic = 'force-dynamic'` per segment | Only for pages that are genuinely identical for every user. **In v1 every authenticated route is dynamic** |
| C-8 | The reverse-geocoding result for a `GeoPoint` | **None** | — | — | It is a personal-data derivation; caching it would create a second copy of a location outside the retention policy |
| C-9 | Firebase Auth ID token | Client memory (`auth.currentUser`) | uid | Until ~1 h, refreshed on `401` or `getIdToken(true)` | Standard Firebase behaviour |
| C-10 | `GET /api/health` | In-memory on the serverless instance | — | **30 s** | Explicitly specified; each dependency check ≤ 1.5 s |
| C-11 | The AI triage result for a given report | **None** | — | — | Triage is a per-report judgement, and the incident's stored fields are the record. Re-running is a deliberate, rate-limited, audited action |
| C-12 | Service-worker asset cache | Browser | Build hash | Version-scoped | A new deploy changes the hash, so the old cache is orphaned and cleared |

### 14.2 What must never be cached

| Never cached | Where the rule lives | Why |
| --- | --- | --- |
| **Any response containing user-specific data** — every `GET /api/incidents*`, `/api/responders*`, `/api/notifications`, `/api/analytics`, `/api/admin/*`, `/api/me*`, `/api/dispatches*` | `Cache-Control: no-store` on every such route ([08 §12.12](./08_API_SPECIFICATION.md)) | A shared cache serving one dispatcher's queue to another is a data breach, and a role change would not invalidate it |
| Any error response containing `details` | Same | Details can include field values |
| `GET /api/uploads/:mediaId/url` | Same, plus the 15-minute signature | A cached signed URL outlives the authorization decision that produced it |
| `GET /api/health` | Explicitly **not** `no-store`; 30 s server cache, `no-cache` on the client | Liveness must be cheap and must not be cached by the browser |
| Firestore listener snapshots | Never | They are live by definition; a cached snapshot is a stale incident |
| The role | Never in `localStorage`, never across requests | [22](./22_USER_ROLES_PERMISSIONS.md) §2 |
| `auditLogs` | Never | Append-only and sensitive |
| `config/app` admin-only keys (`retention`, etc.) | Never in the client cache | `GET /api/config` returns only the client-safe subset; the full document is admin-only and uncached |
| Any AI prompt or raw model output | Never | Only `rawOutputHash` is stored ([09 §9](./09_AI_GEMINI_SPECIFICATION.md)) |
| A location derivation | Never | C-8 |
| Incidents in a shared-device cache | Cleared on sign-out | US-042 criterion 3 |

### 14.3 Cache-control contract

| Route class | Header | Reason |
| --- | --- | --- |
| Every `/api/*` route returning user data | `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache` | §14.2 |
| `/api/health` | `Cache-Control: no-cache` (browser revalidates); 30 s in-memory server cache | Cheap liveness, never stale for the caller |
| `/_next/static/*` | `Cache-Control: public, max-age=31536000, immutable` | Content-hashed |
| CSV exports | `no-store` | Contains incident data |
| Signed media URLs | `no-store` | 15-minute lifetime, and never shared |
| Security headers | Set for all routes in `middleware.ts` | [08 §12.13-14](./08_API_SPECIFICATION.md) |
| `Permissions-Policy` | `geolocation=(self), microphone=(self), camera=(self)` | Nothing else may use these |

---

## 15. `DECISION REQUIRED`

| ID | Question | Impact | Proposed resolution |
| --- | --- | --- | --- |
| **DR-01** | Is the Vercel function max duration long enough for the ~9 s total request budget (800 ms app + 8 s AI + overhead)? | If not, the API contract changes | Verify the plan. If < 25 s, make triage fire-and-forget after the incident write: create the incident with `triageSource: 'pending'`, return `201` immediately, and update the incident when triage completes. That requires amending the `POST /api/incidents` response contract in [08](./08_API_SPECIFICATION.md) §3.1 and FR-020's wording |
| **DR-19** | Is NFR-007's 4 000 reads/session-hour achievable for an **active** dispatcher session, given the §5.4 arithmetic lands at ≈ 5 180 before the traffic assumption is relaxed? | Determines whether the map listener cap must drop | Measure with S-2 in §11. If the active-session total exceeds 4 000, reduce the map listener from 150 to 75 documents and record the change in [07 §12.5](./07_DATABASE_SCHEMA.md). Do not raise the target |
| **DR-20** | Should the live queue listener cap of 50 be raised above 50 for a demo with many pre-seeded incidents? | Attach cost is linear in the cap; §5.4 L-03 already documents the trade | No. Keep 50 and add a visible "showing 50 of N" affordance plus a "load more" that issues a bounded `GET /api/incidents`. A demo is not a monitoring wall |
| **DR-21** | Is `RESPONDER_HEARTBEAT_SEC = 60` acceptable for a demo where responders stand still, or should it be 30 s for a more impressive "live" feel? | 30 s doubles the dominant write line (§6.2) | Keep 60 s. The "live" impression comes from the status transition, not from a faster position fix. If 30 s is chosen for the demo, set it **per environment** and record the write cost |
| **DR-22** | Should `/dashboard` KPI tiles use a separate listener, or derive from the queue listener as proposed? | A separate listener costs +50 attach reads and +1 read per change per client | Derive from the queue listener. One listener, one source, and the tiles cannot disagree with the queue. The cost is that the "available responders" tile needs its own listener (row 2), which is a different collection and therefore not redundant |
| **DR-23** | What is the acceptable `p99` for `POST /api/incidents` with 3 images, given the ~9 s total budget? | p95 is the contract; p99 determines whether the 20 s hard timeout is ever hit | Assert p99 ≤ 1.5 s for the **app** portion and treat the AI portion separately with a p99 ≤ 12 s. If a run exceeds the 20 s hard abort more than once in 100, the AI step is moved off the request path (DR-01) |
| **DR-24** | Do we need a per-route Lighthouse gate, or is a global budget assertion enough? | Per-route is stricter and more informative; global is faster | Per-route for `/report`, `/dashboard`, `/map`, and `/incidents/[id]`. Global assertions for the rest, with a warning rather than a failure |

---

## Phase 10 performance review (2026-09-30)

**No measurement was possible** — no browser, no Lighthouse, no load test, no live
Firebase project. What follows is therefore *bounds enforced by construction*, which
is a real and different property from "fast", and it is labelled as such.

### Bounds that are enforced, not merely intended

| Surface | Bound | Enforced by |
| --- | --- | --- |
| Realtime listeners | 8 channels, per-listener ceilings | The registry **throws** above a declared ceiling. A limit cannot be raised by editing a call site. |
| Listener re-subscription | A `queryKey` string; a re-render does not resubscribe | Phase 8, unit-tested |
| Listener data on unmount | Detached, and detach is **idempotent** | Phase 8 + 15 tests this phase |
| L5 notifications | 50 documents | `docs/13 §3.1`; the unread count is derived from those 50, and the UI says so |
| Analytics live scan | `LIVE_SCAN_CAP = 500` | A capped scan reports `advisory` rather than presenting itself as complete |
| Analytics range | `MAX_RANGE_DAYS = 366` | `daysInRange` is bounded and stops rather than spinning on a bad range |
| Analytics rollup reads | One per day in range | The FR-116 48 h decision picks rollup over live |
| Precomputed collections | **Never** read by a client listener | FR-099, checked |
| Uploads | 15 MB per object, 30 signs/hour | Storage rules at write time, plus the route limiter |
| AI prompts and media | Bounded by `AI_BOUNDS` | Schema limits |
| Rate-limit writes | One document per subject per window | Hashed bucket id |

### The design decisions that keep reads down

1. **Rollups instead of scans** — a 30-day window is 30 document reads, not 3,000. The
   FR-116 rule keys on the **end** of the range, so a 90-day view ending today is live
   rather than serving data up to 48 h stale.
2. **A capped scan is never presented as complete.** `AnalyticsRange` carries both
   `source` and `advisory`, so a truncated scan has to say so.
3. **No listener over a historical collection.** `analyticsDaily` and `riskZones`
   are precomputed; a client recomputing them would defeat the point.
4. **A query key, not a re-subscribe.** The realtime layer's most expensive failure mode
   is a re-render storm opening duplicate channels; the composite key prevents it.
5. **Null metrics cost nothing.** A period with no resolvable incidents returns `null`
   and renders a sentence, rather than forcing a query to produce a number.

### Not measured

Initial load, dashboard render time, real Firestore read counts, map rendering cost,
chart re-render behaviour, bundle size, and Lighthouse scores. **Every figure in the
table above is a bound, not an observation.** Before claiming a performance
requirement is met, it has to be measured against a real Firebase project — the read
counts especially, because an index that has not been deployed fails as
`failed-precondition` and a dashboard that swallows that error looks idle rather than
broken.

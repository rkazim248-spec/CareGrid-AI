# 02 — Technical Requirements Document (TRD)

**Project:** CareGrid AI
**Document type:** Technical requirements (source of truth for *how* the product is built)
**Status:** Baseline v1.0 — approved for implementation
**Related documents:** [01 Product Requirements Document](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) · [03 System Architecture](./03_SYSTEM_ARCHITECTURE.md) · [07 Database Schema](./07_DATABASE_SCHEMA.md) · [08 API Specification](./08_API_SPECIFICATION.md) · [09 AI / Gemini Specification](./09_AI_GEMINI_SPECIFICATION.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [22 User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md) · [23 Data Flow Diagrams](./23_DATA_FLOW_DIAGRAMS.md) · [26 Performance Requirements](./26_PERFORMANCE_REQUIREMENTS.md)

---

## 0. How to read this document

This document is normative for **technology selection**. If code uses a package not listed in §2, or a version below the stated floor, the code is wrong. If code and this document disagree, **this document wins** until it is amended.

| If you want to know… | Read |
| --- | --- |
| What a feature must *do* | [01 PRD](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) (FR-###, NFR-###) |
| What a field or collection must be called | [07 Database Schema](./07_DATABASE_SCHEMA.md) |
| What an endpoint accepts and returns | [08 API Specification](./08_API_SPECIFICATION.md) |
| How Gemini is called and constrained | [09 AI / Gemini Spec](./09_AI_GEMINI_SPECIFICATION.md) |
| Why the architecture looks like this | [03 System Architecture](./03_SYSTEM_ARCHITECTURE.md) + its ADR list |
| Which environment variable is named what | [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) |
| Whether a role may perform an action | [22 User Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md) |
| What the read/write/latency budget is | [26 Performance Requirements](./26_PERFORMANCE_REQUIREMENTS.md) |

### 0.1 Version policy

- **Major versions are pinned** in this document and in `package.json` with caret ranges.
- **Minor/patch versions are not pinned in this document.** The resolved graph is locked by `package-lock.json` and reproduced with `npm ci`. Version numbers for packages marked *verify* below were the latest major available at the time of writing; check `npm view <pkg> version` before relying on the minor.
- A **major** upgrade of any package in §2 requires: a branch, a passing `npm run test` + `npm run lint` + `npm run build`, and a line in the decision register in §13.
- No package may be added without a corresponding entry in §6 (explicitly excluded) being flipped, and a §3 or §4 entry explaining the change.

---

## 1. Scope and engineering constraints

Five constraints shaped every decision in this document. Each technology below is judged against them.

| # | Constraint | Source | What it eliminates |
| --- | --- | --- | --- |
| C1 | **Total infrastructure cost must be $0** for the demo period | NFR-026, PRD §1 principle 6 | Any service with a mandatory paid tier, any metered third-party API without a free allowance, any managed database with a required plan |
| C2 | **One maintainer, short hackathon timeline** | Project context | Distributed systems, multi-service debugging, codegen pipelines, anything with a slow feedback loop |
| C3 | **Emergency response latency budget of seconds, not minutes** | FR-090, NFR-006 | Round-trips through a synchronous third-party service on the *critical path* |
| C4 | **The reporting flow must never fail** because an optional service failed | FR-029, NFR-012 | Any hard dependency on Gemini, Maps, or notification providers |
| C5 | **No native mobile app** | PRD §9 | React Native, Expo, Capacitor, push notification infrastructure, app-store review cycles |

Non-goals for v1 are listed in [01 PRD §9](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md). This document never widens that scope.

---

## 2. Technology stack

### 2.1 Runtime and language

| Component | Version | Where declared | Notes |
| --- | --- | --- | --- |
| Node.js | **>= 22.11.0** | `engines.node` in `package.json` + Vercel project Node version | The two **must match** or the local build and the deployed build differ. Node 22 is the first line with stable `require(esm)`, needed by `firebase-admin` v13 |
| npm | **>= 10.9** | `engines.npm` | Ships with Node 22. `npm ci` is the only install command used in CI and on Vercel |
| TypeScript | **^5.7.0** | `dependencies.devDependencies` | `strict: true` (NFR-022). `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` recommended |
| ECMAScript target | `ES2022`, `module: "esnext"`, `moduleResolution: "bundler"` | `tsconfig.json` | Next.js 15 requirement |
| Git | 2.40+ | CI image | Trivial |

### 2.2 Framework and runtime dependencies

| Package | Major | Why it is in the stack (one line) | Anchor requirement |
| --- | --- | --- | --- |
| `next` | **15** | App Router, React Server Components, Route Handlers, and Vercel-native deployment in one package | [03](./03_SYSTEM_ARCHITECTURE.md) ADR-005 |
| `react` | **19** | Required peer of Next 15; RSC support | — |
| `react-dom` | **19** | Pair with `react` | — |
| `firebase` | **11** | Browser SDK: Auth, Firestore listeners, Storage upload | DEC-15 |
| `firebase-admin` | **13** | Server SDK: `verifyIdToken`, transactions, Storage signed URLs; **bypasses Security Rules** | NFR-015 |
| `@google/genai` | **1.x** (verify) | The current unified Gemini SDK. **Must not** be paired with `@google/generative-ai` | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |
| `@vis.gl/react-google-maps` | **1.5.x** (verify) | Thin, provider-based React wrapper for the Maps JS API; tree-shakes the loader | [12 Map & Location](./12_MAP_LOCATION_SYSTEM.md) |
| `zod` | **4** | One schema definition shared by client form validation, server request validation, and the Gemini `responseSchema` | FR-142, FR-021 |
| `react-hook-form` | **7.x** | Uncontrolled, subscription-based form state; keeps keystrokes out of the React render path on `/report` | NFR-002 |
| `@hookform/resolvers` | **5.x** (verify) | Binds Zod 4 to react-hook-form's `resolver` option | FR-142 |
| `recharts` | **3** | Declarative SVG charts for the analytics surface; no chart state model of its own | FR-111…FR-113 |
| `lucide-react` | **0.5xx** (verify) | Tree-shakeable icon set; icon *names* are stored in `resources.icon` in Firestore | [07](./07_DATABASE_SCHEMA.md) §11.1 |
| `sonner` | **2.x** (verify) | Toaster for FR-076 optimistic rollback and FR-098 retry affordance | — |
| `ngeohash` | **0.6.x** | `encode`/`decode` for geohash precision 6; pure, tiny, no native code | FR-036, [07](./07_DATABASE_SCHEMA.md) §9.2 |
| `date-fns` | **4.x** (verify) | Timezone-aware formatting for `APP_TIMEZONE` display | FR-146 |
| `clsx` | **2.x** | Conditional class names | — |
| `tailwind-merge` | **3.x** (verify) | Conflict-free Tailwind class composition for shadcn/ui variants | — |
| `class-variance-authority` | **0.7.x** | Variant maps for buttons/badges (urgency, status, severity) | FR-072 |

> **Version honesty note.** Only the *major* lines above are a requirement. The minor lines marked *verify* were current when this document was written and are not asserted as exact. `npm ci` against the committed lockfile is the actual guarantee.

### 2.3 Development, test, and CI dependencies

| Package | Major | Purpose | Anchor requirement |
| --- | --- | --- | --- |
| `vitest` | **3** | Unit + integration runner (Jest-compatible API, native ESM/TS) | NFR-049, NFR-022 |
| `@vitest/coverage-v8` | **3** | V8 coverage provider (matches the V8 runtime used by Next 15) | [18 Testing & QA](./18_TESTING_QA_PLAN.md) |
| `@testing-library/react` | **16** | React 19 component testing | NFR-017 |
| `@testing-library/jest-dom` | **6.x** (verify) | DOM matchers for a11y assertions | NFR-017 |
| `@testing-library/user-event` | **14.x** (verify) | Realistic interaction simulation (keyboard, pointer) | NFR-018 |
| `@firebase/rules-unit-testing` | **4** | Emulator-backed Firestore/Storage rules tests | NFR-014 |
| `firebase-tools` | latest at install (verify) | Emulator Suite CLI, `firebase deploy --only firestore:rules,storage`, config lint | NFR-014 |
| `@playwright/test` | **1.5x** (verify) | E2E across the browser matrix in §9 | NFR-001, NFR-020 |
| `axe-core` or `@axe-core/playwright` | **4.x** (verify) | Automated WCAG 2.1 AA scanning in E2E and unit tests | NFR-017 |
| `eslint` | **9** (flat config) | Lint, plus the custom rules listed in §3.16 | NFR-022, NFR-023 |
| `eslint-config-next` | **15** | Next.js Core Web Vitals + React rules | NFR-023 |
| `prettier` | **3** | Formatting | NFR-023 |
| `prettier-plugin-tailwindcss` | **0.6.x** (verify) | Deterministic Tailwind class order | NFR-023 |
| `typescript-eslint` | **8.x** (verify) | TS-aware rules inside the ESLint flat config | NFR-022 |
| `lighthouse-ci` (`@lhci/cli`) | **0.14.x** (verify) | LCP/INP/CLS regression gate in CI | NFR-001, NFR-002 |
| `gitleaks` | latest (CI binary) | Free secret scanning in CI | NFR-013 |

### 2.4 Platform and third-party services (not npm packages)

| Service | Product | Access | Key env vars | Restriction requirement |
| --- | --- | --- | --- | --- |
| Identity | Firebase Authentication | `firebase` (client) + `firebase-admin` (server) | `NEXT_PUBLIC_FIREBASE_*` (client), `FIREBASE_*` (server) | See [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| Database | Cloud Firestore (Native mode) | `firebase` + `firebase-admin` | as above | DEC-15 |
| Object store | Cloud Storage for Firebase | `firebase` + `firebase-admin` | as above | [15 File Storage](./15_FILE_STORAGE_SPECIFICATION.md) |
| AI | Gemini via Google AI Studio | `@google/genai`, **server only** | `GEMINI_API_KEY` | Never `NEXT_PUBLIC_` — [21](./21_ENVIRONMENT_VARIABLES.md) §1 rule 2 |
| Maps | Maps JavaScript API, Geocoding API, Places API | Browser + server | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_KEY` | **Both keys must be restricted** — [21](./21_ENVIRONMENT_VARIABLES.md) §5 |
| Hosting + functions | Vercel (Next.js runtime) | CLI / dashboard | `CRON_SECRET`, `VERCEL_GIT_COMMIT_SHA` | [19 Deployment & DevOps](./19_DEPLOYMENT_DEVOPS.md) |

### 2.5 Repository shape implied by the stack

```
app/                 Next.js App Router: pages, layouts, route handlers (app/api/**/route.ts)
components/          Shared presentational components (shadcn/ui generated + app-specific)
features/            Vertical feature slices: reporting, dispatch, map, history, analytics, admin …
lib/                 Pure logic — NO Firestore import allowed in lib/ (FR-049 testability)
  ai/ geo/ duplicates/ incidents/ validation/ analytics/ api/
services/            Server-only services: ai/, duplicates/, dispatch/, notifications/, audit/
  firestore/         Admin SDK initialisation + transaction helpers
hooks/               Client hooks: useRealtime*, useMediaRecorder, useGeolocation
scripts/             seed.ts, create-admin.ts, backfill-*.ts (all NODE_ENV-guarded)
tests/               unit/, integration/, rules/, e2e/, fixtures/ai/
```

**Normative constraint:** `lib/**` must not import `firebase-admin`. This is what makes `haversineM`, `jaccard`, `classifyDuplicate`, `riskScore`, and `sanitize` unit-testable without an emulator (FR-049, [09](./09_AI_GEMINI_SPECIFICATION.md) §9.4 step 4).

---

## 3. Technology decisions

Each subsection uses the same four headings so that the reasoning is auditable. **Trade-offs accepted** is not a formality — where a choice is genuinely worse than an alternative, it says so.

### 3.1 Node.js 22.11+ and TypeScript 5.7 in strict mode

**Why selected**
- Node 22 is an Active LTS line; 22.11 is the floor that guarantees stable `require(esm)`, which removes an entire class of "works in dev, fails in the serverless bundle" failures with `firebase-admin` v13.
- TypeScript `strict: true` is the cheapest available enforcement of NFR-022 ("zero `any` in `app/`, `features/`, `services/`, `lib/`").
- The Firestore/Geo/Timestamp types are strongest when the compiler is strict; `strictNullChecks` is what makes `geo: null` (FR-034) impossible to mishandle.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Node 20 LTS | Older `require(esm)` behaviour; `firebase-admin` v13 targets 22. Vercel's default runtime has moved on. No benefit |
| Bun / Deno runtime | Vercel does not run them as a first-class Node replacement for Next.js Route Handlers. Would require self-hosting, breaking ADR-011 |
| TypeScript 4.x / non-strict | Cannot express discriminated unions over `IncidentStatus` safely; every `.strict()` Zod schema would need casts at the boundary |
| JavaScript + JSDoc | Loses `strictNullChecks`; Zod inference degrades to `any`; NFR-022 becomes unenforceable |
| Babel / SWC only (no typecheck) | Faster but gives no compile-time guarantee; ESLint + `tsc --noEmit` is required either way |

**Trade-offs accepted**
- TypeScript adds a build step and slows the inner loop. Mitigated by Vite-backed Vitest and `tsc --noEmit` in parallel with `next dev`.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` (recommended, not mandated) will surface friction with third-party typings. They are opt-in per-directory if a dependency proves incompatible.
- No `ts-node`/`tsx`-free scripts: `scripts/*.ts` run through Node's built-in type stripping in Node 22.11+; if a script needs a transform, it is run through Vitest's node environment instead of adding `tsx`.

### 3.2 Next.js 15 (App Router) as the single application framework

**Why selected**
- One deployable covers the marketing surface, the four role surfaces, the Server Components that do the first Firestore read, **and** the API — which means one auth story, one build, one set of headers in `middleware.ts`.
- Route Handlers give a real Node runtime (`export const runtime = 'nodejs'`, [08](./08_API_SPECIFICATION.md) §1.1) so `firebase-admin` and `@google/genai` work without a second compute project.
- Vercel deploys the output with zero configuration and gives a 4.5 MB request-body limit that is *irrelevant* because uploads go direct-to-Storage (ADR-004).

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Separate SPA (Vite/React) + separate API (Express/Fastify) | Two deployments, two auth wirings, CORS, a second place for a security header to be forgotten. Doubles the surface for a single-maintainer project |
| Remix / React Router 7 | Genuinely comparable. Rejected because Vercel's zero-config Next.js adapter and the App Router's server-component-by-default posture are better documented and more stable for RSC patterns at the time of writing |
| SvelteKit | Smaller runtime and excellent DX. Rejected: the team and the reviewer pool are React-shaped; Radix + shadcn/ui + the accessibility work in [25](./25_ACCESSIBILITY_RESPONSIVENESS.md) is an order of magnitude cheaper in React |
| Astro | Wrong tool: no first-class per-request server runtime of the shape we need, and the interactive surfaces are the majority of the product |
| Raw Cloudflare Workers / Deno Deploy | Would break `firebase-admin` and the Node-only Gemini SDK, or require HTTP calls to Firebase REST instead of the Admin SDK — trading a well-supported path for quota juggling |
| Firebase Hosting + Cloud Functions for the API | Works, but splits the app across two platforms (ADR-005) and loses one atomic deploy/rollback unit |

**Trade-offs accepted**
- Next.js is opinionated and the App Router has a real learning curve (async `params`/`searchParams`, server/client boundaries). Accepted because the alternative is a framework we would also have to learn plus a deployment we would also have to learn.
- The 4.5 MB Vercel body limit is a real constraint on the API. Worked around by DEC-08 (direct-to-Storage signed uploads) — a workaround, not a fix.
- **Known open risk carried from [21](./21_ENVIRONMENT_VARIABLES.md) §8:** Vercel Hobby has a lower maximum function duration than the 20 s AI timeout. If confirmed, triage must be fire-and-forget after incident creation. Logged as `DECISION REQUIRED` in §13.
- Next.js is the single largest dependency in the tree. Accepted in exchange for the deploy/SSR/route-handler unification; pinned to a single major at a time.

### 3.3 React 19 and the Server Component / client component split

**Why selected**
- Server Components let the first `/dashboard` and `/report` read happen on the server with the Admin SDK (server-authoritative role, NFR-015) instead of shipping an API key round-trip to the browser first. That directly serves NFR-001 (LCP) and the read budget in [26](./26_PERFORMANCE_REQUIREMENTS.md) §5.
- `'use client'` becomes an explicit, reviewable boundary. Every Firestore listener, every optimistic mutation, and every map interaction is forced to declare itself.
- React 19 is the peer version Next 15 targets; staying on 18 would be unsupported.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| A fully client-rendered SPA with SWR/React Query | Two round-trips before first content; role information would be briefly client-asserted, which is precisely what NFR-015 forbids. Rejected on security as much as performance |
| Next.js Pages Router | No RSC; server data would be `getServerSideProps` JSON, adding a client cache layer we deliberately do not have (§3.13 ADR-009) |
| React Server Components only, no client components | Impossible: geolocation, `MediaRecorder`, Firestore listeners, and the map are all browser APIs |
| Adding TanStack Query as a server-state cache | Explicitly rejected — see §6. It would create a second source of truth next to Firestore listeners |

**Trade-offs accepted**
- The server/client boundary is easy to get wrong. A `lib/geo` function used from both a Server Component and a Client Component pulls a second copy into the browser bundle; this must be checked against the per-route budget in [26](./26_PERFORMANCE_REQUIREMENTS.md) §2.2.
- Client components are not tree-shakeable at the boundary; `optimizePackageImports` discipline is required (documented in [26](./26_PERFORMANCE_REQUIREMENTS.md) §9).
- RSC cache semantics changed between Next 15 minor versions. Pinned and covered by tests rather than embraced.

### 3.4 Tailwind CSS v4, shadcn/ui (new-york, neutral base), Radix UI

**Why selected**
- shadcn/ui components are *copied into the repository*, not installed from a vendor. There is no shadcn version to upgrade, and the accessibility work is in the repo under our control.
- Radix provides the primitives (dialog, popover, select, combobox, toast-anchor) that make NFR-018 (full keyboard operability) achievable without writing focus-trap code.
- Tailwind v4's CSS-first configuration removes `tailwind.config.js` JS indirection and the `content` globs that silently break purging.
- The `neutral` base colour gives a dispatcher console that does not fight the severity colours, which are the only colours carrying operational meaning (FR-080, FR-101).

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| MUI / Ant Design | Larger runtime, opinionated theming that fights severity colours, and a11y regressions are upstream fixes we would wait for |
| Mantine | Excellent a11y and DX. Rejected on bundle size and on the same theming conflict |
| Headless UI | Fewer components than Radix; no combobox/select parity for the dispatcher filters |
| CSS Modules / vanilla-extract | Zero-runtime, but no design-token discipline; urgency/status colour mapping would be re-implemented in every feature slice |
| Plain CSS with a design-token stylesheet | The most honest zero-dependency option. Rejected because responsive layout across 5 viewports (NFR-020) is the single most common source of overflow bugs, and utility classes with a constrained scale prevent most of them |
| shadcn/ui with the `base` variant | Cosmetic only; `new-york` was chosen for its denser tables, which suit the dispatcher queue (FR-072) |

**Trade-offs accepted**
- Vendored shadcn components are *our* maintenance burden: upstream bug fixes do not arrive automatically.
- Tailwind v4 is a new major with a smaller community surface than v3. The `@theme` block is the version-sensitive part; it is isolated in one CSS file.
- Utility-class-heavy JSX is verbose and, if unbounded, hard to review. Mitigated by extracting `cva` variants for anything repeated (badges, buttons, rows).

### 3.5 Firebase v11 (client) + firebase-admin v13 (server)

**Why selected**
- One vendor for identity, database, listeners, and object storage, all with a usable free tier (C1), all reachable from the Vercel Node runtime.
- **Custom claims** on the ID token are readable inside Firestore Security Rules. That is the only mechanism in the whole platform that lets a *client* be authorised by a role it cannot forge, and it is the basis of [22](./22_USER_ROLES_PERMISSIONS.md) §2 and ADR-007.
- `firebase-admin` bypasses Security Rules, which is what allows the server to perform resource-scoped reads that rules cannot express (e.g. in-radius responder visibility, [22](./22_USER_ROLES_PERMISSIONS.md) §4.1).
- Firestore listeners give FR-090 (≤ 3 s propagation) without writing a WebSocket layer.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| **Realtime Database** | No transactions over multiple documents, no composite indexes, weaker query/planning, and DEC-15 is explicit: Firestore is the single datastore |
| **Supabase (Postgres + Realtime + Auth)** | The strongest alternative and genuinely attractive. Rejected on two counts: (a) it breaks the $0 constraint the moment a real project needs a paid plan or a non-local region; (b) Postgres geospatial is a *strength* we deliberately do not need, and Firestore's geohash emulation is explicitly honest about its limits ([07](./07_DATABASE_SCHEMA.md) §9.1) |
| **Appwrite / PocketBase /自-hosted** | Operational burden and self-hosting on a VPS contradict ADR-011 and C2 |
| **Neon / PlanetScale / Turso** | Free tiers are time-boxed or credit-metered; a demo that breaks when a trial expires is not a $0 guarantee |
| **AWS (DynamoDB + Cognito + S3 + Lambda)** | Genuinely capable, and a better fit for geospatial queries. Rejected: higher concept count, more keys to leak, and the free tier is per-service with more sharp edges |
| **Convex** | Excellent DX and reactivity. Rejected: platform lock-in that violates the spirit of NFR-029 and adds a vendor whose free tier is not contractually stable |
| **PlanetScale + Prisma** | SQL contradicts DEC-15-adjacent decisions; `prisma` is explicitly excluded (§6) |

**Trade-offs accepted**
- **No geospatial queries.** Firestore cannot do `near`/`geoWithin`. Every distance filter is emulated with geohash cells + Haversine in code ([07](./07_DATABASE_SCHEMA.md) §9.1–9.2). This is a real, permanent cost of choosing Firestore.
- **No `GROUP BY`/aggregation.** Analytics must read precomputed `analyticsDaily` rollups (FR-116, [07](./07_DATABASE_SCHEMA.md) §11.7).
- **Transactions are the only cross-document atomicity**, they silently retry up to 5 times (so every transaction body must be idempotent), and they are capped at 20 writes/s. Bulk operations must be chunked and queued.
- **Custom-claim writes are not transactional with Firestore** ([07](./07_DATABASE_SCHEMA.md) §12.7). A role change can leave a pending marker; the *server* treats `users/{uid}.role` as authoritative and the claim as a rules-only mirror.
- `firebase-admin` service-account credentials bypass every rule. They are the single most dangerous secret in the project ([21](./21_ENVIRONMENT_VARIABLES.md) §1 rule 7) and are rotated every 90 days.
- Vendor concentration: Firebase + Google Maps + Gemini are all Google. Accepted under NFR-029 as a documented lock-in, with a named escape hatch (`services/ai/provider.ts` exposes a `TriageProvider` interface — one provider is implemented, on purpose).

### 3.6 Firebase Authentication

**Why selected**
- Email/password **and** Google sign-in are both required by [22](./22_USER_ROLES_PERMISSIONS.md) §1 and both are free.
- ID tokens are self-describing, verified offline against Google's public keys, and cheap to verify per request (the basis of NFR-015).
- Custom claims are the only supported way to make a role visible to Security Rules → ADR-007.
- Token revocation is expressible (`checkRevoked: true` against `users/{uid}.tokensValidAfter`), which is how account suspension actually takes effect ([22](./22_USER_ROLES_PERMISSIONS.md) §8.3).

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| NextAuth / Auth.js | Would add a session layer, a database adapter, and a cookie strategy — all of which the project explicitly does not need (`SESSION_SECRET` is *intentionally undefined*, [21](./21_ENVIRONMENT_VARIABLES.md) §9) |
| Clerk / Auth0 / WorkOS | Paid above the free tier, or free-tier-limited in a way that would break the demo. Also a second vendor for something Firebase already provides |
| Clerk's free tier | Appealing, but its "10,000 MAU" model introduces a billing cliff and a second SDK |
| Self-rolled JWT sessions | Hand-rolled auth is how token forgery bugs happen. Rejected absolutely |
| Anonymous auth | Rejected by DEC-10 in the PRD: accountability and abuse prevention require an identity |

**Trade-offs accepted**
- Firebase Auth's own email sending is quota-limited per project. A burst of password resets can hit it. Mitigation: reset emails are best-effort with a "try again later" message, and no core flow depends on email delivery.
- Custom claims appear in the ID token and are therefore visible to the user, and are capped in size. Our claim is a single `role` string, so we are nowhere near the limit — but adding claims later must be justified.
- **Claim staleness is real and accepted.** After a role change the user must call `getIdToken(true)` ([08](./08_API_SPECIFICATION.md) §10). Before that, the claim and `users/{uid}.role` disagree and the server answers `403 ROLE_MISMATCH` — a fail-closed outcome, which is the correct trade.
- Account suspension does not fully revoke Firestore reads for an un-expired token (documented residual risk in [22](./22_USER_ROLES_PERMISSIONS.md) §8.3). All privileged data reads are therefore server-mediated.

### 3.7 Cloud Firestore

**Why selected**
- Documents match our access pattern: one queue row read per incident, denormalised summary fields ([07](./07_DATABASE_SCHEMA.md) §1.1).
- Composite indexes let the dispatcher queue, the citizen history, the responder assignments, and the SLA sweep be four indexed queries instead of four table scans.
- `array-contains` on the 10-element `geoCells` array is the *entire* geospatial strategy, and it costs exactly one query ([07](./07_DATABASE_SCHEMA.md) §9.2).
- Free-tier-shaped for the demo: reads/writes/storage, not provisioned IOPS.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Firestore in **Datastore mode** | Loses field-level rules, `array-contains`, and nested-subcollection ergonomics. Native mode only |
| Cloud SQL / PostgreSQL + PostGIS | Would solve geospatial properly and give real `GROUP BY`. Rejected on C1 (managed Postgres free tiers are limited and credit-metered) and C2 (schema migrations, connection pooling from serverless) |
| MongoDB Atlas | Free tier exists but is credit-metered and shared; adds a query language to learn |
| Firestore + BigQuery export | Out of scope; NFR-010 caps the horizon at 50 000 incidents, which one document read per incident can handle |
| Elastic / Algolia for `searchTokens` | Costs money and adds a component. `searchTokens` + `array-contains` is adequate for a 30-token cap and a 3-token query ([07](./07_DATABASE_SCHEMA.md) §4.1) |

**Trade-offs accepted**
- Cost is **per operation, not per byte**: a chatty dashboard is the main risk, so the read budget in [26](./26_PERFORMANCE_REQUIREMENTS.md) §5 is a hard architectural constraint, not an optimisation.
- The `deletedAt == null` filter must be in *every* query ([07](./07_DATABASE_SCHEMA.md) §12.4). It is the single most common defect this design invites; enforced by review and rules tests.
- 10-value array index limit and 30-value `in` limit are hard platform limits, and our status sets are designed to sit inside them (7 active statuses).
- Every transaction body must be idempotent because Firestore retries silently. This is a permanent, subtle correctness obligation.
- Firestore TTL deletes happen "within 24 h of `expiresAt`" — so TTL is a hygiene tool, never a correctness mechanism ([07](./07_DATABASE_SCHEMA.md) §12.7).

### 3.8 Cloud Storage for Firebase

**Why selected**
- Short-lived **V4 signed URLs** are exactly the mechanism FR-007 needs: the browser `PUT`s bytes straight to Storage, so file bytes never transit the Vercel function and the 4.5 MB body limit is irrelevant (DEC-08, ADR-004).
- Storage rules give per-path ownership (`staging/{uid}/…` is the uploader's alone; `incidents/{id}/…` is server-only), which is the storage half of the six enforcement layers in [22](./22_USER_ROLES_PERMISSIONS.md) §6.
- The Admin SDK can `copy`/`delete` to move a staged object into its final incident path ([08](./08_API_SPECIFICATION.md) §8.1), which solves the "incident ID does not exist yet" ordering problem without inventing a temporary document.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Upload through a Route Handler (multipart) | Blocked by the 4.5 MB Vercel limit for audio, and it would make the function the bandwidth bottleneck. Directly contradicts FR-007 |
| Cloudinary / Imgix / S3 + presigned POST | Cloudinary is genuinely better at image transforms. Rejected: costs money, and we deliberately do not add image processing (§6.2) |
| Amazon S3 | Excellent, but introduces a second cloud account/key set for zero gain |
| Store bytes in Firestore | 1 MiB document limit, base64 bloat, and every read would be a read. Rejected |
| Signed POST instead of signed PUT | POST is the more precise primitive (form fields enforce content type and size), but PUT is simpler from `MediaRecorder`/`Blob` and the size/type are re-verified server-side by magic-byte sniffing anyway (FR-008) |

**Trade-offs accepted**
- A two-step upload (sign → PUT → claim) is more client code than a single POST, and a user who abandons between steps leaves an orphan in `staging/` — swept by `sweep-staging-uploads` / `STAGING_UPLOAD_SWEEP_MIN=30`.
- Magic-byte sniffing is a heuristic, not a virus scanner. `scanStatus` exists in the schema ([07](./07_DATABASE_SCHEMA.md) §10.1) precisely so a real scanner can be added later without a migration. Accepted as an honest limitation.
- There is no permanent public media URL. Every read is a 15-minute signed URL, which is more server traffic but is the correct privacy posture (FR-103, NFR-027).

### 3.9 Gemini via `@google/genai` (model `gemini-2.5-flash`)

**Why selected**
- Structured output via `responseSchema` + `responseMimeType: 'application/json'` is the primary defence against a manipulated model returning a `dispatch: true` field; `.strict()` Zod on top of it is the second ([09](./09_AI_GEMINI_SPECIFICATION.md) §5.1).
- Text + image + audio in one call is what lets a single pipeline handle a garbled voice note and a photo (FR-005, FR-006).
- A free tier with a real model, and a local RPM/RPD guard (`GEMINI_RPM_LIMIT`, `GEMINI_RPD_LIMIT`) so we never exhaust it accidentally.
- `gemini-2.5-pro` is **not** used: latency and quota are the binding constraints (NFR-004).

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| `@google/generative-ai` (the older SDK) | Deprecated; the current SDK is `@google/genai`. Using both is explicitly forbidden ([09](./09_AI_GEMINI_SPECIFICATION.md) §2) |
| Vertex AI / Gemini on GCP | Better data-governance story, but it is a *paid* configuration and needs a service account with Vertex scopes. Breaks C1 |
| Claude / OpenAI / Mistral / Llama | Each is a second integration, a second schema-mapping exercise, and a second adversarial test set. **One AI provider only** is ADR-012; a `TriageProvider` interface exists so a swap is one file, but no second provider is implemented because speculative generality is worse than a migration |
| A local open-weights model on a VPS | Free per call, but adds GPU/ops cost (C1) and a second failure mode |
| Pure rules, no AI | The deterministic fallback in [09](./09_AI_GEMINI_SPECIFICATION.md) §7.2 *is* the safety net, and it is mandatory. It is not a replacement: fallback confidence never exceeds 0.55, so every fallback incident is badged "Needs review" by design |
| Client-side AI (WebGPU / transformers.js) | Exposes the API surface to the browser, breaks key management, and moves a 3-image payload onto a phone's metered connection |

**Trade-offs accepted**
- **AI latency is on the report path**: p95 ≤ 8 s, hard timeout 20 s (NFR-004). Accepted because triage happens before the incident is visible to the dispatcher (FR-020) and the UI shows an explicit "triage in progress" state. Mitigated, not removed.
- **Output is not trusted.** `.strict()`, one repair attempt, then fallback ([09](./09_AI_GEMINI_SPECIFICATION.md) §8). We pay for a repair call in ~1 in N failures.
- **The free tier's data-handling terms apply.** The sanitiser redacts PII and sends only a coarse area label, which bounds the exposure — a mitigation, not a guarantee ([09](./09_AI_GEMINI_SPECIFICATION.md) §13).
- Quota exhaustion during a live demo is a real risk. It is handled by the local guard, the fallback path, and a pre-flight check in [29 Demo Scenario](./29_DEMO_SCENARIO.md) — **never** by adding a paid key mid-demo.
- Gemini's safety filters can block a legitimate emergency report. Handled explicitly: `outcome: 'blocked'`, urgency forced to `high`, fallback for the rest ([09](./09_AI_GEMINI_SPECIFICATION.md) §6.2).

### 3.10 Google Maps via `@vis.gl/react-google-maps`

**Why selected**
- The wrapper is provider-based: `<APIProvider>` + hooks, so the loader is a separate import and the map is a lazily-loaded chunk (FR-086, [26](./26_PERFORMANCE_REQUIREMENTS.md) §7).
- Places Autocomplete gives FR-087 (debounced ≥ 300 ms geocoding) without hand-rolling a combobox; Radix supplies the accessible listbox behaviour.
- The Maps JS API is the only realistic way to draw the FR-084 500 m duplicate-radius ring and a live marker layer with `AdvancedMarkerElement`.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| MapLibre GL + OpenStreetMap raster tiles | No per-load billing at all, genuinely attractive for C1. Rejected for v1: OSM tile usage policy is not a *contractual* free tier, clustering and marker styling cost more implementation, and the team already knows the Google Maps API. **This is the most likely post-hackathon migration** and is recorded as a roadmap item, not a rejection on merit |
| Leaflet + OpenStreetMap | Same tile-policy objection, plus weaker marker/SDF rendering |
| `react-google-maps` (the older wrapper) | Effectively unmaintained for React 19; superseded by `@vis.gl/react-google-maps` |
| A static map image / iframe embed | Cannot show live markers, cannot be interactive, fails FR-080…FR-084 |
| Building a map from raw tiles | Rejected: this is not a product, it is a hobby |

**Trade-offs accepted**
- **This is the single real cost risk in the project.** Maps JavaScript API billing requires an enabled Google Cloud billing account; without a hard budget alert an unauthenticated key plus a public referrer list can generate a real invoice ([21](./21_ENVIRONMENT_VARIABLES.md) §5). Mitigations are mandatory, not optional: both keys restricted (referrer for the browser key, IP for the server key), a hard budget alert, and a documented list/table fallback for every map surface (FR-085). See §7.5.
- `in` cannot be combined with `array-contains`, so a viewport query is up to 9 sequential reads ([07](./07_DATABASE_SCHEMA.md) §12.1) — a real cost of combining Firestore with a map.
- Two keys, two restriction regimes, two failure modes (`MAPS_UNAVAILABLE`, 502). The degradation path is a static list fallback, not a spinner.
- A map route that lazy-loads the SDK still pays the SDK's own load cost. Budgeted explicitly in [26](./26_PERFORMANCE_REQUIREMENTS.md) §2.2 (B-3) and §8.1.

### 3.11 Zod 4

**Why selected**
- One schema per endpoint, exported and referenced from [08](./08_API_SPECIFICATION.md) (NFR-025), and reused verbatim as the Gemini `responseSchema` source ([09](./09_AI_GEMINI_SPECIFICATION.md) §5.1).
- `.strict()` makes "the model added a `dispatch` key" a validation failure rather than a silently ignored field. This is the single most valuable property in the AI design.
- Zod 4's inference is materially better than Zod 3, which matters because the same types flow into Firestore writes and API responses.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| `valibot` / `arktype` | Faster and smaller; both have smaller ecosystems and neither has a first-class, stable Zod→JSON-Schema bridge, which we need for Gemini |
| Joi / Yup | No `.strict()`-equivalent that fails on unknown keys, and no shared TS inference. Yup in particular is unmaintained |
| `zod` v3 | Works, but v4's error `issues` shape and performance are better and the migration cost of staying behind grows |
| Hand-written validators | Guarantees divergence between client and server validation. FR-142 exists precisely to prevent that |
| JSON Schema only | No inference, and a separate generator step |

**Trade-offs accepted**
- One more package in a bundle-sensitive app. Zod is used in Server Components and Route Handlers far more than in the browser; the client-side usage is limited to the form resolvers, and the per-route budgets in [26](./26_PERFORMANCE_REQUIREMENTS.md) §2.2 account for it.
- A Zod→JSON-Schema bridge is a real, occasionally imperfect translation. Mitigation: the schema is exported from `services/ai/schema.ts` (single source) and there is an explicit test that the generated JSON Schema matches the fixture Gemini accepted.

### 3.12 react-hook-form 7 + @hookform/resolvers

**Why selected**
- Uncontrolled inputs: typing in a 2 000-character `textarea` on a low-end Android does not re-render the form tree on every keystroke. That is the NFR-002 lever.
- `@hookform/resolvers` reuses the same Zod schema as the API, so FR-017's "disabled until valid, with the reason in `aria-describedby`" is a schema-derived fact, not hand-written `if` statements.
- Mature, framework-agnostic, tiny relative to form-heavy alternatives.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| React Hook Form's successors / TanStack Form | Newer and very promising; HFR 7 is battle-tested and the team knows its error-shape conventions |
| Controlled forms with `useState` | Re-renders the whole form per keystroke. Measurably worse on the exact device class in NFR-002 |
| Formik | Older, less focus on performance, weaker TypeScript inference |
| A bespoke form hook | FR-003 and FR-017 need validation, dirty tracking, submit-pending, and error focus management. Hand-rolling all of that is a bug source, not a saving |

**Trade-offs accepted**
- An abstraction between the DOM and state means debugging a field requires two mental models.
- The Tailwind **forms plugin is deliberately excluded** (§6.4) so the base input styles for checkbox/radio/select must be provided by the vendored shadcn components.

### 3.13 Recharts 3 (and the deliberate absence of a server-state library)

**Why selected**
- Recharts is declarative SVG, tree-shakeable, and takes plain arrays — which is exactly the shape of `analyticsDaily` rollups and `GET /api/analytics` ([08](./08_API_SPECIFICATION.md) §7.1). No chart state model to build.
- Category bar/donut (FR-111), trend lines (FR-112), and a bucketed histogram (FR-113) are all first-class.
- Responsive by container, which is what a dashboard that reflows from 1440 px to 768 px needs.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| D3 | Maximum control, no opinion. Rejected as **ADR-008**: scales, axes, and transitions would be re-implemented per chart, and FR-111…FR-113 are all standard forms. D3 is the right answer for a bespoke visualisation and the wrong answer for a hackathon with one maintainer |
| Nivo | Excellent defaults; heavier runtime and a React-version coupling that has broken twice historically |
| Chart.js | Imperative canvas API; needs a React wrapper; worse for accessible SVGs (NFR-017) |
| Victory | Effectively unmaintained relative to Recharts |
| Hand-rendered SVG/CSS bars | Tempting for one donut. Rejected because FR-112's trend and FR-113's histogram are not trivial and inconsistent chart styling across two features is a visible quality problem |
| **TanStack Query / SWR / Zustand / Redux** | **Explicitly excluded** (§6.1). Server state is read by Server Components and delivered by Firestore listeners; adding a cache layer creates a second source of truth with its own invalidation rules. ADR-009 |

**Trade-offs accepted**
- Bundle cost. Recharts is imported only inside `features/analytics` and `features/dashboard`, both behind a dynamic import with a skeleton (budgeted in [26](./26_PERFORMANCE_REQUIREMENTS.md) §2.2 B-5).
- Recharts is not the most accessible charting library out of the box. Mitigation: every chart has a visually-hidden data table and an `aria-label` summary; the axe scan covers it (NFR-017).
- Canvas vs SVG: Recharts is SVG, so very large series are slow. The analytics surface is capped at 366 buckets by the API's max span.

### 3.14 Small utility dependencies

| Package | Why it is here | What we gave up by not going further |
| --- | --- | --- |
| `lucide-react` | Tree-shakeable, consistent stroke style, and its *names* are what `resources.icon` stores ([07](./07_DATABASE_SCHEMA.md) §11.1) | We cannot use icon fonts or a custom set without a seed-data change |
| `sonner` | One `<Toaster />`; FR-076 rollback and FR-098 retry both need an actionable toast | No toast queue/persistence across reloads; not required |
| `ngeohash` | 0.6.x is small, pure, and has no native build step — important on Vercel | It has **no neighbour helper** in the version we target, so the 8-neighbour fan-out uses documented degree offsets and *must* be unit-tested against a reference table ([07](./07_DATABASE_SCHEMA.md) §9.2). This is a known, accepted risk |
| `date-fns` | The only date library in the project. `date-fns-tz`-style helpers or plain `Intl` cover `APP_TIMEZONE` display | No moment/dayjs-style mutable API; a deliberate reduction in surface |
| `clsx` + `tailwind-merge` + `class-variance-authority` | The canonical Tailwind + shadcn trio | Nothing; this is the standard stack |

**Alternatives considered** (aggregate): Moment.js and Day.js rejected — mutable, larger, and a migration hazard (Moment explicitly rejected in §6.5); `date-fns-tz` rejected in favour of `Intl.DateTimeFormat` with an explicit `APP_TIMEZONE`, one fewer dependency; a custom icon set rejected because the catalogue data in Firestore is already written against lucide names.

**Trade-offs accepted:** five small dependencies instead of one larger one. Each is individually replaceable in under an hour, and each has one obvious job.

### 3.15 Test toolchain

**Why selected**
- **Vitest 3** for unit and integration: native TS/ESM, fast, and shares the Vite transform with Next's tooling so there is no second compile path.
- **@firebase/rules-unit-testing 4** with the Emulator Suite: NFR-014 requires rules to be *deployed and tested*, not merely written. A rule that has never been executed against the emulator is an assumption.
- **Playwright** for E2E: one runner across Chromium, Firefox, and WebKit matches the browser matrix in §9, and `@axe-core/playwright` folds accessibility into the same run (NFR-017).
- **Lighthouse CI** turns NFR-001/NFR-002 into a build-failing gate instead of a wish.
- **gitleaks** is free and self-hosted, satisfying NFR-013 without a paid scanner.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Jest | Slower on ESM/TS, and a second transform pipeline. Kept only if a dependency forces it |
| Cypress | Genuinely good DX; rejected for a heavier runner and a weaker WebKit story |
| Testing Library's `jest-dom` under Jest | Not applicable under Vitest; `@testing-library/jest-dom` works with either |
| Unit tests only, no E2E | Realtime, roles, and multi-tab behaviour are not unit-testable. NFR-014 and the role matrix ([22](./22_USER_ROLES_PERMISSIONS.md) §10) demand E2E |
| A paid APM/Sentry for verification | §6.5; monitoring is free (see [26](./26_PERFORMANCE_REQUIREMENTS.md) §10) |

**Trade-offs accepted**
- The Firestore Emulator Suite must be running for rules and integration tests; a CI service container is required. A developer who forgets gets a confusing failure, mitigated by a preflight check in the test setup.
- Playwright adds real CI minutes. Mitigated by running the full matrix nightly and a single browser on every PR.
- Coverage is V8-based, so it measures execution, not intent. Thresholds are set on the modules where correctness is critical (`lib/duplicates`, `lib/ai`, `lib/incidents/lifecycle`), not globally.

### 3.16 ESLint 9 (flat config), Prettier 3

**Why selected**
- ESLint 9 flat config is a single `eslint.config.mjs` with no `extends` cascade, and it is the config format `eslint-config-next` 15 targets.
- Three custom rules carry real product requirements: no server-env import from a client file ([21](./21_ENVIRONMENT_VARIABLES.md) §1 rule 3); no `any` in `app/ features/ services/ lib/` (NFR-022); a review checklist item for `deletedAt == null` in queries ([07](./07_DATABASE_SCHEMA.md) §12.4).
- Prettier with `prettier-plugin-tailwindcss` removes class-order bikeshedding from review, which is a measurable review-time win on a UI-heavy codebase.

**Alternatives considered**

| Alternative | Why not |
| --- | --- |
| Biome | Faster and simpler. Rejected because `eslint-config-next` does not exist for it, and Next-specific correctness rules (server/client boundary, `no-img-element`) would be lost |
| ESLint 8 `.eslintrc` | Supported by Next 15, but flat config is the direction and the migration is small |
| Prettier only, no lint | Formatting is not correctness. NFR-022/023 need both |
| ESLint only, no Prettier | Class ordering and JSX wrapping would consume review attention forever |

**Trade-offs accepted**
- Two formatters of opinion in the repo; conflicts are resolved by the documented order (ESLint `--fix` then Prettier) in `npm run lint`.
- Custom rules are our maintenance burden and can produce false positives; they are scoped tightly to reduce that.

---

## 4. Platform-level alternatives and the lock-in position

### 4.1 Hosting: Vercel vs. a VPS vs. Cloud Run vs. Firebase Hosting

| Option | Verdict | Reason |
| --- | --- | --- |
| **Vercel Hobby** | **ADOPTED (ADR-011)** | $0, zero-config Next.js, edge headers via `middleware.ts`, built-in cron, one deploy unit with rollback. The binding constraints are the 4.5 MB body limit (worked around, DEC-08) and the max function duration (`DECISION REQUIRED`, §13) |
| A single small VPS (Hetzner/DigitalOcean) + Docker + Caddy | Rejected | Cheaper at scale, but a maintainer becomes a sysadmin: TLS renewal, patching, backups, log shipping, monitoring. Directly contradicts C2. It also breaks the "one atomic deploy" property |
| Google Cloud Run | Rejected | Serverless and cheap-to-free, but adds a second cloud account, container images, and cold starts in front of the Firestore region |
| Firebase Hosting + Cloud Functions (2nd gen) | Rejected | Two platforms, two deploy pipelines, and Functions would need the Admin SDK wired identically. Chosen against in ADR-005 |
| Cloudflare Pages/Workers | Rejected | Great edge, but the Node runtime story for `firebase-admin` and the Gemini SDK is a workaround, and Workers' subrequest/CPU limits would need re-validating every design decision |

**Lock-in position (NFR-029).** The genuine lock-in is **Google** (Firebase + Maps + Gemini). It is accepted and documented rather than mitigated, because the alternatives each cost money or time. Two named escape hatches exist and cost nothing: (a) the datastore is reached only through `services/firestore/*`, so a SQL migration is a rewrite of that directory, not of the app; (b) the AI provider is behind `services/ai/provider.ts`. Everything else (auth, storage, hosting) is replaceable in a bounded amount of work.

### 4.2 Datastore: why Firestore and not SQL

DEC-15 in the PRD settles this; the technical case is:

| Factor | Firestore | Postgres (managed free tier) |
| --- | --- | --- |
| $0 guarantee | Daily operation quota on the free tier, no expiry | Free tiers are credit-metered or time-boxed; a demo can break when a trial ends |
| Serverless write model | Native — no connection pooling from serverless functions | Connection limits, pooling (PgBouncer), and cold-connection latency are a real tax |
| Transaction ergonomics | `runTransaction` with automatic retry | Correct, but multi-statement retry semantics are hand-written |
| Geospatial | **No geo queries at all** — must be emulated ([07](./07_DATABASE_SCHEMA.md) §9.1) | `PostGIS` is a first-class, indexed, exact answer |
| Aggregation | **No `GROUP BY`** — needs `analyticsDaily` rollups | Native |
| Admin/rules layer | Custom claims readable in Security Rules | Row-level security, comparable but not identical |
| Schema evolution | Field-optional, no migrations | Migrations required; a 50 000-row table is trivial but the tooling is not free |

**Honest conclusion:** Postgres is the better database. Firestore wins on C1 + C2, loses badly on geo and aggregation, and we pay for both losses with an explicitly documented emulation layer rather than pretending they do not exist.

### 4.3 Firebase Emulator Suite vs. a shared dev Firebase project

| Option | Verdict | Reason |
| --- | --- | --- |
| Emulator Suite (Auth + Firestore + Storage) for local dev | Rejected as the **default** local path | `firebase-admin` against emulators needs extra wiring, and the Emulator UI is a second thing to learn. But it is **required** for the rules tests ([18](./18_TESTING_QA_PLAN.md) §7) |
| **A dedicated `caregrid-ai-dev` Firebase project** | **ADOPTED** | Real SDK behaviour (rules, indexes, TTL) with no emulator tax. Isolated from prod. Trade-off: local development **can** mutate the dev project, and emulator-only behaviours (offline persistence) are not reproducible locally |

Consequence, stated plainly: **the default local path uses the dev project's real Firestore**, so `NEXT_PUBLIC_FIREBASE_USE_EMULATORS` is `true` only for the rules test suite, and `ALLOW_SEED=true` + `NODE_ENV !== 'production'` is the only way to write demo data ([21](./21_ENVIRONMENT_VARIABLES.md) §4). Never share one Firebase project across environments.

### 4.4 Single region vs. multi-region

Single region, matching the Vercel region, with `preferredRegion: 'bom1'` (Mumbai) as a candidate for Firestore latency ([21](./21_ENVIRONMENT_VARIABLES.md) §8). Multi-region Firestore costs roughly 2× per operation and buys nothing for a single-city product (PRD §9 excludes multi-tenant federation). **Honest note:** the Vercel region and the Firestore region must both be verified before the demo; a mismatch adds a network round-trip to every request, which is directly a NFR-001/NFR-003 risk. `DECISION REQUIRED` (§13).

### 4.5 Realtime transport: Firestore listeners vs. WebSockets vs. polling

| Option | Verdict | Reason |
| --- | --- | --- |
| **Firestore `onSnapshot`** | **ADOPTED (ADR-009)** | Already authenticated with the same ID token, already role-filterable, already covered by Security Rules, and it delivers FR-090's ≤ 3 s p95 with no server code |
| A custom WebSocket service | Rejected | A new always-on service to operate and secure (C2), for a capability Firestore already has |
| Server-Sent Events from a Route Handler | Rejected | Vercel serverless has no durable connection; every SSE consumer pins an instance |
| Polling | Rejected | Directly contradicts FR-090 ("without polling") and multiplies the read budget ([26](./26_PERFORMANCE_REQUIREMENTS.md) §5) |

The cost is real and accepted: a listener is billed one read per document per attach, and a listener that is not unsubscribed is a permanent read leak. FR-091's ≤ 8 listeners and FR-092's `limit()` + unsubscribe discipline are therefore architectural requirements, not lint suggestions.

### 4.6 Monorepo vs. single package

**Single package.** A monorepo (Turborepo/Nx/pnpm workspaces) is the right answer for a team shipping several apps. Here there is one app, one deploy, and one maintainer; workspaces would add install time, a second lockfile, and cross-package type resolution problems for zero benefit.

---

## 5. Third-party API requirements

### 5.1 Gemini (Google AI Studio)

| Item | Requirement | Source |
| --- | --- | --- |
| SDK | `@google/genai` only. `@google/generative-ai` is **deprecated and forbidden** | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |
| Auth | `GEMINI_API_KEY`, server-only, `new GoogleGenAI({ apiKey })`. **Never** a `NEXT_PUBLIC_` var | [21](./21_ENVIRONMENT_VARIABLES.md) §1 rule 2 |
| Model | `GEMINI_MODEL`, default `gemini-2.5-flash`. `gemini-2.5-pro` not used | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |
| Endpoint | `aiplatform.googleapis.com`, hard-coded in the SDK | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |
| Timeouts | `GEMINI_TIMEOUT_MS=20000` hard; `GEMINI_MAX_RETRIES=3` for **429/503 only**, never for 400 | [09](./09_AI_GEMINI_SPECIFICATION.md) §2.1 |
| Local quota guard | `GEMINI_RPM_LIMIT=8`, `GEMINI_RPD_LIMIT=200`, `AI_ENABLE_LOCAL_QUOTA_GUARD=true`. **Quota numbers are never hard-coded in source** — they are set from the project's AI Studio quota page | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |
| Structured output | `responseMimeType: 'application/json'` + `responseSchema` + `safetySettings` at `BLOCK_ONLY_HIGH` | [09](./09_AI_GEMINI_SPECIFICATION.md) §6.2 |
| Tools / function calling | **Never configured.** The model cannot call anything | [09](./09_AI_GEMINI_SPECIFICATION.md) §4.3 step 9 |
| Output validation | `aiTriageOutputSchema` (Zod, `.strict()`), **one** repair attempt (`AI_REPAIR_ATTEMPTS=1`), then deterministic fallback | FR-021, FR-022 |
| Request cap | ≤ 3 images, ≤ 1 audio clip ≤ 120 s, ≤ 2 000 chars text, ~18 MB total; images dropped in reverse order above 15 MB with `mediaDropped` logged | [09](./09_AI_GEMINI_SPECIFICATION.md) §2.1, §4.2 |
| Failure behaviour | Never fails the report (FR-029). `AI_UNAVAILABLE` never reaches the client on `POST /api/incidents` | [08](./08_API_SPECIFICATION.md) §3.1 |
| Observability | `aiRuns` per attempt with `model`, `promptVersion`, `latencyMs`, token usage, `outcome`, `fallbackUsed`, `rawOutputHash` (never the raw text) | FR-028, [09](./09_AI_GEMINI_SPECIFICATION.md) §9 |
| Change control | A model change is an env change (`GEMINI_MODEL`), not a code change. `services/ai/gemini.ts` is the only file that constructs `GoogleGenAI` | [09](./09_AI_GEMINI_SPECIFICATION.md) §2 |

### 5.2 Google Maps JavaScript API

| Item | Requirement | Source |
| --- | --- | --- |
| Client | `@vis.gl/react-google-maps` with `APIProvider`; script loaded lazily, never in the `/dashboard` initial bundle | FR-086, [26](./26_PERFORMANCE_REQUIREMENTS.md) §2.2 B-3 |
| Key | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (public by design, like the Firebase web key, but **environment-specific**) | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| **Restriction** | **Application restriction: HTTP referrers** — `localhost:3000/*`, `https://<staging-domain>/*`, `https://<prod-domain>/*`. APIs: Maps JavaScript API, Places API | [21](./21_ENVIRONMENT_VARIABLES.md) §5 |
| Styling | `NEXT_PUBLIC_MAP_STYLE` (`dark` operationally), `NEXT_PUBLIC_MAP_ZOOM_DEFAULT=13`, `NEXT_PUBLIC_MAP_ZOOM_MAX=18` | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| Search | Places Autocomplete, debounced ≥ 300 ms (FR-087) | — |
| Degradation | On load failure, render the static list fallback with coordinates plus a **Retry map** action (FR-085). Never a spinner-only failure | [12](./12_MAP_LOCATION_SYSTEM.md) |
| Markers | Incident markers coloured by urgency, shaped by status; responder markers `available`/`busy`/`offline`; clustering toggle above 20 markers | FR-080…FR-082 |
| Viewport queries | Bounded: ≤ 500 m radius or ≤ 25 documents (FR-037), and per [07](./07_DATABASE_SCHEMA.md) §12.5 ≤ 150 incidents, ≤ 9 cell queries, ≤ 25 km span | — |

### 5.3 Google Geocoding API (server-side)

| Item | Requirement | Source |
| --- | --- | --- |
| Key | `GOOGLE_MAPS_SERVER_KEY` — a **different key** from the browser key | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| **Restriction** | **Application restriction: IP addresses** — the Vercel egress ranges from the dashboard, plus the local machine for dev. APIs: Geocoding API, Places API | [21](./21_ENVIRONMENT_VARIABLES.md) §5 |
| Use | Server-side reverse geocoding of incident coordinates to a `placeName`; region bias from `GOOGLE_MAPS_REGION` | FR-035, [12](./12_MAP_LOCATION_SYSTEM.md) |
| Privacy | Street-level components are **discarded before the AI sees anything**; only a coarse area label (`locality`/`sublocality`/`administrative_area_level_2`) is sent to Gemini. The street-level `placeName` is stored for dispatcher display only | FR-035, [09](./09_AI_GEMINI_SPECIFICATION.md) §4.1 |
| Timeout | 8 000 ms (`AbortSignal.timeout(8_000)`) | [08](./08_API_SPECIFICATION.md) §1.1 |
| Failure | `MAPS_UNAVAILABLE` (502) and the incident is still created with `geo` set but no `placeName` | [08](./08_API_SPECIFICATION.md) §1.7 |

### 5.4 Google Places API

| Item | Requirement | Source |
| --- | --- | --- |
| Uses | Place Autocomplete (client, browser key) for map/address search; Place details for a manual pin's `placeId`/`placeName` | [12](./12_MAP_LOCATION_SYSTEM.md) |
| Keys | Browser key (referrer-restricted) for Autocomplete; `GOOGLE_MAPS_SERVER_KEY` (IP-restricted) for server-side detail lookups | [21](./21_ENVIRONMENT_VARIABLES.md) §5 |
| Debounce | ≥ 300 ms; never a request per keystroke (FR-087) | — |
| Free-text address path | `location.source = 'address_text'` requires `location.text` 3–200 chars and triggers a server-side geocode; a geocode failure is a warning, not a rejection, and the incident is created with `geo = null` | [08](./08_API_SPECIFICATION.md) §3.1 |

### 5.5 Firebase Authentication (as a third-party surface)

| Item | Requirement | Source |
| --- | --- | --- |
| Providers | Email/password + Google. Both are handled **client-side**; there is no `/api/auth/login` route | [08](./08_API_SPECIFICATION.md) §2 |
| Token | `Authorization: Bearer <Firebase ID token>`; `verifyIdToken` server-side; refresh on 401 | [08](./08_API_SPECIFICATION.md) §1.1 |
| Claims | `setCustomUserClaims({ role })`; the claim is a **mirror**, `users/{uid}.role` is authoritative | ADR-007, [22](./22_USER_ROLES_PERMISSIONS.md) §2 |
| Revocation | `verifyIdToken(token, true)` against `users/{uid}.tokensValidAfter` on suspension | [22](./22_USER_ROLES_PERMISSIONS.md) §8.3 |
| Audit | `POST /api/auth/event` for `login`/`logout`/`login_failed`; `auth.login_failed` is rate-limited to 10/IP/hour (FR-135) | [08](./08_API_SPECIFICATION.md) §2.4 |

---

## 6. Deliberately excluded technologies

> **This section is normative.** [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 refers to §6 for the image-processing decision, which is **6.2** below. Adding any package named in this section requires a §13 decision-register entry.

### 6.1 No client server-state library (no Redux, no Zustand for server data, no TanStack Query, no SWR)

**Why not:** Server state in this app has exactly three sources — a Server Component read, a Route Handler response, and a Firestore listener. A cache library adds a fourth authority with its own invalidation rules, plus a body of code whose only job is to re-fetch things Firestore already pushes. The data lives in Firestore; duplicating it in a client cache is the defect, not the fix. UI-only state (open panel, selected row, form draft) stays in React state or `react-hook-form`.

### 6.2 No `sharp` (no server-side image processing)

**Why not:** `sharp` is a native binary dependency. It is the right tool for thumbnailing, re-encoding, and dimension extraction, and it is what a production version of this product would use. For v1 it is excluded for three compounding reasons: (a) it is a native module that must be present in the Vercel build image for every function, which is an extra class of "works locally, fails on deploy" failure; (b) it costs CPU and time on every upload for a benefit the demo does not show; (c) Vercel's built-in image optimisation already covers the *display* case.

**What we do instead:** client-side downscaling on upload (`canvas`/`createImageBitmap`) when the file exceeds the declared budget, the client sends `clientWidth`/`clientHeight` with the sign request, the server records `width`/`height`/`durationSec` on the `MediaRef` ([07](./07_DATABASE_SCHEMA.md) §10.1), and Gemini receives the original bytes inline, accepting the latency as [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 step 2 states explicitly. **Accepted cost:** no server-side guarantee about image dimensions, and larger inline payloads to Gemini (mitigated by the 15 MB budget check that drops images in reverse order, logged as `mediaDropped`).

**Revisit when:** the demo needs multi-size derivatives, or upload volume makes the display cost visible.

### 6.3 No tRPC

**Why not:** tRPC's type inference between client and server is excellent, and it is the *second* best answer after a shared Zod schema. But we already need a hand-written HTTP contract for the API specification ([08](./08_API_SPECIFICATION.md)), CSRF origin checks, a uniform error envelope with a stable `code`, and `requestId` correlation (FR-140, FR-141). tRPC's error model would have to be wrapped to produce that envelope anyway, so the type benefit is retained but the wire format is still ours. Zod already gives us the shared types (Zod 4's `z.infer`).

### 6.4 No Prisma, Drizzle, or any ORM

**Why not:** there is no SQL database (DEC-15-adjacent, §4.2). An ORM for Firestore is not a thing; Firestore's own Admin SDK *is* the data layer, and writing transactions by hand is required for the patterns in [07](./07_DATABASE_SCHEMA.md) §12.6. A repository layer is the only indirection we allow, and it is ours.

### 6.5 No Tailwind forms plugin

**Why not:** the vendored shadcn/ui components already define the base input styles, and the plugin is a global preflight-adjacent override. Its defaults would fight our own variant system on the 5 urgency colours. Style inputs explicitly.

### 6.6 No Moment.js or Day.js

**Why not:** we use `date-fns` plus `Intl.DateTimeFormat` with `APP_TIMEZONE` (FR-146). Adding a second date library is the classic cause of timezone bugs in incident timelines.

### 6.7 No Redis (no `ioredis`, no Upstash, no in-memory rate-limit store)

**Why not:** C1. Redis free tiers exist but are throughput-metered and would add a network dependency to *every write request*. Firestore's transaction-backed token bucket ([07](./07_DATABASE_SCHEMA.md) §11.6) costs 1 read + 1 write per limited request and needs no new service. `RATE_LIMIT_STORE=firestore` is explicit in [21](./21_ENVIRONMENT_VARIABLES.md) §2, and `RATE_LIMIT_STORE=memory` is documented as **unsafe on Vercel** because serverless instances are ephemeral and per-instance.

### 6.8 No Sentry (or any paid APM)

**Why not:** NFR-030 asks for structured server logs with `requestId` and a *pluggable, default-disabled* client reporter. Vercel function logs, the Firebase usage dashboard, and `GET /api/admin/system/health` cover the demo. `SENTRY_DSN` exists in the env template as an **optional, disabled-by-default** hook so the plug-in point is real without the cost.

### 6.9 No Storybook

**Why not:** a component gallery is a second build, a second dependency tree, and a second thing to keep in sync. For a hackathon with a fixed UI spec ([04](./04_UI_UX_DESIGN_SPECIFICATION.md)), visual review happens in the running app plus Playwright screenshots.

### 6.10 No i18n library

**Why not:** the UI is English-only (PRD §9). The AI records the detected input `language` for later work (FR-004) and that is a data field, not a UI feature. Adding `next-intl` would add routing, message catalogs, and a translation surface with no consumer.

### 6.11 No service worker / PWA framework (no `next-pwa`, no Workbox)

**Why not:** the requirement is a responsive web app that is *PWA-ready*, not an offline-first application (PRD §9 excludes full offline sync). A hand-written minimal `manifest.webmanifest` plus a same-origin service worker for asset caching satisfies "installable"; a framework would add build coupling for offline behaviour we explicitly do not support.

### 6.12 No retry/queue library (no BullMQ, no Inngest, no Trigger.dev)

**Why not:** the only asynchronous work in v1 is: notification fan-out (fire-and-forget, ≤ 2 retries, FR-107), analytics/risk recompute (cron or manual admin trigger), and four maintenance sweeps ([08](./08_API_SPECIFICATION.md) §10). All of that is implemented as idempotent functions called from a Route Handler or a cron route, and failures are logged and retried on the next run. A durable queue is the right answer at 10× the volume, and would be a cost and complexity liability now.

### 6.13 No GraphQL and no public read API

**Why not:** a GraphQL endpoint would be a second, differently-authorised way to read data — the fastest way to defeat the two-gate model in [22](./22_USER_ROLES_PERMISSIONS.md) §5. One HTTP surface, one envelope, one audit story.

### 6.14 No Docker, no Kubernetes, no Terraform

**Why not:** ADR-011. Vercel owns the build; Firebase owns the infrastructure. There is nothing for a Dockerfile or Terraform state to manage, and both would add a way for the deployed environment to diverge from the documented one.

### 6.15 No observability vendor

**Why not:** see §6.8. Free tooling is enumerated in [26](./26_PERFORMANCE_REQUIREMENTS.md) §10.

---

## 7. Cost analysis — proving the $0 claim (NFR-026)

The claim is: **running the CareGrid AI demo costs $0.** Line by line, with the honest caveats.

### 7.1 The claim table

| # | Line item | Paid plan? | Free tier used | Cost | Verifiable at |
| --- | --- | --- | --- | --- | --- |
| 1 | **Vercel** — hosting, serverless functions, CDN, cron | Hobby (free) | Hobby: personal/non-commercial use, HTTPS, cron **once per day** | **$0** | Vercel dashboard → Billing; Hobby plan terms |
| 2 | **Custom domain** | Paid | **Not purchased.** The demo runs on the `*.vercel.app` subdomain | **$0** | — |
| 3 | **Cloud Firestore** — database | Spark (free) | Spark: a shared **daily** operation allowance for reads, writes, deletes + stored data | **$0** | Firebase console → Usage & billing → **verify the current daily figures** |
| 4 | **Firebase Authentication** — email/password + Google sign-in | Spark (free) | Spark: free sign-in, free token verification; email *sending* is quota-limited | **$0** | Firebase console → Authentication → Usage; Google Identity Platform pricing |
| 5 | **Cloud Storage for Firebase** — evidence files | Spark (free) | Spark: free bucket with a small stored-data allowance and monthly egress allowance | **$0** | Firebase console → Storage → Usage; **verify GB and egress figures** |
| 6 | **Gemini API** — AI triage | Free tier key | Google AI Studio free tier, `gemini-2.5-flash` | **$0** | AI Studio usage dashboard; **verify RPM/RPD** and set `GEMINI_RPM_LIMIT`/`GEMINI_RPD_LIMIT` from it |
| 7 | **Google Maps JavaScript API** — map, markers, clustering | Free monthly credit | Monthly usage credit for Maps JavaScript API loads | **$0 *only if* the credit is not exceeded and a hard budget alert is set** | Google Cloud Console → Billing → Budgets; Maps Platform pricing |
| 8 | **Geocoding API + Places API** | Free monthly credit | Free monthly credit on the same Cloud billing account | **$0 *within credit*** | Google Cloud Console → Billing |
| 9 | **Google Cloud Platform** base charges | Billing **enabled** (required for Maps) | No compute, no VMs, no load balancer, no Cloud Logging ingestion beyond free tiers | **$0** | Google Cloud Console → Billing → zero charges other than any Maps overage |
| 10 | **CI** (lint, test, build, rules deploy, Lighthouse CI) | Paid | GitHub Actions free minutes for public repos; `gitleaks` self-hosted | **$0** | GitHub → Actions → Usage |
| 11 | **Email** (password reset, responder verification) | Paid | None sent through a provider; Firebase Auth's own relay only, quota-limited | **$0** | Firebase console |
| 12 | **SMS / WhatsApp** notifications | Paid | **Not implemented.** `ENABLE_SMS_NOTIFICATIONS=false`, `ENABLE_WHATSAPP_NOTIFICATIONS=false`; channels exist behind a `NotificationChannel` interface with **no provider** (FR-105, FR-106) | **$0** | n/a |
| 13 | **Error monitoring** | Paid | None. `SENTRY_DSN` optional and unset | **$0** | n/a |
| 14 | **Seed data** | — | Local script; `ALLOW_SEED=true` + non-production only (FR-147) | **$0** | — |
| 15 | **Registries** | — | npm public packages | **$0** | — |

**Total: $0**, conditional on line 7/8 (see §7.5) and on line 1's plan terms.

### 7.2 The arithmetic behind the Firestore line

The $0 claim for Firestore is not "we will not use much" — it is an arithmetic claim we can check. The daily read consumption is dominated by two things: initial listener attach and queue polling. Using the estimates in [07](./07_DATABASE_SCHEMA.md) §15 and the budgets in [26](./26_PERFORMANCE_REQUIREMENTS.md) §5:

```
Reads per dispatcher session-hour
  = first-paint RSC read        (~120)
  + live-queue listener attach  (~50 docs, 1 read each)
  + listener re-deliveries      (bounded by incident churn)
  + candidate ranking           (≤ 60, on demand only)
  + analytics                   (≤ 366, only for a 366-day range)

At 10 dispatchers × 6 h  = 60 session-hours
  ⇒ ~4 000 reads/session-hour × 60 ≈ 240 000 reads on a demo day
  plus 1 dispatcher opening a 7-day analytics view ≈ +30 reads
```

> **VERIFY REQUIRED.** The Firestore Spark-plan daily read allowance is *documented at time of writing as a specific figure that we are deliberately not restating here*, because quotas change and a wrong number in this document would be worse than an honest "check the console". The check is: run the demo rehearsal load ([26](./26_PERFORMANCE_REQUIREMENTS.md) §11), then read the actual usage in Firebase console → Usage & billing, and confirm the day landed under the allowance. The architectural mitigations that make this safe are `limit()` on every query, ≤ 8 listeners per client (FR-091), and a 30-day analytics window served from ≤ 30 rollup reads (FR-116).

### 7.3 The arithmetic behind the Gemini line

```
Demo scenario ([29](./29_DEMO_SCENARIO.md)): ~30 triage calls
Local guard: GEMINI_RPD_LIMIT = 200/day
⇒ demo usage ≈ 15% of our own self-imposed daily ceiling
```

Repair attempts double the call count for a failure. Even at a 30% failure rate during a live demo, total calls stay under 60, well inside both our guard and (verify) the free-tier RPD quota.

### 7.4 The arithmetic behind the Storage line

```
Demo scenario: 3 incidents × (2 images + 1 audio) ≈ 6 images @ ~300 KB + 3 audio @ ~400 KB
               ≈ 3.0 MB uploaded
Free-tier bucket allowance: "documented at time of writing — verify"
⇒ three orders of magnitude of headroom. The 50 000-incident horizon in NFR-010
  is what would eventually matter, and it is a roadmap problem, not a demo problem.
```

### 7.5 The one real cost risk: Google Maps billing

**This is the honest answer to "what could actually cost money?"**

| Failure mode | Consequence | Mandatory control |
| --- | --- | --- |
| A Google Cloud billing account is enabled for Maps and the Maps monthly usage credit is exceeded | Real charges appear on a real card | **Hard budget alert** at a small amount, configured before the demo ([21](./21_ENVIRONMENT_VARIABLES.md) §5) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` has **no application restriction** | Anyone can use the key from any site and exhaust the credit, billing you | Referrer restriction is mandatory: `localhost:3000/*`, staging, prod |
| `GOOGLE_MAPS_SERVER_KEY` has no IP restriction | Same, plus server-side abuse | IP restriction to the Vercel egress ranges + local machine |
| The alert is set but nobody watches email during a demo | A slow overage | Check the budget before and after the rehearsal; the demo is a known, bounded number of map loads |
| Billing is disabled entirely | Maps fails with `MAPS_UNAVAILABLE` / `REQUEST_DENIED` | **Documented fallback:** every map surface degrades to the list fallback (FR-085); the rest of the product is unaffected. This is the honest "we turn the map off and still demo" path |

**Second, smaller risk:** Vercel Hobby's terms of service cover personal and non-commercial use. A hackathon entry is non-commercial; a later commercial deployment would require a paid plan. Flagged as `DECISION REQUIRED` (§13).

**Third, smallest risk:** Firebase Spark-plan quotas are not contractual. If a quota were reduced, the honest response is degradation (keyword fallback for AI, cached read-through for reads, list fallback for maps) — all of which are already designed.

### 7.6 What we will not do to keep the cost at zero

- No paid key introduced mid-demo, ever. If Gemini quota is exhausted, the demo runs on the keyword fallback and says so honestly ([09](./09_AI_GEMINI_SPECIFICATION.md) §9.1).
- No vendor whose "free" tier requires a card that can be charged without an explicit action.
- No service that requires a minimum plan purchase to be created.

---

## 8. Free-tier considerations by service

> **All allowances below are "documented at time of writing — verify."** Firebase, Google, and Vercel change quotas without notice and without a changelog aimed at hobby projects. The authoritative check for every number is the provider's own console: **Firebase console → Usage & billing**, **Google AI Studio → Usage**, **Google Cloud Console → Billing → Budgets**, **Vercel dashboard → Usage**. This document records the *shape* of each allowance and *what breaks*; it does not assert figures we cannot re-verify at read time.

### 8.1 Firebase Authentication

| Aspect | Position |
| --- | --- |
| Documented free allowance | Free email/password and Google sign-in; free ID-token verification. Email *delivery* through Firebase's own relay is quota-limited per project. **Verify** the current sending quota. |
| What breaks at the limit | New sign-ups and password resets start failing with an auth-provider error. Existing sessions are unaffected. |
| Our mitigation | Sign-up is never on the critical path of *reporting an already-signed-in emergency*; a sign-up failure shows an actionable error, not a blank screen. Password reset is best-effort and the UI says so. `POST /api/auth/login-failed` is rate-limited 10/IP/hour (FR-135) to prevent log flooding from an attacker burning the quota. |
| Verification pointer | Firebase console → Authentication → Usage; Google Identity Platform → Quotas |

### 8.2 Cloud Firestore

| Aspect | Position |
| --- | --- |
| Documented free allowance | A single **daily** pool covering document reads, writes, deletes, and stored data, on the Spark (free) plan. There is also a maximum daily *operation* ceiling per project. **Verify** both numbers in the console. |
| What breaks at the limit | Firestore returns `RESOURCE_EXHAUSTED`. The API maps that to `DB_UNAVAILABLE` (503). Reporting fails — this is the only third-party failure that can break the core flow, which is why it is the one we budget hardest against. |
| Our mitigation | (a) `limit()` on **every** query; (b) ≤ 8 listeners/client (FR-091) and mandatory unsubscribe (FR-092); (c) 30-day analytics from rollups, ~30 reads (FR-116); (d) duplicate candidate cap of 50, and 25 when a live listener is active ([07](./07_DATABASE_SCHEMA.md) §15); (e) the read budget per dispatcher session-hour is capped at 4 000 (NFR-007) and verified by the load plan in [26](./26_PERFORMANCE_REQUIREMENTS.md) §11; (f) `analyticsDaily` rollups mean a 30-day analytics view costs the same whether there are 500 or 50 000 incidents. |
| Verification pointer | Firebase console → Usage & billing → **Document reads / writes / deletes**, day by day; run the rehearsal load first |

### 8.3 Cloud Storage for Firebase

| Aspect | Position |
| --- | --- |
| Documented free allowance | A default bucket with a free stored-data allowance and a monthly network-egress allowance. **Verify** the current GB and egress figures. |
| What breaks at the limit | Uploads fail (`STORAGE_UNAVAILABLE`, 503) or signed-URL generation fails. Evidence is lost if the upload was mid-flight. |
| Our mitigation | Per-file retry with progress ([01 PRD](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) US-002); upload failures never discard the typed text — the report is still submittable with text only; `POST /api/uploads/sign` validates declared size against `UPLOAD_MAX_IMAGE_BYTES`/`UPLOAD_MAX_AUDIO_BYTES` **before** a signed URL is issued, so an oversized file is rejected without spending bandwidth; orphan staging objects are swept after `STAGING_UPLOAD_SWEEP_MIN=30`. |
| Verification pointer | Firebase console → Storage → Usage; check the bucket's stored bytes and egress |

### 8.4 Gemini (Google AI Studio)

| Aspect | Position |
| --- | --- |
| Documented free allowance | Requests-per-minute and requests-per-day per project **per model** on the Generative Language API free tier. **Verify** the numbers for `gemini-2.5-flash` in AI Studio and set `GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT` below them (defaults 8 / 200). |
| What breaks at the limit | HTTP 429. We do **not** fail the report: the local guard short-circuits before calling the API, and the deterministic keyword fallback produces the triage ([09](./09_AI_GEMINI_SPECIFICATION.md) §7). The incident appears with `triageSource: 'fallback'`, `urgency: medium`, `triageError: 'AI_QUOTA'`, and an `aiRuns` row with `outcome: 'error'`. |
| Our mitigation | Local RPM/RPD guard; 20 s hard timeout with 3 retries for 429/503 only; one repair attempt then fallback; audio disabled (`GEMINI_AUDIO_ENABLED=false`) when quota headroom < 50% ([09](./09_AI_GEMINI_SPECIFICATION.md) §9.1); a pre-flight quota check before the demo. **Never** a paid key. |
| Verification pointer | AI Studio → Usage (24 h / 7 d), and read the project's quota page — do not hard-code the numbers |

### 8.5 Google Maps Platform (JS API, Geocoding, Places)

| Aspect | Position |
| --- | --- |
| Documented free allowance | A **monthly usage credit** for Maps JavaScript API loads, and free-tier monthly request allowances for Geocoding and Places. Billing must be **enabled** on the Cloud project to use the Maps APIs. **Verify** the current credit and per-API request allowances. |
| What breaks at the limit | **Overage → charges** (the only real cost risk in the project, §7.5). Separately, exceeding an API-specific free-tier request cap returns `OVER_QUERY_LIMIT`; a disabled/restricted key returns `REQUEST_DENIED`. |
| Our mitigation | Both keys **restricted** ([21](./21_ENVIRONMENT_VARIABLES.md) §5); a **hard budget alert**; the map is lazily loaded so a demo run loads it a bounded number of times; viewport queries are bounded (FR-037, ≤ 150 incidents); debounced geocoding (FR-087); and a **documented list fallback for every map surface** (FR-085) so a Maps outage does not stop the demo. |
| Verification pointer | Google Cloud Console → Billing → **Budgets** (alert set + no charges), Billing → Usage, and Maps Platform → Usage |

### 8.6 Vercel (Hobby)

| Aspect | Position |
| --- | --- |
| Documented free allowance | Hobby: $0 for personal/non-commercial use, HTTPS, a global CDN, serverless function invocations with a per-day ceiling, and **cron jobs limited to once per day**. Also: a **4.5 MB serverless request body limit** and a maximum function duration. **Verify** the current invocation ceiling and function-duration limit for the plan — the duration limit is the open risk in §13. |
| What breaks at the limit | Functions return an over-quota error and the app is unavailable. A request body over 4.5 MB is rejected outright. |
| Our mitigation | (a) **Media never transits a function** — direct-to-Storage signed PUT (FR-007, DEC-08, ADR-004), which sidesteps the body limit entirely; (b) the analytics rollup cron is scheduled **once per day** (`0 3 * * *`) and risk recomputation is a **manual admin action** ([08](./08_API_SPECIFICATION.md) §7.2) precisely because of the cron limit; (c) `SLA_BREACH_SWEEP=on_write` so no minute-level cron is needed; (d) the four maintenance sweeps are explicit, admin-triggered, individually audited endpoints ([08](./08_API_SPECIFICATION.md) §10). |
| Verification pointer | Vercel dashboard → Usage; and the plan's documented function max-duration for the triage route |

---

## 9. Browser support matrix

Targets follow [25 Accessibility & Responsiveness](./25_ACCESSIBILITY_RESPONSIVENESS.md) and NFR-020. Support means: **all citizen and responder flows work end to end; dispatcher flows are supported on desktop browsers; the map may degrade to its list fallback.**

| Browser / device | Tier | Supported | Required capabilities | What degrades | Notes |
| --- | --- | :-: | --- | --- | --- |
| **Chrome** (desktop, last 2 major) | Primary | ✔ | ES2022, `MediaRecorder`, `geolocation`, `canvas`, WebGL (Maps) | — | Reference environment; all budgets measured here |
| **Microsoft Edge** (Chromium, last 2 major) | Primary | ✔ | as Chrome | — | Shares the engine; only Chromium-specific testing gap |
| **Firefox** (desktop, last 2 ESR + current) | Primary | ✔ | as Chrome | Audio container may differ: `audio/webm` may be `audio/ogg` and must be transcode-free — mapped to the allow-list or the audio option hides | Firefox `MediaRecorder` MIME support is narrower than Chromium's; `ENABLE_VOICE_REPORTING` gates on feature detection, not user agent |
| **Safari / macOS** (current + previous) | Primary | ✔ | as Chrome | — | Tested via Playwright WebKit |
| **iOS Safari** (current + previous, iPhone) | Primary (citizen/responder) | ✔ | `MediaRecorder` (audio only, image capture via `<input type=file accept=image/*>`), `geolocation`, **no** `navigator.mediaDevices.getUserMedia` audio on some iOS versions | Voice recording hides if unsupported (US-003 criterion 3); `getUserMedia` is never required | The report form must be completable with the keyboard closed, one-handed, at 360 px (PRD §4.1) |
| **Android Chrome** (current, mid-range) | Primary | ✔ | as Chrome; `MediaRecorder` audio `audio/webm` | — | NFR-002 ("Interactive on `/report` (mid-range Android) ≤ 3.0 s") is measured here |
| **Low-end Android WebView / Chrome, ≤ 2 GB RAM** | Supported, degraded | ✔ (text path guaranteed) | Text reporting + pin drop; image upload attempted with a progress bar | Concurrent map listeners are reduced; clustering is force-enabled above 20 markers; the dashboard KPI refresh interval is relaxed; a device-capability hint disables non-essential animation | NFR-012 graceful degradation; a slow device must still be able to **report** |
| **Samsung Internet** | Supported, degraded | ✔ | Chromium-based | Same as low-end Android | Playwright does not cover it; covered by Chromium at a reduced performance target |
| **Opera / Opera Mini** | Best-effort | ◐ | Chromium-based desktop | Same as Chrome | Not in the test matrix |
| **Tor Browser** | Not supported | ✖ | — | — | Out of scope; a note in the README |
| **Text-only / screen reader** | Supported | ✔ | WCAG 2.1 AA (NFR-017), full keyboard operability (NFR-018) | The map's canvas is not navigable; the **map list fallback is the accessible equivalent** and is always available (US-040 criterion 4) | axe + manual audit; the fallback is a first-class list, not a degraded mode |
| **No JavaScript** | Not supported | ✖ | — | — | The product is a live operations console; a no-JS path is out of scope. The citizen **tracking** page is the one candidate for a future static fallback |

**Explicit non-goals:** Internet Explorer (any), legacy EdgeHTML, Opera Mini's data-saver mode, and WebViews older than Android 9.

**Feature-detection rules (no user-agent sniffing):**

| Feature | Detection | Behaviour if absent |
| --- | --- | --- |
| `MediaRecorder` | `'MediaRecorder' in window` | Voice option hidden, text alternative shown |
| `navigator.geolocation` | `'geolocation' in navigator` | Manual pin + address text only (FR-033) |
| `crypto.subtle.digest` (client SHA-256) | `'crypto' in window && crypto.subtle` | `sha256` omitted from the sign request; server computes it |
| `IntersectionObserver` | `'IntersectionObserver' in window` | Map marker rendering falls back to `limit(25)` per viewport (FR-037) |
| `CanvasRenderingContext2D` (client downscale) | feature detection | Original file uploaded; §6.2 accepted cost |

---

## 10. Mobile support approach

**Decision: a responsive, installable web application. No native app. No app-store presence. No push-notification infrastructure.**

| Aspect | Approach | Requirement anchor |
| --- | --- | --- |
| Layout | Single responsive layout, 5 breakpoints covering 360 / 390 / 768 / 1024 / 1440 px, no horizontal scroll at 360 px | NFR-020 |
| Touch | All primary actions ≥ 44 × 44 px; the record button ≥ 56 px | NFR-021, US-003 |
| Offline | **Limited local queue only**: a draft report in IndexedDB/localStorage (FR-014) and a responder action queue with a "pending sync" badge and ordered replay on reconnect (US-014). No general offline sync. | PRD §9 |
| Installability | `manifest.webmanifest` (name, icons, `display: standalone`, `theme_color`, `start_url: '/'`) plus a minimal same-origin service worker for asset caching only. No Workbox. | §6.11 |
| Notifications | In-app only. No Web Push (a service-worker push handler, VAPID keys, and browser permission UX are a second notification system we do not need while a tab is open). | FR-100, DEC-14 |
| Media capture | `<input type="file" accept="image/*" capture="environment">` for camera; `MediaRecorder` for voice, feature-detected | FR-005, FR-006 |
| Location | `navigator.geolocation` requested **only after an explicit user action**; accuracy graded; manual pin and address text always offered | FR-030…FR-034 |
| Map on mobile | The map is optional on `/report` (pin drop has a coordinate/address alternative). On `/map`, a full-screen map with a bottom-sheet list; the list fallback is always reachable. | US-040 criterion 4 |
| Battery | No continuous GPS. One `watchPosition` while the map is open; a 60 s heartbeat for responders **only while available and the tab is active** (FR-066). | NFR-020 persona, FR-066 |
| Battery/network budget | Realtime is push-based, so an idle screen costs nothing. No polling anywhere (FR-090). | [26](./26_PERFORMANCE_REQUIREMENTS.md) §6 |
| `prefers-reduced-motion` | Honoured globally; the live-row highlight is the only non-essential animation | NFR-019 |
| Orientation | Portrait is the design target; landscape is supported but not optimised | — |

**Why not a native app:** PRD §9 excludes it; the personas need a browser at incident time; and a React Native build would double the frontend surface while adding app-store review latency that a hackathon cannot absorb. Recorded as a roadmap item in [28](./28_FUTURE_ROADMAP.md).

**What "PWA-ready" means here, precisely:** installable, offline-capable for *previously visited* routes and a stored draft, no install prompt nag on the report flow, and a status bar that matches the theme colour. It does **not** mean background sync of mutations, which is explicitly deferred.

---

## 11. Deployment requirements

### 11.1 Environments

| Environment | Firebase project | URL | Seed | Notes |
| --- | --- | --- | --- | --- |
| `development` | `caregrid-ai-dev` | `http://localhost:3000` | allowed with `ALLOW_SEED=true` | Uses the dev project's **real** Firestore by default (§4.3) |
| `staging` | `caregrid-ai-staging` | `https://staging.<domain>` | allowed with `ALLOW_SEED=true` | Production rate limits |
| `production` | `caregrid-ai-prod` | `https://<domain>` (or `*.vercel.app`) | **blocked in code** | `ALLOW_SEED=true` + `NODE_ENV=production` throws at boot ([21](./21_ENVIRONMENT_VARIABLES.md) §7) |

**Never share a Firebase project between environments** ([21](./21_ENVIRONMENT_VARIABLES.md) §4).

### 11.2 Build

| Item | Value | Source |
| --- | --- | --- |
| Build command | `npm run build` | [21](./21_ENVIRONMENT_VARIABLES.md) §8 |
| Install command | `npm ci` (lockfile-exact) | — |
| Node | `>= 22.11.0` in `engines` **and** the Vercel project setting; both must match | [21](./21_ENVIRONMENT_VARIABLES.md) §8 |
| Output | Next.js 15 default (`standalone` output not required on Vercel) | — |
| Route runtime | `export const runtime = 'nodejs'` on **every** `app/api/**/route.ts` | [08](./08_API_SPECIFICATION.md) §1.1 |
| Region | Vercel region + `preferredRegion: 'bom1'` candidate; **verify against the Firestore region** | [21](./21_ENVIRONMENT_VARIABLES.md) §8, §13 |
| Function memory | 1024 MB (the triage route may hold 3 inlined images) | [21](./21_ENVIRONMENT_VARIABLES.md) §8 |
| Function max duration | Target 25 s for triage; **Vercel Hobby may cap this lower** | `DECISION REQUIRED` §13 |
| Headers | CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), microphone=(self), camera=(self)` in `vercel.json` + `middleware.ts` | [08](./08_API_SPECIFICATION.md) §12.13–14 |
| Cron | `0 3 * * *` daily rollup only (Hobby = once/day) | [21](./21_ENVIRONMENT_VARIABLES.md) §8 |

### 11.3 Pre-deploy gate (all must pass)

| Gate | Command | Enforces |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` | NFR-022 |
| Lint | `npm run lint` (ESLint 9 flat config + custom rules) | NFR-022, NFR-023 |
| Format | `npm run format:check` | NFR-023 |
| Unit + integration | `npm run test` | FR-049, AI safety rules |
| Rules tests | `npm run test:rules` (emulator) | NFR-014 |
| E2E | `npm run test:e2e` (Playwright, Chromium gate) | NFR-017, NFR-020 |
| Accessibility | axe inside the E2E run | NFR-017 |
| Lighthouse CI | `npx lhci autorun` | NFR-001, NFR-002 |
| Secret scan | `gitleaks detect --no-git` | NFR-013 |
| Build | `npm run build` | — |

### 11.4 Firestore / Storage artefacts to deploy

| Artefact | Command | Why it must not be skipped |
| --- | --- | --- |
| Composite indexes | `firestore.indexes.json` → deploy | Without them, index #6 (the map/dup query) fails at runtime |
| Security Rules | `firestore.rules`, `storage.rules` | NFR-014: rules must be *deployed*, not merely written |
| Seed (non-prod only) | `scripts/seed.ts` with `ALLOW_SEED=true` | [07](./07_DATABASE_SCHEMA.md) §14 |
| First admin | `scripts/create-admin.ts` | Out-of-band by design ([22](./22_USER_ROLES_PERMISSIONS.md) §8.1) |

### 11.5 Rollback and operational readiness

- Vercel promotes the previous deployment instantly; no database migration is involved in a deploy, which is a genuine advantage of the schema-free Firestore model.
- A bad deploy that broke **indexes or rules** is not rolled back by Vercel — it is rolled back by redeploying the previous `firestore.rules`/`firestore.indexes.json` with `firebase-tools`. This is in the runbook.
- `GET /api/health` (unauthenticated, cached 30 s) and `GET /api/admin/system/health` (admin) are the pre-demo health checks.
- A pre-demo checklist lives in [29 Demo Scenario](./29_DEMO_SCENARIO.md): quota check for Gemini, budget check for Maps, an admin login, a signed-report end to end, and a **rehearsal run of the load plan** in [26](./26_PERFORMANCE_REQUIREMENTS.md) §11.

---

## 12. Requirement → technology traceability

| Requirement | Technology that satisfies it |
| --- | --- |
| FR-007 (bytes never transit the function) | `firebase-admin` signed URL + Cloud Storage (ADR-004) |
| FR-008 (magic-byte validation) | Node `crypto` hash + the first 4 KiB read via the Admin SDK; no `file-type` dependency needed |
| FR-014 (local draft) | Browser IndexedDB/localStorage, no library |
| FR-020…FR-029 (AI triage) | `@google/genai` + Zod 4 + `services/ai/*` |
| FR-036 (server-computed geohash cells) | `ngeohash` 0.6 |
| FR-040…FR-049 (duplicate engine) | `ngeohash` + pure `lib/duplicates/score.ts`; ≥ 20 unit tests (FR-049) |
| FR-066 (responder heartbeat) | `navigator.geolocation` + `PATCH /api/responders/:id/location` |
| FR-080…FR-088 (map) | `@vis.gl/react-google-maps` + Places |
| FR-090…FR-099 (realtime) | `firebase` Firestore `onSnapshot`; no polling (ADR-009) |
| FR-111…FR-113 (charts) | Recharts 3 (ADR-008) |
| FR-140…FR-143 (envelope, requestId, Zod-first, UTC) | Zod 4 + `lib/api/*` |
| FR-142 (validate before any DB/AI call) | The route-handler pipeline in [08](./08_API_SPECIFICATION.md) §1.6 step 7 |
| NFR-001/NFR-002 (LCP/INP) | Next.js 15 RSC, route-level code splitting, Recharts and Maps behind dynamic imports |
| NFR-013 (no secret in the client bundle) | `lib/env.ts` vs `lib/env.client.ts` split + lint rule + gitleaks |
| NFR-014 (rules deployed and tested) | `firebase-tools` + `@firebase/rules-unit-testing` |
| NFR-015 (server-side authorization) | `firebase-admin` `verifyIdToken` + `users/{uid}.role` read (NFR) |
| NFR-016 (rate limiting) | Firestore token bucket (§6.7) |
| NFR-017/NFR-018 (a11y) | Radix primitives + axe + the map list fallback |
| NFR-022/NFR-024 (strict TS, ≤ 400-line components) | TypeScript strict + ESLint custom rules |
| NFR-026 ($0) | §7 |
| NFR-030 (structured logs, default-disabled reporter) | Vercel logs + `requestId` + optional `SENTRY_DSN` |

---

## 13. Decision register and open items

### 13.1 Technology decisions taken

| ID | Decision | Alternatives rejected | Consequence to live with |
| --- | --- | --- | --- |
| TD-01 | Single Next.js 15 app for UI **and** API | SPA + separate API, Remix, Astro, Workers | One framework to learn; opinionated routing |
| TD-02 | Firestore (Native) as the only datastore | RTDB, Postgres/Supabase, MongoDB Atlas, DynamoDB | No geo queries, no `GROUP BY` — both emulated |
| TD-03 | Roles in Firebase Auth custom claims, mirrored from `users/{uid}.role` | NextAuth sessions, a role table read by rules, Clerk | Claim staleness; a pending-marker retry |
| TD-04 | Direct-to-Storage signed uploads | Multipart through a function, Cloudinary, S3 | Two-step upload; orphan staging files |
| TD-05 | Zod 4 as the single validation source | Joi/Yup, valibot, hand-written | One more package; JSON-Schema bridge is imperfect |
| TD-06 | `@google/genai` + `gemini-2.5-flash`, one provider | `@google/generative-ai`, Vertex, other vendors | Vendor lock-in; quota dependence |
| TD-07 | `@vis.gl/react-google-maps` | MapLibre, Leaflet, raw tiles | The $0 risk in §7.5 |
| TD-08 | Recharts 3 | D3, Nivo, Chart.js | SVG performance on very large series |
| TD-09 | Firestore listeners, **no** client cache library | Redux/Zustand-for-server-state, TanStack Query, SWR, polling | A second authority is deliberately absent |
| TD-10 | Vercel Hobby | VPS, Cloud Run, Firebase Hosting, Cloudflare | 4.5 MB body limit, once/day cron, function-duration cap |
| TD-11 | ngeohash 0.6 + 10-cell `geoCells` + Haversine | geohash fan-out, `GeoPoint` ranges, PostGIS, Maps Geometry library | Approximate neighbour offsets must be unit-tested |
| TD-12 | Vitest + Playwright + rules-unit-testing | Jest, Cypress, unit tests only | An emulator service container in CI |
| TD-13 | No `sharp`; client downscale + server-side sniff only | `sharp`, Cloudinary transforms, Vercel image optimisation | No server guarantee of dimensions (§6.2) |
| TD-14 | No `next-pwa`/Workbox; minimal manifest + SW | `next-pwa`, Workbox, `vite-plugin-pwa` | Not a true offline app (by design, PRD §9) |

### 13.2 `DECISION REQUIRED` — open items

| ID | Question | Why it is open | Proposed default | Blocks |
| --- | --- | --- | --- | --- |
| **DR-01** | What is the **maximum function duration** on the actual Vercel plan in use? | [21](./21_ENVIRONMENT_VARIABLES.md) §8 flags a possible 10 s Hobby cap, which is **shorter than the 20 s AI timeout** in NFR-004. If confirmed, an in-request synchronous triage cannot meet its own contract. | Verify the plan limit first. If < 25 s: keep triage in the request but with a **fire-and-forget AI step after the incident write** — the incident is created with `triageSource: 'pending'` and updated when triage returns — or move the AI call to a client-triggered route with a longer budget. The API contract (`POST /api/incidents` returns a fully triaged incident) would then need an amendment. | FR-020, FR-029, NFR-004, the demo's core narrative |
| **DR-02** | Which **Vercel region** and which **Firestore region**? | `preferredRegion: 'bom1'` is a *candidate*; it must be confirmed against the actual Firestore location, and a mismatch adds a network hop to every request. | Pick one region and set both; verify the Firestore region from the Firebase console before the first deploy. | NFR-001, NFR-003 |
| **DR-03** | Is a **custom domain** purchased, or is the `*.vercel.app` subdomain used? | A domain is a real, recurring cost and would break the strict $0 claim. | Use the `*.vercel.app` subdomain. State the URL on the submission form. | NFR-026, §7 line 2 |
| **DR-04** | Is the **Vercel Hobby plan acceptable** for a hackathon submission? | Hobby's terms cover personal/non-commercial use. A hackathon entry is non-commercial, but the terms must be read, not assumed. | Yes, with the submission clearly marked non-commercial. If a judge requires otherwise, that is a budget decision, not a technical one. | NFR-026 |
| **DR-05** | What is the **Google Maps monthly credit** and the exact **budget alert amount**? | The credit is what makes §7 line 7 true. | Read the value from the Cloud Console, set a hard budget alert at a small multiple of the expected demo usage, and record the alert amount in [29](./29_DEMO_SCENARIO.md). | NFR-026, §7.5 |
| **DR-06** | Is `ngeohash` 0.6's **neighbour helper** available, and does the degree-offset fan-out match a reference table? | [07](./07_DATABASE_SCHEMA.md) §9.2 requires the 8 neighbours to be *correct*; an error means false negatives in duplicate detection. | If the helper exists, use it. Otherwise validate the offsets with the required unit tests against known coordinates and, if they cannot be made exact, raise the neighbour derivation to a **precision-5** fan-out and re-verify the read budget. | FR-040, FR-049 |
| **DR-07** | Should `Gemini` be **called with audio enabled** by default on the demo path? | Audio increases payload size, latency, and token cost, and consumes quota faster; it is also the most fragile MIME path across browsers. | `GEMINI_AUDIO_ENABLED=false` for the primary demo path; enable it only for the voice demo segment, with the fallback demonstrated honestly. | FR-006, NFR-004, §8.4 |
| **DR-08** | What is the **provenance and licence** of the geohash neighbour offsets and the Jaccard stopword list? | Both are embedded constants. The stopword list is English-only and blocks non-English duplicate detection quality (FR-004 records the language but does not translate). | Attribute both in a `NOTICE` in the repo. Accept that duplicate text matching is weaker for non-English reports and surface `language` in the duplicate breakdown so the dispatcher can see why. | FR-042, FR-043 |
| **DR-09** | Does the **Vercel Hobby cron** need `CRON_SECRET`, and is a daily-only schedule acceptable for `analyticsDaily` completeness? | With one cron per day, "today"'s rollup can only be produced the next morning. | Accept it. `GET /api/analytics` already switches to a live scan for ranges ending less than 48 h ago (FR-116), so the gap is invisible to the user. `POST /api/analytics/recompute` covers an on-demand refresh. | FR-115, FR-116 |

---

## 14. Document consistency rules

1. Adding a package: add it to §2 **and** add an entry to §13.1 explaining what it replaces, or flip the relevant §6 entry.
2. Raising a minimum version: update §2.1, then run the full §11.3 gate.
3. Changing a field name, collection, endpoint, or env var: amend [07](./07_DATABASE_SCHEMA.md), [08](./08_API_SPECIFICATION.md), or [21](./21_ENVIRONMENT_VARIABLES.md) **first**, then this document.
4. Any claim about a provider's free tier must carry the "documented at time of writing — verify" qualifier. A number we cannot re-verify at read time is not written down.
5. If this document and the code disagree, this document wins until it is amended.

# 31 — Coding Standards

**Project:** CareGrid AI
**Document type:** Language, architecture, and process rules for writing code in this repository
**Status:** Baseline v1.0 — normative; every rule is either lint-enforced, test-enforced, or a review gate
**Related documents:** [01 PRD](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) · [05 Frontend Architecture](./05_FRONTEND_ARCHITECTURE.md) · [06 Backend Architecture](./06_BACKEND_ARCHITECTURE.md) · [07 Database Schema](./07_DATABASE_SCHEMA.md) · [08 API Specification](./08_API_SPECIFICATION.md) · [16 Error Handling](./16_ERROR_HANDLING.md) · [17 Validation Rules](./17_VALIDATION_RULES.md) · [18 Testing & QA Plan](./18_TESTING_QA_PLAN.md) · [20 Folder Structure](./20_PROJECT_FOLDER_STRUCTURE.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [22 Roles & Permissions](./22_USER_ROLES_PERMISSIONS.md) · [32 AI Agent Rules](./32_AI_CODING_AGENT_RULES.md)

> **Authority.** Where this document and an anchor document disagree, the anchor document wins and this file is amended. [07](./07_DATABASE_SCHEMA.md) owns field names, [08](./08_API_SPECIFICATION.md) owns endpoint contracts, [16](./16_ERROR_HANDLING.md) owns error codes, [17](./17_VALIDATION_RULES.md) owns field bounds, and [20](./20_PROJECT_FOLDER_STRUCTURE.md) owns file placement. This document owns everything else: how the code is written, named, reviewed, and committed.

---

## 0. How to read this document

| You are | Read | Skip |
| --- | --- | --- |
| Writing your first PR | §1, §15, §16 | §14 |
| Adding an API endpoint | §6, §7, §10 | §4, §5 |
| Touching Firestore | §8, §9, §13 | §4 |
| Reviewing a PR | §12, §15, §16 | §2–§11 skim |
| An AI coding agent | [32](./32_AI_CODING_AGENT_RULES.md) first, then this document in full | — |

**Enforcement legend.** Every rule is tagged with how it is enforced, so a reviewer knows whether a violation is a build failure or a conversation:

| Tag | Meaning |
| --- | --- |
| **[LINT]** | A rule in `eslint.config.mjs`; `npm run lint` fails |
| **[TYPE]** | A `tsconfig.json` compiler flag; `npm run typecheck` fails |
| **[SCRIPT]** | A `scripts/check-*.ts` CI check |
| **[TEST]** | A test in [18](./18_TESTING_QA_PLAN.md); `npm run verify` fails |
| **[REVIEW]** | A human gate; a reviewer must reject the PR |
| **[DOC]** | A documentation obligation; the PR is incomplete without it |

---

## 1. Principles

Five beliefs. Everything below is a consequence of one of them.

### 1.1 Readability over cleverness

The reader is a stressed human at 2 a.m. during a hackathon, or a reviewer who has never seen this file. A clever solution that takes a paragraph to explain is worse than a boring one that takes a line. **[REVIEW]**

### 1.2 Boring code

If two implementations are equally clear, prefer the one whose behaviour you can predict without reading it: an explicit `if` over a clever generic, a named constant over an inline literal, a `switch` over a lookup chain with side effects. **[REVIEW]**

### 1.3 No premature abstraction

Two call sites do not make a utility; three do, and even then only if the abstraction removes real duplication. Abstractions written for a hypothetical third caller are dead weight with a maintenance cost. One of the most important rules here: **do not build the layer you might need.** **[REVIEW]**

### 1.4 Consistency with what exists

When you add a route, a component, or a validator, the first thing to do is find the closest existing example and match it — its naming, its file layout, its error handling, its test style. A repository with two conventions has no convention. **[REVIEW]**

### 1.5 Delete dead code

Unused code in a repository is a security and review liability ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §7 #15). If it is not reachable, it is not documentation; it is a trap for the next reader. Deleting a function is a feature, not a failure. **[REVIEW]**

---

## 2. TypeScript rules

### 2.1 Compiler configuration

```jsonc
// tsconfig.json — the flags this project commits to
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,   // DECISION REQUIRED — see §17 D-31-1
    "verbatimModuleSyntax": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "es2022",
    "paths": { "@/*": ["./*"] }
  }
}
```

| Flag | Why it is on | Consequence you will feel |
| --- | --- | --- |
| `strict` | NFR-022 | `null` and `undefined` are checked everywhere. This is the single biggest source of "it compiled but it was undefined at runtime" fixes. |
| `noUncheckedIndexedAccess` | An array or record access returns `T \| undefined` | `items[0]` is `T \| undefined`. You must narrow. This has caught real bugs in the queue sort and the cursor pagination. |
| `noImplicitOverride` | A subclass method must say `override` | Protects against a renamed base method silently becoming a new method. |
| `noFallthroughCasesInSwitch` | A silent fallthrough in a status switch is a lifecycle bug | The `case` must end in `break`, `return`, or `throw`. |
| `exactOptionalPropertyTypes` | `{ a?: string }` no longer accepts `{ a: undefined }` | **Strictest and most painful flag in this list.** See D-31-1. |
| `verbatimModuleSyntax` | Forces `import type` for type-only imports | Removes a whole class of "type import became a runtime import" bundle bloat. |
| `noUnusedLocals` / `noUnusedParameters` | Dead code fails the build | Prefixes with `_` when the parameter is required by a signature. |

### 2.2 The `any` ban

`@typescript-eslint/no-explicit-any: 'error'` in `app/`, `features/`, `services/`, `lib/`, `hooks/`, `types/`, `validators/`. **[LINT]** Plus `@typescript-eslint/no-unsafe-assignment` **[LINT]**. NFR-022 requires zero `any` in `app/`, `features/`, `services/`, and `lib/`.

The only sanctioned escape is `unknown` plus narrowing:

```ts
// ❌ any: the compiler is now off duty for this value
const incident = data as any;
return incident.status;

// ✅ unknown: the compiler is still on duty
const parsed = aiTriageOutputSchema.safeParse(data);
if (!parsed.success) {
  throw new AppError({ code: 'AI_OUTPUT_INVALID' });
}
return normalizeTriageOutput(parsed.data);
```

```ts
// ❌ a single justified escape, without a reason
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const firebaseError = err as any;

// ✅ a single justified escape, with a reason and a narrow cast
// The Firestore SDK's error type is not exported, so `code` cannot be typed.
// Narrowed immediately to a string; see lib/api/errors.ts toAppError.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { code } = err as any;
if (typeof code !== 'string') throw new AppError({ code: 'INTERNAL_ERROR' });
```

A file with more than **one** `eslint-disable` for `no-explicit-any` is a review failure. Zero is the target. **[REVIEW]**

### 2.3 Type-only imports

```ts
// ❌ a value import used only as a type
import { Incident } from '@/types/domain';

// ✅ a type import
import type { Incident } from '@/types/domain';
```

`@typescript-eslint/consistent-type-imports` with `fixStyle: 'separate-type-imports'` **[LINT]**, and `verbatimModuleSyntax` **[TYPE]** makes it mandatory anyway. It is not pedantry: a mixed import pulls the module into the runtime graph, and `types/domain.ts` re-exports nothing at runtime.

### 2.4 Discriminated unions over optional-everything

An object with six optional fields describes six possible states and makes every consumer defensive. A discriminated union describes the states exactly and lets the compiler check the `switch`.

```ts
// ❌ every field optional: nothing is guaranteed, everything is checked
type IncidentAction = {
  verify?: boolean;
  falseAlarm?: { reason: string };
  assign?: { responderUid: string; mode: DispatchMode };
  status?: { status: IncidentStatus; reason?: string; resolutionCode?: ResolutionCode };
};

// ✅ one shape per action; the switch is exhaustively checked
type IncidentAction =
  | { kind: 'verify' }
  | { kind: 'false_alarm'; reason: string }
  | { kind: 'assign'; responderUid: string; mode: DispatchMode }
  | { kind: 'unassign'; reason: string }
  | { kind: 'status'; status: IncidentStatus; reason?: string; resolutionCode?: ResolutionCode };

function describe(action: IncidentAction): string {
  switch (action.kind) {
    case 'verify': return 'Verifying this incident';
    case 'false_alarm': return 'Marking as a false alarm';
    case 'assign': return `Assigning ${action.responderUid}`;
    case 'unassign': return 'Removing the responder';
    case 'status': return `Moving to ${action.status}`;
    default: return assertNever(action);      // a new kind fails the build here
  }
}
```

`assertNever` lives in `lib/assert-never.ts` **[LINT]**-checked by the compiler, not by review.

### 2.5 `satisfies` for configuration objects

```ts
// ❌ widened: every field becomes string
const badges = { critical: 'destructive', high: 'warning' };

// ✅ literal types preserved, and the shape is checked against the contract
const urgencyBadges = {
  critical: { className: 'bg-critical-subtle', tone: 'critical', label: 'Critical' },
  high: { className: 'bg-warning-subtle', tone: 'warning', label: 'High' },
  medium: { className: 'bg-info-subtle', tone: 'info', label: 'Medium' },
  low: { className: 'bg-surface-2', tone: 'neutral', label: 'Low' },
} satisfies Record<Urgency, BadgeSpec>;
```

Use `as const` when you want the literal values frozen; use `satisfies` when you want the shape checked but the values inferred. They are not interchangeable.

### 2.6 `as const` for literals

```ts
// ✅ the tuple is the source of truth for the enum
export const incidentStatusValues = [
  'new', 'triaged', 'verified', 'assigned', 'en_route',
  'on_scene', 'resolved', 'closed', 'cancelled', 'false_alarm', 'merged',
] as const;

export type IncidentStatus = (typeof incidentStatusValues)[number];
export const incidentStatusSchema = z.enum(incidentStatusValues);
```

This is the pattern from [05](./05_FRONTEND_ARCHITECTURE.md) §15. **A second copy of an enum literal list anywhere is forbidden** ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §7 #6). **[LINT]** via a `no-restricted-syntax` rule and **[TEST]** via a source scan.

### 2.7 No TypeScript `enum`

```ts
// ❌ a TS enum
enum IncidentStatus { New = 'new', Triaged = 'triaged' }
// Problems: it is a runtime value with reverse mappings, it cannot be `.strict()`ed
// cleanly, it does not tree-shake, and it creates a second source of truth.

// ✅ a frozen tuple + a derived union + a Zod enum
export const incidentStatusValues = ['new', 'triaged'] as const;
export type IncidentStatus = (typeof incidentStatusValues)[number];
export const incidentStatusSchema = z.enum(incidentStatusValues);
```

**Why, concretely:**

| Reason | Detail |
| --- | --- |
| Single source of truth | One array feeds Zod, the TypeScript type, the UI maps, the API contract, and the Firestore enum validation. A TS enum needs a second, parallel definition for Zod. |
| Zod compatibility | `z.enum()` requires a readonly tuple of strings. A TS enum's `Object.values` is `string[]`, losing the literal types. |
| Runtime cost | A TS enum emits an IIFE that assigns an object. `as const` emits nothing. This matters because `validators/enums.ts` is imported by client bundles. |
| Erased types | A string-union type is fully erased at compile time, so importing the type has zero runtime cost. |
| Exhaustiveness | A `switch` over a string union with a `default: assertNever(value)` catches a new member. With a TS enum, a missed member silently falls through. |
| Reversible mapping | Nobody needs `IncidentStatus[0]`. If someone does, they want a lookup table, not an enum. |

The only place a mapped object is right is a **lookup**, and then it is a `Record` built with `satisfies`, not an enum.

### 2.8 No non-null assertions outside tests

`@typescript-eslint/no-non-null-assertion: 'warn'` **[LINT]**, treated as an error by review outside `tests/**`.

```ts
// ❌ "trust me"
const first = candidates[0]!.uid;

// ✅ the compiler is satisfied because you proved it
const first = candidates[0];
if (!first) return { candidates: [], consideredCount: 0, truncated: true };
```

`noUncheckedIndexedAccess` is on precisely so that `candidates[0]` is `Candidate | undefined`. Reaching for `!` throws away the guarantee the flag exists to give you. In `tests/**` a non-null assertion is acceptable when the preceding line is an explicit `expect(x).toBeDefined()`.

### 2.9 Zod-derived types, never hand-written DTOs

```ts
// ❌ a hand-written DTO that can drift from the schema
type CreateIncidentInput = { text: string; media: MediaItem[] };

// ✅ derived from the schema, which is derived from nothing else
export const createIncidentSchema = z.object({ /* ... */ }).strict();
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
```

A hand-written DTO is a lint error (`no-dto-without-schema`) **[LINT]**. It is a bug factory: the schema gains a `.refine()` and the DTO does not.

### 2.10 Timestamps, GeoPoint, and the client boundary

| Rule | Detail |
| --- | --- |
| `Timestamp` and `GeoPoint` **never** cross the client boundary | `lib/api/serialize.ts` converts them server-side |
| Client-side timestamps are ISO-8601 `string` | Never `Date` in props, never an epoch number (FR-143) |
| Never `Date` in a component prop | `RelativeTime` takes the string and formats it in `APP_TIMEZONE` |
| Geo is a named `GeoPointJson` type | `{ lat: number; lng: number }`, nullable for "unknown location" (FR-034) |
| Money | Not modelled. Not applicable. |

### 2.11 `catch` discipline

```ts
// ❌ swallowing
try { await sendNotification(n); } catch (e) {}

// ❌ rethrowing a raw Error, which defeats the funnel
try { await tx.commit(); } catch (e) { throw new Error(String(e)); }

// ✅ recover to a documented fallback, or funnel through AppError
try {
  await tx.commit();
} catch (e: unknown) {
  throw AppError.from(e, ctx);   // → DB_TRANSACTION_FAILED / DB_UNAVAILABLE
}
```

`catch (e: unknown)` is mandatory under `useUnknownInCatchVariables` **[TYPE]**. A bare `Error` throw loses the code, the status, and the retryability. **[LINT]** flags `throw new Error()` outside `scripts/` and `tests/`.

### 2.12 Boundary types

```ts
// ✅ branded types where a wrong type is a real hazard
type IncidentId = string & { readonly __brand: 'IncidentId' };
type CgReference = string & { readonly __brand: 'CgReference' };  // 'CG-XXXXXX'
type RequestId = string & { readonly __brand: 'RequestId' };
```

Used sparingly: where a genuine bug is "passing a user id where an incident id belongs", which is the mistake behind most IDOR bugs. Generated by the functions in `lib/incidents/reference.ts` and `lib/server/request-id.ts`, and validated by the `params` schemas in `validators/`.

---

## 3. Naming conventions

### 3.1 Files and folders

| Kind | Convention | Example |
| --- | --- | --- |
| Folders | `kebab-case`, nouns | `incident-archive/`, `features/notifications/` |
| React components | `PascalCase.tsx` | `UrgencyBadge.tsx`, `QueueTableView.tsx` |
| Presentational, server-safe | `<Name>-view.tsx` | `QueueTableView.tsx` |
| Client-interactive | `<Name>.tsx` with `"use client"`, or `<name>-client.tsx` | `LiveMap.tsx` |
| Hooks | `use<Thing>.ts` | `useRealtimeIncidents.ts` |
| Non-component modules | `kebab-case.ts` | `haversine.ts`, `nearest.ts`, `caregrid-dark-style.json` |
| API route folders | the URL segment, `[param]` form | `app/api/incidents/[id]/status/route.ts` |
| Unit/integration tests | `<module>.test.ts` | `score.test.ts` |
| E2E tests | `<subject>.spec.ts` | `dispatcher.spec.ts` |
| Types | `types.ts` (feature-local) or `types/<topic>.ts` (shared) | `features/incidents/types.ts` |
| Zod schemas | `schemas.ts` or `validators/<domain>.ts` | `validators/incident.ts` |
| User-visible strings | `copy.ts` | `features/reporting/copy.ts` |
| Barrels | `index.ts` | `components/domain/index.ts` |
| Server-only | `*.server.ts` | `lib/server/firebase-admin.ts` |
| Client-only | `*.client.ts` | `lib/env.client.ts` |
| Scripts | `kebab-case.ts` | `scripts/check-listeners.ts` |
| Documents | `docs/<NN>_<TITLE>.md` | `docs/18_TESTING_QA_PLAN.md` |

A folder name is never a hook name (`use-map-instance/` is wrong) and a file name never encodes a route.

### 3.2 Identifiers

| Kind | Convention | Example |
| --- | --- | --- |
| Enumerated values | `lower_snake_case`, **identical to the database** | `'on_scene'`, `'manual_pin'`, `'potential_duplicate'`, `'sla_breached'` |
| Enum tuples | `<thing>Values` | `incidentStatusValues`, `safetyFlagValues` |
| Types from enums | `PascalCase` singular | `IncidentStatus`, `SafetyFlag`, `ResolutionCode` |
| Booleans | `is` / `has` / `can` / `should` prefix | `isLoading`, `hasMore`, `canAssign`, `shouldRetry` |
| Event handler props | `on<Event>` | `onSelect`, `onSubmit`, `onStatusChange` |
| Internal event handlers | `handle<Event>` | `handleSubmit`, `handleFilterChange` |
| Async functions | verb + noun | `listIncidents`, `changeIncidentStatus`, `finalizeUpload` |
| API client functions | the resource verb | `createIncident`, `getIncident`, `mergeIncidents` |
| Hook return objects | a named type, one per hook | `RealtimeQueue`, `UploadApi`, `LocationPermissionState` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_LISTENERS`, `SLA_MINUTES`, `ALLOWED_IMAGE_TYPES` |
| CSS class composition | `cn()` from `lib/cn.ts` | `cn('px-4', isActive && 'bg-elevated')` |
| Private members | no `export` unless another file needs them | `function buildGeoCells()` stays module-private |
| Branded types | `<Concept>Id` | `IncidentId`, `CgReference` |
| Refs | `<thing>Ref` | `formRef`, `mapRef` |
| Test ids | `<element>-<role-or-state>` | `submit-report`, `queue-row-CG-7QK4M2` |

### 3.3 Collection and enum constants — never a string literal

```ts
// ❌ a string literal in a query: a rename breaks it silently
db.collection('incidents').where('deletedAt', '==', null);

// ✅ a named constant
db.collection(COLLECTIONS.incidents).where('deletedAt', '==', null);
```

`COLLECTIONS` lives in `config/collections.ts` **[SCRIPT]**-verified against `firestore.rules` by `scripts/check-collections.ts`, so a collection that exists in one place and not the other is a build failure. The same rule applies to:

| Constant group | Home | Example |
| --- | --- | --- |
| Firestore collection names | `config/collections.ts` | `COLLECTIONS.incidents`, `COLLECTIONS.auditLogs` |
| Enum value lists | `validators/enums.ts` | `incidentStatusValues` |
| Field name lists used in rules or audits | `config/field-allowlists.ts` | `MUTABLE_INCIDENT_FIELDS` |
| Error codes | derived from the catalogue in [16](./16_ERROR_HANDLING.md) | `type ErrorCode` |
| Env var names | `lib/env.ts` / `lib/env.client.ts` | `env.GEMINI_MODEL` |
| SLA minutes, upload caps, heartbeat seconds | `config/limits.ts` | `LIMITS.RESPONDER_HEARTBEAT_SEC` |

**A string literal naming a collection, a field the rules depend on, or an error code is a review failure.** **[REVIEW]**

### 3.4 Zod schema names

| Kind | Name | Example |
| --- | --- | --- |
| Request body | `<verb><Resource>BodySchema` | `createIncidentBodySchema` |
| Query params | `<resource>QuerySchema` | `incidentListQuerySchema` |
| Path params | `<resource>ParamsSchema` | `incidentParamsSchema` |
| Response DTO | `<resource>ResponseSchema` (only where the client parses it) | `incidentListRowSchema` |
| Cross-field refinement | `<resource>BodySchema` + `superRefine` inline | — |
| Shared primitive | `boundedInt`, `cgReference`, `isoTimestamp` | `validators/common.ts` |

A schema defined **inside a route file** is forbidden: it cannot be shared with the client form and it will drift ([17](./17_VALIDATION_RULES.md) anti-pattern 24). **[LINT]**. **[DOC]** the schema in [08](./08_API_SPECIFICATION.md) §11. **[TEST]** `route-schema` asserts every `route.ts` exports a schema.

### 3.5 Error code usage

`ErrorCode` is a union generated from the catalogue in [16](./16_ERROR_HANDLING.md) §3, so `new AppError({ code: 'TYPO' })` is a **compile error**. There is no escape hatch and there must not be one. A genuinely new condition requires a catalogue amendment **in the same commit** as the code. **[LINT]** **[DOC]**

---

## 4. Component conventions

### 4.1 Function components only

No class components, no `React.FC`, no default-prop patterns. Props are `readonly`, callbacks are `(…) => void`. **[LINT]**

```tsx
// ❌ React.FC adds nothing and forbids nothing useful
export const UrgencyBadge: React.FC<Props> = ({ urgency }) => …;

// ✅ an explicit interface, readonly props
export interface UrgencyBadgeProps {
  readonly urgency: Urgency;
  readonly showTarget?: boolean;
  readonly className?: string;
}

export function UrgencyBadge({ urgency, showTarget = false, className }: UrgencyBadgeProps) {
  return <span className={cn(urgencyBadges[urgency].className, className)}>…</span>;
}
```

`interface` for extendable shapes, `type` for unions and intersections **[LINT]** via `consistent-type-definitions`.

### 4.2 `"use client"` discipline

`"use client"` is allowed **only** in files under `components/` and `features/` **[LINT]** (`no-restricted-syntax` on a directive expression in `app/**`, `lib/**`, `services/**`, `scripts/**`).

Before adding it, the checklist — all five must be true:

1. The component uses a React hook, an event handler, a browser API, or a client-only library.
2. It cannot be a Server Component that renders a client child with serialisable props.
3. It is not a leaf that could be split into a server parent + client island.
4. Adding it does not pull a server-only module into the client graph (checked by the boundary rules).
5. The PR description says **why**, in one sentence.

Default to Server. The dispatcher dashboard's first read happens on the server because the role is already authoritative there ([26](./26_PERFORMANCE_REQUIREMENTS.md) §3) — that is the pattern.

### 4.3 Size

**No component over 400 lines** (NFR-024) **[LINT]** (a max-lines rule scoped to `features/**` and `components/**`), and no file over 250 lines unless it is a generated barrel or a seed fixture. **[DOC]** a file over 400 lines is a design conversation, not a lint waiver.

When a component approaches 300 lines, the extraction order is:

1. Logic into a custom hook in the same feature (`features/<domain>/hooks/`).
2. A presentational subcomponent with explicit props into the same folder.
3. A genuinely shared piece (used by ≥ 2 features) into `components/domain/`.

### 4.4 JSX only in `.tsx`

A `.ts` file containing JSX is a build error under the default Next/TypeScript configuration, and `.tsx` with no JSX is a smell. **[LINT]**

### 4.5 Keys on lists

```tsx
// ❌ array index as a key: rows reorder and React reuses the wrong DOM
{items.map((item, i) => <Row key={i} … />)}

// ✅ a stable domain identifier
{items.map((item) => <Row key={item.incidentId} … />)}
```

For the queue, prefer the domain key and never the array index — the list is re-sorted on every snapshot ([05](./05_FRONTEND_ARCHITECTURE.md) §16). **[REVIEW]**

### 4.6 Memoisation hygiene

`React.memo` is used on `QueueTableRow`, `KpiTile`, the badges, `Timeline`, and `MarkerLegend` — on **primitive props only**.

```tsx
// ❌ a memo defeated by a fresh object every render
const MemoRow = memo(QueueTableRow);
<MemoRow filters={{ urgency, category }} />          // new object, memo is useless

// ✅ primitives in, memo works
<MemoRow urgency={urgency} category={category} />
```

An inline object or array prop silently disables every `memo` in the tree. **[REVIEW]** — a `react-hooks/exhaustive-deps` and a props-primitives checklist item in the PR template.

### 4.7 Controlled vs uncontrolled

| Field | Pattern | Why |
| --- | --- | --- |
| `Textarea` (report description) | **Controlled** | The character counter, the disabled-with-reason, and the draft restore all read the value |
| `Input` (reference search) | **Uncontrolled** with `defaultValue` + a form library | Nothing else needs the value on every keystroke |
| `Switch` (availability) | **Controlled** | The optimistic update and roll-back need the value |
| `Dialog` / `Sheet` | **Uncontrolled** open state in the parent | Focus management is the library's job |
| `Select` (filters) | **Controlled** via URL search params | The filter state is shareable and back-button-correct |

Never mix the two on one field. **[REVIEW]**

### 4.8 Accessibility by default

Every component, without being asked:

| Rule | Detail | Enforcement |
| --- | --- | --- |
| An icon-only control has a non-literal `aria-label` | A literal `aria-label` on an icon button is a lint error, so a test can assert the string | **[LINT]** **[TEST]** TC-ACC-017 |
| Status is never colour alone | Icon + text, plus a non-empty `aria-label` | **[TEST]** TC-ACC-013 |
| A disabled control has a reason | `aria-describedby` pointing at visible helper text | **[TEST]** TC-ACC-015 |
| An icon is `aria-hidden` when adjacent text names it | Otherwise it is announced twice | **[REVIEW]** |
| A form field has a `<Label htmlFor>` | Never a placeholder as the only label | **[TEST]** axe |
| A mutation's result is announced | A `role="status"` region for success, `role="alert"` for errors | **[TEST]** TC-ACC-016 |
| Focus moves deliberately | On route change to the `h1`; after a mutation to the next primary action; on error to the error summary | **[TEST]** TC-ACC-040 |
| A table has a `caption`, `scope`, and one `aria-sort` | — | **[TEST]** TC-ACC-014 |
| `prefers-reduced-motion` is respected | No animation over 80 ms when reduced | **[TEST]** TC-ACC-018 |

### 4.9 Styling

```tsx
// ❌ design-system violations, all lint errors
<div className="bg-gradient-to-b from-blue-500 to-blue-700" />
<div className="bg-[#1a1f2b]" />
<div className="style={{ backgroundColor: '#1a1f2b' }} />
```

Tokens only, no gradients, no hex literals, no inline colour. `className` composition goes through `cn()`. **[LINT]** **[REVIEW]**

---

## 5. Hooks conventions

### 5.1 Naming and location

| Rule | Detail |
| --- | --- |
| `use` prefix, PascalCase after it | `useRealtimeIncidents`, `useLocationHeartbeat`, `useOfflineQueue` |
| One feature only → `features/<domain>/hooks/use<Thing>.ts` | **[DOC]** ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §5.1) |
| Used by ≥ 2 features → `hooks/use<Thing>.ts` | A hook in `hooks/` must not import from `features/` **[LINT]** |
| Never a hook in a component file | A hook defined in a `.tsx` cannot be shared or tested in isolation **[REVIEW]** |
| A hook that only wraps one component's state stays a `useState` | Not everything needs a hook **[REVIEW]** |

### 5.2 Exhaustive dependencies

`react-hooks/exhaustive-deps` is an **error**, not a warning **[LINT]**. A suppression requires a comment explaining why the dependency is safe to omit.

```tsx
// ❌ a stale closure waiting to happen
useEffect(() => {
  const t = setInterval(() => refetch(), 30_000);
  return () => clearInterval(t);
}, []);                                   // refetch changes every render

// ✅ correct, and the interval is a UI clock, not data fetching
const refetch = useCallback(() => { void apiFetch('/api/incidents'); }, []);
useEffect(() => {
  const t = setInterval(refetch, 30_000);
  return () => clearInterval(t);
}, [refetch]);
```

`setInterval` exists in this codebase for exactly two UI clocks: `useSlaCountdown` (15 s) and `RelativeTime` (30 s). **There is no polling anywhere** (FR-090) **[SCRIPT]** `scripts/check-listeners.ts` and a grep for `setInterval` in data-fetching code.

### 5.3 No conditional hooks

```tsx
// ❌ a rules-of-hooks violation, and a real bug when the condition flips
if (isOpen) {
  const [draft, setDraft] = useState('');
}

// ✅ the hook always runs; the effect decides what to do
const [draft, setDraft] = useState('');
useEffect(() => { if (!isOpen) setDraft(''); }, [isOpen]);
```

`react-hooks/rules-of-hooks` is an error **[LINT]**. **[TEST]** renders each modal component both open and closed.

### 5.4 Return shape

A custom hook returns a **named object**, never a positional tuple beyond two elements, and never a bare value that hides whether it can be `undefined`.

```ts
export interface RealtimeQueue {
  readonly items: IncidentListRow[];
  readonly status: 'connecting' | 'live' | 'reconnecting' | 'error';
  readonly lastUpdatedAt: string | null;
  readonly isStale: boolean;
  readonly error: ApiError | null;
  readonly refetch: () => void;
}
```

The interface is exported **[DOC]** so a consumer can type a prop. A hook returning a tuple of five unnamed values is a review failure. **[REVIEW]**

### 5.5 Cleanup discipline

Every hook that subscribes, opens, or schedules **must** return a cleanup. The teardown must handle the case where the effect never completed.

```ts
useEffect(() => {
  const unsubscribe = onSnapshot(query, handleSnapshot, handleError);
  return () => {
    unsubscribe();            // always safe to call once
    registry.release(handleId);
  };
}, [deps]);
```

For Firestore listeners specifically, registration goes through `lib/firebase/listener-registry.ts` so the ≤ 8 budget (FR-091) and the teardown are enforced in one place **[TEST]** TC-RT-002, TC-RT-003.

### 5.6 `useEffect` avoidance

`useEffect` is for synchronising with something outside React. It is **not** for deriving state.

```tsx
// ❌ derived state in an effect: two sources of truth, one extra render
const [fullName, setFullName] = useState('');
useEffect(() => { setFullName(`${first} ${last}`.trim()); }, [first, last]);

// ✅ derived during render
const fullName = `${first} ${last}`.trim();
```

The rule of thumb: if the value can be computed from props/state during render, compute it. `useEffect` is for listeners, subscriptions, timers, focus management, and imperative browser APIs. **[REVIEW]**

### 5.7 The offline queue hook

`features/responders/hooks/useOfflineQueue.ts` is the only hook that writes to `localStorage`, and its contract is fixed by [16](./16_ERROR_HANDLING.md) §6.5: ≤ 20 entries, strict FIFO by `enqueuedAt`, `localStorage` not IndexedDB, conflict entries kept and surfaced, the whole queue paused on an auth failure, nothing else queueable. **[TEST]** TC-RT-014 to TC-RT-017.

---

## 6. API route conventions

### 6.1 The mandatory pipeline

A route handler is a thin wrapper. The pipeline order is [06](./06_BACKEND_ARCHITECTURE.md) §3.1 and it is **not negotiable**:

```ts
// app/api/incidents/[id]/status/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { buildRequestContext } from '@/lib/api/context';
import { requireUser, assertRole, assertResourceAccess } from '@/lib/api/auth';
import { assertSameOrigin } from '@/lib/api/csrf';
import { enforceRateLimit } from '@/lib/api/ratelimit';
import { parseJsonBody } from '@/lib/api/validate';
import { changeIncidentStatus } from '@/services/incidents/change-status';
import { serializeIncident } from '@/lib/api/serialize';
import { ok, fail } from '@/lib/api/respond';

export const runtime = 'nodejs';                       // mandatory on EVERY route [SCRIPT]

const bodySchema = changeStatusBodySchema;             // from validators/incident.ts, not local

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await buildRequestContext(req, { auth: 'required', routeKey: 'incidents.status' });

  // 2–4: auth, role, resource
  const user = requireUser(ctx);
  assertRole(ctx, 'responder', 'dispatcher', 'admin');
  const { id } = await parseParams(await params, incidentParamsSchema);
  const access = await assertResourceAccess(ctx, 'incident', id, 'action');

  // 5–6: origin, rate limit
  assertSameOrigin(req);
  await enforceRateLimit(ctx, 'incidents.status');

  // 7: validate BEFORE any DB/AI/Maps call (FR-142)
  const body = await parseJsonBody(req, bodySchema);

  // 8–9: idempotency, business operation
  const result = await changeIncidentStatus({ ctx, user, incidentId: id, access, ...body });

  // 10–11: serialise, envelope
  return ok({ incident: serializeIncident(result.incident, access) });
}
```

The order exists for reasons, each of which is a test **[TEST]**:

| Order rule | Why | Test |
| --- | --- | --- |
| Role and resource checks **before** rate limiting | An unauthorised caller cannot burn another subject's quota | TC-INT-125 |
| Zod **before** any Firestore, AI, or Maps call | A malformed body must cost one CPU pass, not a database round trip | TC-INT-124 |
| Serialisation **after** the service | A service never shapes a response body and never knows the caller's role for redaction | TC-INT-127 |
| `requestId` generated **first** | It must appear in every log line, the audit row, the history event, and the response | TC-FR-141 |

### 6.2 One concern per route

A route handler does one thing. If you are writing `if (action === 'verify') … else if (action === 'assign')` inside a route, the action is a separate endpoint ([08](./08_API_SPECIFICATION.md) §3.5, §3.6, §3.9). A route that both reads and mutates by method is fine (`GET` + `PATCH` on the same resource); a route that branches on business intent is not.

### 6.3 Zod in, Zod out

| Rule | Detail |
| --- | --- |
| Parse the body, the query, **and** the params | All three. Validating only one of them is anti-pattern 10 in [17](./17_VALIDATION_RULES.md) **[TEST]** TC-FR-142b |
| `.strict()` on every input schema | `.passthrough()` lets `role` or `status: 'verified'` be smuggled in |
| Validate **before** side effects | Anti-pattern 4 in [17](./17_VALIDATION_RULES.md) |
| "Zod out" for anything the client parses | A response DTO with a schema is a client-side contract; a response without one is a `any` in disguise |
| `formatZodIssues` produces `details` | Never hand-build a `details` array **[TEST]** |
| No ad-hoc clamping | Exactly **one** clamp site in `validators/`, asserted by a static test (anti-patterns 17, 18) |

### 6.4 The envelope writers are the only writers

`lib/api/respond.ts` exports `ok`, `created`, `accepted`, `noContent`, `csv`, and `fail`. A route never constructs a `NextResponse` with a hand-built JSON body. **[LINT]** (`no-restricted-syntax` on `NextResponse.json` outside `lib/api/respond.ts`).

```ts
// ❌ a bespoke body
return NextResponse.json({ success: true, data: { incident } }, { status: 201 });

// ✅ the writer
return created({ incident: serializeIncident(incident, access) });
```

### 6.5 No direct Firestore from a route handler

A route handler calls **one** `services/*` function. A Firestore import in `app/api/**` is forbidden **[LINT]** (`no-restricted-imports` for `firebase-admin` and `firebase/firestore` outside `lib/server/` and `services/`).

The reason is not purity: the service is where the transaction lives, where the audit row is written in the same operation, and where the domain rules are testable without a `Request` object. A route that talks to Firestore directly is a route whose business rules are untestable and unauditable. **[REVIEW]**

### 6.6 `runtime = 'nodejs'`, always

Firebase Admin and the Gemini SDK need Node. A route that omits the export runs on the Edge runtime and fails at import time in a way that is confusing. **[SCRIPT]** `scripts/check-routes.ts` scans every `app/api/**/route.ts`. **[TEST]** TC-INT-069.

### 6.7 The 15-point security checklist on every route

Reproduced from [08](./08_API_SPECIFICATION.md) §12 as a review gate **[REVIEW]** **[TEST]** where machine-checkable:

1. `runtime = 'nodejs'`.
2. `requireUser()` or an explicit, documented public exception.
3. A role check against a **server-side** role source.
4. A resource-level visibility check.
5. `Origin`/`Referer` on every non-GET.
6. Rate limiting.
7. Zod on body, query, and params.
8. No user input interpolated into a field path, a Storage path, a prompt string, or an HTML string.
9. Catalogue error codes only; no stack traces, no raw exception text.
10. `requestId` on every response, including errors.
11. Privileged mutations write an audit row **inside the same operation**.
12. `Cache-Control: no-store` on user-specific responses.
13. CSP at the edge; a route never returns interpolated HTML.
14. Security headers in `middleware.ts`.
15. No endpoint returns another user's data, whatever the role.

---

## 7. Service and library conventions

### 7.1 Pure functions wherever possible

`lib/` is pure **[LINT]**: no React, no `next/*`, no Firebase, no `fetch`. This is what makes FR-043 and FR-049 possible — `haversineM`, `jaccard`, and `classifyDuplicate` are unit-testable with zero mocks. **[SCRIPT]** a static scan asserts no Firestore/Admin import in `lib/**` (outside `lib/server/`). **[TEST]** TC-DUP-010b.

A pure function that needs "now" or randomness **takes them as parameters**:

```ts
// ❌ untestable without fake timers, and a hidden dependency
export function slaState(slaTargetMin: number, verifiedAt: string): SlaState { … }

// ✅ deterministic, and the clock is visible at every call site
export function slaState(now: Date, slaTargetMin: number, verifiedAt: string | null, createdAt: string): SlaState { … }
```

### 7.2 Services: explicit inputs, explicit outputs

```ts
// ✅ an explicit input object, so adding a field is a visible change
export interface CreateIncidentInput {
  readonly ctx: RequestContext;
  readonly user: RequestUser;
  readonly payload: CreateIncidentBody;
  readonly idempotencyKey: string | null;
}

export interface CreateIncidentResult {
  readonly incident: Incident;
  readonly duplicate: DuplicateCandidate | null;
  readonly notificationIds: readonly string[];
}

export async function createIncident(input: CreateIncidentInput): Promise<CreateIncidentResult>
```

No positional parameter lists longer than three, no `any` in the signature, no `Request` inside a service (the `RequestContext` is passed instead, so the service is testable without HTTP).

### 7.3 No module-level mutable state

```ts
// ❌ survives between requests on a warm instance; two requests interleave
let currentUser: RequestUser | null = null;

// ❌ a module-level cache with no invalidation and no per-instance key
const cache = new Map<string, Incident>();

// ✅ the value is passed, returned, or scoped to the request
export function buildGeoCells(lat: number, lng: number): readonly string[] { … }
```

Module-level state on a Vercel function is a cross-request data leak. **[LINT]** flags mutable module-level `let` and non-`const` module-level collections in `lib/**` and `services/**` **[REVIEW]**.

The legitimate exceptions are the singletons `lib/server/firebase-admin.ts` (the Admin SDK app), `lib/logger.ts` (the logger), and `lib/firebase/client.ts` (the browser SDK), each initialised once and documented as such.

### 7.4 Error throwing policy

| Rule | Detail |
| --- | --- |
| Throw `AppError` only | `new AppError({ code: 'INVALID_STATUS_TRANSITION', details: [...] })` |
| **Never** `throw new Error(...)` in `app/`, `lib/`, `services/` | **[LINT]** |
| **Never** return an error shape | No `{ ok: false, error }` return values. A failure is a throw. **[LINT]** |
| No prose in a throw | Omit `message` and take the catalogue copy. A custom `message` must be one of the approved variants ([16](./16_ERROR_HANDLING.md) §7) **[SCRIPT]** `scripts/check-copy.ts` |
| `details` only per the allow-list | §1.5 of [16](./16_ERROR_HANDLING.md); never a stack, a path, or arbitrary user data **[REVIEW]** |
| `AppError.from(e, ctx)` for anything unknown | The single funnel; the `cause` is logged, never serialised |
| A `catch` recovers only to a documented fallback | AI → fallback; Maps → omission; notification → log; otherwise rethrow **[REVIEW]** |

### 7.5 Logging

```ts
// ❌ bypassing the logger, its levels, its redaction, and its requestId binding
console.log('incident created', incident);
console.log(request.body);

// ✅
logger.info('request.completed', {
  requestId: ctx.requestId,
  routeKey: ctx.routeKey,
  status: 201,
  durationMs: elapsed(ctx.startedAt),
  incidentId: incident.incidentId,
});
```

| Rule | Detail |
| --- | --- |
| `lib/server/logging.ts` is the only logger | **[LINT]** `no-restricted-syntax` on `console.*` outside the allowed files |
| `console.warn` / `console.error` allowed only in | `lib/observability/`, `lib/firebase/listener-registry.ts`, and dev-only blocks **[SCRIPT]** |
| Never log a body, a token, a text field, a phone, or an address | Field names and counts only **[SCRIPT]** `check-copy.ts` + the secret-name guard in `lib/logger.ts` (`token`, `secret`, `password`, `authorization`, `apiKey`, `privateKey`) |
| `requestId` on every line for a request | **[TEST]** |
| Level discipline | `debug` for tracing, `info` for the request lifecycle, `warn` for a degraded path, `error` only for `isOperational: false` |

### 7.6 Pure vs I/O — the placement test

```
Does it need the Admin SDK, Gemini, Storage, a transaction, or a server secret?
├─ YES → services/<domain>/<verb>.ts
└─ NO  ↓
Is it pure (no React, no fetch, no Firebase)?
├─ YES → lib/<area>/<kebab-case>.ts
└─ NO  ↓
Is it stateful behaviour used by one domain?
├─ YES → features/<domain>/hooks/use<Thing>.ts
└─ NO  ↓
Used by two or more features?
├─ Hook      → hooks/use<Thing>.ts
├─ Component → components/domain/<Thing>.tsx
└─ NO  ↓
A tunable, a static table, a JSON asset?
└─ YES → config/<topic>.ts
```

**[DOC]** the answer in the PR description when it is not obvious. **[REVIEW]**

---

## 8. Firestore conventions

### 8.1 Transactions

| Rule | Detail |
| --- | --- |
| Every multi-document write is one `runTransaction` | The list in [07](./07_DATABASE_SCHEMA.md) §12.6 is normative |
| Transaction bodies are **idempotent** | A transaction retries silently up to 5 times; a counter incremented twice is a data bug **[TEST]** TC-INT-138 |
| Read inside the transaction | A pre-transaction read is a race. The "current status" check must be in the transaction |
| No `await` on anything non-Firestore inside a transaction body | A non-Firestore await holds a retry slot and can exceed the deadline **[REVIEW]** |
| Never a `writeBatch` for something that must be atomic | A batch is not atomic across documents; a transaction is |
| `setCustomUserClaims` is **outside** the transaction | It is not transactional with Firestore; the compensating `roleChangePending` marker and retry are the mechanism **[TEST]** TC-INT-143, TC-INT-095 |
| An empty `catch` around the claim write is forbidden | Anti-pattern 20 in [16](./16_ERROR_HANDLING.md) |

### 8.2 Batching

`writeBatch` is limited to **500 operations** in the SDK and 200 is the practical ceiling we use for a single logical group **[TEST]** TC-INT-142. Anything larger is chunked and queued:

```ts
// ❌ 500+ in one batch
const batch = db.batch();
for (const doc of thousands) batch.update(doc.ref, { read: true });

// ✅ chunked, with the size named
const CHUNK = 200;
for (let i = 0; i < docs.length; i += CHUNK) {
  const batch = db.batch();
  for (const d of docs.slice(i, i + CHUNK)) batch.update(d.ref, { read: true });
  await batch.commit();
}
```

### 8.3 Every query needs a `limit()`

```ts
// ❌ an unbounded read, and a silent budget breach
db.collection(COLLECTIONS.incidents).where('status', '==', 'triaged').get();

// ✅ bounded, ordered, and the number is a named constant
db.collection(COLLECTIONS.incidents)
  .where('deletedAt', '==', null)
  .where('status', 'in', ACTIVE_STATUSES)
  .orderBy('createdAt', 'desc')
  .limit(LIMITS.DUPLICATE_MAX_CANDIDATES)      // 50
  .get();
```

The hard limits are in [07](./07_DATABASE_SCHEMA.md) §12.5: ≤ 200 on a client listener, ≤ 500 on a server query, ≤ 150 map viewport documents, ≤ 60 candidate responders, ≤ 50 duplicate candidates. **[SCRIPT]** `scripts/check-listeners.ts` and a `no-restricted-syntax` lint rule. **[TEST]** TC-INT-145 asserts the observed maximum during a full integration run.

### 8.4 Every list query filters `deletedAt == null`

```ts
// ❌ the single most commonly forgotten rule in this project ([07] §12.4)
.where('reporterUid', '==', uid)

// ✅
.where('deletedAt', '==', null)
.where('reporterUid', '==', uid)
```

Exceptions, all explicit and audited: `includeDeleted=true` (dispatcher/admin only, always audited) and the admin restore view. **[SCRIPT]** lint rule for client queries; **[TEST]** TC-INT-144 asserts it by instrumenting the SDK during a full integration run, which catches a query added in a code path the reviewer did not read.

### 8.5 Timestamps

| Rule | Detail |
| --- | --- |
| Server-controlled fields use `FieldValue.serverTimestamp()` | `createdAt`, `updatedAt`, `receivedAt`, `verifiedAt`, `resolvedAt`, `deletedAt` |
| Device/client-supplied times are validated and stored as a `Timestamp` | `reportedAt`, `capturedAt` — validated against the past and future bounds in [17](./17_VALIDATION_RULES.md) |
| **Never** a `Date.now()` value stored as a number | **[SCRIPT]** a lint rule rejecting `Date.now()` in a Firestore `set`/`update` object |
| `receivedAt` is always the **server** clock | It is authoritative for staleness; `capturedAt` is the device clock and can be wrong (clock skew, D-17-9) |
| Never a local-time string | UTC only, per [07](./07_DATABASE_SCHEMA.md) §2 |

```ts
// ✅ server-controlled
await ref.set({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

// ✅ client-supplied, validated
const reportedAt = Timestamp.fromDate(new Date(payload.reportedAt));
```

### 8.6 Denormalised fields

| Field | Maintained by | In the same transaction as |
| --- | --- | --- |
| `reportCount`, `linkedReportCount` | `services/duplicates/merge.ts`, `services/incidents/create-incident.ts` | The report write |
| `assigneeUid`, `assignmentMode` | `services/dispatch/assign.ts` | The dispatch write |
| `responders.activeIncidentCount`, `responders.status` | `services/dispatch/{assign,withdraw,claim}.ts` | The dispatch write |
| `slaTargetMin` | Create and the urgency-change path | The incident write |
| `incidents.safetyFlags` | Create, triage, merge | The incident write |
| `responders.lastLocationAt`, `lastLocationAccuracyGrade` | `services/responders/location-heartbeat.ts` | The location write |
| `searchTokens` | Create and the location/text update path | The incident write |

**A denormalised field is written in the same transaction as the write that changes it, or not at all.** Writing it in a follow-up call creates a window where two documents disagree. **[REVIEW]** **[TEST]** each counter has a transaction test.

### 8.7 Document size and shape

| Rule | Detail |
| --- | --- |
| Keep a growing document under ~1 KB | Unbounded data belongs in a subcollection (`statusHistory`, `incidentReports`, `incidents/{id}/resources`) |
| Absent means "unknown" | Use `null` **only** where the API contract says `null` |
| Booleans are real booleans | Never `"true"` |
| Enums are validated on write | `validators/enums.ts`; a stored enum is never trusted on read |
| `schemaVersion` on the versioned documents | Currently `1`; a schema change bumps it |

### 8.8 Cursor pagination

```ts
// ✅ bounded, ordered, cursor-based, with the limit from the query
let q = db.collection(COLLECTIONS.incidents)
  .where('deletedAt', '==', null)
  .orderBy('createdAt', 'desc')
  .limit(pageSize);                       // default 25, max 100
if (cursor) q = q.startAfter(await resolveCursorDoc(cursor));   // server-side re-read
```

The cursor token is opaque to the client; the **server** re-resolves the document, so a client cannot inject an arbitrary snapshot. An unresolvable cursor is `400 INVALID_CURSOR`; a cursor from a different filter set is `400 CURSOR_COMBINATION_INVALID`. **[TEST]** TC-FR-121b, TC-FR-121c, TC-FR-121e.

---

## 9. Realtime conventions

### 9.1 The listener budget

**Maximum 8 concurrent Firestore listeners per client** (FR-091). Enforced by `lib/firebase/listener-registry.ts`, which throws on the 9th registration **[TEST]** TC-RT-002.

| Surface | Listeners |
| --- | ---: |
| Dispatcher dashboard | 4 (queue, KPIs, responder snapshot, notifications) |
| Responder dashboard | 3 (assignments, availability, notifications) |
| `/report` | 0 |
| `/login`, `/signup`, `/track`, `/` | **0** (FR-095) |

### 9.2 Rules

| Rule | Detail | Enforcement |
| --- | --- | --- |
| Every listener query has a `limit()` | No exceptions | **[SCRIPT]** **[TEST]** |
| Every listener query is role-scoped | A citizen is never left subscribed to dispatcher data | **[TEST]** TC-RT-003 |
| Teardown is mandatory | Unsubscribe on unmount **and** on role change | **[SCRIPT]** **[TEST]** |
| Listener queries are built with the scoped helpers | A raw chained `.where()` inside `onSnapshot` is a lint error | **[LINT]** |
| `onSnapshot` is only for the live queue, the map, the bell, and the responder's active incidents | Never for analytics or history | **[REVIEW]** **[TEST]** TC-RT-010 |
| `includeMetadataChanges: true` only where a pending state exists | Otherwise it is a wasted document read | **[REVIEW]** **[TEST]** TC-RT-004 |
| No polling | `setInterval` only for the two UI clocks | **[SCRIPT]** |
| Listeners live in `hooks/` or a feature's `hooks/` | Never in a component file | **[DOC]** **[REVIEW]** |

### 9.3 Offline and reconnect

| Rule | Detail |
| --- | --- |
| A connectivity loss shows a persistent banner | Not a toast; a toast storm is a defect ([16](./16_ERROR_HANDLING.md) §6.3) |
| Re-subscription is automatic | On `online` and on the next successful read |
| Data is marked stale while disconnected | `isStale` in the hook's return shape, so the UI can say so |
| A background read failure is silent | The banner plus the stale indicator; no toast |
| A user-initiated mutation failure is loud | A toast with **Retry** (FR-098) |

### 9.4 Optimistic updates

| Step | Rule |
| ---: | --- |
| 1 | Apply the change locally |
| 2 | **Await** the write acknowledgement (FR-098) |
| 3 | On success, replace the local value with the server value |
| 4 | On failure, **roll back visibly** and show a toast with the server `code` and a Refresh action (FR-076) |
| 5 | Never auto-retry a non-idempotent mutation without the same idempotency key |

---

## 10. Error handling conventions

| Rule | Detail |
| --- | --- |
| Throw `AppError` | Never a bare `Error`, never a returned error object |
| The code comes from the catalogue | `ErrorCode` is a union, so a new code is a compile error |
| The message is the catalogue copy | Or one of the approved variants in [16](./16_ERROR_HANDLING.md) §7 |
| `details` per the allow-list | §1.5; omitted entirely when there is no field-level information |
| `expose: false` for anything unmapped | The response uses the generic copy; the real message never leaves the server |
| One envelope for success and failure | `lib/api/respond.ts` is the only writer **[LINT]** |
| `requestId` on every response | Body and `X-Request-Id` header |
| `Cache-Control: no-store` on user data | **[REVIEW]** **[TEST]** TC-INT-121 |
| `Retry-After` on every 429 and every retryable 503 | **[TEST]** |
| A non-idempotent mutation is never auto-retried | Only with the same `Idempotency-Key` or `clientActionId` |
| No `403` for "not yours" on a read | `404`, byte-identical to a missing document (non-existence opacity) |
| No `500` for a client mistake | A malformed body is `400 invalid_json` |
| Never invent a code at a throw site | Add it to [16](./16_ERROR_HANDLING.md) §3 **and** the client table in the same commit **[DOC]** |
| Never return `err.message`, `err.stack`, or a stringified SDK error | **[LINT]** **[REVIEW]** |
| Never put a stack in `details` | Log it |

### 10.1 User-facing copy

| Rule | Detail |
| --- | --- |
| No exclamation marks | **[SCRIPT]** `check-copy.ts` |
| No blame, no jargon, no scary words | The reader may be in an emergency |
| No "invalid", "illegal", "unauthorized" | Use the approved copy |
| Every error surface shows a `requestId` chip | US-041 AC3 |
| One toast at a time | A storm of toasts is a defect |
| No toast for correct user behaviour | A rejected heartbeat is silent |
| A 5xx message is never the server's message | Use the calm catalogue line |
| Every user-visible string lives in a `copy.ts` | **[DOC]** **[SCRIPT]** |

---

## 11. Comments and documentation

### 11.1 JSDoc on exported functions

Every exported function, and every exported type with non-obvious semantics, gets a JSDoc block:

```ts
/**
 * Classifies a report against a candidate incident using the `dedupe-v1` algorithm.
 *
 * Pure: no Firestore, no clock, no randomness. This is what makes FR-049's boundary
 * suite possible. The caller supplies `now` so the time window is deterministic in tests.
 *
 * @param report - The incoming report's location, time, category, and text.
 * @param incident - The candidate incident as stored.
 * @param cfg - The tunable thresholds from `config/app` (§9.5 of doc 07).
 * @param now - The reference clock instant.
 * @returns The score breakdown, always including `decision` and `reasons` for auditability.
 */
export function classifyDuplicate(
  report: DuplicateReportInput,
  incident: DuplicateCandidateInput,
  cfg: DuplicateConfig,
  now: Date,
): DuplicateBreakdown
```

| Rule | Detail |
| --- | --- |
| `@param` and `@returns` on every exported function | **`@returns`** is mandatory **[SCRIPT]** |
| Write **WHY**, not WHAT | `// increments the counter` is noise. `// the 5th retry is where a duplicate assignment becomes visible` is documentation. |
| No commented-out code | Delete it ([20](./20_PROJECT_FOLDER_STRUCTURE.md) §7). Git has it. |
| No bare `TODO` | A TODO needs an owner and an issue link: `// TODO(cg-team): #214 — add a second provider once the interface has a second caller.` A bare `TODO` is a review failure. |
| No file headers on every file | Only where there is a licence or ownership note |
| An inline comment on a non-obvious line is welcome | One line, above the code, explaining the constraint |
| Reference the requirement ID where the code encodes one | `// FR-091: the budget is a hard number, not a guideline.` |
| Mermaid only where a diagram earns its place | Prefer a table; a table is searchable and diffable |

### 11.2 Documentation obligations per change type

| Change type | Documents that must be updated in the same PR |
| --- | --- |
| A new FR | [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) first, then the phase plan, then the traceability in [18](./18_TESTING_QA_PLAN.md) |
| A new field | [07](./07_DATABASE_SCHEMA.md) **first**. The schema is authoritative; code that differs from it is wrong |
| A new endpoint | [08](./08_API_SPECIFICATION.md) §3 and §11, the Zod schema in `validators/`, the client function in `lib/api/client.ts`, and an integration test |
| A new error code | [16](./16_ERROR_HANDLING.md) §3, the client table, and a test |
| A new env var | [21](./21_ENVIRONMENT_VARIABLES.md) and `.env.example` |
| A new permission | [22](./22_USER_ROLES_PERMISSIONS.md) §3 and the rules tests |
| A new status or transition | [07](./07_DATABASE_SCHEMA.md) §4.3, then `lib/incidents/lifecycle.ts` and its 121-case test |
| A new folder | [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2 |
| A new dependency | A decision note (see §14) |
| A new test layer or tool | [18](./18_TESTING_QA_PLAN.md) §2 and the CI workflow |

**[DOC]** **[REVIEW]**

---

## 12. Git, commits, and review

### 12.1 Conventional Commits

`<type>(<scope>): <subject>` with a lowercase imperative subject, no trailing period, ≤ 72 characters for the subject line.

**Types:** `feat` · `fix` · `docs` · `refactor` · `test` · `perf` · `build` · `ci` · `chore` · `revert`

**Scope maps to the folder structure**, so a commit's scope is a location in the codebase:

| Scope | Area | Scope | Area |
| --- | --- | --- | --- |
| `incidents` | `services/incidents/`, `features/incidents/` | `api-incidents` | `app/api/incidents/` |
| `reporting` | `features/reporting/` | `api-reporting` | `app/api/incidents` create path |
| `dispatch` | `services/dispatch/`, `features/dispatch/` | `responders` | `services/responders/`, `features/responders/` |
| `duplicates` | `lib/duplicates/`, `services/duplicates/` | `lifecycle` | `lib/incidents/lifecycle.ts` |
| `geo` | `lib/geo/` | `ai` | `services/ai/` |
| `notifs` | `services/notifications/`, `features/notifications/` | `analytics` | `lib/analytics/`, `services/analytics/` |
| `auth` | `services/auth/`, `lib/server/auth-guard.ts` | `rbac` | `firestore.rules`, `services/admin/` |
| `rules` | `firestore.rules`, `storage.rules` | `storage` | `services/uploads/`, `storage.rules` |
| `validation` | `validators/` | `api-core` | `lib/api/`, `lib/server/` |
| `ui` | `components/` | `ui-report` / `ui-dispatch` / `ui-responders` / `ui-map` | a specific feature's components |
| `styles` | `app/styles/`, `config/maps/` | `config` | `config/` |
| `types` | `types/` | `env` | `lib/env*.ts`, `.env.example` |
| `tests` | `tests/` | `ci` | `.github/workflows/` |
| `docs` | `docs/` | `deps` | `package.json`, `package-lock.json` |
| `perf` | a performance-only change | `a11y` | an accessibility-only change |

### 12.2 Twelve real commit messages for this project

```text
feat(dispatch): add one-click assign with ranked candidate list

Implements FR-065 and FR-074. The candidates endpoint ranks by distance then
lastLocationAt, returns at most 10, and flags staleLocation when the last fix
is older than 15 minutes.

The assign action is one click and confirms with a toast naming the responder.
A second assignment to the same incident requires replaceExisting, which closes
the previous dispatch as 'withdrawn' inside the same transaction.

Closes #142
```

```text
fix(duplicates): keep 10 geoCells but query only the centre cell

The candidate search was issuing 10 array-contains reads, one per cell in the
array. Because every incident stores its own cell plus all eight neighbours,
one query on the query point's own geohash-6 already returns every incident in
that cell. Ten queries was a 10x read-cost bug.

TC-GEO-009b asserts the read count is exactly 1.

Closes #151
```

```text
feat(ai): cap fallback confidence at 0.55 and badge it Needs review

FR-024 and rule R5. Previously the keyword fallback could report 0.8 confidence,
which put a low-information triage into the high band and buried it in the queue.

Confidence is now 0.25 base plus 0.1 per high-signal keyword, capped at 0.55, so
the fallback can never claim confidence. TC-AI-073 asserts the cap.

Closes #118
```

```text
feat(validation): reject geoCells and accuracyGrade in request bodies

Both are server-derived (FR-036, FR-032). Accepting them from a client would let
a caller place an incident in an arbitrary cell and bypass the duplicate search.

The anti-bribe suite now also asserts role and assigneeUid are rejected on create.

Closes #133
```

```text
fix(security): deny all writes to auditLogs including for admin

FR-131, matrix row 59. The rules had a dispatcher-only read and an implicit
default-deny for write, which is correct, but there was no explicit negative
test, so a later edit could have opened it.

TC-RULES-013 now asserts update and delete are denied for admin, dispatcher,
responder, and citizen.

Closes #097
```

```text
perf(dashboard): move the first queue read to the server component

The queue was fetched from the client, which produced an unauthenticated flash
followed by a 403, plus an extra round trip. The RSC does the first read with
the Admin SDK where the role is already authoritative.

First paint is now 50 queue + 20 KPI + 50 responder reads, and the JS budget
for /dashboard drops. TC-PERF-031 asserts 120 reads per render.

Closes #149
```

```text
refactor(lifecycle): extract the transition table into a pure module

The table was duplicated between the status handler and the allowedNext
derivation, which is how the two drifted and produced a client that offered an
illegal action. Both now read lib/incidents/lifecycle.ts.

The 121-case test asserts every cell of doc 07 section 4.3, including every
rejection, and must be 100% branch covered.

Closes #127
```

```text
test(e2e): cover the offline responder status queue and its conflict path

US-014 acceptance criteria 1-3 were untested. The queue contract from doc 16
section 6.5 is now covered: 20-entry bound, FIFO order, conflict entries kept and
surfaced, and the whole queue paused on an auth failure rather than discarded.

Closes #161
```

```text
fix(uploads): quarantine on MZ magic bytes instead of rejecting the type

A .png whose bytes began 4D 5A was failing with UPLOAD_SIGNATURE_MISMATCH and
being dropped. It is an executable, so it now fails with UPLOAD_QUARANTINED and
is moved under quarantine/, which is the documented behaviour.

TC-INT-078 covers the polyglot case.

Closes #155
```

```text
docs(schema): amend the FR count and reserve the four unused ranges

Doc 01 section 13 said 127 assigned requirements while the tables enumerate 133,
and four range headers named IDs that have no row. The unused IDs are now
explicitly reserved so they are never reused.

TC-18 traceability now covers all 133 rows.

Closes #172
```

```text
chore(deps): add @axe-core/playwright for the accessibility gate

Decision note in the PR body: alternatives were axe-core directly (no Playwright
integration, so no page-object support) and pa11y (heavier, a separate browser
launch, slower CI). @axe-core/playwright reuses the browser the E2E suite already
launches, so the a11y gate costs no extra browser startup.

Bundle impact: dev-only, zero client bytes. Licence: Apache-2.0. Free tier: n/a.

Closes #170
```

```text
chore(config): enable noUncheckedIndexedAccess and fix 23 call sites

The flag catches array and record access returning undefined, which was the
likely cause of the queue sort dropping the last row when the snapshot was empty.
Twenty-three sites needed an explicit narrowing, each of which turned out to be
a real unchecked assumption.

Closes #104
```

### 12.3 Branch naming

```
feat/duplicate-merge-undo
fix/queue-empty-snapshot-drop
chore/ci-rules-emulator
docs/testing-qa-plan
perf/dashboard-rsc-first-read
test/e2e-offline-queue
```

| Prefix | Use for | Merges as |
| --- | --- | --- |
| `feat/…` | A new capability | Squash, unless the reviewer asks otherwise |
| `fix/…` | A bug fix | Squash |
| `chore/…` | Tooling, config, dependencies, CI | Squash |
| `docs/…` | Documentation only | Squash |
| `test/…` | Tests only | Squash |
| `perf/…` | A measured performance change | Squash, with the measurement in the body |
| `spike/…` | An investigation that will not ship | **Deleted, not merged** |

No branch without a prefix. No branch named after a person.

### 12.4 PR template

```markdown
## What
<2–3 sentences. What changed, in terms of the requirement, not the files.>

## Requirement traceability
- FR: FR-053, FR-074
- NFR: NFR-015
- Test IDs: TC-LIFE-004b, TC-INT-025
- Anchor document amended: none / [08](./08_API_SPECIFICATION.md) §3.6 (explain why)
- Phase: 4 — Dispatch

## Files changed
<grouped by purpose, with a one-line reason for any file a reviewer will not expect>

| File | Why |
| --- | --- |
| `services/dispatch/assign.ts` | closes the previous active dispatch inside the transaction |
| `tests/integration/transactions.test.ts` | the double-dispatch race |

## Test evidence
- `npm run verify` — <green/red>, <commit sha>
- New tests: <count>, of which <n> are negative
- Manual verification: <what you did by hand, and the result>
- Known gaps: <any skipped test, with the issue link>

## Design notes
<anything a reviewer could not infer from the diff: a trade-off, a rejected
alternative, a constraint from an anchor document, a decision that needed
DECISION REQUIRED>

## Risk
- What could break: <...>
- How it fails if it does: <the degraded path, per NFR-012>
- Rollback: <how to revert, and whether data needs migrating>

## Checklist
- [ ] `npm run verify` is green on this commit
- [ ] Every new exported function has JSDoc with `@param` and `@returns`
- [ ] No `any`, no `!` outside tests, no `console.*` outside the allowed files
- [ ] Every new Firestore query has a `limit()` and `deletedAt == null`
- [ ] Every listener has a `limit()` and a teardown
- [ ] Every new endpoint has a Zod schema, is listed in doc 08 §11, and has
      1 happy + 2 failure tests
- [ ] Every new error code is in doc 16 §3 and the client table, in this commit
- [ ] No secret, no `dangerouslySetInnerHTML`, no client-trusted role
- [ ] The `"use client"` directive is justified in a comment, if present
- [ ] The PR adds a dependency, it has a decision note
```

### 12.5 Review checklist

A reviewer works through this list. **A missing item is a reason to request changes**, not a suggestion.

| # | Check | How |
| ---: | --- | --- |
| 1 | The change does what the FR says, and nothing more | Read the FR, then the diff |
| 2 | The diff contains no unrelated change | A drive-by refactor gets its own PR |
| 3 | Field names match [07](./07_DATABASE_SCHEMA.md) exactly | A rename without an amendment is a rejection |
| 4 | The Zod schema is `.strict()` and validated before any side effect | |
| 5 | `runtime = 'nodejs'` is on a new route | |
| 6 | Authorisation: role **and** resource, in the pipeline order | |
| 7 | Errors are catalogue codes with catalogue copy | |
| 8 | Every transaction body is idempotent | |
| 9 | Every query has a `limit()`; every list query has `deletedAt == null` | |
| 10 | Every listener has a `limit()` and a teardown | |
| 11 | No `any`, no `!` outside tests | |
| 12 | No dead code, no commented-out code, no bare `TODO` | |
| 13 | Tests assert outcomes, not the absence of a throw | |
| 14 | Tests are deterministic: no `Date.now()`, no unseeded randomness | |
| 15 | Tests cover the **negative** cases, not just the happy path | |
| 16 | The test IDs are real and appear in [18](./18_TESTING_QA_PLAN.md) | |
| 17 | The anchor documents are updated in the same PR if the design changed | |
| 18 | No secret, no new env var without doc 21, no new dependency without a note | |
| 19 | The code reads like the code around it | |
| 20 | The PR description would let a reviewer reproduce the verification | |

### 12.6 When to squash

**Always** for `feat/`, `fix/`, `chore/`, `docs/`, `test/`, and `perf/`. The project history is read as requirements, not as a diary.

**Never** squash when:

- The commits are independently revertible and the revert granularity matters (a risky experiment behind a flag).
- A reviewer asked to see the sequence.
- The branch contains a `revert` that should stay visible.

A `spike/` branch is deleted, not merged. An `experiment/` branch is deleted after the decision is recorded in a decision note.

---

## 13. Security rules in code

| # | Rule | Enforcement | Rationale |
| ---: | --- | --- | --- |
| 1 | **No secrets in code, ever.** Not in a constant, not in a comment, not in a test fixture, not in a screenshot. | **[SCRIPT]** `check-secrets.ts` + `gitleaks` + a pre-commit hook | NFR-013 |
| 2 | **No `dangerouslySetInnerHTML`.** React text interpolation only. | **[LINT]** | Stored verbatim reporter text is the primary XSS source (FR-003) |
| 3 | **Never trust a client-supplied role.** Not in a body, a query, a header, or `localStorage`. | **[LINT]** + **[TEST]** TC-SEC-016 | NFR-015 |
| 4 | **No unvalidated input reaches Firestore, Storage, or Gemini.** | **[LINT]** + **[TEST]** TC-FR-142 | Every path is hostile |
| 5 | **No `firebase-admin` import outside `lib/server/`.** | **[LINT]** | One accidental client import is a full database compromise |
| 6 | **No PII in logs.** No text, phone, address, token, or evidence URL. | **[SCRIPT]** + the logger's secret-name guard | A log store has a different retention and access model |
| 7 | **`localStorage` holds nothing sensitive.** Allowed: the UI theme, the map style, the last-used filter, the offline queue payload (status actions only, no evidence, no identity). Forbidden: the role, the token, any incident, any notification, any user profile field. | **[REVIEW]** + a static scan for `localStorage.setItem('role'` | [20](./20_PROJECT_FOLDER_STRUCTURE.md) §7 #21 |
| 8 | **`process.env` only via `lib/env.ts` or `lib/env.client.ts`.** | **[LINT]** | [21](./21_ENVIRONMENT_VARIABLES.md) §1.3 |
| 9 | **Only `NEXT_PUBLIC_*` is referenced from application code.** | **[LINT]** | A `NEXT_PUBLIC_` secret ships to the browser |
| 10 | **Validate with Zod at the boundary, on the server, always.** | **[LINT]** + **[TEST]** | The client is the attack surface |
| 11 | **`.strict()` on every input schema.** | **[LINT]** | `.passthrough()` lets `role` or `status: 'verified'` through |
| 12 | **No field path or Storage path built from user input.** Anchored regexes and prefixes. | **[LINT]** + **[TEST]** TC-INT-083 | Path traversal and evidence theft |
| 13 | **No `403` for "not yours" on a read.** `404`, identical to missing. | **[TEST]** TC-SEC-019 | No existence oracle |
| 14 | **Security Rules are deny-by-default.** No `if true` catch-all. | **[SCRIPT]** TC-RULES-028 | The single most dangerous rules bug |
| 15 | **Never widen a rule to make a test pass.** Fix the call site. | **[REVIEW]** | A widened rule is a silent authorisation hole |
| 16 | **Short-lived signed URLs only.** No permanent public media URL. | **[TEST]** TC-INT-055 | Evidence is personal data |
| 17 | **No `eval`, no `new Function`, no dynamic `import()` of a variable path.** | **[LINT]** | |
| 18 | **`requestId` and a hashed IP only** — the raw IP is never persisted. | **[LINT]** + **[TEST]** | [07](./07_DATABASE_SCHEMA.md) §2 |
| 19 | **Every privileged mutation is audited**, inside the operation. | **[TEST]** TC-FR-130 | FR-130 |
| 20 | **No non-idempotent auto-retry.** | **[TEST]** TC-RT-009b | Duplicate incidents, double assignments |
| 21 | **Errors never leak internals.** | **[TEST]** TC-INT-122 | |
| 22 | **CSRF origin check on every non-GET.** No temporary removal. | **[TEST]** TC-INT-120 | Defence in depth |
| 23 | **The AI cannot drive a dispatch.** There is no tool/function calling, and no code path from an AI output to `dispatches`. | **[TEST]** TC-AI-001, TC-AI-044 | DEC-05, mandatory |
| 24 | **Never treat a client-declared MIME type or size as truth.** Magic bytes and the measured size win. | **[TEST]** TC-FR-008, TC-INT-081 | FR-008 |

---

## 14. Dependency policy

**The default answer is no.** A dependency must earn its place in a written decision note in the PR body. The note covers all five points below.

| # | Question | What "answered" looks like |
| ---: | --- | --- |
| 1 | **Alternatives** | At least two named, with why each was rejected. "There wasn't an alternative" is an answer only for a zero-dependency implementation |
| 2 | **Bundle impact** | The measured gzip delta in the client bundle, or `0 (server-only / dev-only)`. "Probably small" is not an answer |
| 3 | **Maintenance** | Last release date, open issue count, whether the maintainer is a single person, and what happens if it is abandoned. A single-maintainer dependency in a hackathon repo is acceptable **only** if the interface is small enough to replace |
| 4 | **Licence** | The exact SPDX identifier, checked against the project's licence. Copyleft in a shipped product needs a decision |
| 5 | **Free-tier fit** | Whether it works on the free tier, and what it costs at demo scale. A paid-required dependency is rejected for anything in the critical path |

Additional rules:

| Rule | Detail |
| --- | --- |
| No duplicate-purpose libraries | One date library, one validation library, one HTTP client, one chart library |
| `npm install` in a feature branch requires the decision note | Not just a lockfile bump **[REVIEW]** |
| The existing stack is not a licence to add more | Next.js 15, React 19, TypeScript 5.7 strict, Tailwind v4, shadcn/ui are locked. Adding a state library, a data-fetching library, or a form library is a **DECISION REQUIRED** |
| Prefer a 20-line local function to a 20 KB package | Especially for a single function |
| Pin with a caret range; lock with an exact resolution | The lockfile is the truth; `package.json` expresses intent |
| `npm ci`, never `npm install`, in CI | A drifted lockfile is a build failure, not a surprise |
| Audit before adding | `npm audit --omit=dev`; a high-severity advisory in a new dependency blocks the merge until it is triaged |
| Deprecations are checked at build time | A deprecated import fails the build, so the upgrade is not deferred silently |
| One copy of React and one copy of `zod` | A duplicate React is a hooks bug; `npm ls react` must show one version |
| Dev dependencies are free-tier-safe too | They run in CI, which is free-tier-limited on minutes |

### 14.1 The locked stack

Next.js 15 App Router · React 19 · TypeScript 5.7 strict · Tailwind v4 · shadcn/ui · Vitest 3 + `@vitest/coverage-v8` · `@testing-library/react` 16 + jest-dom + user-event · `@firebase/rules-unit-testing` 4 · `firebase-tools` (emulator) · Playwright 1.5x · `@axe-core/playwright` · Lighthouse CI · ESLint 9 flat config + `eslint-config-next` · Prettier 3 + `prettier-plugin-tailwindcss` · `@google/genai` · `ngeohash` · `zod` · `date-fns` (subpath imports only) · `firebase` / `firebase-admin` · `lucide-react` · `recharts` 3 · `@vis.gl/react-google-maps` · `sonner` · `react-hook-form` + `@hookform/resolvers` · `clsx` + `tailwind-merge` · `ngeohash`.

Anything not on this list needs a decision note.

---

## 15. Definition of Done

A change is done when **every** box in the relevant group is checked. This is the PR's completion gate **[REVIEW]**.

### 15.1 Every change

- [ ] `npm run verify` is green on **this** commit, not a previous one.
- [ ] The diff contains no unrelated change.
- [ ] Every new exported function has JSDoc with `@param` and `@returns`.
- [ ] No `any`, no `!` outside `tests/`, no `console.*` outside the allowed files.
- [ ] No dead code, no commented-out code, no bare `TODO`.
- [ ] The anchor documents are updated if the design changed, in the same PR.
- [ ] The traceability is updated: FR, NFR, and test IDs named in the description.
- [ ] The commit follows Conventional Commits with a folder-derived scope.

### 15.2 Bug fix

- [ ] A failing test exists that fails **without** the fix and passes with it. (A fix without a regression test is a coincidence until the bug comes back.)
- [ ] The test is named for the behaviour, not the fix.
- [ ] If the bug was a data or security issue, the audit trail is checked for prior occurrences.
- [ ] The root cause is described in the PR body, not just the symptom.
- [ ] Any affected documentation is corrected (a wrong doc is a bug too).

### 15.3 Feature

- [ ] The FR is identified, and the implementation matches the anchor document's wording.
- [ ] Unit tests for every pure function introduced, at 100 % branch coverage for a safety-critical one.
- [ ] Integration tests: 1 happy path and **at least 2 failure paths** for a new endpoint.
- [ ] Negative tests for every authorisation-relevant behaviour.
- [ ] Accessibility: the component passes axe, has an accessible name, is keyboard operable, and is ≥ 44 px.
- [ ] Responsive: no horizontal scroll at 360 px; checked at all five viewports if layout changed.
- [ ] Loading, empty, error, and forbidden states exist and are tested.
- [ ] Every user-visible string is in a `copy.ts`.
- [ ] The telemetry exists if the change affects an NFR: a log line, an `auditLogs` action, or an `aiRuns` field.
- [ ] [18](./18_TESTING_QA_PLAN.md) §4 gains a row, or an existing row is extended.
- [ ] The PR description explains what was **rejected** and why.

### 15.4 Refactor

- [ ] **No behaviour change.** If there is one, it is not a refactor.
- [ ] Tests pass **before and after**, unchanged. (Changing the tests in a refactor PR is the signal that behaviour changed.)
- [ ] The public surface is unchanged, or the change is documented as a breaking change with the call sites updated.
- [ ] File and folder sizes still satisfy [20](./20_PROJECT_FOLDER_STRUCTURE.md) P8.
- [ ] Coverage is not lower than before.
- [ ] The diff is easier to read than what it replaced. If not, the refactor was not worth doing.

### 15.5 Documentation

- [ ] The change is in a numbered file, `docs/<NN>_<TITLE>.md`.
- [ ] The status line and the "Related documents" links are present and correct.
- [ ] Every Mermaid diagram is syntactically valid and every code block is closed.
- [ ] Tables render; no row has an unbalanced `|`.
- [ ] Every link is a **relative** path to a file that exists.
- [ ] No document contradicts an anchor document. If it must, the anchor is amended in the same PR and the change is noted here.
- [ ] `DECISION REQUIRED` items are listed in a register, not buried in prose.
- [ ] `prettier --check docs/` passes, or the file is in `.prettierignore` for a stated reason.

### 15.6 Dependency

- [ ] The decision note answers all five questions in §14.
- [ ] Alternatives were named and rejected explicitly.
- [ ] The bundle impact is measured, not estimated.
- [ ] The licence is checked.
- [ ] Free-tier fit is confirmed.
- [ ] `npm ls <pkg>` shows exactly one version.
- [ ] `npm audit` shows no new high-severity advisory.
- [ ] The lockfile is committed.
- [ ] [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) and [20](./20_PROJECT_FOLDER_STRUCTURE.md) are updated if the dependency appears in either.

---

## 16. Anti-pattern catalogue

Twenty-eight named failures. Each has a one-line cause and a correct form.

| # | ❌ Anti-pattern | Why it is forbidden | ✅ Correct form |
| ---: | --- | --- | --- |
| 1 | `catch {}` | Hides bugs and turns a 500 into a silently wrong answer. The most damaging pattern in this list. | `catch` only to recover to a **documented** fallback, and log the recovery. Otherwise `throw AppError.from(e, ctx)`. |
| 2 | `const role = (body as { role: Role }).role` | A client-supplied role is a privilege escalation. | `requireUser(ctx)` then `ctx.user.role`, which came from `users/{uid}`. |
| 3 | `db.collection('incidents')` | A string literal renames silently. | `db.collection(COLLECTIONS.incidents)`. |
| 4 | `db.collection(COLLECTIONS.incidents).where('status','==','triaged').get()` | An unbounded read. | Add `where('deletedAt','==',null)`, an `orderBy`, and a `.limit(...)` from `LIMITS`. |
| 5 | A list query with no `deletedAt` filter | Soft-deleted rows leak into every view. The single most commonly forgotten rule in the project. | `.where('deletedAt', '==', null)` on every list query. |
| 6 | `const first = rows[0]!.id` | `!` discards the `noUncheckedIndexedAccess` guarantee that exists to protect you. | Narrow: `const first = rows[0]; if (!first) return emptyState;` |
| 7 | `throw new Error('Not found')` | Loses the code, the status, the retryability, and the audit flag. | `throw new AppError({ code: 'INCIDENT_NOT_FOUND' })`. |
| 8 | `return NextResponse.json({ error: err.message }, { status: 500 })` | Leaks a project id, a bucket name, or a Firestore path. | `return fail(err, ctx)`; the funnel decides what is exposed. |
| 9 | `const parsed = schema.safeParse(body); if (!parsed.success) return { error: 'bad' }` | A 200 with an error body breaks the single-envelope contract in a way the client cannot detect. | `throw new AppError({ code: 'VALIDATION_FAILED', details: formatZodIssues(parsed.error) })`. |
| 10 | `<p dangerouslySetInnerHTML={{ __html: incident.originalText }} />` | Stored verbatim reporter text becomes an XSS sink. | `{incident.originalText}` as a text child. |
| 11 | `if (body.role === 'admin') { … }` | Authorization from the request body. | `assertRole(ctx, 'admin')` against the Firestore role. |
| 12 | `onSnapshot(db.collection('incidents'), cb)` | No `limit()`, no role scoping, no teardown: a budget breach and a privacy leak. | A scoped helper from `lib/firebase/`, with a `limit()` and a registry-managed teardown. |
| 13 | `useEffect(() => { setTotal(a + b) }, [a, b])` | Derived state in an effect: two sources of truth and an extra render. | `const total = a + b;` during render. |
| 14 | `if (isOpen) { const [x, setX] = useState(0); }` | A rules-of-hooks violation that becomes a real bug when the condition flips. | The hook always runs; the effect decides. |
| 15 | `let currentUser: User \| null = null;` at module scope | Survives between requests on a warm instance. Two requests interleave and see each other's user. | Pass the user through the call chain, or scope it to the request. |
| 16 | `console.log('got incident', incident)` | Bypasses `LOG_LEVEL`, the redaction guard, and the `requestId` binding. Puts incident text in a log store. | `logger.info('incident.loaded', { requestId, incidentId })`. |
| 17 | `import { db } from '@/lib/firebase-admin'` | The most dangerous import in the project; one accidental client import is a full database compromise. | `import { getAdminDb } from '@/lib/server/firebase-admin'`, server-only. |
| 18 | `const urgency = await gemini(prompt)` used as `urgency` | An AI value reaching a decision without validation. The single worst failure mode in this product. | `aiTriageOutputSchema.safeParse` → `applySafetyRules` → the server decides. |
| 19 | `incidents.geo = aiOutput.location` | Fabricated location. There is no coordinate field in the AI schema for exactly this reason. | `incidents.geo = validatedRequestLocation`; the model never sees coordinates. |
| 20 | `// TODO: fix this later` | A TODO with no owner and no issue never gets done, and it normalises leaving them. | `// TODO(cg-team): #214 — <why> <what>` |
| 21 | `/* eslint-disable @typescript-eslint/no-explicit-any */` at the top of a file | A file-wide opt-out is not a justification. | `unknown` + narrowing. If one cast is truly unavoidable, one line, with a reason, narrowed immediately. |
| 22 | `if (navigator.geolocation) { getCurrentPosition(…) }` on mount | Auto-prompting on page load is forbidden (FR-030) and is the fastest way to lose a stressed user. | An explicit **Use my current location** action. |
| 23 | `if (accuracy > 1000) reject('location looks wrong')` | A rejected report is a lost emergency. | Create the incident and flag it for dispatcher review ([17](./17_VALIDATION_RULES.md) §8.3). |
| 24 | `setInterval(() => fetchQueue(), 5000)` | Polling is forbidden (FR-090); it costs reads and is slower than a listener. | An `onSnapshot` listener with a `limit()`. |
| 25 | `localStorage.setItem('role', user.role)` | Invites a future "read the role client-side" bug and violates [22](./22_USER_ROLES_PERMISSIONS.md) §2. | `GET /api/me` → `data.user.role`, re-fetched. |
| 26 | `const incident = makeIncident(); incident.status = 'verified';` | Bypasses the transition table and writes no `statusHistory` entry, so the audit trail has a hole. | `changeIncidentStatus({ …, status: 'verified' })`, which validates, timestamps, and appends history in one transaction. |
| 27 | `await apiFetch(path, { retries: 3 })` on a `POST` | A double tap during an outage produces two incidents. The most likely real-world harm in this list. | Retry only with the **same** `Idempotency-Key`. |
| 28 | `import { Button } from '@/components/ui/button-copy'` | Two buttons means inconsistent states and focus rings. | Extend the shadcn primitive via props; shadcn components are edited in place. |

---

## 17. `DECISION REQUIRED` register

| # | Item | Why it is open | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| D-31-1 | **`exactOptionalPropertyTypes`.** [05](./05_FRONTEND_ARCHITECTURE.md) §15 lists it as enabled. It is the strictest and most painful flag for a project of this size: `{ a?: string }` no longer accepts `{ a: undefined }`, which changes the shape of nearly every optional prop and every Zod output. | Enabling it after several hundred optional props exist is a large, noisy change. Disabling it after promising it is a documentation mismatch. | **Decide before the first component is written.** If enabled, the cost is paid once and the type system gets meaningfully safer. If disabled, amend [05](./05_FRONTEND_ARCHITECTURE.md) §15 to say so and record why. Either is defensible; silence is not. | `tsconfig.json`; §2.1 |
| D-31-2 | **Enforcement severity of the file-length rule.** NFR-024 sets 400 lines as an enforced ceiling; [20](./20_PROJECT_FOLDER_STRUCTURE.md) P8 sets 250 lines for everything except barrels and seed fixtures. | A single lint rule cannot express "400 for components, 250 for modules, exempt barrels" without a small plugin. | Implement the 400-line rule as a **lint error** and the 250-line rule as a **warning**, both scoped to `app/`, `features/`, `components/`, `lib/`, and `services/`, with `index.ts` and `scripts/seed.ts` exempted. Alternatively use `eslint-plugin-max-lines` and configure both. | The ESLint config |
| D-31-3 | **Branded types for `IncidentId` / `CgReference`.** §2.12 recommends them for the resources where a type confusion becomes an IDOR bug. | Branded types add friction at every boundary, including JSON serialisation and Zod parsing, and they interact with `exactOptionalPropertyTypes` decisions. | Adopt them for `IncidentId` and `CgReference` only, produced by `lib/incidents/reference.ts` and validated by `validators/common.ts`, and **not** for `uid` (which appears in too many shapes). | The validator layer |
| D-31-4 | **`scripts/check-fixtures.ts` and `scripts/check-collections.ts` are new scripts.** [20](./20_PROJECT_FOLDER_STRUCTURE.md) §6.3 lists `check-bundle`, `check-listeners`, and `check-copy`; [18](./18_TESTING_QA_PLAN.md) §17 adds `check:secrets`, `check:fixtures`, and `check:routes`. | The folder structure is the authority on which CI scripts exist, and it does not yet list all of them. | Amend [20](./20_PROJECT_FOLDER_STRUCTURE.md) §6.3 to list every `check:*` script referenced by [18](./18_TESTING_QA_PLAN.md) and by this document, so the two agree. | The CI workflow; [20](./20_PROJECT_FOLDER_STRUCTURE.md) §6.3 |
| D-31-5 | **Maximum test IDs that cite the same `data-testid` in the "Anti-patterns" table.** §4.8 requires a non-literal `aria-label` "so a test can assert the string". | A non-literal label means the test imports the constant, which is correct, but it also means a copy change can silently break a test that imported a literal. | Keep the requirement. The test imports the constant from the component's module, so a copy change is a deliberate one-line update. | Nothing; recorded for the reviewer |
| D-31-6 | **`lib/collections.ts` vs `config/collections.ts`.** §3.3 names `config/collections.ts`; [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2 lists `config/` but does not list a `collections.ts`. | A new file in `config/` requires amending [20](./20_PROJECT_FOLDER_STRUCTURE.md) per its own rule. | Add `config/collections.ts` to [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2, or place the constant in `lib/constants.ts`, which is already listed. | [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2 |

---

## Appendix A — Lint rule inventory

The rules this document depends on, so a reviewer can see which rules are load-bearing.

| Rule | Level | Applies to | Enforces |
| --- | --- | --- | --- |
| `import-x/no-restricted-imports` (boundary matrix) | error | all | §7, §13 #5, #17, [20](./20_PROJECT_FOLDER_STRUCTURE.md) §3.2 |
| `no-restricted-syntax` (`'use client'`) | error | `app/`, `lib/`, `services/`, `scripts/` | §4.2 |
| `no-restricted-properties` (`process.env`) | error | all but `lib/env*.ts`, `lib/server/**`, `app/api/**` | §13 #8 |
| `no-restricted-syntax` (`process.env.X` for non-`NEXT_PUBLIC_`) | error | all | §13 #9 |
| `@typescript-eslint/no-explicit-any` | error | `app/`, `features/`, `services/`, `lib/`, `hooks/`, `types/`, `validators/` | §2.2 |
| `@typescript-eslint/no-unsafe-assignment` | error | as above | §2.2 |
| `@typescript-eslint/consistent-type-imports` | error | all | §2.3 |
| `@typescript-eslint/no-non-null-assertion` | warn (error by review) | all but `tests/` | §2.8 |
| `@typescript-eslint/consistent-type-definitions` | error | all | §4.1 |
| `react-hooks/rules-of-hooks` | error | all | §5.3 |
| `react-hooks/exhaustive-deps` | error | all | §5.2 |
| `no-restricted-syntax` (gradients, hex, inline colour, literal `aria-label`) | error | `components/`, `features/`, `app/` | §4.9 |
| `no-restricted-syntax` (`onSnapshot` + `.where`) | error | all but `lib/server/`, `services/`, `scripts/`, `tests/` | §9.2 |
| `max-lines` | error 400 / warn 250 | `features/`, `components/`, `lib/`, `services/` | §4.3, D-31-2 |
| `no-restricted-syntax` (`dangerouslySetInnerHTML`) | error | all | §13 #2 |
| `no-console` | error outside the allow-list | all | §7.5 |
| `no-restricted-syntax` (enum literal lists outside `validators/enums.ts`) | error | all | §2.6, §3.3 |
| `custom: no-dto-without-schema` | error | `types/` | §2.9 |
| `custom: no-firestore-in-route` | error | `app/api/**` | §6.5 |
| `custom: no-manual-envelope` | error | all but `lib/api/respond.ts` | §6.4 |

## Appendix B — Quick reference card

```text
BEFORE YOU WRITE
  Read the anchor doc for what you are changing.   Field name?  → doc 07
  New endpoint?                                   → doc 08 §3 and §11
  New error?                                      → doc 16 §3
  New bound?                                      → doc 17 §5
  New file?                                       → doc 20 §2
  New env var?                                    → doc 21 §2
  Permission?                                     → doc 22 §3

WHILE YOU WRITE
  strict TS, no any, no !, import type, no console.*
  Zod .strict() in the route, before any side effect
  Every query: limit() + deletedAt == null
  Every listener: limit() + teardown + registry
  Every throw: AppError with a catalogue code
  Every string the user sees: in copy.ts
  Every new function: JSDoc with @param and @returns

BEFORE YOU PUSH
  npm run verify

IN THE PR
  FR / NFR / test IDs, files changed with reasons, test evidence,
  design notes, risk, and the checklist
```

---

**End of document 31.** Amendments must reference the anchor document they change. This document may not introduce a field, an endpoint, an error code, an environment variable, a collection, or an enum value that is not already defined in [07](./07_DATABASE_SCHEMA.md), [08](./08_API_SPECIFICATION.md), [16](./16_ERROR_HANDLING.md), [17](./17_VALIDATION_RULES.md), or [21](./21_ENVIRONMENT_VARIABLES.md).

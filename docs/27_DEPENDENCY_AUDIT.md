# Dependency audit — triage, not a fix

Phase 15, item 9: audit dependencies for known vulnerabilities **without blind major upgrades**.

Run: `npm audit --json` against `package-lock.json`.

## Result

**0 critical, 5 high, 10 moderate, 15 total.** Nothing here justifies an emergency change, and nothing here
should be fixed by running `npm audit fix`.

## DO NOT RUN `npm audit fix` ON THIS REPO

This is the most important line in this document.

| Package | Installed | `fixAvailable` | What npm would actually do |
|---|---|---|---|
| `firebase` | **11.10.0** | `9.14.0` | **Downgrade** by two majors |
| `firebase-admin` | 13.10.0 | `14.5.0` | Upgrade across a major |
| `next` | 15.5.26 | `16.3.8` | Upgrade across a major |
| `vitest` | 3.2.7 | `5.0.3` | Upgrade across a major |

The `firebase` entry is the trap. Its advisory range is open-ended at the top
(`>=9.15.0-20221206221533`), which sweeps up every modern release including 11.10.0. `npm audit fix` resolves a
range violation by installing the nearest version **outside** the range — and for an open-ended upper bound that
is *below* it. So the "fix" is `firebase@9.14.0`.

That is not a patch. It is a two-major downgrade of the client SDK, and it would be applied silently, by a
command whose entire purpose reads as "make the audit output clean."

## Per-advisory triage

Exploitability is judged against how this project actually uses the dependency, not the advisory's CVSS.

### `@grpc/grpc-js` — HIGH — via `@firebase/firestore` ← `firebase`
> `getAuthContext` can return unauthorized certificates as though they were authorized.

Firestore's gRPC transport accepts a certificate it should have rejected. It is a **certificate-validation**
defect, so the exploitable shape is a hostile or MITM'd endpoint — not a malicious request from a user.

Relevant here in two places: `firebase-admin` (server) and `firebase` (browser). The browser leg never speaks
gRPC, so the exposure is the server leg talking to Firestore, which is Google's own TLS endpoint.

**Verdict: low practical risk, genuine defect.** Fix is bundled into a `firebase` major that is itself
impossible without the downgrade above. Revisit when `firebase` 12 ships.

### `postcss` — HIGH — via `next`
> XSS via unescaped `</style>` in CSS stringify output; arbitrary file read via attacker-controlled
> `sourceMappingURL`.

**Build-time only.** PostCSS runs during `next build` against this repository's own CSS. There is no path by
which a user supplies CSS to the build. The `sourceMappingURL` file-read is the more interesting half: it would
require a malicious `.map` arriving via a dependency.

**Verdict: low risk for the running production app, relevant to CI.** If you ever process untrusted CSS or
ingest a `.map` from outside the team, re-read this one. A `next@16` upgrade clears it.

### `firebase` (aggregate) — HIGH
Not a separate defect; the sum of the `@firebase/firestore` and `@firebase/firestore-compat` entries above.

### `@vitest/mocker` — MODERATE — via `vitest` (dev)
> Path traversal / arbitrary file read via `mocker` redirect mock.

**Test-time only**, and the payload is a mock redirect in test code. Exploitable only by someone who can
already write to the test suite — at which point they own `verify` anyway.

**Verdict: low. Will clear on `vitest@5`.** Worth noting only because Phase 15 asked.

### `uuid` — MODERATE — via `google-gax` ← `teeny-request` ← `retry-request` ← `firebase-admin`
> Missing buffer bounds check in v3/v5/v6 when `buf` is provided.

Requires calling `uuid.v3/v5/v6` with a caller-supplied output buffer. We call none of those entry points; the
dependency is pulled in transitively and its vulnerable functions are never reached.

**Verdict: not reachable.** Clears on `firebase-admin@14`.

### `@google-cloud/firestore`, `@google-cloud/storage`, `google-gax`, `retry-request`, `teeny-request` — MODERATE
Transitive, roll-ups of the above. No independent finding.

### `next` — MODERATE
Inherited from `postcss`. Not an independent issue.

## Recommendation

**Change nothing now.** Specifically:

1. Do not run `npm audit fix`, `npm audit fix --force`, or accept any automated resolution.
2. Do not add `overrides` to silence these. A suppressed advisory is indistinguishable from a fixed one to
   everyone reading the audit output later.
3. When there is room for a focused upgrade cycle, take the three majors **one at a time**, each with a full
   `npm run verify` between them: `vitest` → `firebase-admin` → `next`. `firebase` (client) is last and needs a
   real decision, because the advisory's open-ended range means the audit will keep reporting it until a
   release lands that is outside the range.
4. Re-run `npm audit` after each and record the delta. The baseline to beat is the line above.

## Why this file exists

`npm audit` output is a list of package names and severities. Read on its own it invites the one action that
makes this repo worse. The useful question is never "how many advisories are open" but "what would applying
this change actually do" — and for `firebase` the answer is a two-major downgrade.
# 15 — File Storage Specification

**Project:** CareGrid AI
**Document type:** Normative specification for evidence media (images and audio) in Firebase Cloud Storage
**Status:** Baseline v1.0 — normative for the path scheme, the MIME allow-list, the validation chain, and the retention rules. The Storage Security Rules are specified in [10](./10_AUTHORIZATION_SECURITY.md) §10.
**Related:** [10 Authorization & Security §10, §17](./10_AUTHORIZATION_SECURITY.md) · [08 API Specification §3.1, §8](./08_API_SPECIFICATION.md) · [07 Database Schema §10.1](./07_DATABASE_SCHEMA.md) · [09 AI Spec §4.2](./09_AI_GEMINI_SPECIFICATION.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [24 Threat Model T-05..T-08, T-36, T-45](./24_THREAT_MODEL_SECURITY.md)

---

## 0. How to read this document

Two rules govern everything below.

1. **A client-declared `contentType` is a claim, not a fact.** FR-008: "Every uploaded file MUST be validated server-side by sniffing magic bytes; a client-declared MIME type MUST NOT be trusted." The only value we ever store is the **server-sniffed** value (`MediaRef.contentType` in [07](./07_DATABASE_SCHEMA.md) §10.1 is explicitly "server-verified, not client-declared").
2. **Container checks are best-effort, and this document says so every time.** A magic-byte match is *necessary*. It is not *sufficient*. §5.4 states precisely what a match does and does not prove.

Terminology:

| Term | Meaning |
| --- | --- |
| **staging** | `staging/{uid}/{mediaId}.{ext}` — a per-user scratch area, reachable only by its owner |
| **final path** | `incidents/{incidentId}/reports/{reportId}/{mediaId}.{ext}` or `.../supplements/{reportId}/...` |
| **quarantine** | `quarantine/{mediaId}.{ext}` — unreachable by every client, including the uploader |
| **`mediaId`** | `med_` + 12 base32 (`A–Z2–7`) characters, server-generated (§4) |
| **`kind`** | `'image'` or `'audio'`, from the request, cross-checked against the sniffed type |
| **sniff** | Reading the first 4 KiB of the object and comparing against the signature table in §5 |
| **`scanStatus`** | `clean \| pending \| quarantined` on every `MediaRef` ([07](./07_DATABASE_SCHEMA.md) §10.1) |

---

## 1. Scope

### 1.1 In scope

| Evidence kind | Why it exists | FR |
| --- | --- | --- |
| **Images** (≤ 3 per report) | Vision triage and dispatcher/responder situational awareness | FR-005 |
| **Audio** (≤ 1 clip per report, ≤ 120 s) | Voice reporting for a citizen who cannot type; audio transcription | FR-006 |

### 1.2 Explicitly out of scope

| Excluded | Reason |
| --- | --- |
| **Video** | Size, cost, transcoding, and playback surface. FR "out of scope: video evidence" ([01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) §9) |
| **Documents / PDFs** | No viewer, no redaction story, an unbounded parser attack surface |
| **Avatars / user uploads** | The `photoURL` is a Google-hosted URL reference, not a stored object |
| **Any file attached to a notification** | Notifications carry text and an internal route only |
| **Any file attached to a responder profile** | `responders.photoURL` is a reference; `certifications` are structured data, not uploads |
| **Server-side image processing** | No `sharp`, no thumbnail pipeline, no EXIF stripping, no virus scanning. See §9, §11, §12.3 |

### 1.3 Why direct-to-Storage at all

| Option | Rejected because |
| --- | --- |
| Upload through the Next.js Route Handler | **Vercel's request body limit is 4.5 MB.** FR-005 allows a 5 MB image and FR-006 a 15 MB clip. A `multipart/form-data` body over 4.5 MB is rejected by the platform before our code runs. This is the entire reason for DEC-08 |
| Base64 in the JSON body | 4/3 size inflation on top of an already-inflated limit, plus a ~1.33× memory cost in the function |
| Firebase Storage resumable upload from the client SDK | It works, but it needs client-SDK write permission to `incidents/**`, which the rules must then express per-visibility — and rules cannot evaluate assignment or distance ([10](./10_AUTHORIZATION_SECURITY.md) §11). A **server-issued V4 signed URL** moves the whole decision to the server, where it can be correct |
| Google Cloud Storage client library directly | Bypasses Firebase Auth's identity model; no path-ownership rules; extra credentials |

**The chosen design:** the client asks the server for permission, receives a single-object, `PUT`-only, 15-minute signed URL, and uploads the bytes straight to Storage. **The client never receives a service-account credential and never holds a key that could write anywhere else.** The server then verifies the bytes and moves the object.

---

## 2. Firebase Storage configuration

### 2.1 Bucket, project, region

| Setting | Value | Source |
| --- | --- | --- |
| Bucket | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` = `<project>.appspot.com` (or `<project>.firebasestorage.app` on newer projects — **verify which one your project uses before hard-coding either**) | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| Project | `caregrid-ai-dev` / `caregrid-ai-staging` / `caregrid-ai-prod` — **never shared between environments** | [21](./21_ENVIRONMENT_VARIABLES.md) §4 |
| Region | The same region as the Firestore database. `preferredRegion: 'bom1'` (Mumbai) is the Vercel region setting, and it must match. `DECISION REQUIRED` — the actual Firestore region of the created project must be read from the console and confirmed before the region setting is trusted | [21](./21_ENVIRONMENT_VARIABLES.md) §8 |
| Default bucket access | **All users denied.** The bucket has no public object, ever | §12 |
| Default bucket location | Not set — the project region governs | — |
| Uniform bucket-level access | **Enabled.** This removes the legacy per-object `acl` path, so a misconfigured object cannot become public | — |
| `cacheControl` on upload | Not set by the client; the read path is a signed URL with a short TTL | §12.2 |

### 2.2 Bucket layout

```
gs://<bucket>/
│
├── staging/                                    ← the uploader's own scratch space
│   └── {uid}/
│       └── med_{12 base32}.{ext}               ← rules: owner-only rw, ≤ 15 MB, ext must match the content type
│
├── incidents/                                  ← final evidence. rules: if false for every client
│   └── {incidentId}/
│       ├── reports/
│       │   └── {reportId}/
│       │       └── med_{12 base32}.{ext}
│       └── supplements/
│           └── {reportId}/
│               └── med_{12 base32}.{ext}
│
├── quarantine/                                 ← soft-deleted / rejected. rules: if false for every client
│   └── med_{12 base32}.{ext}
│
└── (anything else)                             ← rules: if false. Reachable by nobody.
```

```
                     client
                        │  1. POST /api/uploads/sign
                        ▼
                 ┌──────────────┐
                 │   Vercel fn  │  validates kind/contentType/size,
                 │ (TB3, trusted)│  generates mediaId, forces the path
                 └──────┬───────┘
                        │ 2. signed PUT URL, 15 min, one object
                        ▼
                 ┌──────────────┐
   client ───────►│   Storage    │  writes staging/{uid}/{mediaId}.{ext}
   (bytes only)   │   (TB4)      │  evaluated against storage.rules §10.2
                 └──────┬───────┘
                        │ 3. POST /api/uploads/finalize { mediaId }
                        ▼   server reads first 4 KiB → sniff → compare
                 ┌──────────────┐
                 │   Vercel fn  │  4. POST /api/incidents with the staging path
                 └──────┬───────┘  5. re-sniff, then copy + delete
                        ▼
                 ┌──────────────┐
                 │   Storage    │  incidents/{id}/reports/{rid}/{mediaId}.{ext}
                 └──────────────┘
                        │ 6. GET /api/uploads/:mediaId/url
                        ▼
                 15-minute signed GET URL → browser renders via <img>
```

### 2.3 CORS configuration for direct browser `PUT`

The signed URL is issued by the Firebase Storage API and the browser performs a **cross-origin** `PUT` to `firebasestorage.googleapis.com`. Without bucket CORS, the browser preflight fails and no upload is possible.

| Origin | Methods | Headers | Max age | Credentials |
| --- | --- | --- | --- | --- |
| `http://localhost:3000` | `PUT`, `GET`, `HEAD`, `OPTIONS` | `Content-Type`, `x-goog-content-sha256`, `x-goog-date`, `Authorization` | `3600` | `false` (signed URL = the credential) |
| `https://<staging-domain>` | `PUT`, `GET`, `HEAD`, `OPTIONS` | same | `3600` | `false` |
| `https://<prod-domain>` | `PUT`, `GET`, `HEAD`, `OPTIONS` | same | `3600` | `false` |

Rules for the CORS config:

| Rule | Why |
| --- | --- |
| `"credentials": false` | The signed URL **is** the credential. Sending cookies would be wrong and would break the signature |
| `Content-Type` is allowed | The signed URL binds the content type, so the header must be permitted |
| **No `*` origin** | A wildcard origin would let any site attempt cross-origin uploads against a leaked signed URL. Explicit origins only |
| `maxAge 3600` | A preflight per upload would double the request count on a 3-image report |
| Configure in the Google Cloud console, **not** in code | The console is the source of truth and is what an auditor can see |

> **Honest limitation:** CORS is enforced by the *browser*, not by Storage. It prevents a well-behaved cross-origin page; it does not prevent `curl`. The actual control is the signed URL's scope (one object, one verb, 15 minutes) and the rules evaluation of the write.

### 2.4 Storage Security Rules

Specified in full, with the explanation table, in **[10](./10_AUTHORIZATION_SECURITY.md) §10**. The three things to remember:

| Rule | Effect |
| --- | --- |
| `staging/{uid}/{file}` | Owner-only read/write/delete, `mediaIdOk()`, `withinSize()`, `extMatches()`. Cross-user path theft is denied |
| `incidents/**` and `quarantine/**` | `allow read, write, delete: if false` for **every** client. The client SDK cannot touch final evidence at all |
| `match /{allPaths=**} { allow … if false; }` | Deny by default |

---

## 3. Path scheme (normative)

### 3.1 The four legal shapes

```
staging/{uid}/{mediaId}.{ext}
incidents/{incidentId}/reports/{reportId}/{mediaId}.{ext}
incidents/{incidentId}/supplements/{reportId}/{mediaId}.{ext}
quarantine/{mediaId}.{ext}
```

| Segment | Source | Format | Why |
| --- | --- | --- | --- |
| `staging/{uid}` | **`token.uid`**, server-side | `[A-Za-z0-9_-]{1,128}` (Firebase UID charset) | The path owner is the identity, so the rules can evaluate ownership with a single `mine(uid)` comparison |
| `incidents/{incidentId}` | Firestore auto-ID | `[A-Za-z0-9]{20}` | Matches [07](./07_DATABASE_SCHEMA.md) §4.1 |
| `reports/{reportId}` | Firestore auto-ID | `[A-Za-z0-9]{2,}` | Matches the doc ID of `incidents/{id}/reports/{rid}` |
| `supplements/{reportId}` | Firestore auto-ID | `[A-Za-z0-9]{2,}` | A supplement is a *new report document* of `kind: 'supplement'`; it lives under the same incident but a distinct sub-tree so a dispatcher can tell originals from supplements at a glance |
| `{mediaId}` | **server-generated** | `med_[A-Z2-7]{12}` | §4 |
| `{ext}` | **server-derived from the sniffed type** | `jpg \| jpeg \| png \| webp \| webm \| m4a \| mp3` | Never taken from the client's filename |

### 3.2 Why staging exists — the load-bearing reason

> **The incident ID does not exist at upload time.**

The report flow is: pick a photo → upload it → *then* submit the report. At the moment the citizen taps "upload photo", there is no `incidentId` and no `reportId`. Both are Firestore auto-IDs created later inside the `POST /api/incidents` transaction ([07](./07_DATABASE_SCHEMA.md) §12.6).

The alternatives, and why each is worse:

| Alternative | Why rejected |
| --- | --- |
| Client invents the `incidentId` | A client-chosen path segment means a client-chosen destination. It also breaks the `runTransaction` that creates the incident, which owns the ID |
| Upload to a flat `uploads/{mediaId}` prefix | Works, but loses the "who owns this, structurally" property that makes `mine(uid)` a one-line rules check. It also makes every object share one prefix, so one rules mistake exposes every upload |
| Two-phase: create a stub incident first, then upload, then finalize | Doubles the write count on the most important endpoint, creates abandoned stub incidents on a failed upload, and doubles the failure modes of the report flow. US-001 requires a report in 30 seconds on a cracked screen — a two-phase create is a UX regression for a security gain that `staging/{uid}` already provides |
| **Staging, then a server-side move** | **Chosen.** Ownership is structural during upload; the final location is authoritative and server-chosen afterwards |

### 3.3 The move

```ts
// services/uploads/finalize-upload.ts + services/incidents/create-incident.ts
const stagingPath = `staging/${uid}/${mediaId}.${ext}`;                     // what the client holds
const finalPath   = `incidents/${incidentId}/reports/${reportId}/${mediaId}.${ext}`;   // what the client never names

// copy-then-delete (not "move"): a failed copy must never destroy the only copy.
await bucket.file(stagingPath).copy(bucket.file(finalPath));
await bucket.file(stagingPath).delete({ ignoreNotFound: true });
```

| Property | Decision | Why |
| --- | --- | --- |
| Operation | **copy then delete**, never a hypothetical atomic "move" | A rename across prefixes is not atomic in the Storage SDK. Copy-then-delete means an interruption leaves a duplicate in staging (harmless, swept in 30 min) rather than losing evidence (unacceptable) |
| Who performs it | The **Admin SDK**, server-side, inside the `POST /api/incidents` flow | The client has no permission on `incidents/**` at all |
| Order relative to the incident write | After the media re-verification, **before** the transaction commits the `MediaRef` | So a `MediaRef.storagePath` is never persisted for an object that does not exist |
| Failure | `STORAGE_UNAVAILABLE` (503). The report is **not** created without its verified evidence, unless the report has valid text — in which case the media is dropped, the incident is created, and `evidenceCount` reflects reality | Reporting must never fail because storage hiccupped (the FR-029 spirit applied to storage) |
| Orphans | Anything still in `staging/` after `STAGING_UPLOAD_SWEEP_MIN` (30) is removed by the `sweep-staging-uploads` maintenance job | §16.2 |

### 3.4 The regex that must be allowed

[08](./08_API_SPECIFICATION.md) §3.1 currently specifies:

```
^incidents/[A-Za-z0-9]{20}/(reports|supplements)/[A-Za-z0-9]{2,}/[A-Za-z0-9_.-]+$
```

§8.1 of the same document specifies that the client posts the **staging** path. Those two statements are not simultaneously satisfiable.

**The implementation contract (`validateMediaPath()` in `validators/upload.ts`, normative):**

```
STAGING_PATH_RE  = ^staging/[A-Za-z0-9_-]{1,128}/med_[A-Z2-7]{12}\.(jpg|jpeg|png|webp|webm|m4a|mp3)$
FINAL_PATH_RE    = ^incidents/[A-Za-z0-9]{20}/(reports|supplements)/[A-Za-z0-9]{2,}/med_[A-Z2-7]{12}\.(jpg|jpeg|png|webp|webm|m4a|mp3)$
QUARANTINE_PATH_RE = ^quarantine/med_[A-Z2-7]{12}\.(jpg|jpeg|png|webp|webm|m4a|mp3)$
```

| Path shape the client may send | Accepted | Checked against |
| --- | --- | --- |
| `staging/{own uid}/med_XXXXXXXXXXXX.jpg` | ✔ | `STAGING_PATH_RE` **and** `path.split('/')[1] === token.uid` **and** the mediaId was issued to this uid by `POST /api/uploads/sign` within 30 min |
| `incidents/{id}/reports/{rid}/med_XXXXXXXXXXXX.png` | ✔ | `FINAL_PATH_RE` **and** the report belongs to an incident this uid reported, **and** the object exists with a matching `mediaId` |
| `staging/{someoneElse}/med_XXXXXXXXXXXX.jpg` | ✖ | `403 UPLOAD_FORBIDDEN_PATH` |
| `quarantine/med_XXXXXXXXXXXX.jpg` | ✖ | `403 UPLOAD_FORBIDDEN_PATH` |
| anything with `..`, a leading `/`, a doubled `/`, or a `%2e` | ✖ | `403 UPLOAD_FORBIDDEN_PATH` |
| `incidents/{id}/reports/{rid}/../../other/med_x.jpg` | ✖ | the character classes plus an explicit segment check; `403 UPLOAD_FORBIDDEN_PATH` |
| a path with a client filename like `IMG_20260926_101530.jpg` | ✖ | `med_` prefix required; `403 UPLOAD_FORBIDDEN_PATH` |

> **`DECISION REQUIRED` (D-1 in [10](./10_AUTHORIZATION_SECURITY.md) §22.1):** make the canonical `media[].storagePath` contract explicit in [08](./08_API_SPECIFICATION.md) — either "the staging path always" (recommended; it is what the client actually has) or "the final path, and the client must re-sign after the incident exists" (which would require a second round trip and breaks the 30-second flow). The implementation accepts **both**, with a strict ownership check on each, and this document and the API spec must converge on one.

### 3.5 Why client filenames are never used

| Hazard of a client filename | Example |
| --- | --- |
| Path traversal | `../../config/app` |
| Extension spoofing | `photo.jpg` that is actually an SVG |
| Control characters and newlines | `med\x00.jpg`, or a name containing `\n` that forges a log line |
| Unicode homoglyphs | `med_a91\u2024jpg` rendering as `med_a91.jpg` in a UI but not in a path |
| Length | A 300-character filename from a Windows machine |
| Information leak | `WhatsApp Image 20260926 at 14.31.02.jpeg` puts a timestamp and an app name in an object path that admins can list |
| PII | `Priyas passport photo.jpg` |

None of these is possible when the server generates the entire filename from a 12-character base32 token. The only place a client filename is ever touched is the **local** preview `<img>` in the browser, before upload.

---

## 4. `mediaId` generation

```ts
// services/uploads/sign-upload.ts
import { randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';       // 32 chars, RFC 4648 base32, no 0/1/8/9/I/L/O

function mediaId(): string {
  const bytes = randomBytes(12);                          // 96 bits
  let out = '';
  for (let i = 0; i < 12; i++) out += BASE32[bytes[i] % 32];
  return `med_${out}`;                                    // "med_" + 12 chars = 16 chars
}
```

| Property | Value | Why |
| --- | --- | --- |
| Prefix | `med_` | A 3-character namespace prefix, consistent with `rep_`, `dsp_`, `ev_`, `ai_`, `rz_`, `res_` in [07](./07_DATABASE_SCHEMA.md) |
| Body length | **12** base32 characters | 12 × 5 = **60 bits of entropy**. A 5-character `res_` id would be 25 bits; 12 is enough that guessing is hopeless while staying short enough to read aloud and to appear in a Storage console listing |
| Alphabet | `A–Z2–7` (32 symbols) | Case-insensitive in a path on Windows/macOS, no `0/O/1/I` confusion, and a regex-safe character class with no escaping needed |
| Source | `crypto.randomBytes`, **server-side only** | A client-generated `mediaId` would let a client enumerate or overwrite another user's media id. `Math.random()` and `Date.now()` are not acceptable |
| Collision handling | **None needed.** 60 bits across, say, 100 000 objects is a collision probability of ~4 × 10⁻¹⁰. A collision would also require the same `incidentId` *and* the same `reportId` | — |
| Extent | `med_[A-Z2-7]{12}` — enforced by `mediaIdOk()` in `storage.rules` **and** by `STAGING_PATH_RE`/`FINAL_PATH_RE` in `validators/upload.ts` | Two independent gates |
| Case | Always uppercase | Storage object names are case-sensitive; forcing one case removes a whole class of "why is this 404" bug |

---

## 5. Allowed MIME types and magic-byte verification

### 5.1 The allow-list

| `contentType` | Extension used in the path | `kind` | Max bytes | Max per report | FR |
| --- | --- | --- | --- | --- | --- |
| `image/jpeg` | `jpg` | `image` | 5 242 880 (5 MB) | 3 | FR-005 |
| `image/png` | `png` | `image` | 5 242 880 | 3 | FR-005 |
| `image/webp` | `webp` | `image` | 5 242 880 | 3 | FR-005 |
| `audio/webm` | `webm` | `audio` | 15 728 640 (15 MB) | 1 | FR-006 |
| `audio/mp4` | `m4a` | `audio` | 15 728 640 | 1 | FR-006 |
| `audio/mpeg` | `mp3` | `audio` | 15 728 640 | 1 | FR-006 |

**Six values. That is the entire list.** `config.app` and `validators/upload.ts` share one constant, `ALLOWED_MEDIA`, so the API validation, the Storage rules, the client pre-check, and this table cannot drift.

```ts
// validators/upload.ts — the single source for the allow-list
export const ALLOWED_MEDIA = {
  'image/jpeg':  { kind: 'image', ext: 'jpg', maxBytes: 5_242_880,  sig: [0xFF, 0xD8, 0xFF] },
  'image/png':   { kind: 'image', ext: 'png', maxBytes: 5_242_880,  sig: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  'image/webp':  { kind: 'image', ext: 'webp', maxBytes: 5_242_880, sig: null },          // multi-part, see §5.2
  'audio/webm':  { kind: 'audio', ext: 'webm', maxBytes: 15_728_640, sig: [0x1A, 0x45, 0xDF, 0xA3] },
  'audio/mp4':   { kind: 'audio', ext: 'm4a',  maxBytes: 15_728_640, sig: null },          // multi-part, see §5.2
  'audio/mpeg':  { kind: 'audio', ext: 'mp3',  maxBytes: 15_728_640, sig: null },          // multi-part, see §5.2
} as const;
```

### 5.2 Magic-byte signatures (what the server actually checks)

The server downloads the **first 4 KiB** of the object with a range request and runs `detectMediaType(buf)`. The function returns `'image/jpeg' | 'image/png' | 'image/webp' | 'audio/webm' | 'audio/mp4' | 'audio/mpeg' | null`.

#### 5.2.1 `image/jpeg`

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0–2 | `FF D8 FF` | **SOI marker + the start of the next marker.** This is the check |

| Secondary check (best-effort) | Rule |
| --- | --- |
| Bytes 3–4 | Should be a marker prefix `FF` followed by a valid marker code: `E0` (APP0/JFIF), `E1` (APP1/Exif), `DB` (DQT), `C0`–`CF` (SOF), `FE` (COM), `C4` (DHT). Anything else ⇒ reject |
| Reject if | The buffer starts `FF D8 FF` but contains no `FF D9` (EOI) anywhere in the first 4 KiB **and** the object is smaller than 512 bytes — that is a 3-byte header pretending to be a photo |

#### 5.2.2 `image/png`

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0–7 | `89 50 4E 47 0D 0A 1A 0A` | **PNG signature.** The `0D 0A 1A 0A` tail is specifically chosen to break naive 7-bit text handling |
| 8–11 | `00 00 00 0D` | Length of the first chunk = 13 |
| 12–15 | `49 48 44 52` = `IHDR` | The first chunk **must** be IHDR (width/height/bit depth) |

| Secondary check | Rule |
| --- | --- |
| Bytes 16–23 | Big-endian width and height. Both **must** be > 0 and ≤ `MAX_IMAGE_DIMENSION` (12 000, §9.1) |
| IEND | Reject if the first 4 KiB contains neither `IEND` nor at least one `IDAT` |

#### 5.2.3 `image/webp`

WebP is a RIFF container, so the check is three-part:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0–3 | `52 49 46 46` = `RIFF` | RIFF magic |
| 4–7 | little-endian uint32 | File size minus 8 |
| 8–11 | `57 45 42 50` = `WEBP` | The WebP form type |
| 12–15 | subformat | `57 50 38 20` = `VP8 ` (lossy) · `57 50 38 4C` = `VP8L` (lossless) · `57 50 38 58` = `VP8X` (extended/animated) |

| Secondary check | Rule |
| --- | --- |
| Reject | `VP8X` **with** the `ANIM`/`ANMF` chunk present — animated WebP is unbounded CPU to decode and pointless as emergency evidence. `DECISION REQUIRED` (D-2 below) |
| Reject | `RIFF` + a non-`WEBP` form type (`WAVE`, `AVI `) — this is the check that stops a renamed WAV |
| Reject | Any subformat not in the three above |

#### 5.2.4 `audio/webm` (Matroska/WebM — Opus)

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0–3 | `1A 45 DF A3` | **EBML header.** This is the check |
| 4–6 | `01 …` | EBML version (must be `01`) |
| DocType | search 4 KiB for `42 82` (`webm`) | Must be the `webm` DocType. Matroska (`matroska`) is **rejected** — a broader container is a broader surface |

**Distinguishing audio-only WebM from video WebM.** Both start with the same four bytes, so the header alone is not enough. The scan looks for track four-character codes in the first 4 KiB:

| FourCC found | Interpretation | Action |
| --- | --- | --- |
| `A_OPUS` and/or `A_VORBIS` | has audio | accept, **provided** no `V_` code is present |
| `V_VP8`, `V_VP9`, `V_AV1` **and** no `A_` code | video-only | **reject** — `415 UNSUPPORTED_MEDIA_TYPE` |
| `V_…` **and** `A_…` | muxed audio+video | **reject** — the video track is out of scope (FR "video evidence" excluded) |
| neither found in the first 4 KiB | inconclusive | **reject**, `415` — we do not guess |

> **Honest limitation, stated plainly.** In a real WebM file the `Segment`/`Tracks` elements frequently sit **beyond 4 KiB**, especially for a 120-second Opus recording. A legitimate `audio/webm` upload can therefore be rejected by this check. The mitigations, in order: (a) increase the sniff window to 64 KiB for the `audio/webm` case specifically — a range request of 64 KiB is still trivial; (b) if the fourCC scan is still inconclusive, accept the object as `audio/webm` **but** set `scanStatus: 'pending'` and record `sniffInconclusive: true` in the `MediaRef` metadata so a human can look. **Choosing between (a) and (b) is `DECISION REQUIRED` (D-3 below).** The current documented default is (a) with a 64 KiB window, because "reject a valid 90-second voice note" is a worse failure for this product than "accept a video-only WebM and let `<audio>` fail to play it".

#### 5.2.5 `audio/mp4` (M4A — ISO base media, AAC)

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 4–7 | `66 74 79 70` = `ftyp` | ISO-BMFF `ftyp` box. **The `ftyp` is at offset 4, not 0** — the first box is usually a `free` or `moov`/`mdat` box |
| 8–11 | major brand | Audio brands to accept: `4D 34 41 20` = `M4A `, `4D 34 42 20` = `M4B `, `6D 70 34 32` = `mp42`, `6D 70 34 31` = `mp41`, `69 73 6F 6D` = `isom`, `69 73 6F 32` = `iso2`, `69 73 6F 36` = `iso6` |
| 12–… | minor version + compatible brands | Best-effort consistency check only |

| Reject | Video brands and containers: `69 73 6F 34`/`69 73 6F 35` used with an `avc1`/`hvc1`/`hev1` compatible brand, `61 76 63 31` = `avc1`, `6D 70 34 34` = `mp44` with video, `33 67 70 34` = `3gp4`, `33 67 70 35` = `3gp5`, `71 74 20 20` = `qt  ` |
| Reject | `ftyp` at any offset other than 4 — a `ftyp` string deeper in the file is a data coincidence, not a container header |

> **Honest limitation, stated plainly.** Distinguishing an audio-only M4A from an MP4 video requires reading the `moov/trak/mdia/hdlr` box to find the handler type (`soun` vs `vide`). For a 15 MB file the `moov` atom is very often at the **end**, far beyond any sniff window. So for `audio/mp4` we can only assert "this is an ISO-BMFF file of an accepted brand". The residual risk is a client that declares `audio/mp4` and uploads a video file. Mitigations: the client only ever produces `audio/mp4` from `MediaRecorder` (§10.1), the file is served with `Content-Type: audio/mp4` from a different origin with `nosniff`, and it is rendered only through `<audio controls>`. A `<video>` payload served as `audio/mp4` plays nothing and executes nothing. `DECISION REQUIRED` (D-4): whether to accept this residual risk or to require a server-side `moov` read (which needs a range read at the tail, not just the head).

#### 5.2.6 `audio/mpeg` (MP3)

Two accepted shapes:

| Shape | Offset | Bytes | Note |
| --- | --- | --- | --- |
| ID3v2 tag | 0–2 | `49 44 33` = `ID3` | The 4th byte is the major version (`03`/`04`), the 5th the revision, the 6th the flags, and bytes 6–9 a syncsafe size. A syncsafe size whose high bits are set is invalid ⇒ reject |
| Raw MPEG audio frame | 0–1 | `FF Ex` or `FF Fx` where the second byte's top 3 bits are `111` | Layer bits must indicate Layer III (`FF FB`, `FF F3`, `FF F2`, `FF E3`, `FF E2`…) |

| Secondary check | Rule |
| --- | --- |
| Frame length | Derive it from the frame header's bitrate/samplerate fields and require the **first frame to end at or after offset 4** — a 2-byte file claiming to be an MP3 is rejected |
| Reject | `FF FF` — the classic marker of a JPEG whose first two bytes were shifted; a strong polyglot signal |
| Reject | A file that matches an ID3v2 header **and** has a zero declared size **and** is under 1 KiB |

#### 5.2.7 The verification function

```ts
// services/uploads/sniff.ts
export type Detected = { contentType: string; kind: 'image' | 'audio'; confidence: 'exact' | 'inconclusive' } | null;

export function detectMediaType(buf: Buffer, sniffLen = 4096): Detected {
  if (starts(buf, [0xFF, 0xD8, 0xFF]) && validJpegMarkerFollows(buf))      return { contentType: 'image/jpeg',  kind: 'image', confidence: 'exact' };
  if (starts(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) && chunk(buf, 12) === 'IHDR') {
    const { width, height } = pngDimensions(buf);
    if (width > 0 && height > 0 && width <= 12_000 && height <= 12_000)  return { contentType: 'image/png',   kind: 'image', confidence: 'exact' };
    return null;                                                        // out of dimension caps → reject
  }
  if (starts(buf, ascii('RIFF')) && chunk(buf, 8) === 'WEBP') {
    const sub = chunk(buf, 12);
    if (!['VP8 ', 'VP8L', 'VP8X'].includes(sub)) return null;
    if (sub === 'VP8X' && find(buf, ascii('ANIM')) !== -1) return null;    // animated WebP rejected
    return { contentType: 'image/webp', kind: 'image', confidence: 'exact' };
  }
  if (starts(buf, [0x1A, 0x45, 0xDF, 0xA3]) && docType(buf) === 'webm') {
    const fourccs = findFourCC(buf, 64 * 1024);
    if (fourccs.some(c => c.startsWith('V_'))) return null;                // any video track → reject
    if (fourccs.some(c => c.startsWith('A_'))) return { contentType: 'audio/webm', kind: 'audio', confidence: 'exact' };
    return { contentType: 'audio/webm', kind: 'audio', confidence: 'inconclusive' };
  }
  if (chunk(buf, 4) === 'ftyp' && AUDIO_BRANDS.has(chunk(buf, 8)))       return { contentType: 'audio/mp4',  kind: 'audio', confidence: 'exact' };
  if (chunk(buf, 4) === 'ftyp' && VIDEO_BRANDS.has(chunk(buf, 8)))       return null;
  if (starts(buf, ascii('ID3')) && validId3(buf))                        return { contentType: 'audio/mpeg', kind: 'audio', confidence: 'exact' };
  if (starts(buf, [0xFF]) && (buf[1] & 0xE0) === 0xE0 && mpegFrameLength(buf, 0) > 0)
                                                                            return { contentType: 'audio/mpeg', kind: 'audio', confidence: 'exact' };
  return null;                                                             // anything else → 415
}
```

### 5.3 Comparison rules

| Rule | Implementation | Error |
| --- | --- | --- |
| The **sniffed** type wins | `MediaRef.contentType = detected.contentType`. The declared type is never stored | — |
| Declared ≠ sniffed ⇒ hard failure | The media item is **dropped** from the report, not silently accepted | `415 UPLOAD_SIGNATURE_MISMATCH` |
| Sniffed is not in the allow-list ⇒ hard failure | — | `415 UNSUPPORTED_MEDIA_TYPE` |
| Sniffed `image/*` but declared `audio` (or vice versa) | `kind` is taken from the sniffed type, not the request | `415 UPLOAD_SIGNATURE_MISMATCH` |
| Every media item dropped **and** no valid text ⇒ whole request fails | — | `422 EMPTY_REPORT` (FR-002) |
| Some items dropped, text present | Incident is created with the surviving evidence; the response reports the drops | `200`/`201` with `meta.droppedMedia` |
| Executable/archive signature detected | Moved to `quarantine/` and never attached | `422 UPLOAD_QUARANTINED` |
| `confidence: 'inconclusive'` | Accepted, but `scanStatus: 'pending'` and `sniffInconclusive: true` is recorded, so a human can look before the dispatcher relies on it | — |

### 5.4 What a magic-byte match does and does not prove — the honest statement

> **A magic-byte match is necessary but not sufficient. It proves that the first few bytes of the object are consistent with a container of that type. It does not prove that the object is a valid, safe, complete, or only-that-type file.**

| A match proves | A match does **not** prove |
| --- | --- |
| The file is not a Windows PE, ELF, Mach-O, shebang script, ZIP, RAR, 7z, or gzip archive at offset 0 | That the file is a *complete* image — a truncated JPEG with a valid SOI passes |
| The file is unlikely to be an HTML or SVG document served as an image | That the file contains **only** image data. **Polyglots are real**: a GIF/JPEG/PNG can legally carry trailing application data, and a valid JPEG header followed by an HTML payload passes this check |
| The declared `contentType` is not a deliberate lie about the container | That the image is not a decompression bomb (§8.4) — a 5 MB PNG can be 60 000 × 60 000 pixels |
| The file will not be *sniffed* by a browser as HTML, given `nosniff` | That the image content is benign in any other sense |

**Why the residual polyglot risk is acceptable here, specifically:**

1. The file is served from `firebasestorage.googleapis.com`, **not** from our origin. An HTML payload in an object on that origin is a same-origin problem for Google, not for us, and Google serves it with its own content type.
2. It is served with the **sniffed** `Content-Type` (`image/jpeg`) plus `X-Content-Type-Options: nosniff`, so a browser will not re-interpret it as HTML.
3. It is rendered through `<img src="…">`, which does not execute script, does not load external subresources, and does not run `javascript:` URLs. There is no `<object>`, `<embed>`, or `<iframe>` pointing at media anywhere in the product.
4. Downloads go through `GET /api/incidents/:id/export` (CSV) or a direct signed URL with `Content-Disposition: attachment` for the raw object. Neither is rendered as HTML in our origin.
5. SVG and HTML are not in the allow-list at all (§6), which removes the two formats where a script payload would actually execute.

**What would close it properly:** a real decoder that re-encodes the image (`sharp`, or Cloud Run + libvips), which by construction emits only pixel data. `sharp` is **deliberately absent** from the stack ([09](./09_AI_GEMINI_SPECIFICATION.md) §4.2, and [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §6). Recorded as residual risk RR-10 in [10](./10_AUTHORIZATION_SECURITY.md) §22.

---

## 6. Rejected types, with reasons

Each row is a **server-side** refusal, not just a client-side file-picker filter. A modified client gains nothing.

| Type | Decision | Reason | Error code |
| --- | --- | --- | --- |
| **`image/svg+xml`, `.svg`** | **REJECT** | **The single most important decision in this document.** SVG is an XML document that can contain `<script>`, `onload=`, `<foreignObject>`, external `<image href>`, and CSS `@import`. Serving it from a signed URL on a Storage origin and rendering it in any way that is not a strict sandbox is a stored-XSS vector. There is no sanitiser in the stack and no legitimate need for vector evidence in an emergency report | `415 UNSUPPORTED_MEDIA_TYPE` |
| **`.html`, `.htm`, `.xhtml`, `.xml`** | **REJECT** | Same class as SVG, plus XML external-entity (XXE) risk if anything ever parses it. Nothing in CareGrid AI renders user HTML | `415 UNSUPPORTED_MEDIA_TYPE` |
| **`image/gif` (incl. animated)** | **REJECT** | Decompression ratio is attacker-controlled and unbounded: a 5 MB GIF can be 100 000×100 000 logical pixels. Decoding it in a browser or a model pipeline is a cheap DoS. Emergency evidence has no use for animation | `415 UNSUPPORTED_MEDIA_TYPE` |
| **`image/heic`, `image/heif`, `.heic`** | **REJECT — `DECISION REQUIRED` (D-5)** | iPhones produce HEIC by default, so rejecting it is a *usability* cost, not a security win. The reason for rejection is decoder inconsistency: support across Chromium, Safari, `<img>`, and Gemini's image pipeline differs, and a format that decodes differently in different places is a format where "is this file safe?" has no single answer. The security argument is *consistency*, not danger | `415 UNSUPPORTED_MEDIA_TYPE` until decided |
| **`image/bmp`**, **`image/tiff`** | **REJECT** | Uncompressed or lightly compressed; 5 MB of BMP is a 1000×1000 image at best, so the size limit buys no safety. TIFF is a sprawling container with many optional compression and metadata schemes — a large, poorly-specified attack surface for zero product value | `415 UNSUPPORTED_MEDIA_TYPE` |
| **`application/pdf`** | **REJECT** | Needs a viewer; the PDF parser is historically the single most exploited file format in browsers and in native code; embedded JavaScript, embedded launch actions, and external references all exist. No requirement in the PRD needs it | `415 UNSUPPORTED_MEDIA_TYPE` |
| **`.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.bz2`, `.xz`** | **REJECT** | Archives are the delivery vehicle for everything on this list. "A zip that contains a polyglot" and "a zip bomb" and "a zip with a path-traversal entry" are all one class of risk, and we have no reason to accept an archive | `422 UPLOAD_QUARANTINED` — the signature is recognisable, so it goes to quarantine rather than a plain 415 |
| **Windows PE, ELF, Mach-O, shebang scripts, `.exe`, `.dll`, `.sh`, `.bat`, `.ps1`, `.apk`, `.dmg`** | **REJECT + quarantine** | The MZ/`\x7FELF`/`#!`/`\xCF\xFA\xED\xFE` signatures are unambiguous. There is no legitimate reason for one to arrive on an incident-report form | `422 UPLOAD_QUARANTINED` |
| **Video: `video/mp4`, `video/webm`, `video/quicktime`, `video/*`** | **REJECT** | FR scope excludes video. Also the largest single cost and DoS risk in the media pipeline | `415 UNSUPPORTED_MEDIA_TYPE` |
| **M4A AAC variants outside the brand set** (e.g. `3gp4`, `mp44` with video, `qt  `) | **REJECT** | §5.2.5 brand set | `415 UNSUPPORTED_MEDIA_TYPE` |
| **Other audio: `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/flac`, `audio/aac`, `audio/opus`** | **REJECT** | WAV is 44.1 kHz/16-bit/stereo = ~1.4 MB per 10 s, so the 15 MB cap would allow ~110 s of *huge* PCM for no benefit. FLAC is lossless for no benefit. `audio/ogg` matters: **Firefox's `MediaRecorder` prefers `audio/ogg;codecs=opus`**, so Firefox would fall back to `audio/webm` per §10.1 — a real constraint, not a theoretical one | `415 UNSUPPORTED_MEDIA_TYPE` |
| **Zero-byte objects** | **REJECT** | `409 UPLOAD_INCOMPLETE` in `POST /api/uploads/finalize`; `422 EMPTY_REPORT` at incident creation if it is the only evidence | as stated |
| **Anything over the size cap** | **REJECT** | `413 UPLOAD_TOO_LARGE` | `413` |
| **Mismatched extension** (a `.png` that sniffs as JPEG) | **ACCEPT, but the extension is corrected** | The **path** extension is derived from the sniffed type, so a mislabelled file lands as `.jpg`. No failure. This is the friendly and correct behaviour, and it is also why §3.1's regex cannot be used to infer the type | — |
| **Forged `contentType` in the request body** | **REJECT the media item** | `415 UPLOAD_SIGNATURE_MISMATCH` when declared ≠ sniffed. The declared type is never persisted | `415` |

> **A note on "what about `.txt`?"** A plain text file is harmless, and a citizen might reasonably try to attach a note. It is still **rejected**, because it is not in the allow-list and adding a text type opens `text/plain`-vs-`text/html` sniffing questions for no product benefit. The report body is where text goes (FR-003, FR-012), and a text correction is a *new report* of `kind: 'correction'`, never a file.

---

## 7. Size and count limits

### 7.1 Limits table

| Limit | Value | Enforced in | Error |
| --- | --- | --- | --- |
| Max images per report | **3** | `validators/incident.ts` (`media.max(3)` + a per-kind count) | `400 VALIDATION_FAILED` |
| Max audio clips per report | **1** | same | `400` |
| **Max total media items** | **3** | `media.max(3)` | `400` |
| Max image size | **5 242 880** (5 MiB) | `UPLOAD_MAX_IMAGE_BYTES`; `POST /api/uploads/sign`; Storage rules `withinSize()`; the signed URL's declared `maxSizeBytes` | `413 UPLOAD_TOO_LARGE` |
| Max audio size | **15 728 640** (15 MiB) | `UPLOAD_MAX_AUDIO_BYTES`; same three places | `413` |
| Max audio duration | **120 s** | `durationSec` in the sign request; the client auto-stops the recorder | `400 VALIDATION_FAILED` |
| Max image dimensions | **12 000 × 12 000** px, and ≤ 40 MP | §9.1, checked in the PNG/WEBP sniff | `415` / `400` |
| Total `POST /api/incidents` JSON body | ~64 KiB (it carries only metadata; **no bytes**) | Next.js body limit is irrelevant here — that is the point of DEC-08 | `413` from the platform if abused |
| Total inline AI payload | ~15 MB after dropping | [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 step 3 — images are dropped in reverse order until the base64 budget fits, and `mediaDropped` is recorded | never fails the request |
| Signed URL TTL | **900 s** | `UPLOAD_SIGNED_URL_TTL_SEC` | — |
| Staging object lifetime | **30 min** unclaimed | `STAGING_UPLOAD_SWEEP_MIN` + `sweep-staging-uploads` | — |
| Signed-URL sign requests | **30 / hour / uid** | `POST /api/uploads/sign` rate limit | `429 RATE_LIMIT_EXCEEDED` |
| Signed read-URL requests | **120 / min / uid** | `GET /api/uploads/:mediaId/url` rate limit | `429` |

### 7.2 The 5 MB image vs the 4.5 MB Vercel body limit

This is worth stating as a number, because it is the reason the entire architecture looks the way it does.

```
Vercel serverless function request body limit   : 4 194 304 bytes (4 MiB)  [commonly quoted as 4.5 MB]
FR-005 maximum single image                     : 5 242 880 bytes (5 MiB)
FR-006 maximum single audio clip                : 15 728 640 bytes (15 MiB)
Base64 inflation factor                        : × 1.37

A single allowed image, base64-encoded into a JSON body : 5 242 880 × 1.37 = 7 182 745 bytes
                                                          └── 1.7× OVER the platform limit

A single allowed audio clip, base64-encoded               : 15 728 640 × 1.37 = 21 548 237 bytes
                                                          └── 4.8× OVER the platform limit
```

Therefore, for the **largest allowed file in the product**, no function-proxied upload can exist. The upload **must** go browser → Storage directly, and the only thing the function does is mint a signed URL. This is DEC-08, and it is the reason `sharp`-based server-side validation is also impossible without a different runtime.

---

## 8. The complete validation chain

Seven steps. Each step is a place where a bad file is stopped, and the table in §8.2 says what happens at each.

### 8.1 The chain

```
STEP 1  CLIENT PRE-CHECK                             (features/reporting — UX only, NOT a control)
        - type in ALLOWED_MEDIA for the kind
        - size <= UPLOAD_MAX_* (via env, public subset)
        - image dimension caps from a locally-decoded naturalWidth/naturalHeight
        - audio: MediaRecorder auto-stops at 120 s; duration read back and checked
        - image: re-drawn to a <canvas> to strip EXIF (§9.2) and downscale if > 1600 px
        → immediate, friendly, per-file error; no network

STEP 2  SIGNED URL ISSUANCE                          POST /api/uploads/sign
        requireUser() → assertRole(all four) → assertSameOrigin → rateLimit(30/h)
        → Zod: kind, contentType ∈ ALLOWED_MEDIA[kind], sizeBytes ≤ cap, durationSec ≤ 120,
                clientWidth/clientHeight 1..12000, intent === 'report'
        → server GENERATES mediaId and the path staging/{token.uid}/{mediaId}.{ext}
        → returns { mediaId, storagePath, token, uploadUrl, expiresAt, maxSizeBytes,
                    requiredContentType }
        → 30-minute claim stored at users/{uid}/uploadClaims/{mediaId}; Firestore TTL removes expired claims
        → the client contributes NOTHING to the path or the filename

STEP 3  DIRECT PUT                                  browser → firebasestorage.googleapis.com
        Content-Type: exactly requiredContentType
        body: the raw file bytes
        - Storage evaluates storage.rules: mine(uid) && mediaIdOk() && withinSize() && extMatches()
        - the V4 signature binds the path, the method (PUT), the content type, and the expiry
        → on any failure the client retries once, then surfaces "Upload failed — try again"

STEP 4  FINALIZE                                    POST /api/uploads/finalize { mediaId }
        requireUser() → assertResourceAccess(media: owner of the staging path)
        → server reads the bounded image (≤ 5 MiB) to parse its dimensions; audio reads the configured sniff window
        → detectMediaType() (§5.2.7)
        → declared vs sniffed mismatch      ⇒ 415 UPLOAD_SIGNATURE_MISMATCH
        → not in the allow-list             ⇒ 415 UNSUPPORTED_MEDIA_TYPE
        → executable / archive signature     ⇒ move to quarantine/ + 422 UPLOAD_QUARANTINED
        → size 0, or > 1 % off the declared size ⇒ 409 UPLOAD_INCOMPLETE
        → computes sha256 over the full object (integrity + duplicate-upload detection)
        → returns { mediaId, kind, verifiedContentType, actualSizeBytes, sha256,
                    scanStatus: 'clean', width, height, durationSec }
        → OPTIONAL: POST /api/incidents works without it; finalize only gives faster failure

STEP 5  INCIDENT CREATION                           POST /api/incidents
        requireUser() → assertSameOrigin → rateLimit(5/h, 20/day) → Zod(media[] paths)
        → for each media item: validateMediaPath() (§3.4) against the caller's own uid
        → RE-SNIFF in the request handler (the authoritative check; finalize was only a fast-fail)
        → compute the final path incidents/{newId}/reports/{reportId}/{mediaId}.{ext}
        → copy staging → final, then delete staging
        → only then does the transaction persist the MediaRef with the sniffed contentType
        → audit incident.create

STEP 6  MOVE TO THE FINAL PATH                      Admin SDK
        bucket.file(staging).copy(bucket.file(final));  bucket.file(staging).delete()
        - copy-then-delete, never a rename (§3.3)
        - the client has no permission on incidents/** at all

STEP 7  SERVING                                     GET /api/uploads/:mediaId/url  or  GET /api/incidents/:id
        requireUser() → assertRole → assertResourceAccess(media, §13)
        → scanStatus must be 'clean'  ⇒ else 422 MEDIA_NOT_VERIFIED
        → 15-minute signed GET URL (§12)
```

### 8.2 What happens at each failure

| Step | Failure | Detected by | Response | What the user sees | Cleanup |
| --- | --- | --- | --- | --- | --- |
| 1 | Wrong type / too large / too long | Client `File` + `HTMLMediaElement` metadata | Nothing sent | "Photos must be JPG, PNG or WebP and under 5 MB" | n/a |
| 1 | EXIF strip / downscale fails (e.g. a tainted canvas) | The catch around `canvas.toBlob` | The **original** is sent, with `exifStripped: false` in the sign request | No error — reporting must not fail over metadata | — |
| 2 | `contentType` not in the allow-list | Zod | `415 UNSUPPORTED_MEDIA_TYPE` | "That file type isn't supported" | Nothing created |
| 2 | Over the size cap | Zod | `413 UPLOAD_TOO_LARGE` | "Photos must be under 5 MB" | Nothing created |
| 2 | `intent !== 'report'` | Zod `.strict()` | `400 VALIDATION_FAILED` | — | Nothing created |
| 2 | Rate limit | Token bucket | `429 RATE_LIMIT_EXCEEDED` + `Retry-After` | "Too many uploads, try again shortly" | Nothing created |
| 2 | Storage unreachable | Admin SDK | `503 STORAGE_UNAVAILABLE` | "Upload is temporarily unavailable — your text is safe" | Nothing created |
| 3 | Wrong `Content-Type` on the PUT | Storage (signature binding) | `403` from Storage | "Upload failed" | Nothing stored |
| 3 | Over `maxSizeBytes` | Storage | `400` from Storage | "Upload failed — file too large" | Partial object is not created |
| 3 | Cross-user path (modified client) | `storage.rules` `mine(uid)` | `PERMISSION_DENIED` | "Upload failed" | Nothing stored |
| 3 | Wrong extension for the content type | `extMatches()` | `PERMISSION_DENIED` | "Upload failed" | Nothing stored |
| 3 | Network drop mid-upload | Client fetch | Client retries **once**, then reports failure | "Upload interrupted — tap to retry" | A partial object may remain; the size check in step 4 catches it and the sweeper removes it |
| 4 | Object does not exist | Admin SDK | `404 MEDIA_NOT_FOUND` | "That upload did not complete" | — |
| 4 | 0 bytes | Size check | `409 UPLOAD_INCOMPLETE` | "That upload did not complete" | Delete the object |
| 4 | Size differs > 1 % from declared | Size check | `409 UPLOAD_INCOMPLETE` | "That upload did not complete" | Delete the object |
| 4 | Declared ≠ sniffed | `detectMediaType` | `415 UPLOAD_SIGNATURE_MISMATCH` | "That file's contents don't match its type" | Delete the object |
| 4 | Sniffed type not allowed | Allow-list | `415 UNSUPPORTED_MEDIA_TYPE` | "That file type isn't supported" | Delete the object |
| 4 | Executable/archive signature | Signature table | `422 UPLOAD_QUARANTINED` | "That file type isn't accepted" | **Move to `quarantine/`**, set `scanStatus: 'quarantined'`, audit |
| 5 | Path not the caller's own staging path | `validateMediaPath` | `403 UPLOAD_FORBIDDEN_PATH` | "That upload isn't yours" | Leave the object; the sweeper removes it |
| 5 | Path not issued to this uid | The 30-minute claim record | `403 UPLOAD_FORBIDDEN_PATH` | "That upload isn't yours" | Leave the object |
| 5 | Re-sniff disagrees with step 4 | `detectMediaType` (2nd pass) | `415 UPLOAD_SIGNATURE_MISMATCH` | "That file's contents don't match its type" | Delete the object |
| 5 | All media dropped, no valid text | FR-002 | `422 EMPTY_REPORT` | "Tell us a little more, or add a photo" | Objects deleted |
| 5 | Some media dropped, text present | — | `201` with `meta.droppedMedia: ["med_c3"]` | Report submitted, with the failed photo shown as failed | Dropped objects deleted |
| 6 | Storage unavailable during the move | Admin SDK | `503 STORAGE_UNAVAILABLE`; if valid text exists, the incident is created without that media and `evidenceCount` is accurate | "Report submitted; the photo could not be attached" | The staging object remains and the sweeper removes it in ≤ 30 min |
| 7 | `scanStatus !== 'clean'` | `assertResourceAccess` | `422 MEDIA_NOT_VERIFIED` | "This file is not available yet" | — |
| 7 | Caller may not see it | `assertResourceAccess` | `404 MEDIA_NOT_FOUND` (byte-identical to a genuine miss) | "File not found" | — |

**Design note.** Steps 4 and 5 both sniff. This is deliberate redundancy, not an oversight: `POST /api/uploads/finalize` is **optional**, so step 5 cannot assume it ran; and a TOCTOU window exists between step 4 and step 5 in which the object could be replaced (a signed URL stays valid for 900 s). Re-sniffing inside the request that actually creates the incident is the control that closes it. Recorded as [24](./24_THREAT_MODEL_SECURITY.md) T-45.

---

## 9. Image specifics

### 9.1 Dimension caps

| Cap | Value | Enforced in | Why |
| --- | --- | --- | --- |
| Max width / height | **12 000 px** each | Client `createImageBitmap`; server PNG `IHDR`, JPEG `SOF`, or WebP `VP8`/`VP8L`/`VP8X` parse; declared dimensions are only an early sign-time check | A 12 000 × 12 000 image is 144 MP; decoding it to 4 bytes/px is 576 MB in a browser tab and will crash a mid-range phone |
| Max total pixels | **40 MP** | same | Aspect-ratio-independent bound |
| Client pre-downscale | Long edge → **1 600 px** if the original is larger; JPEG q0.85 | `features/reporting`, §9.2 | A citizen's evidence does not need 12 MP for a dispatcher to see a car crash. This also keeps the AI inline budget small |
| AI inline budget | ≤ 1 024 px long edge, and only re-encoded if > 1.5 MB | [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 step 2 — **a `sharp`-free decision**, so in practice the original is passed and the token limit is relied on | — |

### 9.2 EXIF handling — the honest position

**The stack contains no `sharp` and no image library.** [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 makes this an explicit, documented decision for the MVP. The consequence is precise:

> **We cannot strip EXIF server-side, because we cannot re-encode the image server-side. Anything the client does not remove stays in the stored object.**

| Metadata class | Example | Risk if retained |
| --- | --- | --- |
| **GPS EXIF** | `GPSLatitude`, `GPSLongitude`, `GPSAltitude` | **A precise home or workplace location, permanently attached to an "emergency" photo, downloadable by a dispatcher and readable by anyone who obtains the object.** A citizen photographing a fire at their home has published their address to every future dispatcher |
| Device serial / body serial | `BodySerialNumber`, `LensSerialNumber`, `InternalSerialNumber` | Unique device fingerprint |
| Timestamp | `DateTimeOriginal` | Useful for the investigation; low risk |
| Camera/EXIF software | `Make`, `Model`, `Software` | Low risk; occasionally genuinely useful |
| Thumbnails | Embedded `JPEGThumbnail` | A second, pre-transform copy of the image — including **its own** EXIF |

#### The mitigation, and why it is described as "untrusted-but-useful"

```ts
// features/reporting/strip-exif.ts  (client, before upload)
export async function normalizeImage(file: File): Promise<{ blob: Blob; exifStripped: boolean; width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file);                 // decodes; EXIF orientation is applied by the browser
    const scale  = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width  * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, w, h);

    // toBlob on a canvas produces a bitmap-only file. There is nowhere for EXIF to survive,
    // because the canvas never carried it.
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('toBlob returned null');
    return { blob, exifStripped: true, width: w, height: h };
  } catch {
    // Untrusted-but-useful: if normalisation fails we still send the original.
    // Refusing to report an emergency because of a metadata quirk is the wrong trade.
    return { blob: file, exifStripped: false, width: 0, height: 0 };
  }
}
```

| Property | Value |
| --- | --- |
| Mechanism | Re-draw to a `<canvas>` and re-encode with `canvas.toBlob()`. The canvas pixel buffer has no metadata channel, so **all** EXIF — including GPS — is dropped as a side effect, not by filtering |
| Applies to | JPEG and PNG (both re-encoded to `image/jpeg`). **WebP**: `toBlob` cannot emit WebP on all browsers, so a WebP source is either converted to JPEG or sent unmodified with `exifStripped: false` |
| Flag | `exifStripped` is sent in the sign request and recorded in the `MediaRef` metadata, so an admin can see which objects *might* carry EXIF |
| **Trust** | **Untrusted.** A modified client skips the function entirely. The flag is a client assertion and proves nothing |
| Failure mode | If the canvas is tainted (it will not be — no cross-origin image is drawn) or the context is unavailable, the original is sent and the flag is `false` |

#### What actually mitigates the residual EXIF, given the client step is not a control

| Control | Effect |
| --- | --- |
| Stored EXIF is **never surfaced in any UI** | No map marker, no panel, no export, and no analytics field ever reads EXIF. The object is served as an opaque blob |
| Download entitlement is already narrow | Only `dispatcher`/`admin` (full), the **assigned responder** (evidence, not reporter identity), and the **reporter** (own evidence) can download. A third party never gets the object. [24](./24_THREAT_MODEL_SECURITY.md) T-29 |
| Retention bounds the exposure | Evidence on an open incident is retained for the incident's life; soft-deleted media moves to `quarantine/` and is purged after 30 days (§14) |
| An admin can see the risk | `GET /api/admin/system/health` can report the count of `MediaRef`s where `exifStripped !== true`, so the exposure is measurable |
| Server-side strip would close it | Requires `sharp` (a native dependency, disallowed in v1) or a Cloud Run function with libvips. **Neither is available at $0 with zero config** — actually Cloud Run has a free tier, but it adds a deploy unit, a cold start in the report path, and a new failure mode. `DECISION REQUIRED` (D-6) |

> **`DECISION REQUIRED` (D-6):** Is location-bearing EXIF acceptable to retain on evidence at all? The options are (a) retain, documented, visible in the admin health count — status quo; (b) add `sharp` and strip server-side, accepting a native dependency; (c) add a Cloud Run re-encode step, accepting a second deploy unit and a cold start on the report path; (d) refuse to store any client-supplied image, which destroys FR-005. **This is a privacy judgement about citizen safety, not a technical one, and it is not the engineer's call.**

---

## 10. Audio specifics

### 10.1 `MediaRecorder` MIME negotiation

`MediaRecorder` support and container support are both inconsistent across browsers. The client negotiates in this exact order and takes the first supported value.

```ts
// features/reporting/audio-capture.ts
const CANDIDATES: { mime: string; ext: string; label: string }[] = [
  { mime: 'audio/webm;codecs=opus',   ext: 'webm', label: 'WebM / Opus' },  // Chromium, Edge, Firefox
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a', label: 'MP4 / AAC-LC' }, // Safari 14.1+ on iOS and macOS
  { mime: 'audio/mp4',               ext: 'm4a', label: 'MP4 / AAC' },     // Safari, some Chromium builds
];

export function pickAudioMime(): typeof CANDIDATES[number] | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(c.mime)) return c;
  }
  return null;   // the UI hides the record button and shows a text alternative (US-003 AC3)
}
```

| Browser | Selected | Why |
| --- | --- | --- |
| Chrome / Edge (desktop + Android) | `audio/webm;codecs=opus` | Native container for Opus. ~6.4 kbps mono speech at a low quality setting, so 120 s is well under 1 MB |
| Firefox | `audio/webm;codecs=opus` | Firefox supports WebM/Opus. It also supports `audio/ogg;codecs=opus` and may *prefer* it — that is fine, we never request Ogg, and if WebM is unavailable the record button hides rather than producing a file we would reject |
| Safari (macOS, iOS 14.1+) | `audio/mp4;codecs=mp4a.40.2` | **Safari does not support `MediaRecorder` with WebM.** It emits ISO-BMFF with AAC-LC. The bare `audio/mp4` is the fallback because the codec string varies by Safari version |
| Older Safari (< 14.1) | `null` | No `MediaRecorder`. The voice option is hidden and a clear text alternative is shown (US-003 AC3) |
| Any browser with `isTypeSupported` missing | `null` | Feature-detect, do not guess |

> **The design consequence of Safari's container:** an iPhone citizen produces `audio/mp4`, and our `audio/mp4` verification can only assert "ISO-BMFF of an accepted brand", not "audio-only" (§5.2.5). We accept that residual risk (`DECISION REQUIRED` D-4) because the alternative — refusing iPhone voice reports — is a far worse outcome for this product.

### 10.2 Recording constraints

| Constraint | Value | Enforcement |
| --- | --- | --- |
| Max duration | **120 s** | `setTimeout(stopRecording, 120_000)` in the client, plus a visible countdown; the UI shows "Recording will stop at 2:00" (US-003 AC2) |
| Manual stop | Always available, and does not lose the text or the images (US-003 AC1) | The recorder lives in component state, not in a route transition |
| Minimum duration | **1 s** | Below 1 s the clip is discarded with "Recording too short" |
| Elapsed time display | Live, `aria-live="polite"` | Accessibility (NFR-017) |
| Button size | **≥ 56 px** | Exceeds the 44 px minimum (NFR-021) because it is pressed repeatedly in a stressful state (US-003 AC1) |
| Sample rate / bit rate | Requested where supported: `audioBitsPerSecond: 32000`, `audioConstraints: { channelCount: 1, echoCancellation: true, noiseSuppression: true }` | Keeps 120 s ≈ 480 KB, far under 15 MB |
| `durationSec` provenance | Read back from the recorded `Blob`'s duration where the browser exposes it; otherwise measured from `startTime` to `stop` on the recorder stream | Client-declared; see §10.4 |
| Retry | A failed recording never clears the text or the photos (US-002 AC4) | State model keeps them separate |

### 10.3 Duration enforcement — the honest gap

> **The server cannot verify audio duration without decoding the container. We do not have `ffprobe` and we are not going to add it.**

| Layer | Enforces 120 s? | How |
| --- | --- | --- |
| Client recorder | **Yes** | Auto-stop timer; the user cannot exceed it through the UI |
| Client post-capture | **Yes** | `blob` duration is checked; over-length is re-encoded or rejected with a clear message |
| `POST /api/uploads/sign` | **Partly** | `durationSec` is validated to be in `[0, 120]`. It is a **client-declared** number |
| Storage rules | **No** | Rules can check `size`, never duration |
| `POST /api/uploads/finalize` | **No** | It can read the size and the container header; parsing the Opus/MPEG frame table to sum durations is a real parser, and a partial one is worse than none |
| `POST /api/incidents` | **No** | Same |
| The AI call | **Effectively yes** | Gemini's input window bounds what is transcribed. A longer file is truncated by the model, and the transcript is marked `audio_transcript_uncertain: true` ([09](./09_AI_GEMINI_SPECIFICATION.md) §5.1) |
| Byte size | **A weak bound** | 15 MB at 32 kbps is ~62 minutes. Byte size is *not* a duration control |

**Consequence, stated plainly:** a modified client can attach a 15 MB, 40-minute file. It will be stored, it will cost storage, and the model will transcribe roughly the first two minutes. The blast radius is cost and a confusing UX, **not** a security or privacy failure — and the file is downloadable only by the roles already entitled to it.

**What would close it:** `ffprobe` in a Cloud Run function, invoked only on `finalize`. Free-tier Cloud Run makes this $0-capable, but it adds a deploy unit and a cold start to a P1 feature. `DECISION REQUIRED` (D-7).

### 10.4 Waveform UI expectations

There is **no server-side waveform, no thumbnail, and no audio re-encode.** The UI is honest about this.

| Surface | Behaviour | Rationale |
| --- | --- | --- |
| While recording | A live level meter driven by an `AnalyserNode` on the `MediaStream` — **not** a waveform | A real-time level meter needs only the Web Audio API and costs nothing |
| While recording | A live elapsed timer, and a red dot that is animated | A pulsing/animating record indicator is a WCAG 2.1 AA consideration: it must respect `prefers-reduced-motion` (NFR-019), so the motion is on the colour/opacity of a static dot, not a scale animation |
| After capture | Duration (`0:47`) and file size, from the local `Blob`. **Playable in place** via `<audio controls src={URL.createObjectURL(blob)}>` | The object URL is **local and ephemeral**. It is revoked with `URL.revokeObjectURL` on unmount and on successful upload, so the raw clip is never left in a `blob:` URL that a screenshot or a devtools panel could capture |
| After capture | A deterministic placeholder bar (e.g. a 32-bar pseudo-waveform derived from a hash of the blob bytes) | **Visually honest:** it is a progress/identity affordance, and the UI labels it "waveform preview" only after the label "approximate" is shown. Deriving it from a hash means the same file always looks the same, so it functions as a change-detector |
| In the dispatcher/responder view | Duration + a download/signed-URL play button. The transcript is shown as text with an `uncertain` marker | Dispatchers act on the **transcript**, not on the audio, and the transcript is what [09](./09_AI_GEMINI_SPECIFICATION.md) §5.1 validates |
| `prefers-reduced-motion` | The 32 bars are static, not animated | NFR-019 |
| Offline / poor signal | The audio is attached to the report exactly like an image; the local queue replay path handles it (US-014) | — |

---

## 11. Virus and content scanning

### 11.1 The constraint

> **There is no ClamAV in this project. There is no virus scanner at all. That is a consequence of the $0, zero-config, single-deploy-unit constraint — not an oversight, and not a claim that the risk is zero.**

| Option | Cost / complexity | Verdict |
| --- | --- | --- |
| ClamAV on Cloud Functions | ~1 GB image, cold starts, deployment friction, signature-database freshness to manage | Rejected |
| Cloud Run + ClamAV + libvips | Free tier exists, but: a second deploy unit, a cold start in the report path, a new failure mode, and a new thing to page someone about at 03:00 | **The documented upgrade path**, not the v1 choice |
| Google Cloud Security Command Center / Event Threat Detection | Analyzes **GCS** activity, not Firebase Storage object contents, and is a paid product | Not applicable |
| A third-party scan API | Per-object cost; a third party receives citizen evidence | Rejected: cost and a data-disclosure problem |
| **A magic-byte allow-list + a quarantine path + no server-side rendering** | $0 | **Chosen** |

### 11.2 Compensating controls

| # | Control | Where it lives | What it actually buys |
| --- | --- | --- | --- |
| C1 | **A 6-value allow-list of container signatures** | `services/uploads/sniff.ts`, `storage.rules` `withinSize()`/`extMatches()` | Eliminates the *known-malware delivery formats* — executables, scripts, archives, HTML, SVG, PDF, Office documents. This is a large fraction of real-world malware delivery, because the formats are popular precisely because they execute or auto-render |
| C2 | **An explicit quarantine signature set** | `QUARANTINE_SIGNATURES` in `sniff.ts` | `MZ`, `\x7FELF`, `\xCF\xFA\xED\xFE`, `\xFE\xED\xFA`, `#!`, `PK\x03\x04`, `Rar!`, `7z\xBC\xAF`, `\x1F\x8B`, `%PDF`, `<svg`, `<!DOCTYPE html`, `<html` | A file matching one of these is moved to `quarantine/`, gets `scanStatus: 'quarantined'`, and returns `422 UPLOAD_QUARANTINED`. It is **never** attached to an incident |
| C3 | **No public objects** | `storage.rules`, no `getPublicUrl` anywhere | A scanner, an indexer, or a link-preview bot has nothing to fetch |
| C4 | **Nothing untrusted is rendered server-side** | There is no server-side rendering of media. No PDF rasteriser, no image transcoder, no thumbnailer, no virus scanner — nothing parses an uploaded object in a long-lived process | **This is the most important compensating control.** A parser bug is the usual way a "harmless" upload becomes RCE. We ship no parser |
| C5 | **A 900-second TTL on every URL** | `UPLOAD_SIGNED_URL_TTL_SEC` | Even a URL that leaks in a screenshot, a log, or a shared chat is dead in 15 minutes |
| C6 | **`scanStatus` on every `MediaRef`** | [07](./07_DATABASE_SCHEMA.md) §10.1 | `clean \| pending \| quarantined`. `GET /api/uploads/:mediaId/url` refuses anything that is not `clean` with `422 MEDIA_NOT_VERIFIED`. A `pending` object is invisible to a dispatcher until a human clears it |
| C7 | **`pending` is reachable in normal operation** | `detectMediaType` returning `confidence: 'inconclusive'` sets `pending` | So the "hold for review" state is a real, exercised path rather than a theoretical one |
| C8 | **An admin inspection surface** | `GET /api/admin/system/health` + the incident detail's media list | An admin can see every object with `scanStatus !== 'clean'` and its reason, and can delete it (moving it to `quarantine/`) |
| C9 | **Retention bounds** | §14 | A quarantined object is purged after 30 days. An object's useful life is measured in hours, not years |
| C10 | **Dimensions caps** | §9.1 | Removes the decompression-bomb class (§16.5) |

### 11.3 The honest residual risk

> **A file that (a) has a valid image or audio signature at offset 0, (b) passes the dimension and size caps, and (c) also carries a malicious payload in a region the container permits, will be accepted with `scanStatus: 'clean'`.**

| Residual case | Likelihood | Impact | Why it is acceptable |
| --- | --- | --- | --- |
| A valid JPEG with a trailing HTML/JS payload | Possible | **Very low** | Never rendered as HTML; served from another origin with `nosniff`; displayed only via `<img>`, which does not execute script |
| An EICAR test string inside a valid JPEG | Certain (if attempted) | **Very low** | EICAR exists to prove a scanner is installed. With no scanner it is inert. It is also a plain 68-byte ASCII string, so a `grep` for `EICAR` over downloaded objects is a **possible** compensating check, and one worth adding to the admin health job — `DECISION REQUIRED` (D-8) |
| A memory-corruption exploit in the *browser's* image decoder, triggered by our `<img>` tag | Very unlikely | Major (on that user only) | This is a browser risk, not an application risk. The same file would trigger it in any image viewer. No mitigation is available in application code |
| A malicious file that a *model provider's* decoder mishandles | Very unlikely | Major (inference) | The media is sent to Gemini inline. The provider's decoder is their security boundary. Our mitigation is the allow-list and the dimension cap, which bound the input |
| A real malware binary smuggled inside a valid image's appended data, later extracted by a human | Possible | Low | Only an entitled role can download, and downloading evidence is the intended function |

**The upgrade path, when someone has budget:** a Cloud Run function that (1) streams the object, (2) runs ClamAV with fresh signatures, and (3) re-encodes the image with libvips (which simultaneously strips EXIF, caps dimensions *after* decode, and eliminates polyglots). That one function closes C1's residual, RR-10, RR-11, RR-12, and D-6 at once. It is the single highest-value security upgrade available to this project.

---

## 12. Serving

### 12.1 Signed read URLs

```ts
// services/uploads/signed-url.ts
export async function signedReadUrl(path: string, opts: { download?: boolean } = {}): Promise<string> {
  const expiresAtMs = Date.now() + Number(process.env.UPLOAD_SIGNED_URL_TTL_SEC ?? 900) * 1000;
  const [url] = await getStorage().bucket(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!)
    .file(path)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAtMs,
      ...(opts.download ? { disposition: 'attachment' } : {}),
    });
  return url;
}
```

| Property | Value | Why |
| --- | --- | --- |
| Version | **V4** | V2 tokens are long-lived and unversioned; V4 is path-, method-, and expiry-scoped |
| Action | `read` | The write URL from `POST /api/uploads/sign` is `write` and is a **different token** for a **different verb**. A write URL cannot read and a read URL cannot write |
| TTL | **900 s** (`UPLOAD_SIGNED_URL_TTL_SEC`) | Long enough to view evidence and a transcript; short enough that a leaked URL is a non-event |
| Scope | **one object path.** No wildcards anywhere in the codebase | A prefix-scoped token would expose a whole `staging/{uid}/` directory |
| **There is no `getPublicUrl`** | Zero occurrences in the codebase; a CI grep asserts it | A public URL is permanent, unexpirable, shareable, and outside every authorization decision |
| No unauthenticated media route | `GET /api/uploads/:mediaId/url` requires a valid ID token and a resource-access check | [08](./08_API_SPECIFICATION.md) §8.3 |
| On suspension | The API refuses to issue; outstanding URLs expire within 15 minutes | The URL itself carries no revocation check — an accepted, documented consequence of the bearer-token model ([10](./10_AUTHORIZATION_SECURITY.md) §10.4) |

### 12.2 Cache-control

| Object class | Cache header | Why |
| --- | --- | --- |
| Signed read URL response | `Cache-Control: private, no-transform` + `max-age` bounded by the remaining TTL | The Storage service sets `private, max-age=<ttl>, no-transform` by default for V4 tokens. **We do not extend it and we do not add `public`.** A shared cache must never retain a citizen's evidence |
| API responses containing user data | `Cache-Control: no-store` | [08](./08_API_SPECIFICATION.md) §12.12 |
| `GET /api/incidents/:id` | `no-store` | It contains `originalText`, reporter identity, and signed URLs |
| `GET /api/resources`, `GET /api/config` | `private, max-age=300` | Static reference data |
| Staging objects | Not readable by anyone but the owner; no cache policy set | — |

### 12.3 Thumbnails

> **v1 has no thumbnail pipeline. There is no `sharp`, no Cloud Run image service, and no server-side resize.**

| Surface | Strategy | Consequence |
| --- | --- | --- |
| Incident queue row | **No image.** The row shows a category icon, urgency badge, and an evidence **count** | FR-072 lists the row fields; images are not among them. This is the right call: 50 rows × 3 thumbnails = 150 extra image requests per dispatcher page view, on a metered connection |
| Incident detail | The **original** object via a signed URL, rendered in a fixed-aspect `<div>` with CSS `object-fit: cover` and `aspect-ratio: 4/3`, with the real dimensions shown in the alt text | One request, one object, no derivative. **Bandwidth cost is the full original**, which is why §14 caps evidence counts |
| Map | **No image.** Markers only | — |
| Mobile | The same original, `width`/`height` set from the sniffed `MediaRef` so the browser reserves layout space and the page does not reflow (a reflow of a `<img>` with unknown size is a measurable LCP regression, NFR-001/NFR-002) |
| Audio | No waveform asset; the pseudo-waveform in §10.4 is computed client-side from a hash | — |

**The cost of this decision, honestly.** Without thumbnails, a dispatcher viewing 20 incidents with 3 images each downloads 60 full-size images — potentially 300 MB. On the free tier, egress is the metric most likely to be exceeded ([15](./15_FILE_STORAGE_SPECIFICATION.md) §15). The mitigations, in order of effect:

1. **The client downscales to a 1 600 px long edge and re-encodes to JPEG q0.85 before upload** (§9.2). A phone photo at 4000 × 3000 becomes roughly 200–400 KB. This single step is the reason the no-thumbnail decision is affordable, and it is why §9.2's "untrusted-but-useful" framing matters: even a client that skips the downscale still hits the 5 MB cap.
2. **≤ 3 images per report** (FR-005).
3. **`?width=` is not a thing.** No resize parameters are sent, so the browser downloads the original.
4. Lazy loading: `loading="lazy"` on every evidence `<img>` below the fold.

> **`DECISION REQUIRED` (D-9):** if image bandwidth becomes a real cost, the options in preference order are (a) raise the client downscale target from 1 600 px to 1 024 px — free, one constant, no new infrastructure; (b) generate a second, smaller "preview" object at `POST /api/uploads/finalize` time using a client-side canvas (free, but doubles the object count and the client CPU on a low-end phone); (c) add `sharp` and a server thumbnailer. **Option (a) should be tried first** and is almost certainly sufficient for a hackathon-scale demo.

---

## 13. Access control — who may download which evidence

### 13.1 The matrix

| Caller | Evidence on an incident they own | Evidence on an incident they are **assigned** to | Evidence on an in-radius unassigned incident | Evidence on any other incident | Reporter identity, with the evidence |
| --- | --- | --- | --- | --- | --- |
| **Citizen (reporter)** | ✔ own evidence | — | — | ✖ `404` | own (it is their own) |
| **Citizen (not the reporter)** | ✖ `404` | ✖ `404` | ✖ `404` | ✖ `404` | ✖ |
| **Responder (assigned)** | — | ✔ **evidence** | — | ✖ `404` | **✖ never** (FR-068, NFR-027) |
| **Responder (in-radius, unassigned, `available`)** | — | — | ✔ evidence (needed to decide whether to self-claim) | ✖ `404` | ✖ |
| **Responder (neither)** | — | — | — | ✖ `404` | ✖ |
| **Dispatcher** | ✔ | ✔ | ✔ | ✔ all | ✔ (operationally necessary) |
| **Admin** | ✔ | ✔ | ✔ | ✔ all, including soft-deleted | ✔ |
| **Unauthenticated** | ✖ | ✖ | ✖ | ✖ | ✖ |

### 13.2 The exact enforcement, in order

```
GET /api/uploads/:mediaId/url?mediaId=med_…
  │
  ├─ 1  requireUser()                       → 401 / 403
  ├─ 2  rateLimit(120/min)                  → 429
  ├─ 3  Zod: mediaId matches ^med_[A-Z2-7]{12}$  → 400
  ├─ 4  find the MediaRef:
  │      - scan the caller's own staging objects                     (kind: image|audio, scanStatus pending → ok, pre-incident)
  │      - else query incidents/{id}/reports/{rid} for mediaId
  │        and incidents/{id}/supplements/{rid}
  │      - else → 404 MEDIA_NOT_FOUND   ◄── byte-identical to "exists but not yours"
  ├─ 5  assertResourceAccess(media)   → 404 MEDIA_NOT_FOUND on failure
  │        - incidents/{id}.reporterUid == uid                       ⇒ allow
  │        - incidents/{id}.assigneeUid == uid                       ⇒ allow (evidence only)
  │        - responder && status == 'available'
  │             && incident.status in {new,triaged,verified}
  │             && incident.assigneeUid == null
  │             && haversineM(responderLocation.geo, incident.geo) <= serviceRadiusM
  │             && incident.evidenceCount > 0                        ⇒ allow (evidence only)
  │        - role in {dispatcher, admin}                             ⇒ allow
  │        - otherwise                                                ⇒ 404
  ├─ 6  scanStatus must be 'clean'           → 422 MEDIA_NOT_VERIFIED
  ├─ 7  audit: none required by FR-132. `DECISION REQUIRED` (D-10):
  │        should evidence download be audited? It is the highest-value bulk
  │        read in the system, and a compromised dispatcher can exfiltrate
  │        the entire evidence corpus one 15-minute URL at a time.
  └─ 8  signedReadUrl(path, { download: false })  → 15-minute V4 read URL
```

### 13.3 The redaction that travels with the evidence

Evidence access and identity access are **separate decisions**, and evidence access never implies identity access. When a responder is granted evidence, `lib/api/serialize.ts` still omits:

| Omitted for a responder | Source |
| --- | --- |
| `reporterUid` | `incidents.reporterUid` |
| `reporter.displayName`, `reporter.email` | `users/{uid}` join |
| `incidents.locationText` (the reporter's typed address) | [22](./22_USER_ROLES_PERMISSIONS.md) §4.1 |
| `incidentReports[].ipHash` | [07](./07_DATABASE_SCHEMA.md) §5 |
| `reports[].text` for non-original reports; the original text is replaced with `summary` | FR-068 |
| `ai.rawOutputHash`, `ai.model`, `ai.promptVersion` | No operational value for a responder |

**The evidence itself can still contain a face, a voice, a uniform, a house number, or a vehicle registration.** No amount of field redaction changes that: an image of the reporter's face is identity data. The honest statement is that FR-068 prevents *metadata* disclosure; it cannot prevent *photographic* disclosure, and the mitigation is that only a responder who has been dispatched to the incident — who physically needs to know where they are going — can see it. That is a deliberate, documented product decision, and it is why responder verification (FR-063) is an **admin-only, reason-required, audited** action.

### 13.4 Defence in depth

| Layer | Control |
| --- | --- |
| 1 — UI affordance | Evidence is rendered only when the server-computed per-resource `permissions[]` contains `incident:evidence:read` |
| 2 — API route | `assertResourceAccess(media)` as above. This is the real boundary |
| 3 — Data shaping | `redactForRole()` omits reporter identity from the same payload |
| 4 — Firestore rules | `incidents/{id}/reports` read inherits the incident's `canRead()`. A client listener cannot read the `media[]` array of an incident it may not see |
| 5 — Storage rules | `incidents/**` and `quarantine/**` are `if false` for every client. The only way to read an object is through a URL the API issued |
| 6 — Audit | `incident.*` actions are audited; evidence reads are `DECISION REQUIRED` (D-10) |

---

## 14. Quarantine, deletion, and retention

### 14.1 Lifecycle

```
  upload                     incident created            incident soft-deleted
     │                             │                              │
     ▼                             ▼                              ▼
staging/{uid}/{mediaId}.{ext}   incidents/{id}/               quarantine/{mediaId}.{ext}
     │                        reports/{rid}/{mediaId}.{ext}       │
     │                             │                              │
     │ swept after 30 min          │ retained for the life       │ purged after 30 days
     │ (sweep-staging-uploads)     │ of the incident             │ (purge-quarantine-media)
     │                             │ NEVER auto-purged           │
     │                             ▼                              ▼
     │                        purge-closed-locations          hard delete
     │                        (90 d) clears geo,            (the ONLY hard delete
     │                        geoCells, placeId,             in the media system,
     │                        locationText —                and it is not in a
     │                        not the media)                request path)
```

### 14.2 Rules

| Rule | Detail | Mechanism |
| --- | --- | --- |
| **No hard delete in the request path** | `DELETE /api/incidents/:id` sets `deletedAt/deletedBy/deleteReason` and **moves** the media. It never calls `bucket.file().delete()` | FR-123, DEC-11. Doc 07 §12.4: "no hard delete in the request path" |
| Media move on soft delete | Each `MediaRef` object is copied to `quarantine/{mediaId}.{ext}`, then the source is deleted. The `MediaRef` keeps `scanStatus: 'quarantined'` and a `quarantinedAt` timestamp | `services/incidents/delete-incident.ts`; `auditLogs incident.delete` records `metadata.quarantinedMedia: n` |
| `MediaRef` is **not** deleted | The `MediaRef` stays on the report with the new `storagePath`, so an admin can restore the incident **and** its evidence | FR-123 "MUST remain recoverable by an admin" |
| Quarantine purge | **30 days**, by the `purge-quarantine-media` job, which hard-deletes the objects and sets `MediaRef.quarantinePurgedAt` | `DECISION REQUIRED` (D-11): this job is **not** yet in the `POST /api/admin/maintenance/*` list in [08](./08_API_SPECIFICATION.md) §10. It must be added, along with `ENABLE_MAINTENANCE_JOBS=true` |
| Staging sweep | **30 min** (`STAGING_UPLOAD_SWEEP_MIN`) for anything in `staging/` that was not claimed by `POST /api/incidents` | `sweep-staging-uploads`. The object is hard-deleted; nothing references it |
| **Evidence on a live incident is never auto-purged** | An open incident's evidence is the operational record. There is no TTL, no `expiresAt`, no auto-delete | The only thing that can remove it is a soft delete, which moves it to quarantine first |
| Location purge does **not** touch media | The 90-day location purge clears `geo`, `geoCells`, `placeId`, `locationText`. It does **not** clear `media` | NFR-028 is about precise location, not about evidence. **But note the interaction:** if the evidence image itself contains a house number or a shopfront, the 90-day purge is bypassed by the photo. This is the same EXIF/jpeg-content privacy point as §9.2 and is stated again here deliberately |
| Restore | `POST /api/incidents/:id/restore` moves the media **back** from `quarantine/` to the final path, within the quarantine window | Audit `incident.restore`. **After 30 days the evidence is gone and a restore restores only the incident** — the UI must say so |
| Retention of the *incident* | Soft-deleted incidents are retained indefinitely and remain admin-restorable | DEC-11, FR-123 |
| Every purge and move is audited | `incident.update` with `reason: 'retention purge'`, `incident.restore`, `incident.delete` with the quarantined count | `lib/server/audit.ts` |

### 14.3 What a citizen can delete

| Action | Allowed? | Mechanism |
| --- | --- | --- |
| Cancel an incident before verification | ✔ | `PATCH /api/incidents/:id/status` → `cancelled`, with a `reason`. FR-019: rejected once `verifiedAt` is set |
| Cancel after verification | ✖ | `409 INVALID_STATUS_TRANSITION` |
| Delete an incident | ✖ | `DELETE` is dispatcher/admin only |
| Delete **their own** evidence | ✖ **There is no such route.** A citizen cannot remove evidence from an incident, even before verification | Deliberate. FR-012 says supplements are *added*; nothing says a citizen can erase what they sent. Erasing evidence from an emergency record is exactly the capability an abuse-prevention policy must not hand out. `DECISION REQUIRED` (D-12): does the product want citizen-initiated evidence deletion for *unverified, uncited* incidents? It is a reasonable privacy request and a real abuse vector |
| Withdraw a report | The closest thing: `cancelled` before verification, recorded as `resolutionCode: 'withdrawn_by_reporter'` | FR-054 |
| Suppress their own location | ✔ | FR-039: correct or clear location on an unverified incident they own |

---

## 15. Cost

### 15.1 The numbers, with the honest caveat

> **The figures below are indicative. Firebase's free-tier quotas change. Read the live Firebase pricing page and set a Cloud Billing budget alert before the demo. Do not trust a number in a document to protect a budget.**

| Resource | Free tier (indicative) | Our cap | Exposure |
| --- | --- | --- | --- |
| Cloud Storage **stored** | 5 GB (standard, multi-region) | 3 images × 5 MB + 1 audio × 15 MB = **30 MB per report** worst case; realistically ~1.5 MB after client downscale | 5 GB ÷ 1.5 MB ≈ 3 300 reports. A hackathon demo will never approach it |
| Cloud Storage **class A operations** (writes, lists) | 50 000 / month | ~5 object operations per report (1 PUT, 1 copy, 1 delete, plus admin lists) | Not close |
| Cloud Storage **class B operations** (reads) | 50 000 / month | 1 read per evidence view | Not close |
| **Network egress (download)** | **1 GB / day** (historically published) | **This is the binding constraint, and it is the one to watch** | See §15.2 |
| Firestore reads | 50 000 / day | A dispatcher session-hour is budgeted at ≤ 4 000 reads (NFR-007) | See [26](./26_PERFORMANCE_REQUIREMENTS.md) §5 |
| Gemini Generative Language API | Free-tier RPM/RPD | `GEMINI_RPM_LIMIT=8`, `GEMINI_RPD_LIMIT=200`, plus the fallback | Demo needs ≈ 30 runs |
| Google Maps JS API | Monthly credit per load | Restricted referrers + a budget alert | The **single highest-cost-risk item** ([02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) §7.5) |

### 15.2 Image traffic is the most likely place to incur a real bill

```
Worst realistic case for a demo session:
  1 dispatcher opens the queue                    50 incidents, no images in rows      0 MB
  1 dispatcher opens 20 incident details          20 × 3 images × ~300 KB (after the
                                                   client's 1 600 px downscale)      ~18 MB
  2 responders each open their assignment         2 × 3 images × ~300 KB            ~1.8 MB
  1 admin opens the audit log + health             no media                          0 MB
  ─────────────────────────────────────────────────────────────────────────────────────────
  Total per demo session                                                    ~20 MB
  Total across 5 demo sessions in a day                                            ~100 MB
  Free-tier egress allowance                                                       1 GB/day

Headroom: ~10×.
```

The scenario that breaks the budget is **not** normal use. It is:

| Blow-up scenario | Why it hurts | Mitigation in place |
| --- | --- | --- |
| A client that skips the downscale, uploading 3 × 5 MB per report, viewed 20× | 300 MB per dispatcher pass | The 5 MB cap is a server cap. A cold-cache re-fetch of the same object by 3 dispatchers triples it |
| **Egress, not storage, is billed** — Storage egress used to be free-to-egress within the same region in some configurations, and the rules have changed more than once | Assumptions about free egress are unsafe | Verify the live pricing page |
| A **signed URL is a bearer token**: it can be shared, and a 15-minute URL downloaded in a loop is indistinguishable from legitimate use from Storage's point of view | No way to rate-limit at the CDN, and Storage sees signed requests as a single identity | Short TTL; no public URLs; evidence-count caps; `Vary` and `no-store` on our own responses |
| A demo on hotel/conference wifi with a captive portal that proxies and re-downloads | Out of our control | — |
| A `gstatic`/Maps load per page view, unbudgeted | Maps, not Storage | `check-bundle.ts`; restricted referrers; the static list fallback (FR-085) means the map is not required for any critical action |

### 15.3 The mitigations, in order of effect

| # | Mitigation | Effect | Cost |
| --- | --- | --- | --- |
| 1 | **Client downscale to a 1 600 px long edge at JPEG q0.85 before upload** | ~10× reduction in both storage and egress. A 4 MB phone photo becomes ~300 KB | $0. One canvas call. Downside: client CPU on a low-end phone, and it is client-side so it is *advisory* for cost purposes |
| 2 | **≤ 3 images + 1 audio per report** (FR-005, FR-006) | Hard cap on the per-incident tail | $0 |
| 3 | **No thumbnail pipeline** (D-9) | Saves *generating* images; costs *full-size* reads | $0 |
| 4 | **`loading="lazy"` on evidence images** | Only downloads images that scroll into view | $0 |
| 5 | **15-minute signed URL TTL** | A leaked URL is a non-event | $0 |
| 6 | **No public objects** | No indexer, no bot, no crawler traffic | $0 |
| 7 | **Quarantine purge after 30 days, staging sweep after 30 min** | Bounds the stored tail | $0 |
| 8 | **Lower the downscale target to 1 024 px if needed** | Another ~2× on egress | $0. One constant. **Do this first if cost appears** |
| 9 | **A Cloud Billing budget alert** on the project | The alert, not the cap, is what stops a surprise | $0 |

**What is explicitly not done, and why:** no image CDN with a paid tier, no Cloud CDN, no signed-URL caching proxy, no "archive to cold storage after 30 days" (cold storage has a 30-day minimum and retrieval fees, and it would break the audit story). If image traffic ever becomes a real cost, the correct next step is a client-side second preview object, then a server thumbnailer — not a CDN.

---

## 16. Failure modes and recovery

### 16.1 Upload interrupted mid-transfer

| Symptom | Detection | Behaviour | Recovery |
| --- | --- | --- | --- |
| Network drop, client detects | `fetch` rejects / `XMLHttpRequest.onerror` | The client retries **once** with a fresh signed URL (the old one may be close to expiry) | On success, normal flow. On second failure, that file is marked failed; the **other** files and the text are preserved (US-002 AC4) |
| Network drop, client does not detect | Nothing | A **partial** object exists in `staging/` with a size far below the declared `sizeBytes` | `POST /api/uploads/finalize` returns `409 UPLOAD_INCOMPLETE` (0 bytes, or > 1 % off the declaration) and **deletes the object**. If finalize is skipped, the incident creation re-sniff finds a short/invalid file and rejects it. If both are skipped, the 30-minute sweeper removes it |
| Tab closed mid-upload | Nothing | The same partial object | The sweeper |
| The user abandons the form entirely | Nothing | The same | The sweeper |
| Signed URL expired before the PUT started | Storage returns `403` on the signature | The client requests a **new** signed URL and retries once | The new URL is for the **same** `mediaId` — safe, because the object does not exist yet. If it does exist, Storage returns `409` and the client re-finalizes |

**Recovery guarantee:** no report is ever blocked by a failed upload, and a failed upload never corrupts a report. The worst case is a missing photo on a report that has text.

### 16.2 Orphaned uploads in `staging/`

| Case | Cause | Detection | Recovery |
| --- | --- | --- | --- |
| Abandoned upload | The user never submitted | `staging/` object older than `STAGING_UPLOAD_SWEEP_MIN` (30) | `sweep-staging-uploads` hard-deletes it. Manual trigger: `POST /api/admin/maintenance/sweep-staging-uploads` with a reason, audited |
| Failed upload after a successful PUT | Finalize or incident creation failed | Same | Same |
| Claimed but the incident was never created | The transaction failed after the copy | Two objects exist: the staging one and the final one. The staging one is swept; the final one is orphaned. `GET /api/admin/system/health` reports objects under `incidents/**` whose `MediaRef` is missing from every report | **This is the honest residual of a non-atomic cross-service write.** Recovery: an admin inspection job that finds unreferenced `incidents/**` objects and moves them to `quarantine/`. `DECISION REQUIRED` (D-13): add a `sweep-orphaned-evidence` job |
| Staging object claimed by a *different* uid | A modified client | `validateMediaPath` compares `path.split('/')[1]` with `token.uid` ⇒ `403 UPLOAD_FORBIDDEN_PATH`; and the `storage.rules` `mine(uid)` blocks the write in the first place | — |
| Storage unavailable at incident creation | Admin SDK errors | The exception surfaces as `STORAGE_UNAVAILABLE` | **The incident is created with the media omitted**, and the request is flagged. `evidenceCount` reflects reality, and the response includes `meta.droppedMedia`. The `staging` object is swept in 30 min. This is the correct behaviour: a storage outage must not lose an emergency report |

### 16.3 Storage unavailable at incident creation

This is the case the FR-029 spirit covers for AI, applied to storage: **recording an emergency never fails because an optional subsystem failed.**

```
POST /api/incidents with 2 media items, Storage returns 503 on the copy
  │
  ├─ try copy(media[0])  → 503
  ├─ try copy(media[1])  → 503
  ├─ text is valid (≥ 20 chars)          ⇒ PROCEED
  │     • incident created
  │     • reports/{rid}.media = []       (both items dropped)
  │     • evidenceCount = 0
  │     • response: 201 { incident, meta: { droppedMedia: ['med_a1','med_c3'],
  │                                          storageDegraded: true } }
  │     • audit incident.create with metadata.storageDegraded = true
  │     • dispatcher sees the incident with NO evidence — visible, not hidden
  │     • reporter sees "Report submitted. We could not attach your photo —
  │                        please add it again from your report page." (FR-012 path)
  │
  └─ text is absent (audio-only or image-only report)
        ⇒ 503 STORAGE_UNAVAILABLE. The report is NOT created.
          The client keeps the local draft (FR-014) and offers a retry.
          This is the one case where a report is not recorded, and it is
          unavoidable: an image-only report with no storable image is not a report.
```

### 16.4 Corrupt object at read time

| Symptom | Detection | Behaviour | Recovery |
| --- | --- | --- | --- |
| Object missing (deleted out of band, or a failed copy) | Admin SDK `getMetadata` 404 during `GET /api/uploads/:mediaId/url` | `404 MEDIA_NOT_FOUND`, byte-identical to a permission refusal | The `MediaRef` records `storageMissing: true`; the dispatcher UI shows "Evidence unavailable" instead of a broken image icon |
| Object present but truncated (out-of-band corruption) | The **client** `onerror` on the `<img>` | The UI shows a broken-evidence placeholder with the file's real size and type, plus a **Retry download** action (a fresh signed URL) | A second `onerror` marks it `storageCorrupt: true` on the `MediaRef` and raises a `warning` audit entry for the admin. The object is moved to `quarantine/` by the admin |
| Object present, 0 bytes | Client `onerror`; also caught at finalize time if the corruption happened after | Same as above | Same |
| Object present, correct size, but undecodable | Client `onerror` | Same. A truncated JPEG has a valid SOI, so **the server cannot detect this** — this is exactly the "necessary but not sufficient" point of §5.4 | Same |
| Signed URL returns `403` because it expired mid-view | Client `onerror` | Auto-refresh: the client calls `GET /api/uploads/:mediaId/url` again (rate limit 120/min) and re-assigns `src` **once** | Silent to the user. A second failure shows the retry affordance |
| The whole Storage service is down | Client `onerror` on every asset; `/api/health` reports `storage: "down"` | The app degrades: map has a static list fallback (FR-085), audio is hidden, the report form still accepts **text** and submits | `GET /api/health` returns `503`. Reports still create without evidence, per §16.3 |

**Recovery guarantee:** a corrupt or missing object degrades the *view*, never the *record*. The incident, its `MediaRef`, its hash, and its audit trail are unaffected. A dispatcher always sees that evidence *existed*, with its type and size, even when it cannot be displayed — which is the honest thing to show.

### 16.5 Decompression bombs (the DoS variant)

| Vector | Cap | Defence |
| --- | --- | --- |
| Pixel-count bomb: a 5 MB PNG declaring 60 000 × 60 000 pixels | 12 000 px per side **and** ≤ 40 MP, checked in the PNG `IHDR` parse | The decoder allocates a bounded buffer or fails. Verified at `finalize` **and** at incident creation |
| Crafted JPEG with a huge `SOF` dimension | Same cap, from the `SOFn` marker | Rejected |
| Animated WebP / animated GIF | Rejected outright (§6) | Unbounded decode time eliminated |
| `decompression_bomb` in a stored ZIP/7z | Not accepted at all (§6) | Eliminated |
| Audio framed to be enormous when decoded | 15 MB cap; no decode server-side | There is no server-side audio decoder, so there is no server-side bomb |
| A slow-loris style `PUT` holding a signed URL open | 900 s TTL; the signature expires | Bounded |
| Many concurrent uploads | `POST /api/uploads/sign` is 30/h/uid; Storage rules cap the size | Bounded per uid. **Not bounded per IP** — residual risk RR-04 in [10](./10_AUTHORIZATION_SECURITY.md) §22 (no edge rate limiting) |

---

## 17. Test matrix

`tests/integration/api/uploads/*.test.ts` plus `tests/integration/storage-rules.test.ts`. Every row is an assertion, not an intention.

### 17.1 Allowed types are accepted

| # | Test | Asserts |
| --- | --- | --- |
| A1 | JPEG 4 KB, declared `image/jpeg` | `201`, `MediaRef.contentType == 'image/jpeg'`, `storagePath` ends `.jpg` |
| A2 | PNG 4 KB with a valid `IHDR` | `201`, `.png` |
| A3 | PNG declaring 8000 × 6000 | `201` (under both caps) |
| A4 | PNG declaring exactly 12 000 × 12 000 | `201` (boundary) |
| A5 | PNG declaring 12 001 × 100 | `415` (over the per-side cap) |
| A6 | PNG declaring 9000 × 9000 (81 MP) | `415` (over the 40 MP cap) |
| A7 | WebP `RIFF…WEBPVP8 ` | `201`, `.webp` |
| A8 | WebP `RIFF…WEBPVP8L` | `201` |
| A9 | WebP `RIFF…WEBPVP8X` with no `ANIM` chunk | `201` |
| A10 | WebP `RIFF…WEBPVP8X` **with** `ANIM` | `415` (animated rejected) |
| A11 | WebM/Opus with `A_OPUS` and no `V_` fourCC | `201`, `.webm` |
| A12 | WebM whose `Tracks` sits beyond 4 KiB, sniffed with a 64 KiB window | `201`, and the test asserts the window size so the D-3 decision cannot be silently reverted |
| A13 | M4A with major brand `M4A ` | `201`, `.m4a` |
| A14 | M4A with major brand `isom` | `201` |
| A15 | MP3 with an `ID3` v2.3 tag | `201`, `.mp3` |
| A16 | MP3 with a raw frame sync `FF FB` | `201` |
| A17 | MP3 with a raw frame sync `FF F3` | `201` |
| A18 | 3 images + 1 audio on one report | `201`, `evidenceCount == 4` |
| A19 | 4 images | `400 VALIDATION_FAILED` |
| A20 | 2 audio clips | `400` |
| A21 | A report with media and `text: null` | `201` (text is optional when media exists, FR-002) |
| A22 | A report with media and `text: "help"` (4 chars) | `201` — the length rule applies only to the text-only path (FR-002) |

### 17.2 Rejected types are refused

| # | Test | Asserts |
| --- | --- | --- |
| R1 | SVG (`<svg xmlns=…><script>…`) | `415 UNSUPPORTED_MEDIA_TYPE` |
| R2 | SVG with a UTF-8 BOM and leading whitespace | `415` |
| R3 | `.html` | `415` |
| R4 | `.xhtml` | `415` |
| R5 | `.xml` | `415` |
| R6 | GIF (`GIF89a`) | `415` |
| R7 | Animated GIF | `415` |
| R8 | HEIC (`ftypheic`) | `415` until D-5 is decided |
| R9 | HEIF | `415` |
| R10 | BMP (`BM`) | `415` |
| R11 | TIFF (`II*\0` and `MM\0*`) | `415` |
| R12 | PDF (`%PDF-1.7`) | `422 UPLOAD_QUARANTINED` + moved to `quarantine/` |
| R13 | ZIP (`PK\x03\x04`) | `422 UPLOAD_QUARANTINED` |
| R14 | RAR (`Rar!\x1A\x07`) | `422 UPLOAD_QUARANTINED` |
| R15 | 7z (`7z\xBC\xAF\x27\x1C`) | `422 UPLOAD_QUARANTINED` |
| R16 | gzip (`\x1F\x8B`) | `422 UPLOAD_QUARANTINED` |
| R17 | Windows PE (`MZ`) | `422 UPLOAD_QUARANTINED` |
| R18 | ELF (`\x7FELF`) | `422 UPLOAD_QUARANTINED` |
| R19 | Mach-O (`\xCF\xFA\xED\xFE`) | `422 UPLOAD_QUARANTINED` |
| R20 | A shell script (`#!/bin/sh`) | `422 UPLOAD_QUARANTINED` |
| R21 | `video/mp4` (ftyp `isom` with an `avc1` compatible brand) | `415` |
| R22 | `video/webm` (EBML with a `V_VP8` fourCC) | `415` |
| R23 | WAV (`RIFF…WAVE`) | `415` — and it specifically proves the `RIFF` branch checks the form type, not just the magic |
| R24 | FLAC (`fLaC`) | `415` |
| R25 | Ogg (`OggS`) | `415` |
| R26 | A 3gp video (`ftyp3gp5`) | `415` |
| R27 | A `.txt` file | `415` |
| R28 | A QuickTime file (`ftypqt  `) | `415` |
| R29 | A `.png` that sniffs as JPEG | `201` with the path corrected to `.jpg` — the *friendly* branch, asserted so it cannot regress into a failure |
| R30 | A file whose magic matches **nothing** in the table | `415 UNSUPPORTED_MEDIA_TYPE` |

### 17.3 Boundary sizes and shapes

| # | Test | Asserts |
| --- | --- | --- |
| B1 | Image of exactly 5 242 880 bytes | `201` |
| B2 | Image of 5 242 881 bytes | `413 UPLOAD_TOO_LARGE` at sign time **and** at incident creation |
| B3 | Audio of exactly 15 728 640 bytes | `201` |
| B4 | Audio of 15 728 641 bytes | `413` |
| B5 | **Zero-byte** file | `409 UPLOAD_INCOMPLETE` at finalize; `422 EMPTY_REPORT` at incident creation if it is the only evidence |
| B6 | A 1-byte file starting `FF D8 FF` | `415` — the SOI-present-but-no-marker-follows branch |
| B7 | A file declaring 184 320 bytes but containing 190 000 (> 1 % delta) | `409 UPLOAD_INCOMPLETE` |
| B8 | `sizeBytes: 0` in the sign request | `400 VALIDATION_FAILED` |
| B9 | `sizeBytes: -1` | `400` (`.int().min(1)`) |
| B10 | `durationSec: 121` | `400 VALIDATION_FAILED` |
| B11 | `durationSec: 120` | `201` |
| B12 | `clientWidth: 0` or `clientHeight: 0` | `400` |
| B13 | A `mediaId` with a lowercase body (`med_aaaaaaaaaaaa`) | `400` — the regex is uppercase-only |
| B14 | A `mediaId` of the wrong length | `400` |
| B15 | A `mediaId` with a character outside `A–Z2–7` (e.g. `0`, `1`, `8`) | `400` |

### 17.4 Mismatched, forged, and polyglot

| # | Test | Asserts |
| --- | --- | --- |
| M1 | PNG magic (`89 50 4E 47 0D 0A 1A 0A`) + `IHDR` + a `<script>alert(1)</script>` payload appended | `201` (the container is a PNG), **and** the test asserts the object is served with `Content-Type: image/png` and that rendering it through `<img>` in Playwright does not execute the script. This is the polyglot test from the spec, and it asserts *behaviour*, not just the status code |
| M2 | A valid JPEG with a trailing ZIP appended | `201` (JPEG magic matches), and the residual risk is asserted in the test's comment with a pointer to §5.4 and RR-10 |
| M3 | `FF D8 FF E0 …` (JFIF) with a `data:text/html` string in a comment | `201`; Playwright asserts the `onerror` path is taken and no script runs |
| M4 | Declared `image/jpeg`, actual PNG bytes | `415 UPLOAD_SIGNATURE_MISMATCH` |
| M5 | Declared `image/jpeg`, actual `audio/webm` | `415`, and the media item is dropped |
| M6 | Declared `audio/webm`, actual JPEG | `415` |
| M7 | A `contentType` with parameters: `image/jpeg; charset=binary` | `400 VALIDATION_FAILED` — the allow-list is an exact string match, not a prefix match |
| M8 | A `contentType` of `image/jpg` (a common wrong spelling) | `400` |
| M9 | `kind: 'audio'` with `contentType: 'image/jpeg'` | `400` at sign time; at incident time the **sniffed** kind wins and the item is dropped with `415` |
| M10 | A file where the declared `sha256` differs from the server's | The server's value is stored. The client's is ignored. Assert `MediaRef.sha256 == serverHash` |
| M11 | A PNG with a valid signature and a `IHDR` that declares a negative/huge dimension | `415` |

### 17.5 Cross-user path theft and signed-URL behaviour

| # | Test | Asserts |
| --- | --- | --- |
| S1 | Citizen A calls `POST /api/uploads/sign`; Citizen B PUTs to `staging/{A.uid}/med_XXXXXXXXXXXX.jpg` with the client SDK | `PERMISSION_DENIED` from Storage rules (`mine(uid)`) |
| S2 | Citizen A's incident; Citizen B sends `media[0].storagePath = "staging/{A.uid}/{A.mediaId}.jpg"` in `POST /api/incidents` | `403 UPLOAD_FORBIDDEN_PATH` |
| S3 | Citizen B sends `incidents/{A.incidentId}/reports/{A.reportId}/{A.mediaId}.png` | `403 UPLOAD_FORBIDDEN_PATH` (not their report) |
| S4 | Citizen B sends `quarantine/med_XXXXXXXXXXXX.png` | `403 UPLOAD_FORBIDDEN_PATH` |
| S5 | A path with `..`: `staging/{uid}/../../incidents/x/reports/y/med_z.jpg` | `403 UPLOAD_FORBIDDEN_PATH` |
| S6 | A path with a URL-encoded traversal: `staging/%2e%2e/med_z.jpg` | `403` |
| S7 | A path with a doubled slash: `staging//med_z.jpg` | `400` |
| S8 | A path with an absolute prefix: `/staging/{uid}/med_z.jpg` | `400` |
| S9 | A client filename: `staging/{uid}/IMG_2026.jpg` | `400` (the `med_` prefix is required) |
| S10 | A staging object older than 30 min, then `POST /api/incidents` referencing it | `403 UPLOAD_FORBIDDEN_PATH` (outside the claim window) |
| S11 | `GET /api/uploads/:mediaId/url` for another user's media | `404 MEDIA_NOT_FOUND`, **byte-identical to a nonexistent `mediaId`** |
| S12 | A read URL used after 900 s | Storage returns `403`; the client refreshes once |
| S13 | A read URL used for a **write** (`PUT`) | Storage returns `403` (the token action is `read`) |
| S14 | A write URL used for a **read** (`GET`) | Storage returns `403` (the token action is `write`) |
| S15 | A staging object PUT **without** a signed URL, using the client SDK | `PERMISSION_DENIED` for a path outside their own; for their own path it is **allowed by design** (that is the staging contract) |
| S16 | Any client-SDK write to `incidents/**` | `PERMISSION_DENIED` |
| S17 | Any client-SDK read of `incidents/**` | `PERMISSION_DENIED` |
| S18 | Any client-SDK read of `quarantine/**` | `PERMISSION_DENIED`, including by the original uploader |
| S19 | A signed read URL issued to Citizen A, then requested by Citizen B | **This is the accepted bearer-token behaviour** ([10](./10_AUTHORIZATION_SECURITY.md) §10.4). The test asserts the documented behaviour and its 900 s bound, so a platform change is caught |
| S20 | `grep` for `getPublicUrl` in the source tree | Zero occurrences |
| S21 | A bucket-level anonymous `list` | `PERMISSION_DENIED` / `403` |

### 17.6 Retention and lifecycle

| # | Test | Asserts |
| --- | --- | --- |
| L1 | `DELETE /api/incidents/:id` (dispatcher, with a reason) | `deletedAt` set; each `MediaRef` object exists at `quarantine/{mediaId}.{ext}`; the source path is gone; `auditLogs incident.delete` has `metadata.quarantinedMedia: 3` |
| L2 | `POST /api/incidents/:id/restore` within 30 days | The object is back at the final path; `auditLogs incident.restore` exists |
| L3 | `POST /api/incidents/:id/restore` after 30 days | The incident is restored; `MediaRef.quarantinePurgedAt` is set; the API response says the **evidence** could not be restored |
| L4 | `purge-quarantine-media` run | The objects are hard-deleted; the `MediaRef` keeps `scanStatus: 'quarantined'` + `quarantinePurgedAt` |
| L5 | `purge-closed-locations` on a 91-day-old closed incident | `geo`, `geoCells`, `placeId`, `locationText` are null/empty; `media` is **untouched**; `auditLogs` has the purge row |
| L6 | `sweep-staging-uploads` on a 31-minute-old staging object | Deleted; on a 29-minute-old one, not |
| L7 | An open (not closed, not deleted) incident 200 days old | `geo` is **not** purged — the 90-day rule is explicitly about *closed* incidents |
| L8 | A `MediaRef` whose `scanStatus` is `pending` | `GET /api/uploads/:mediaId/url` ⇒ `422 MEDIA_NOT_VERIFIED` |
| L9 | A `MediaRef` whose `scanStatus` is `quarantined` | `GET /api/uploads/:mediaId/url` ⇒ `422 MEDIA_NOT_VERIFIED` |
| L10 | A citizen attempting `DELETE /api/incidents/:id` | `403 FORBIDDEN` |
| L11 | A citizen attempting to cancel a `verified` incident | `409 INVALID_STATUS_TRANSITION` (FR-019) |

### 17.7 Rules tests (staging ownership) — the explicit list

`tests/integration/storage-rules.test.ts`, all against the Storage emulator:

```
RULES-1   context: citizen A, get  staging/{A.uid}/{mediaId}.jpg          ⇒ ALLOW
RULES-2   context: citizen A, list staging/{A.uid}/                        ⇒ ALLOW
RULES-3   context: citizen B, get  staging/{A.uid}/{mediaId}.jpg          ⇒ DENY
RULES-4   context: citizen B, list staging/                               ⇒ DENY (no recursive wildcard)
RULES-5   context: citizen B, delete staging/{A.uid}/{mediaId}.jpg        ⇒ DENY
RULES-6   context: citizen A, put staging/{A.uid}/{mediaId}.jpg (jpeg, 1 MB)  ⇒ ALLOW
RULES-7   context: citizen A, put staging/{A.uid}/{mediaId}.jpg (16 MB)   ⇒ DENY (withinSize)
RULES-8   context: citizen A, put staging/{A.uid}/{mediaId}.txt          ⇒ DENY (extMatches + withinSize)
RULES-9   context: citizen A, put staging/{A.uid}/photo.jpg               ⇒ DENY (mediaIdOk)
RULES-10  context: citizen A, put staging/{A.uid}/{mediaId}.jpg declared as audio/webm ⇒ DENY (extMatches)
RULES-11  context: citizen A, put staging/{A}/x/{mediaId}.jpg (nested)     ⇒ DENY (mediaIdOk: one level only)
RULES-12  context: citizen A, put staging/{A.uid}/{mediaId}.jpg/svg        ⇒ DENY
RULES-13  context: dispatcher, get incidents/{id}/reports/{rid}/{mediaId}.jpg ⇒ DENY   ← surprising but correct
RULES-14  context: admin,      get incidents/{id}/reports/{rid}/{mediaId}.jpg ⇒ DENY   ← reads go via signed URLs
RULES-15  context: the uploader, get quarantine/{mediaId}.jpg             ⇒ DENY
RULES-16  context: admin,      get quarantine/{mediaId}.jpg               ⇒ DENY
RULES-17  context: anyone,    put/delete incidents/**                    ⇒ DENY
RULES-18  context: anyone,    put/delete quarantine/**                   ⇒ DENY
RULES-19  context: anyone,    get/update/delete/ list a/zzz/b/c           ⇒ DENY   ← the catch-all
RULES-20  context: unsigned (null auth), anything at all                   ⇒ DENY
RULES-21  context: a token with role 'citizen' reading staging/{other}/…   ⇒ DENY
RULES-22  context: a token with role 'admin' putting a 20 MB object into its own staging/ ⇒ DENY (size cap is role-independent)
```

`RULES-13` and `RULES-14` deserve a note in the test file, because they look wrong and are not: **even an admin cannot read final evidence through the client SDK.** All evidence reads go through a server-issued signed URL after a resource-access check. The rules file has no admin exception for `incidents/**`, and adding one would be the single most damaging edit anyone could make to it.

### 17.8 How this suite runs

| Suite | Needs an emulator | Runs in CI on every PR | Notes |
| --- | --- | --- | --- |
| Unit: `sniff.ts` (`detectMediaType`) | No | ✔ | Pure function over a `Buffer`. Every row in §17.1, §17.2, §17.4 is a fixture file under `tests/fixtures/media/`. Fastest, and it covers the signature table completely |
| Unit: `ALLOWED_MEDIA` / path regexes | No | ✔ | Pure |
| Integration: `POST /api/uploads/sign`, `finalize`, `url` | Storage emulator | ✔ | Needs `@firebase/rules-unit-testing` |
| Integration: rules | Both emulators | ✔ | RULES-1..22 |
| Integration: retention/lifecycle | Storage emulator | ✔ | L1..L11 |
| E2E: a real browser upload | A real or emulated Storage | ✔ (Playwright) | M1/M3 assert the **behaviour**, which no unit test can |
| Manual: pre-demo | Real project | **Pre-demo gate** | A real camera-roll JPEG, a real iPhone Safari `audio/mp4` recording, a real `GET` of a signed URL in DevTools |

> The iPhone `audio/mp4` test is the one that must be done by hand on real hardware. Everything about §10.1 and §5.2.5 is inference from documentation; the only way to know what Safari actually emits is to record a clip on a phone and drop it into `tests/fixtures/media/`.

---

## 18. `DECISION REQUIRED` items in this document

| # | Decision | Options | Impact | Owner |
| --- | --- | --- | --- | --- |
| D-1 | The canonical `media[].storagePath` form in `POST /api/incidents` | (a) always the staging path **[recommended]**; (b) the final path with a re-sign | The API contract, the test fixtures, and `validators/incident.ts` | Product + Eng |
| D-2 | Animated WebP | (a) reject **[current default]**; (b) accept and cap the frame count | Minor. Rejecting is safe; accepting needs a frame-count check | Eng |
| D-3 | The `audio/webm` sniff window when no fourCC is found in the first 4 KiB | (a) 64 KiB window, then accept with `sniffInconclusive` **[recommended]**; (b) accept immediately; (c) reject | **Usability.** Option (c) rejects valid 90-second voice notes | Eng + Product |
| D-4 | Whether `audio/mp4` residual risk (audio-only cannot be proven) is acceptable | (a) accept, documented **[current]**; (b) read the `moov` handler from the file tail | Accepting means a video payload can be stored as `audio/mp4`; it cannot execute | Eng + Product |
| D-5 | HEIC/HEIF support | (a) reject **[current]**; (b) accept `image/heic` and add a magic-byte check for `ftypheic`/`ftypheix`/`ftypmif1`/`ftypmsf1` | **Usability** for iPhone users. The security argument is decoder consistency, not danger | Product |
| D-6 | Whether location-bearing EXIF may be retained on evidence | (a) retain, documented and countable **[current]**; (b) add `sharp`; (c) a Cloud Run re-encode; (d) refuse client images | **A citizen-safety privacy judgement.** (b)/(c) also close RR-10, RR-11, and RR-12 | Product + Privacy |
| D-7 | Server-side audio-duration enforcement | (a) client-only, documented **[current]**; (b) `ffprobe` in Cloud Run on finalize | A modified client can attach a 40-minute file today. Impact is cost, not safety | Eng |
| D-8 | Whether to add an `EICAR` string scan to the admin health job as a cheap compensating check for the absent AV | (a) add it **[cheap, recommended]**; (b) rely on the allow-list alone | A 1-line check against the one signature every scanner is defined by | Eng |
| D-9 | The thumbnail / egress strategy | (a) no pipeline, client downscale at 1 600 px **[current]**; (b) lower to 1 024 px; (c) a client-side preview object; (d) a server thumbnailer | This is the cost line item most likely to move | Eng + Product |
| D-10 | Whether evidence download should be audited | (a) audit every `GET /api/uploads/:mediaId/url`; (b) audit only dispatches/admin **(current)**; (c) audit only anomalous volume | A compromised dispatcher can exfiltrate the whole evidence corpus one 15-minute URL at a time, with no trace | Product |
| D-11 | Adding `purge-quarantine-media` to `POST /api/admin/maintenance/*` | (a) add it **[required for §14.2 to hold]**; (b) run it manually forever | A 30-day retention promise that nothing enforces is not a promise | Eng |
| D-12 | Whether a citizen may delete their own evidence on an unverified, uncited incident | (a) no **[current]**; (b) yes, with the deletion audited | A genuine privacy request vs. a real abuse vector (erase the evidence of a report you regret) | Product |
| D-13 | Adding a `sweep-orphaned-evidence` job for `incidents/**` objects with no referencing `MediaRef` | (a) add it; (b) accept the orphan tail | Storage cost and confusion in the admin health view | Eng |
| D-14 | The Storage bucket name form (`.appspot.com` vs `.firebasestorage.app`) | (a) read it from `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` **[current]**; (b) hard-code one | Hard-coding the wrong form breaks every signed URL | Eng |

---

## 19. Cross-reference index

| Concern | Authoritative location |
| --- | --- |
| `MediaRef` fields, `scanStatus` | [07](./07_DATABASE_SCHEMA.md) §10.1 |
| `media[].storagePath` validation, the create pipeline, upload endpoints, error codes | [08](./08_API_SPECIFICATION.md) §3.1, §8 |
| Storage Security Rules, signed-URL bearer caveat, rate limits | [10](./10_AUTHORIZATION_SECURITY.md) §10, §11, §17 |
| Why media is inlined and how it is budgeted; the absence of `sharp` | [09](./09_AI_GEMINI_SPECIFICATION.md) §4.2 |
| `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_AUDIO_BYTES`, `UPLOAD_SIGNED_URL_TTL_SEC`, `STAGING_UPLOAD_SWEEP_MIN` | [21](./21_ENVIRONMENT_VARIABLES.md) §2 |
| Threats T-05..T-08, T-29, T-36, T-45 | [24](./24_THREAT_MODEL_SECURITY.md) |
| FR-005, FR-006, FR-007, FR-008, FR-002, FR-012, FR-019, NFR-028 | [01](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) §6.1, §7 |
| Soft delete and quarantine semantics | [07](./07_DATABASE_SCHEMA.md) §12.4 |
| Folder paths (`services/uploads/*`, `tests/fixtures/media/`) | [20](./20_PROJECT_FOLDER_STRUCTURE.md) §2 |

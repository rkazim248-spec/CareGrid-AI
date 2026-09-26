# 29 — Demo Scenario

**Project:** CareGrid AI
**Document type:** The executable demo script. Setup, dataset, beat-by-beat narration, failure drills, and the Q&A appendix
**Status:** Baseline v1.0 — **this is a contract.** The seed data, the coordinates, and the duplicate thresholds below are referenced by [07 §14](./07_DATABASE_SCHEMA.md), [09 §11](./09_AI_GEMINI_SPECIFICATION.md), and [18 §15.3](./18_TESTING_QA_PLAN.md). A change here must be reflected in the seed
**Related documents:** [01 PRD §4 personas](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) · [04 UI/UX](./04_UI_UX_DESIGN_SPECIFICATION.md) · [07 Database Schema §4.3, §4.6, §9.4, §14](./07_DATABASE_SCHEMA.md) · [08 API Specification §3.1, §3.6, §3.8](./08_API_SPECIFICATION.md) · [09 AI Spec §5.3, §6, §7](./09_AI_GEMINI_SPECIFICATION.md) · [18 Testing & QA §11.1, §18](./18_TESTING_QA_PLAN.md) · [19 Deployment & DevOps §5.4, §5.5](./19_DEPLOYMENT_DEVOPS.md) · [21 Environment Variables](./21_ENVIRONMENT_VARIABLES.md) · [26 Performance Requirements §4, §6, §7](./26_PERFORMANCE_REQUIREMENTS.md) · [27 MVP Scope §4.3](./27_HACKATHON_MVP_SCOPE.md)

> **How to use this document.** Read §1 (setup) and §2 (dataset) once, before the event. Rehearse from §4 (the script) twice, timed. Print §3 (the dataset) and §4 side by side. Keep §7 (failure drills) on a second device. §10 is the Q&A appendix and is not read from during the demo.
>
> **One rule that governs everything below: the demo never overclaims.** Every number spoken is read off the screen, every degraded state is named as degraded, and the disclaimer ("this is a demonstration system, not a certified dispatch system") is said out loud at the start. A smaller honest demo beats a larger false one, and the judges in the room are the people who can tell the difference.

---

## 0. The story, in one paragraph

A heatwave evening in Secunderabad. **Ravi** reports a two-car collision on the service road by Metro Gate 1, where someone is trapped. **Three minutes and 140 metres away, Priya reports the same collision** — and CareGrid AI has already worked out that these are the same event, before a human has read either one. The dispatcher, **Meera**, sees one incident with a critical urgency, an AI confidence, a human-verifiable summary, and a link to the original report. She assigns the nearest verified responder, **Yusuf**, who is told within three seconds and who moves through en-route → on-scene → resolved while Meera watches. When it is done, the incident becomes a row in an analytics rollup — and the heatwave cluster that nobody connected to a map is now visible as a pattern.

**The turn of the story is beat 5.** Everything before it is "we built a form". Everything after it is "we built a system that understands messy reality". Protect that beat with the cut ladder in [27 §4.2](./27_HACKATHON_MVP_SCOPE.md).

---

## 1. Setup and prerequisites — T−30 min to T0

Run in this order. The order matters: the **seed is last** so the duplicate partner's timestamp is as close to demo time as possible.

| # | Clock | Action | Command / check | Pass condition | Reference |
| --: | --- | --- | --- | --- | --- |
| 1 | T−30 | **Confirm the deployment** | open the production URL; read `VERCEL_GIT_COMMIT_SHA` from the footer | the intended commit is live | [19 §6.2](./19_DEPLOYMENT_DEVOPS.md) |
| 2 | T−30 | **Health** | `curl -s "$APP_URL/api/health"` | `200`, all three `checks` `ok` | [08 §9.3](./08_API_SPECIFICATION.md) |
| 3 | T−30 | **Gemini pre-flight** | as admin, `GET /api/admin/system/health` | AI success ≥ 95 %, fallback ≤ 5 %, p95 ≤ 8 s, **quota headroom ≥ 50 %**. If headroom < 50 %, set `GEMINI_AUDIO_ENABLED=false` and redeploy **now**, not at T−5 | [09 §9.1](./09_AI_GEMINI_SPECIFICATION.md) |
| 4 | T−30 | **Maps budget check** | Google Cloud console → Billing → Budgets | alert armed at 50/90/100 %; **zero charges to date** | [19 §13.1](./19_DEPLOYMENT_DEVOPS.md) |
| 5 | T−30 | **Firestore usage check** | Firebase console → Usage & billing | reads/writes comfortably inside the allowance with headroom | [26 §5.5](./26_PERFORMANCE_REQUIREMENTS.md) |
| 6 | T−29 | **Provider status** | status.vercel.com, status.firebase.google.com | record the state; you will need it if something degrades | [26 §10.3](./26_PERFORMANCE_REQUIREMENTS.md) |
| 7 | T−28 | **Window 1 — citizen.** A **separate browser profile** (not a window) | Chrome profile "demo-citizen" → `https://<prod>` → sign in as `priya@caregrid.demo` | lands on `/report`; **no geolocation prompt has appeared** | [01 §4.1](./01_PRODUCT_REQUIREMENTS_DOCUMENT.md) |
| 8 | T−28 | **Window 2 — dispatcher.** Profile "demo-dispatcher" | sign in as `meera@caregrid.demo` → open `/dashboard` | the queue renders; KPI tiles show as-of times | |
| 9 | T−27 | **Window 3 — responder.** Profile "demo-responder", sized 390×844 with device emulation, touch on | sign in as `yusuf@caregrid.demo` → open `/dashboard` | the responder dashboard renders; availability is `available` | |
| 10 | T−27 | **Window 4 (optional) — second dispatcher.** Profile "demo-dispatcher-2" | sign in as `deepa@caregrid.demo` → `/dashboard` | used **only** for the fan-out beat. Close it if the screen is small | [19 §8.6](./19_DEPLOYMENT_DEVOPS.md) (profiles, not windows, because two tabs in one profile share a session) |
| 11 | T−26 | **Grant geolocation** in Window 1 (browser permission for the origin) with the location set to the demo coordinates | Chrome → site settings → Location → Allow, and DevTools → Sensors → override lat `17.4490`, lng `78.4878`, accuracy `34` | the coordinates are overridden **before** the demo, so the demo does not depend on a venue's GPS | [08 §3.1](./08_API_SPECIFICATION.md) |
| 12 | T−25 | **Turn OFF network throttling** in all profiles | DevTools → Network → throttling → **No throttling**; confirm in all 3–4 profiles | a throttled demo is a broken demo, not a realistic one | |
| 13 | T−24 | **Clear all notifications** so the bell is readable | as each demo user, mark all read | unread counts are 0 before the demo | |
| 14 | T−24 | **Reset the responder's state** | as dispatcher, withdraw any active assignment on the demo incident; as Yusuf, set `en_route` back by reloading the assignment view (or use a clean incident) | Yusuf is `available` with zero active assignments | |
| 15 | T−22 | **Warm the routes (cold-start avoidance)** | in each profile, load `/report`, `/dashboard`, `/map`, `/incidents/<the duplicate partner>`, `/analytics` once | the serverless instances are warm; cold p95 ≤ 2 500 ms is a real number we do not want to spend on stage | [26 §4.3](./26_PERFORMANCE_REQUIREMENTS.md) |
| 16 | T−20 | **Set the map to the demo centre** | in Window 2, `/map` → centre on `17.4478, 78.4874`, zoom 15 | the seeded incident and the cluster are in frame | `GOOGLE_MAPS_DEFAULT_CENTER=17.4478,78.4874` ([21 §2](./21_ENVIRONMENT_VARIABLES.md)) |
| 17 | T−20 | **Set the queue filter** | Window 2: `/dashboard`, filter `urgency = critical`, clear the sort to default | the queue is ready for beat 7 | [08 §3.2](./08_API_SPECIFICATION.md) |
| 18 | T−18 | **Pre-load the analytics range** | Window 2, `/analytics`, last 7 days, `include = totals,category,trend` | tiles and charts render; confirm every chart has **View as table** | [26 §2.1](./26_PERFORMANCE_REQUIREMENTS.md) |
| 19 | T−15 | **Fallback screenshot set** | capture, at 1440 px: (a) `/dashboard` queue, (b) `/map`, (c) the AI panel on the duplicate partner, (d) the duplicate panel, (e) `/analytics`, (f) `/admin/audit-logs`. Store them **offline** on a second device | 6 images, readable without a network | [27 §8](./27_HACKATHON_MVP_SCOPE.md) |
| 20 | T−15 | **Prepare the fallback text** | paste the live report text into Window 1's textarea, un-submitted | if typing is slow on stage, the text is ready to paste | |
| 21 | T−14 | **Rehearse drill 1 and drill 2** | block `maps.googleapis.com`; then block the Gemini endpoint. Confirm the fallbacks render | both degraded paths work **now** | §7 |
| 22 | T−12 | **Verify the responder payload** | Window 3, open an assigned incident, DevTools → Network → the `GET /api/incidents/<id>` response | **no** `reporterUid`, `reporter.displayName`, `reporter.email`, `locationText`, or `reports[].text`. This is the P5 evidence and it must be verified *before* the demo, not discovered on stage | [08 §3.3](./08_API_SPECIFICATION.md), FR-068 |
| 23 | T−10 | **Stage the narration** | open §4 of this document on the second device, at 150 % zoom, at the beat table | readable from 2 m | |
| 24 | T−8 | **Passwords** | confirm all 13 demo accounts are in the presenter's password manager | no password is in the repository, a screenshot, or a GitHub issue | [18 §15.3](./18_TESTING_QA_PLAN.md) |
| 25 | T−6 | **SEED — the last setup step** | `ALLOW_SEED=true npm run seed` | the dataset in §2 exists. **Running this last is deliberate:** the duplicate partner's `reportedAt` is set to 3 minutes before seed time, so seeding late keeps the live delta small | [07 §14](./07_DATABASE_SCHEMA.md), FR-147 |
| 26 | T−5 | **Re-sign-in after the seed** | the seed does **not** delete users, but it rewrites incidents. Refresh each profile | all three windows are on their start route | |
| 27 | T−4 | **Verify the duplicate partner** | Window 2, open `CG-7QK4M2` | status `triaged`, urgency `critical`, `LOCATION` shows the place name, AI panel present | |
| 28 | T−3 | **Read the health snapshot into the presenter's head** | `GET /api/admin/system/health` one last time | success, fallback, headroom all in range | |
| 29 | T−2 | **All screens to 100 % zoom, projector/laptop checked** | contrast, size, and the second display legible | — | [25](./25_ACCESSIBILITY_RESPONSIVENESS.md) |
| 30 | T−1 | **Silence notifications on the demo devices** | OS-level Do Not Disturb on the presenter's machine | a Slack or email banner mid-demo is a real failure mode | |
| 31 | T0 | **Role call** | presenter / browser driver / dashboard watcher (quota + Firestore usage) | three people, three jobs. The watcher owns "if something breaks, say so" | [27 §6.4](./27_HACKATHON_MVP_SCOPE.md) |

### 1.1 The three windows, stated once

| Window | Profile | User | Route at T0 | Viewport | What it is |
| --- | --- | --- | --- | --- | --- |
| **1** | `demo-citizen` | `priya@caregrid.demo` (Priya Nair, `citizen`) | `/report` | 390×844, touch emulation | The **reporter**. One-handed, keyboard-closed |
| **2** | `demo-dispatcher` | `meera@caregrid.demo` (Meera Rao, `dispatcher`) | `/dashboard` | 1440×900 | The **control room**. Queue, map, analytics, audit |
| **3** | `demo-responder` | `yusuf@caregrid.demo` (Yusuf Khan, `responder`) | `/dashboard` | 390×844, touch emulation | The **responder**. Assignment, en route, arrived, resolve |
| 4 (optional) | `demo-dispatcher-2` | `deepa@caregrid.demo` (Deepa Menon, `dispatcher`) | `/dashboard` | 1440×900 | The **second pair of eyes**, for the fan-out moment only |

> **Separate browser profiles, not tabs.** Two tabs in one profile share one session, so "the citizen and the dispatcher in two tabs" is the same user. This is the single most common demo-day setup mistake and it produces a demo where the roles are wrong.

---

## 2. The exact demo dataset

This is the dataset the seed creates. It is the same dataset referenced by [07 §14](./07_DATABASE_SCHEMA.md) and [18 §15.3](./18_TESTING_QA_PLAN.md), and `demoDataset()` in `tests/helpers/factories.ts` mirrors it for the emulator.

### 2.1 Place and time

| Property | Value |
| --- | --- |
| **Fictional day** | Tuesday, 2026-09-26 |
| **Demo wall-clock** | 15:38 IST (the demo "now") |
| **APP_TIMEZONE** | `Asia/Kolkata` ([21 §2](./21_ENVIRONMENT_VARIABLES.md)) |
| **Storage** | UTC Firestore `Timestamp`; ISO-8601 in the API; `Asia/Kolkata` in the UI (FR-143, FR-146) |
| **Anchor point** | `17.4478, 78.4874` — a service road beside Secunderabad Metro Gate 1. The same anchor as [07 §4.6](./07_DATABASE_SCHEMA.md) and [07 §7.2](./07_DATABASE_SCHEMA.md) |
| **Reference lengths used for the distances below** | 1° latitude ≈ 110 674 m; 1° longitude ≈ 106 234 m at this latitude |
| **Geohash-6 cell** | `9z4g0h` for the anchor and for every incident in the heatwave cluster — the same cell as [07 §4.6](./07_DATABASE_SCHEMA.md)'s `geoCells[0]` |
| **Weather context** | Third day of a declared heatwave. This is what makes 4 `heatwave` reports in one cell *plausible* rather than suspicious |

### 2.2 Users — 13 accounts

Composition matches [07 §14](./07_DATABASE_SCHEMA.md): 1 admin, 2 dispatchers, 4 responders (3 verified, 1 pending), 6 citizens.

| # | Email | Display name | Role | `users.status` | `responders.verification` | `responders.status` | Used on stage? |
| --: | --- | --- | --- | --- | --- | --- | --- |
| 1 | `admin@caregrid.demo` | Arun Iyer | `admin` | `active` | — | — | **No** — setup and Q&A only. Created by `scripts/create-admin.ts` |
| 2 | `meera@caregrid.demo` | Meera Rao | `dispatcher` | `active` | — | — | **Yes** — Window 2 |
| 3 | `deepa@caregrid.demo` | Deepa Menon | `dispatcher` | `active` | — | — | Window 4 (optional) |
| 4 | `yusuf@caregrid.demo` | Yusuf Khan | `responder` | `active` | `verified` | `available` | **Yes** — Window 3 |
| 5 | `lata@caregrid.demo` | Lata Desai | `responder` | `active` | `verified` | `available` | No — she is **rank 2** in the candidate list |
| 6 | `kiran@caregrid.demo` | Kiran B | `responder` | `active` | `verified` | `offline` | No — demonstrates the offline exclusion |
| 7 | `manoj@caregrid.demo` | Manoj P | `responder` | `pending_verification` | `pending` | `offline` | No — demonstrates the **disabled** availability switch and absence from the candidate list |
| 8 | `priya@caregrid.demo` | Priya Nair | `citizen` | `active` | — | — | **Yes** — Window 1, the live reporter |
| 9 | `ravi@caregrid.demo` | Ravi Shankar | `citizen` | `active` | — | — | No — he authored `CG-7QK4M2` and never signs in on stage |
| 10 | `sita@caregrid.demo` | Sita Devi | `citizen` | `active` | — | — | No — 2 heatwave reports |
| 11 | `anil@caregrid.demo` | Anil Gupta | `citizen` | `active` | — | — | No — 2 heatwave reports |
| 12 | `fatima@caregrid.demo` | Fatima Sheikh | `citizen` | `active` | — | — | No — the medical + community-aid reports |
| 13 | `deepu@caregrid.demo` | Deepu Rao | `citizen` | `active` | — | — | No — the flood report |

> **Passwords.** [07 §14](./07_DATABASE_SCHEMA.md) specifies a shared demo password for the demo environment; [18 §15.3](./18_TESTING_QA_PLAN.md) requires that demo passwords are **never committed** and that the E2E specs read them from `E2E_DEMO_PASSWORD` in the runner's environment. Both are satisfiable: the shared password exists only in a non-production project, and it is never committed. **`DECISION REQUIRED`:** the two documents should be reconciled on whether the value is written in documentation or held only in the password manager. This document does not print a password; §1 step 24 assumes it is in the presenter's password manager.

### 2.3 Incidents — 10 seeded, 1 created on stage

`Δ from anchor` is the Haversine distance from `17.4478, 78.4874`, rounded to the metre. A spherical-earth implementation differs from a WGS-84 reference by well under 1 % (TC-DUP-001b), so these are the numbers the UI will show.

| Reference | Category | Urgency | Status | Coordinates | Δ from anchor | Reporter | `reportedAt` (IST) | Role in the demo |
| --- | --- | --- | --- | --- | --: | --- | --- | --- |
| **`CG-7QK4M2`** | `traffic_accident` | `critical` | `triaged` | `17.4478, 78.4874` | 0 m | Ravi Shankar (#9) | 15:35:00 | **The duplicate partner and the map anchor** |
| **(created live)** | `traffic_accident` | `critical` | `new` → `triaged` | `17.4490, 78.4878` | **140 m** | Priya Nair (#8) | 15:38:10 | **Created on stage.** Triggers the duplicate |
| `CG-HW2K9P` | `heatwave` | `high` | `triaged` | `17.4461, 78.4862` | 227 m | Sita Devi (#10) | 14:26:20 | Heatwave cluster |
| `CG-HW4M3R` | `heatwave` | `high` | `triaged` | `17.4485, 78.4855` | 216 m | Anil Gupta (#11) | 14:31:05 | Heatwave cluster |
| `CG-HW7T5V` | `heatwave` | `medium` | `triaged` | `17.4501, 78.4890` | 306 m | Sita Devi (#10) | 14:35:40 | Heatwave cluster |
| `CG-HW9W8X` | `heatwave` | `medium` | `triaged` | `17.4453, 78.4884` | 296 m | Anil Gupta (#11) | 14:39:15 | Heatwave cluster. **Also the FR-048 case**: same cell as `CG-7QK4M2`, different category |
| `CG-MS8H5C` | `missing_person` | `high` | `verified` | `17.4489, 78.4888` | 250 m | Fatima Sheikh (#12) | 14:52:00 | `child_at_risk` flag; the second `verified` incident in the queue |
| `CG-MP3D6L` | `medical` | `high` | `resolved` | `17.4512, 78.4836` | 552 m | Fatima Sheikh (#12) | yesterday 14:12, resolved yesterday 15:04 | Background. **Outside the 500 m radius** → `none` / `outside_radius` |
| `CG-EN5B2Q` | `infrastructure` | `medium` | `triaged` | `17.4440, 78.4905` | 534 m | Deepu Rao (#13) | 14:40:00 | Background. A transformer fire in the block |
| `CG-FL1A4S` | `flood` | `medium` | `triaged` | `17.4432, 78.4840` | 624 m | Deepu Rao (#13) | 14:44:30 | Background. Waterlogging on the service road |
| `CG-CA3D7W` | `community_aid` | `low` | `triaged` | `17.4503, 78.4870` | 295 m | Fatima Sheikh (#12) | 14:57:45 | Background. **The only `low` urgency**, so the default sort visibly puts it last |

**Cluster integrity:** all four `heatwave` incidents are within 310 m of the anchor, so all four sit in geohash-6 `9z4g0h`. This is what makes the analytics beat real (a genuine category spike in one cell) **and** what forces the duplicate engine to prove itself: the live report's single `array-contains` query returns five candidates in the same cell, and it must reject four of them.

### 2.4 The two texts, verbatim

These two strings are the demo's most important data. They are chosen so the **real** algorithm produces `confirmed_duplicate` on its own arithmetic — not because anything was staged.

**`CG-7QK4M2` — `originalText` (Ravi, 15:35:00, verbatim, never rewritten — FR-003):**

```
big accident on the service road near the metro gate, a car is stuck and someone is crying inside, please send help fast
```

**The live report — `originalText` (Priya, 15:38:10, verbatim):**

```
there is an accident on the service road near the metro gate, a car is stuck and a woman is crying inside the car, please help fast
```

### 2.5 The duplicate arithmetic, so the demo is not a staged result

This is [07 §9.4](./07_DATABASE_SCHEMA.md) applied to the two texts above, with the seed defaults (`duplicateRadiusM: 500`, `duplicateTimeWindowMin: 360`, `textSimilarityConfirm: 0.60`, `duplicatePotentialThreshold: 0.55`, `algorithmVersion: 'dedupe-v1'`).

**Tokenisation** — lowercase, punctuation stripped, stopwords and digit-only tokens dropped, whitespace collapsed, each side capped at 60 tokens ([07 §9.4](./07_DATABASE_SCHEMA.md) Gate 3):

| Set | Tokens | Count |
| --- | --- | --: |
| A (Ravi) | big, accident, service, road, metro, gate, car, stuck, **someone**, crying, inside, **send**, help, fast | 14 |
| B (Priya) | accident, service, road, metro, gate, car, stuck, **woman**, crying, inside, help, fast | 12 |
| Intersection | accident, service, road, metro, gate, car, stuck, crying, inside, help, fast | 11 |
| Union | — | 15 |

**`textSimilarity` = 11 / 15 = 0.733**

**Scoring:**

| Term | Weight | Value | Contribution |
| --- | --: | ---: | --: |
| `sDist` = `1 − 140/500` | 0.35 | 0.720 | 0.2520 |
| `sTime` = `1 − 3.17/360` | 0.10 | 0.9912 | 0.0991 |
| `sCat` (exact category, `traffic_accident`) | 0.25 | 1.000 | 0.2500 |
| `sText` | 0.30 | 0.733 | 0.2199 |
| **`score`** | | | **0.8210** |

`CG-7QK4M2.reportCount == 1`, so the multi-report `+0.05` nudge does **not** apply.

**Decision:** `exactCategory && textSimilarity (0.733) ≥ textSimilarityConfirm (0.60)` ⇒ **`confirmed_duplicate`**
**`reasons`:** `['within_radius', 'category_match', 'high_text_similarity']`
**`algorithmVersion`:** `'dedupe-v1'`

**Robustness — why this is not knife-edge.** The result depends on the similarity clearing 0.60, and the observed value is 0.733. Under any plausible 60-word English stopword list the value moves within roughly 0.70–0.79: even if `big`, `someone`, and `send` were all *kept* as content words and `woman` were treated as a stopword, the intersection is still 11 and the union at most 16, giving 0.688. **The decision is stable across every reasonable stopword list.** `DR-08` records the stopword list's provenance as an open item, and this is the honest statement of its current impact.

**The four rejections, which are the harder half.** The same query also returns four `heatwave` incidents in the same cell. Each is rejected at Gate 2 (category) *before* text similarity is computed:

| Candidate | Δ | Gate 0 (time) | Gate 1 (radius) | Gate 2 (category) | Result |
| --- | --: | --- | --- | --- | --- |
| `CG-HW4M3R` | 250 m | pass | pass | `heatwave` ≠ `traffic_accident`; groups `weather` vs `road` | **`separate_incident`**, `reasons: ['category_mismatch']` (FR-048) |
| `CG-HW9W8X` | 296 m | pass | pass | same | **`separate_incident`** |
| `CG-HW7T5V` | 306 m | pass | pass | same | **`separate_incident`** |
| `CG-HW2K9P` | 227 m | pass | pass | same | **`separate_incident`** |
| `CG-MP3D6L` | 552 m | pass | **fail** | — | **`none`**, `reasons: ['outside_radius']`, `score: 0` |
| `CG-EN5B2Q` | 534 m | pass | **fail** | — | **`none`**, `outside_radius` |
| `CG-FL1A4S` | 624 m | pass | **fail** | — | **`none`**, `outside_radius` |
| `CG-CA3D7W` | 295 m | pass | pass | `community_aid` vs `traffic_accident` | **`separate_incident`** |
| `CG-MS8H5C` | 250 m | pass | pass | `missing_person` vs `traffic_accident` | **`separate_incident`** |

> **This table is the real argument, and it is available on stage.** The dispatcher panel shows the *winning* breakdown. If a judge asks "how do you know it did not just merge the heatwave reports too", the answer is that the category gate runs before the text gate, and the reasoning is in [07 §9.4](./07_DATABASE_SCHEMA.md) Gate 2. That is a better answer than a demo that only ever had one candidate.

**Consistency note, recorded honestly.** [07 §4.6](./07_DATABASE_SCHEMA.md)'s illustrative `duplicateBreakdown` shows `textSimilarity: 0.68` with `duplicateScore: 0.91`. The **normative** formula in [07 §9.4](./07_DATABASE_SCHEMA.md) yields `0.85` for those same inputs with `reportCount: 2`, not `0.91`. §9.4 is normative; §4.6's example is illustrative. The demo dataset is computed from §9.4 and its numbers are the ones the UI will display.

**`requiredResources` on `CG-7QK4M2`** — deliberately different from [07 §4.6](./07_DATABASE_SCHEMA.md)'s illustrative example, so that the rank-1 candidate is a real capability match:

```json
[
  { "resourceId": "res_ambulance",       "quantity": 1, "confidence": 0.81, "source": "ai" },
  { "resourceId": "res_traffic_control", "quantity": 1, "confidence": 0.72, "source": "ai" }
]
```

Yusuf's `capabilities` are `['res_ambulance', 'res_first_aid', 'res_traffic_control']`, so `capabilityMatch: true`, `missingResources: []` ([08 §3.7](./08_API_SPECIFICATION.md)).

### 2.6 The live report's expected triage output

Read from the screen, not asserted. The values below are the **expected** shape; the narration quotes whatever appears.

| Field | Expected | Note |
| --- | --- | --- |
| `category` | `traffic_accident` | one of the 11 controlled values |
| `urgency` | `critical` | from `medical_critical` (R1) or a trapped-expression match (R2). The AI may propose `high`; **the deterministic rule raises it** ([09 §5.3](./09_AI_GEMINI_SPECIFICATION.md)). This is worth narrating: the safety rules are in code, not in the prompt |
| `aiConfidence` | 0.75–0.90 | varies run to run; the band is what matters (≥ 0.80 high, 0.60–0.79 medium, < 0.60 **Needs review**) |
| `safetyFlags` | includes `medical_critical`, `injured_tracked`→`injured_trapped` | [07 §4.5](./07_DATABASE_SCHEMA.md) |
| `peopleAffected` | `2` **or** `null` | FR-023: `2` only if the reporter stated or clearly implied a count. Priya's text says "a car" and "a woman" — countable. **If the model returns `null`, that is correct behaviour and worth narrating** |
| `requiredResources` | ambulance + traffic control, `confidence ≤ 0.5` unless explicitly requested | FR-023: inferred needs are capped |
| `language` | `en` | |
| `location_hint` | "near a metro station" or similar, ≤ 120 chars, **never persisted** | TC-AI-006. The incident's `geo` comes from the device, never from the model — the most important AI property in the product |
| `slaTargetMin` | `5` | `critical` |
| `slaState` | `on_track` | clock starts at `verifiedAt ?? createdAt` |
| `duplicateStatus` | `confirmed_duplicate` | §2.5 |

### 2.7 Responders — 4

| Responder | `uid` | Verification | Status | Capabilities | `serviceRadiusM` | Coordinates | `Δ` from `CG-7QK4M2` | `lastLocationAt` | Role |
| --- | --- | --- | --- | --- | --: | --- | --: | --- | --- |
| **Yusuf Khan** | `u_4Kd8sTn` | `verified` | `available` | `res_ambulance`, `res_first_aid`, `res_traffic_control` | 5 000 | `17.4535, 78.4880` | **634 m** | 40 s ago | **Rank 1** — the assignment |
| Lata Desai | `u_5Ee3uWp` | `verified` | `available` | `res_first_aid`, `res_food_water_kit` | 5 000 | `17.4550, 78.4900` | 843 m | 2 min ago | **Rank 2** — makes the list a *ranking* |
| Kiran B | `u_6Kf4xRq` | `verified` | `offline` | `res_power_team`, `res_water_rescue` | 5 000 | `17.4410, 78.4790` | 1 168 m | 3 h ago, `stale: true` | **Absent** from the list — `offline` (FR-081) |
| Manoj P | `u_7Lg5ySr` | **`pending`** | `offline` | `res_first_aid` | 5 000 | `17.4520, 78.4950` | 932 m | never | **Absent** — unverified (FR-064). His availability switch is disabled with "Your account is awaiting admin verification" |

`homeBaseGeoCells` for each is the same 10-cell footprint as an incident's `geoCells` ([07 §7.1](./07_DATABASE_SCHEMA.md)).

**Expected candidate list** from `GET /api/incidents/<id>/dispatch/candidates` — sorted by `distanceM` ascending, then `lastLocationAt` descending; ≤ 10 returned; `consideredCount` from a `limit(60)` read:

| Rank | Responder | `distanceM` | `capabilityMatch` | `missingResources` | `staleLocation` | `activeIncidentCount` / `max` |
| --: | --- | --: | :-: | --- | :-: | --- |
| 1 | Yusuf Khan | 634 | ✔ | `[]` | `false` | 0 / 1 |
| 2 | Lata Desai | 843 | ✖ | `['res_ambulance', 'res_traffic_control']` | `false` | 0 / 1 |

### 2.8 Evidence

| Incident | `evidenceCount` | Media | Notes |
| --- | --: | --- | --- |
| `CG-7QK4M2` | **3** | 2 × JPEG, 1 × `audio/webm` | 18 s voice note: *"there's a car stuck in the service road, someone is crying, please hurry"*. Matches [07 §4.6](./07_DATABASE_SCHEMA.md) and matches [18 §9.3](./18_TESTING_QA_PLAN.md)'s golden file **G1** |
| The live report | **1** | 1 × JPEG | Attached on stage. ~180 KB, 1280×960 |
| Everything else | 0 | — | `evidenceCount: 0` incidents are real and are what makes the `evidenceCount > 0` rule in [22 §4.1](./22_USER_ROLES_PERMISSIONS.md) meaningful |

Media paths follow [08 §8.1](./08_API_SPECIFICATION.md): the signed upload writes to `staging/{uid}/{mediaId}.{ext}`, and `POST /api/incidents` **moves** the verified object to `incidents/{incidentId}/reports/{reportId}/{mediaId}.{ext}`. Every read is a fresh 15-minute signed URL; there is no public URL anywhere.

Seed-supplied media assets live under `public/demo/` ([20 §2](./20_PROJECT_FOLDER_STRUCTURE.md)), are copied into the bucket by `scripts/seed.ts`, and are **not** in the repository as real photographs — they are synthetic placeholder images with the right magic bytes.

### 2.9 Analytics rollups

14 documents, `analyticsDaily/2026-09-13` … `analyticsDaily/2026-09-26`, in `APP_TIMEZONE` day buckets ([07 §11.7](./07_DATABASE_SCHEMA.md)).

| Property | Value |
| --- | --- |
| `completeness` | `"final"` for 2026-09-13 … 2026-09-25; `"partial"` for 2026-09-26 |
| Daily volume | 4–9 incidents, rising over the 14 days as the heatwave builds |
| `topLocations` | `[{ "geohash6": "9z4g0h", "count": <daily> }]` — **the same cell as the demo incident**, so the heat list has a real entry |
| `byCategory` | dominated by `heatwave` in the last 3 days — **a visible spike**, which is the analytics beat |
| `aiFallbackCount` | 1 on 2026-09-19, 0 elsewhere — so the "AI fallback rate 4.2 %" tile is a real number, not a zero |
| `aiAvgConfidence` | 0.76–0.84 |
| `sumVerifySec` / `sumDispatchSec` / `sumResolveSec` | non-zero, so the three mean-time tiles are real |
| `slaBreachedCount` | 1 on 2026-09-22, 0 otherwise |
| `resources` catalogue | 12 entries ([07 §11.1](./07_DATABASE_SCHEMA.md)) |

A 7-day range therefore reports `range.source: "rollup"` and costs **7 reads**. A range ending within 48 h reports `"live"`, caps at 500 reads, and sets `truncated: true` if capped (FR-116).

### 2.10 `config/app` (seeded)

```jsonc
{
  "schemaVersion": 1,
  "appName": "CareGrid AI",
  "appTimezone": "Asia/Kolkata",
  "defaultTimezone": "Asia/Kolkata",
  "slaMinutes": { "critical": 5, "high": 15, "medium": 60, "low": 240 },
  "duplicate": {
    "duplicateRadiusM": 500,            // DEC-01
    "duplicateTimeWindowMin": 360,      // DEC-02
    "textSimilarityConfirm": 0.6,
    "duplicatePotentialThreshold": 0.55,
    "duplicateMaxCandidates": 50,
    "algorithmVersion": "dedupe-v1"
  },
  "notifications": { "channels": { "inApp": true, "sms": false, "whatsapp": false, "email": false } },
  "realtime": { "slaWarnPct": 80, "staleLocationMin": 15, "responderHeartbeatSec": 60 },
  "risk":      { "weightDensity": 0.5, "weightSeverity": 0.35, "halfLifeDays": 14, "windowDays": 14, "enabled": false },
  "features":  { "voice": false, "image": true, "clusters": false, "riskZones": false, "bulkActions": false },
  "retention": { "locationPurgeDays": 90, "auditDays": 365 }
}
```

> `features.voice: false` and `clusters: false` are the **post-cut** values ([27 §2.1](./27_HACKATHON_MVP_SCOPE.md)). If voice and clustering are built, set them `true` — and re-verify the map bundle budget, because clustering lives in the B-3 lazy chunk.

---

## 3. The 14 beats

| Beat | FR / NFR demonstrated | FR IDs | Window | Target time |
| --: | --- | --- | :-: | --: |
| 1 | Submit a report | FR-001, FR-002, FR-003, FR-017 | 1 | 0:20–0:50 |
| 2 | AI analyse | FR-020, FR-028 | 1 | 0:50–1:05 |
| 3 | Category + urgency | FR-025, FR-026, FR-024 | 1 | 1:05–1:20 |
| 4 | Location | FR-030, FR-031, FR-032, FR-035 | 1 | 1:20–1:40 |
| 5 | **Duplicate detected** | FR-040…FR-044, FR-048 | 1 → 2 | 1:40–2:00 |
| 6 | Incident on the map | FR-080, FR-081, FR-083 | 2 | 2:00–2:15 |
| 7 | Dispatcher sees critical | FR-070, FR-072, FR-075 | 2 | 2:15–2:35 |
| 8 | Nearby responder | FR-065, FR-074 | 2 | 2:35–2:50 |
| 9 | Assign | FR-053, FR-074 | 2 | 2:50–3:05 |
| 10 | Realtime assignment | FR-090, FR-100, FR-101, FR-108 | 3 | 3:05–3:20 |
| 11 | Responder status change | FR-055, FR-061, FR-067 | 3 | 3:20–3:40 |
| 12 | Dispatcher live update | FR-090, FR-072, FR-057 | 2 | 3:40–3:55 |
| 13 | Resolve | FR-054, FR-057 | 3 → 2 | 3:55–4:10 |
| 14 | Analytics update | FR-110, FR-111, FR-112, FR-116 | 2 | 4:10–4:30 |

---

## 4. The second-by-second script

Total **4 min 30 s** core, plus 30 s of buffer, inside a 5-minute slot. Every narration line is written to be spoken in the time given at ~150 wpm.

> **Verbatim narration is in bold.** Point-at targets are marked ▸. The presenter's eyes are on the narrator, not the screen; the browser driver performs the clicks. If there is one person, the narration carries the demo and the clicks are silent.

### Beat 0 — t = 0:00 – 0:20 · Hook and framing

**Window:** 2 (dispatcher) on `/dashboard`.

| | |
| --- | --- |
| **Action** | None. Hold on the queue. |
| **On screen** | The dispatcher queue, 11 rows, KPI tiles with as-of times. |
| ▸ **Point at** | The KPI strip: **Active 11 · Unassigned 6 · Critical 3 · Breached 0 · Responders available 2** |
| **Narration (verbatim)** | **"This is a demonstration system, not a certified emergency dispatch system. It is 3:38 on a Tuesday evening in Secunderabad, the third day of a heatwave. Eleven reports are in the queue. Six of them have nobody assigned. Two people are marked available. We have five minutes — let's watch what happens when a thirteenth report comes in."** |

> The disclaimer is **not optional**. [09 §13](./09_AI_GEMINI_SPECIFICATION.md) requires it, and saying it first converts the strongest possible framing: a judge who hears a team disclaim their own product in the first sentence trusts everything after it.

### Beat 1 — t = 0:20 – 0:50 · **Submit a report** (30 s)

**Window:** 1 (citizen, 390×844, touch).

| | |
| --- | --- |
| **Action** | Tap **Use my current location** → permission granted → wait for the badge. Then **paste** the pre-staged text into the textarea (or type the first line if pasting looks awkward). Then tap the camera chip and pick the pre-staged photo. Then tap **Submit report**. |
| **On screen** | Location badge reads **High accuracy** · accuracy 34 m · counter above 20 chars · Submit enabled · per-file upload progress on the photo chip · then the progress state **"Analysing your report…"** |
| ▸ **Point at** | The **accuracy badge** — it says "High accuracy", not "located" |
| **Narration (verbatim)** | **"A citizen types what they can. They are not asked to pick a category, or to write a street name, or to know who to call. One button for location, one box for text, one photo if they have it. Notice the accuracy badge — 34 metres. We grade accuracy and we show it, because a dispatcher will trust a location differently at 34 metres than at a kilometre."** |

> **If typing is slow:** paste. Do not narrate over a 25-second pause. §7's drill 4 covers the failure.

### Beat 2 — t = 0:50 – 1:05 · **AI analyse** (15 s)

**Window:** 1, same route, progress state.

| | |
| --- | --- |
| **Action** | None. Wait. |
| **On screen** | **"Analysing your report…"** with the reference reserved. Then the success screen. |
| ▸ **Point at** | The progress copy itself |
| **Narration (verbatim)** | **"That wait is Gemini. Text, image, and GPS go into one call, and it comes back as a fixed JSON schema — a category, an urgency, a summary, a self-reported confidence. If it times out at twenty seconds, the report is still saved, with a fallback triage and a Needs-review badge. Reporting never fails because the AI failed. That is a requirement, not a hope."** |

### Beat 3 — t = 1:05 – 1:20 · **Category and urgency** (15 s)

**Window:** 1, success screen.

| | |
| --- | --- |
| **Action** | Tap **Copy reference**, then **Track this report**. |
| **On screen** | The reference `CG-XXXXXX` in a `role="status"` heading. Then `/track` shows category, urgency, status, last update, and a "what happens next" line. |
| ▸ **Point at** | The **urgency badge** and, if present, the **Needs review** state |
| **Narration (verbatim)** | **"There is the reference — the citizen can quote it or share it. The AI returned *traffic accident, critical*. But look at where that urgency came from: a deterministic rule in our code, not the model. The model may only ever raise urgency. Only a human can lower it."** |

> If the model returned `urgency: high` and the rule raised it to `critical`, say so — it is a **better** answer than a model that happened to be right.

### Beat 4 — t = 1:20 – 1:40 · **Location** (20 s)

**Window:** 1, `/track` → then back to `/report` (or use the second window).

| | |
| --- | --- |
| **Action** | On `/track`, point at the place name. Then, in Window 2, open `CG-7QK4M2` and open the map side panel for it. |
| **On screen** | `placeName`: **"Service Road, near Secunderabad Metro Gate 1"** · on the incident, **Location: GPS, 34 m, High accuracy** |
| ▸ **Point at** | The place name, then the **accuracy + source** pair |
| **Narration (verbatim)** | **"The server reverse-geocoded those coordinates into a place label. Two things worth saying. First, that street-level label never went to the model — only a district-level one, so the AI can tell that 'near the metro gate' is a real reference without ever seeing an address. Second, if the citizen had denied location, this incident would be flagged LOCATION UNKNOWN and would sort to the top of the dispatcher's queue, because an unlocated emergency is a worse emergency."** |

### Beat 5 — t = 1:40 – 2:00 · **Duplicate detected** — THE TURN (20 s)

**Window:** 1 (`/track`), then 2.

| | |
| --- | --- |
| **Action** | Window 1: the citizen's own duplicate notice appears on the success screen. Then **switch to Window 2** and open the new incident. |
| **On screen** | Citizen side: **"There may already be a report for this — add my details to it, or this is a different incident."**<br>Dispatcher side: the duplicate panel — **"Possible duplicate of CG-7QK4M2 · 140 m · 3 min earlier · same category"**, with **Link report** and **Dismiss**, and the full breakdown: `distanceM 140`, `timeDeltaMin 3`, `textSimilarity 0.73`, `matchedKeywords [accident, service, road, stuck, crying, car, metro, gate, inside, help, fast]`, `algorithmVersion dedupe-v1` |
| ▸ **Point at** | The **breakdown numbers**, not the panel. The numbers are the proof. |
| **Narration (verbatim)** | **"Three minutes after Ravi reported that collision, a hundred and forty metres away, Priya reported the same collision. Our system worked that out before either of us read the second one. Radius, time window, category, and a text-similarity score — 0.73, because the two descriptions share eleven content words. That is a suggestion, not a merge. A human decides. And notice what it did *not* do: there are four heatwave reports in the same cell, and it rejected all four, because a different category is never a duplicate."** |

> **This is the beat.** If it is cut, the story loses its turn. [27 §4.2](./27_HACKATHON_MVP_SCOPE.md) protects it.
>
> **Time-delta honesty.** `timeDeltaMin` is **read from the screen**. The seed sets the partner's `reportedAt` to 3 minutes before seed time; because the seed runs at T−6, the observed delta is typically 5–10 minutes. Narrate the number you see. The classification is insensitive to it: the time term moves the score by ~0.006 across a 20-minute delta, nowhere near the 0.60 threshold.

### Beat 6 — t = 2:00 – 2:15 · **Incident on the map** (15 s)

**Window:** 2, `/map`.

| | |
| --- | --- |
| **Action** | Open `/map`. The new incident's marker appears. Click the marker. |
| **On screen** | Markers coloured by **urgency** and **shaped by status**. The new incident is a red critical marker. The 4 heatwave reports are an amber cluster in the same cell. Clicking opens a side panel with the summary and **Open incident** — the route does not change. |
| ▸ **Point at** | The **shape difference** between statuses, not the colour |
| **Narration (verbatim)** | **"Same data, spatially. Colour carries urgency; shape carries status, so it is readable without colour vision. Four heatwave reports in one cell — that is the heatwave, and we can see it before anyone called it a pattern."** |

> If the map is cut ([27 §4.2](./27_HACKATHON_MVP_SCOPE.md) cut 16) or is failing (drill 1), the side panel's content is delivered from the incident detail page and the narration becomes: *"Maps are off — deliberately, so you can see the degradation path. The list view has the same coordinates, and it is the accessible equivalent, not a degraded mode."*

### Beat 7 — t = 2:15 – 2:35 · **Dispatcher sees critical** (20 s)

**Window:** 2, `/dashboard`, filter `urgency = critical, unassigned = true`.

| | |
| --- | --- |
| **Action** | Back to `/dashboard`. The filter chips are pre-set. The new incident is **already at the top of the queue — no refresh.** Open it. |
| **On screen** | The queue row: reference · category icon · urgency badge · **AI triaged** source badge · confidence 0.83 · status · distance · reporter count **2** · SLA meter 4 min / 5 min · no assignee.<br>The detail page: the AI panel — **model `gemini-2.5-flash`, prompt `triage-v3`, confidence 0.83**, and a plain-language explanation naming the rule that raised the urgency. Plus **2 reports** listed: Ravi's and Priya's. |
| ▸ **Point at** | The **source badge** (`AI triaged`, never `Human verified` — those are different things) and then the **explanation sentence** |
| **Narration (verbatim)** | **"That row was in the queue before I touched anything — Firestore pushed it, no polling, no refresh. Two reporters on one incident. And look at the badge: *AI triaged*, not *human verified*. Every row tells you which of those it is, and the AI panel shows the model, the prompt version, and the confidence — with a sentence explaining what the confidence means. A dispatcher should never have to guess whether they are looking at a fact or an estimate."** |

### Beat 8 — t = 2:35 – 2:50 · **Nearby responder** (15 s)

**Window:** 2, the incident's **Assign responder** panel.

| | |
| --- | --- |
| **Action** | Click **Assign responder**. |
| **On screen** | Two candidates: **Yusuf Khan · 634 m · capability match · 0 of 1 active** and **Lata Desai · 843 m · missing ambulance and traffic control**. No third and fourth entries. |
| ▸ **Point at** | The **absence**. Then the `missingResources` cell on rank 2. |
| **Narration (verbatim)** | **"Nearest verified responder, ranked. Yusuf at 634 metres, with the capabilities this incident needs. Second is 843 metres and missing an ambulance, so she is not a match. Two other responders exist and neither appears: one is offline, and one is still pending admin verification. Unverified responders are never offerable — the candidate list is not an error, it is a filter."** |

> **Optional 8b — the pending-responder proof (10 s, if the time budget allows).** Switch to a window signed in as `manoj@caregrid.demo` and show the availability switch disabled with *"Your account is awaiting admin verification."* This is FR-064 made visible.

### Beat 9 — t = 2:50 – 3:05 · **Assign** (15 s)

**Window:** 2.

| | |
| --- | --- |
| **Action** | Click **Assign** on rank 1. |
| **On screen** | The incident status becomes **`assigned`**. A toast: *"Assigned to Yusuf Khan — Undo"* for 10 s. The SLA meter continues. |
| ▸ **Point at** | The **status change** and the assignee's name in the row |
| **Narration (verbatim)** | **"One click. The incident is now assigned, the responder is marked busy, and — this is the part that matters — the dispatch is written by a transaction, so if two dispatchers hit assign at the same instant, exactly one assignment survives. The other gets a conflict, not a second responder sent to one accident."** |

### Beat 10 — t = 3:05 – 3:20 · **Realtime assignment** (15 s)

**Window:** 3 (responder), then Window 2.

| | |
| --- | --- |
| **Action** | **Switch to Window 3.** The assignment is already there. |
| **On screen** | A `critical` notification banner: **`CG-…` · Traffic accident · CRITICAL · 634 m · Open in maps · Accept.** The bell shows **1 unread**. |
| ▸ **Point at** | The **distance and category** in the notification, then the bell count |
| **Narration (verbatim)** | **"Yusuf has it. Within three seconds, on a phone, with a notification that tells him what, how bad, and how far. It does not tell him who reported it. The citizen's identity is not in his payload at all — that is enforced on the server and it is tested, not just intended. I can show you the network response if you want to see the field is genuinely absent."** |

> **This is the moment to pause if Window 4 exists.** Meera's second dispatcher window (Deepa) shows the same incident appearing without a refresh. One sentence: *"And that just landed on a second dispatcher, also without a refresh."* Then close Window 4.

### Beat 11 — t = 3:20 – 3:40 · **Responder status change** (20 s)

**Window:** 3.

| | |
| --- | --- |
| **Action** | Tap **Accept**. Then tap **I'm en route**. Then tap **I've arrived**. |
| **On screen** | After accept: the incident opens, showing reference, category, urgency, distance, **Open in maps**, and the single primary action **I'm en route** — and nothing else.<br>After en route: the action becomes **I've arrived**.<br>After arrived: the action becomes **Resolve**. |
| ▸ **Point at** | The **single primary action** changing — one button, one next step |
| **Narration (verbatim)** | **"One button, one next permitted action. The transition table lives in code, eleven by eleven, and it is enforced on the server — an illegal move is rejected, not hidden. The same table is what decides which button we render, so the interface cannot offer an action the server would refuse."** |

> Optional, 10 s: the note field — *"two cars, one casualty conscious, bringing the kit"*. Shows the 280-character bounded note.

### Beat 12 — t = 3:40 – 3:55 · **Dispatcher live update** (15 s)

**Window:** 2.

| | |
| --- | --- |
| **Action** | None needed — the queue has already updated. Land on the queue. |
| **On screen** | The row reads **`on_scene`**, assignee Yusuf Khan, with a brief row highlight. The status history shows the full chain: `created` → `ai_triaged` → `assigned` → `en_route` → `on_scene`, each with actor, role, timestamp, and a request id. |
| ▸ **Point at** | The **status history timeline** — five events, five actors, five request ids |
| **Narration (verbatim)** | **"I did not refresh this. The whole transition chain is on one timeline, and every event has an actor, a role, a timestamp, and a request id — so any answer to 'what happened here' is reconstructable. That is the audit trail, and it is append-only: no role, including an admin, can edit or delete a line of it."** |

### Beat 13 — t = 3:55 – 4:10 · **Resolve** (15 s)

**Window:** 3, then 2.

| | |
| --- | --- |
| **Action** | Window 3: tap **Resolve**, pick **`resolved_safe`**, type a one-line note, confirm. Then switch to Window 2. |
| **On screen** | The responder's action is gone. In Window 2 the row reads **`resolved`**, `resolutionCode: resolved_safe`, `resolvedAt` set, `arrivedAt` set, `respondedAt` set. The SLA meter reads **within target**. |
| ▸ **Point at** | The three timestamps — `respondedAt`, `arrivedAt`, `resolvedAt` — and the **SLA meter** |
| **Narration (verbatim)** | **"Resolved, with a reason code from a controlled list — that is what makes the analytics meaningful. Three timestamps: en route, arrived, resolved. The SLA clock started at verification, and for a critical incident the target is five minutes. We did not breach it."** |

### Beat 14 — t = 4:10 – 4:30 · **Analytics update** (20 s)

**Window:** 2, `/analytics`.

| | |
| --- | --- |
| **Action** | Open `/analytics`, last 7 days. |
| **On screen** | Tiles: total, active, critical, resolved, cancellation rate, false-alarm rate, **mean time to verify / dispatch / resolve**, **SLA compliance %**.<br>The category chart with a visible **heatwave** spike. The trend chart over 7 days. Every chart has a **View as table** control. |
| ▸ **Point at** | The **heatwave spike** in the category chart, then the mean-time-to-resolve tile |
| **Narration (verbatim)** | **"One incident just became a row in a daily rollup. This seven-day view costs about seven reads, because it is served from precomputed rollups rather than scanning incidents — and that is the design decision that keeps us inside the free tier. And that spike is the heatwave. The queue gave us eleven unrelated-looking reports; the rollup gives us a pattern. That is the whole reason the data model has both."** |

### Close — t = 4:30

**Narration (verbatim):** **"That is CareGrid AI: unstructured panic-typed reports in, a de-duplicated, prioritised, assigned incident out, and an auditable record that outlives the incident. We run at zero dollars on free tiers, with one hard budget alert on the one thing that could cost money. We are happy to take questions."**

---

## 5. Live network versus recorded fallback

### 5.1 The three principles

| # | Principle | Why |
| --: | --- | --- |
| F1 | **Degrade loudly, never silently** | If a fallback is showing, say so, and name what is degraded. The product's premise is trust, and a demo that hides degradation teaches the opposite lesson |
| F2 | **A recording is fine when it is labelled** | "This is a recording from yesterday's rehearsal, because the network in this room is unreliable" is honest and professional. Playing a recording as if it were live is not |
| F3 | **The architecture is always available as a fallback** | When the product will not run, the *design* still demos. This is the "narrate the architecture instead" path, and it is a legitimate 60 seconds of a 5-minute slot |

### 5.2 What fails, what to do, and what to say

| Failure | Detection | The action | The words (verbatim) | Time cost |
| --- | --- | --- | --- | --: |
| **Maps script will not load** | the map area stays a skeleton for ~5 s, then the fallback | keep going; the incident detail has the coordinates | **"Maps are off — deliberately, so you can see the degradation path. The list view is the accessible equivalent, not a broken mode."** | 0 s |
| **Maps key not authorised for the new host** | `RefererNotAllowedMapError` in the console | the same; this is a Google Cloud configuration problem, not an app problem | **"That's a key restriction doing its job — the browser key is restricted to the deploy host, and this host is not on the list. Which is what we want."** | 0 s |
| **Gemini is slow (> 8 s)** | the "Analysing your report…" state lingers | keep waiting; the 20 s hard timeout produces a fallback | **"Triage is running long. At twenty seconds it will time out and the report will still be saved with the deterministic keyword fallback and a Needs-review badge. That is FR-029 working, not failing."** | 0 s |
| **Gemini quota exhausted (429)** | the incident appears with a **Fallback triage** badge and `urgency: medium` | switch the narrative to the fallback as a feature | **"The local quota guard tripped, so triage just ran on the deterministic keyword path. Look at the badge and the confidence — it is capped at 0.55 by design, so it is badged Needs review. The report was never at risk."** | 0 s, and it is a *good* moment |
| **The whole network drops mid-demo** | everything freezes; the reconnect banner appears | switch to the architecture narration (§5.3) and then the screenshots | **"We have lost the network in this room. Let me tell you what you were looking at, and then I will show you the same screen from the rehearsal."** | 20 s |
| **Firestore listeners stop** | the reconnect banner; the queue is stale | refresh once, and **say the word "refresh" out loud** | **"That is a manual refresh. Without it, the commit-to-paint is about a second and a half, and the requirement is three."** | 2 s |
| **Storage upload fails** | per-file error on the chip; other files survive | remove the photo and submit text-only. The report is still complete | **"The upload failed, the file is rejected on its own chip, and my text and my other files are untouched. Text-only reporting is fully supported — that is the point of the design."** | 5 s |
| **The AI is blocked by a safety filter** | `urgency ≥ high`, `low_confidence` added | continue; narrate it | **"That report tripped a safety filter, so we forced the urgency up and badged it for review. A citizen describing something frightening enough to trip a filter needs a human. The incident still exists."** | 0 s |
| **The whole app 500s** | Vercel runtime log shows it; the watcher sees it | go to §5.3, then the screenshots | — | 20 s |
| **Nothing can be recovered** | — | run the **60-second version** (§8), then Q&A from [28](./28_FUTURE_ROADMAP.md) and §9 | — | 60 s |

### 5.3 The "narrate the architecture instead" path — 20 seconds, verbatim

> **"Here is the shape of it while we wait. A Next.js app on the edge serves both the UI and the API — one deploy, one rollback. Every write goes to Firestore through the server, never from the browser, so roles are authoritative rather than asserted. Uploads go straight from the browser to Storage on a signed URL, so a fifteen-megabyte voice note never touches our function. Gemini is a decision-support component behind a strict schema; it can raise urgency and it cannot dispatch anything. And the realtime path is Firestore listeners, not polling — which costs zero serverless invocations and exactly one read per changed document. Here it is back."**

**What this path costs and buys.** It costs 20 seconds of a 300-second slot and it is the most technically dense 20 seconds in the demo. It buys the story when the network is not ours. It is also a genuinely good answer to "what is this built on", which means it does not feel like a fallback at all.

### 5.4 The pre-recorded screen-capture path

**When:** the live network is unreliable enough that the audience will notice.

**Preparation (T−20, §1 step 19):** capture six 1440 px screenshots — queue, map, AI panel, duplicate panel, analytics, audit log. Store them **offline** on a second device.

**Rules:**

| Rule | Why |
| --- | --- |
| **Label it, immediately, before the first frame** | An unlabelled recording is a deception. A labelled one is a professional fallback |
| Keep the recording under 90 seconds, and never show a face, a name, or a phone number | The demo data is synthetic; do not blur it later |
| Do not add music, transitions, or a voice-over | It reads as a marketing video, and this is an engineering demo |
| Keep the six screenshots as the *last* resort — a static image cannot be interrogated by a judge, and a judge asking "can you scroll that?" is a good sign | Prefer the live network whenever it works |

---

## 6. Judge-question anticipation

Twelve questions, with the answer we give. The answers are short because they are spoken. The bold sentence in each is the one that matters.

### Q1 — "Is this safe for real emergencies?"

> "**No, and we say so at the start of the demo.** It routes community responders, not statutory services, and the dispatch path always has a human actor's id in it. There is no code path in this system where an AI output causes an outbound call, an SMS to an authority, or a public alert. What we do have is the groundwork a real deployment needs and this one does not: an append-only audit trail, a privacy impact assessment as roadmap item H1-8, an accuracy study against a labelled set as H1-7, and an explicit list of what we do not claim."

### Q2 — "What if the AI is wrong?"

> "**It is advisory, and we prove it structurally, not by promising.** The model output is validated against a strict schema, so a key that is not in the contract — a `dispatch: true` — fails validation and never reaches the database. The deterministic safety rules run in our code afterwards and can only *raise* urgency; only a human can lower it. The model's own confidence is displayed, and anything below 0.6 is badged Needs review and sorted up. And we have fifty adversarial fixtures: injections, diagnosis requests, invented addresses, and a case where the model asserted forty-seven victims. The property we test hardest is that the incident's coordinates come from the device and never from the model."

**Follow-up — "so you trust the AI's category?"** → *"The category is 1 of 11 controlled values, and an unmappable value becomes `other` with the raw word kept for the dispatcher. A wrong category costs a dispatcher three seconds. A wrong *urgency* is the dangerous one, and that is the one the code controls."*

### Q3 — "How do you prevent fake reports?"

> "**Identity, rate limits, and an audit trail — and we are honest that this is not detection.** Sign-up is required, because accountability and abuse prevention both need it. Creation is capped at five an hour and twenty a day, enforced by a Firestore transaction so it holds across serverless instances. Every privileged action is audited with a hashed IP. What we do **not** have is fraud *detection*, and we say that: a rate limit bounds volume, not intent. Coordinated fake-report detection is roadmap item H1-10, and the design constraint on it is that every anomaly signal must be advisory, never blocking, because a false positive that silences a real emergency is the worst failure this system could have."

### Q4 — "How do you handle duplicates?"

> "**Four gates in order, and the order is the point.** An absolute time window, then an exact distance filter, then a category match, then a text similarity score. And Firestore cannot do radius queries at all, so the candidate search is a single read against a ten-cell geohash footprint, filtered by exact Haversine in code — one read, not nine. The result is a *suggestion* with its full breakdown stored for audit: distance, time delta, category match, similarity, the matched keywords, and the algorithm version. A human merges. There is no automatic merge, and the merge is reversible for 24 hours. The demo shows four heatwave reports in the same cell being correctly rejected, because a different category is never a duplicate."

**Follow-up — "why geohash?"** → *"Because it is one indexed array query. The alternative — nine sequential `in` queries — is a ten-times read cost for the same answer, and the Firestore read budget, not CPU, is the scarce resource in this system."*

### Q5 — "What happens offline?"

> "**Three different answers, honestly scoped.** A citizen's draft is kept locally, and a submission that fails keeps its idempotency key, so a retry after reconnect creates exactly one incident — not two. A responder's status action goes into a local FIFO queue with a visible Pending sync badge, and replays in order. And if the replay is *rejected* — because someone else changed the incident — it surfaces a conflict message. It does not overwrite, and it is not silently dropped. What we do not have is general offline sync with conflict resolution, and that is deliberately out of scope: merging two conflicting lifecycle states is a safety decision, not a data one."

### Q6 — "How do you know the responders are real?"

> "**A human admin verifies every one, and an unverified responder is not offerable.** The profile carries a verification status, and only `verified` responders appear in the candidate list — the absence is silent, because it is a filter and not an error. Setting the flag is an admin-only endpoint that requires a reason and writes an audit row with before and after. So the answer is: an admin looked at their certification and typed a reason. We do not do automated identity verification, and we would not claim to."

### Q7 — "How much does it cost?"

> "**Zero, and the one line that could break that is the one we watch hardest.** Vercel Hobby, Firestore Spark, Storage Spark, Firebase Auth, and the Gemini free tier. The single exception is the Google Maps monthly credit, because Maps billing needs an enabled Cloud billing account. So: both Maps keys are restricted — the browser one by HTTP referrer, the server one by IP — a hard budget alert is armed at 50, 90, and 100 percent, and we read the billing page before and after every rehearsal. And if the map ever does fail, every map surface degrades to a list view, which is the accessible equivalent, not a spinner. We will demo that on request."

### Q8 — "How would you scale to a hundred thousand incidents?"

> "**The query budgets already do not depend on the total, and that was designed, not discovered.** Every query has a `limit`; the queue listener caps at fifty rows and filters client-side; the map viewport caps at a hundred and fifty across at most nine cells; analytics reads one precomputed rollup per day, so a 365-day view is 365 reads whether there are five hundred incidents or fifty thousand; and there is a hard cap of eight listeners per client. The first thing that would actually break is analytics on very recent ranges — the live-scan path is capped at five hundred reads and honestly reports `truncated`. The fix is hourly rollups, which is additive. The honest limit is single-region, single-city, with no horizontal scale path in the database itself."

### Q9 — "How do you protect citizen privacy?"

> "**Data minimisation at the serialiser, not just at the database.** A responder's incident payload is built by a serialiser that omits the reporter's uid, display name, email, and any typed address, and replaces the original text with the AI summary. That is tested by asserting the *absent fields* in the response body, not the present ones. Beyond that: precise location is purged ninety days after closure while the incident itself is retained; the audit log is retained at least 365 days and is append-only for every role including admin; IP addresses are stored only as a salted hash; notification text is plain text and HTML is rejected, not escaped; and the AI never sees a street-level address — only a district label."

**Follow-up — "what about the AI provider?"** → *"The free Gemini tier's data-handling terms apply. The sanitiser redacts phone numbers, emails, and long digit runs before the text leaves our server, strips invisible Unicode that can smuggle instructions, and wraps the report as untrusted data. That bounds the exposure. It is a mitigation, not a guarantee, and the paid tier with a data-governance policy is the answer for a real deployment."*

### Q10 — "What is Firestore's geospatial limit, and how did you work around it?"

> "**Firestore has no geospatial queries at all — no `near`, no `geoWithin`, no radius, no polygon.** That is a hard platform limitation, not a gap in our design. We emulate it: each incident stores a geohash-6 cell plus its eight neighbours, exactly ten strings, which fits Firestore's ten-element array index limit precisely. A proximity query is one `array-contains` read returning a small superset, then exact Haversine in code. Because every incident stores its neighbours, one query is complete — we do not need nine, and a test fails if anyone ever writes nine. The honest cost: `in` cannot be combined with `array-contains`, so a map viewport spanning a three-by-three cell block costs up to nine sequential reads, and we cap the total at a hundred and fifty documents and debounce panning at four hundred milliseconds."

### Q11 — "Why Next.js and Firebase? What did you give up?"

> "**One deployable with one rollback, and we gave up real geospatial queries and real aggregation.** The UI and the API are the same app, so there is one auth story, one build, and one set of security headers. Firestore gave us transactions, composite indexes, realtime listeners, and a usable free tier. What it did not give us is `GROUP BY` — hence the daily rollups — or distance queries — hence the geohash emulation. The honest lock-in is Google, across Firebase, Maps, and Gemini, and we have two named escape hatches that cost nothing: the datastore is only reached through `services/firestore/*`, and the AI provider sits behind a `TriageProvider` interface with exactly one implementation, on purpose."

### Q12 — "What would break first at real scale?"

> "**Reads, not CPU.** Firestore is priced per operation, so the scarce resource is document reads and the cost of one change is proportional to the number of listening clients — one read per client that covers that document. So the read budget is a hard architectural constraint, not an optimisation: `limit()` on every query, eight listeners maximum, rollups for analytics, fifty duplicate candidates. The second thing to break is the free-tier quotas themselves, which are not contractual. And the third is the rate limiter: it is a Firestore transaction, so it costs a read and a write on every write request. We know the numbers because there is a load-test harness in the repo, and we publish them."

### 6.1 Answers we must **not** give

| Do **not** say | Say instead | Why |
| --- | --- | --- |
| "The AI decides the urgency" | "The AI proposes it; a deterministic rule in code can only raise it, and only a human can lower it" | The first is false ([09 §5.3](./09_AI_GEMINI_SPECIFICATION.md) R9) and the second is the design |
| "It dispatches emergency services" | "It routes community responders, and a human dispatcher is the only actor with dispatch power" | DEC-05 and [09 §6.4](./09_AI_GEMINI_SPECIFICATION.md). There is no such code path |
| "It detects fake reports" | "Identity, rate limits, and an audit trail — which bound volume, not intent. Detection is roadmap item H1-10" | We do not have detection |
| "Real-time" | "Firestore listeners, commit-to-paint about 1.5 seconds p95 measured, against a 3-second requirement" | "Real-time" without a number is a claim; with a measured number it is engineering |
| "Sub-second response times" | "Under 3 seconds end to end, measured, and here is the percentile" | Unmeasured latency claims are the easiest thing for a technical judge to falsify |
| "Enterprise-grade security" | "Six enforcement layers, 95 rules assertions, and an independent review of the rules is our first post-hackathon item" | "Enterprise-grade" is unfalsifiable and we have not had an independent review |
| "Scalable to millions" | "Query budgets do not depend on incident count up to 50 000 by design; a million needs hourly rollups and analytics off Firestore, and we have written down exactly where each wall is" | The second half is the honest answer and it is more impressive than the claim |
| "Works offline" | "A local draft, an idempotency key, and a FIFO action queue with a conflict message — not general offline sync, which is deliberately out of scope" | "Works offline" invites someone to disconnect mid-demo |
| "We trained a model" | "We call `gemini-2.5-flash` behind a strict schema with a deterministic fallback, and we have an accuracy study on the roadmap because we have not measured our own accuracy yet" | We have not trained anything, and we have not measured it either |
| "Accessible" | "Tested against WCAG 2.1 AA automated checks with zero serious violations, plus a keyboard-only pass. We have **not** tested with real disabled users, and that is a stated gap" | [18 §20](./18_TESTING_QA_PLAN.md) says this outright |
| "99.9 % uptime" | "99.5 % is our design target and we do not gate on it, because on free tiers we cannot measure it honestly. Every optional dependency has a designed degraded path" | There is no SLA and no monitoring to measure one |
| "It's free forever" | "It is free on the free tiers we have read the current quotas for, with one budget alert armed on the one line that could cost money" | "Forever" is false — quotas change without notice |

---

## 7. Live-demo failure drills

Rehearse all five. Each must be recoverable inside the time stated. A drill that has not been rehearsed is not a plan.

### Drill 1 — Kill the Maps script

| | |
| --- | --- |
| **Simulate** | DevTools → Network → request blocking → block `maps.googleapis.com` and `maps.gstatic.com`; reload `/map` |
| **Expected** | `MapListFallback` renders, expanded, keyboard-operable, with coordinates and a **Retry map** action; the reason is announced to assistive technology |
| **Recovery action** | Unblock. Or, better: **keep it blocked** and continue the demo on the fallback |
| **Words** | "Maps are off — deliberately, so you can see the degradation path. The list view is the accessible equivalent, not a broken mode. The map is also not in the dashboard's JavaScript bundle — there is a CI check that fails the build if it ever is." |
| **Time** | **8 s** |
| **FR / test** | FR-085, FR-086 · TC-UI-025, TC-UI-026, TC-UI-025b / M12 |

### Drill 2 — Exhaust the Gemini quota

| | |
| --- | --- |
| **Simulate** | Set `GEMINI_RPD_LIMIT=0` (or `GEMINI_API_KEY` to an invalid value), redeploy, or in the dev environment simply trip the local guard. **Rehearse the invalid-key variant**, because it needs no redeploy |
| **Expected** | The report is still created (`201`). `triageSource: "fallback"`, `urgency: "medium"`, `aiConfidence ≤ 0.55`, `triageError` set, an `aiRuns` row with `outcome: "error"`, and a visible **Fallback triage** + **Needs review** badge |
| **Recovery action** | None needed. This is the *designed* behaviour |
| **Words** | "The AI is unavailable, so triage ran on the deterministic keyword path. Two things to notice: the report was still recorded — reporting never fails because the AI failed — and the badge says **Fallback triage**, with the confidence capped at 0.55 so it is badged Needs review. A fallback that looked confident would be worse than no AI at all." |
| **Time** | **0 s** — this drill *improves* the demo |
| **FR / test** | FR-029, FR-024 · TC-FR-029, TC-FR-029b, TC-FR-029d, TC-AI-008, TC-AI-078 |

### Drill 3 — Drop the network

| | |
| --- | --- |
| **Simulate** | DevTools → Network → **Offline**, in Window 2 mid-demo |
| **Expected** | The **Reconnecting…** banner appears; the last snapshot is retained; no toast storm; on reconnect, listeners re-attach automatically and any queued action drains in order |
| **Recovery action** | Go back online. If the reconnect is slow, use the architecture narration (§5.3) to fill |
| **Words** | "We have lost the network in this room. The banner is the honest state — we keep the last snapshot rather than blanking the screen, and we re-subscribe automatically when it returns. While we wait: *the architecture narration*." |
| **Time** | **15 s** of narration, then the beat resumes |
| **FR / test** | FR-094, NFR-012 · TC-RT-005, TC-RT-005b, TC-UI-031 |

### Drill 4 — A rules-permission error

| | |
| --- | --- |
| **Simulate** | As citizen B in a private window, open citizen A's incident id directly in the URL; then try to reach `/dashboard` as a citizen |
| **Expected** | `404 INCIDENT_NOT_FOUND`, **byte-identical** to a genuinely non-existent reference — no existence oracle. The forbidden page renders a `403 ForbiddenState` with the server code, never a redirect loop |
| **Recovery action** | None. Close the window |
| **Words** | "That is a *different* citizen asking for that incident, and the response is identical to asking for a reference that does not exist — same code, same body, same length. If we returned a 403 for one and a 404 for the other, we would have built an oracle that lets anyone confirm whether a report exists." |
| **Time** | **12 s**, and it converts an error into a security demonstration |
| **FR / test** | FR-124, NFR-015, US-005 · TC-FR-011b, TC-SEC-019, TC-SEC-019a, TC-UI-028 |

### Drill 5 — An AI timeout

| | |
| --- | --- |
| **Simulate** | DevTools → Network → block `aiplatform.googleapis.com`; or set a custom request throttle to 25 s. Or set `GEMINI_TIMEOUT_MS=3000` in the dev environment |
| **Expected** | The 20 s hard abort fires, `outcome: "timeout"`, `triageError: "AI_TIMEOUT"`, the fallback supplies the triage, and the request still returns `201`. The citizen never sees a 20-second spinner, because the server has already answered |
| **Recovery action** | Unblock. The next report triages normally |
| **Words** | "That is the twenty-second hard abort firing. The server has already returned an incident — with the keyword fallback and a Needs-review badge — so the citizen saw a progress state, not a failure. Our budget is a p95 of nine seconds for the whole request, and the hard ceiling is twenty-one, which is the constraint that makes the function-duration question on our open-decision list a real one." |
| **Time** | **0 s** — the abort is invisible to the user by design |
| **FR / test** | FR-029, NFR-004 · TC-FR-029, TC-AI-015, TC-AI-032, TC-INT-090 |

### 7.1 The drill that is not a drill

**The role mix-up.** Two demo tabs in one browser profile means the citizen and the dispatcher are the same session, and the demo collapses into one role with a broken navigation. **Rehearse it deliberately once:** open the wrong window, notice, and recover. Knowing the recovery takes 5 seconds of confusion out of a real occurrence.

---

## 8. The 60-second version

For a 1-minute slot, or for a slot interrupted late. The whole story, at speed, in five beats.

| Time | Beat | Action | Words (verbatim) |
| --: | --- | --- | --- |
| 0:00–0:08 | Frame | Hold on the queue | **"A demonstration system, not a certified dispatch system. Eleven emergency reports, six with nobody assigned. Three minutes ago one of them got a second reporter 140 metres away."** |
| 0:08–0:22 | Duplicate | Open the new incident; the duplicate panel is visible | **"The system matched them before a human read either one: same category, 0.73 text similarity, 140 metres, three minutes apart. Four heatwave reports in the same cell were correctly rejected. A human merges — the AI never does."** |
| 0:22–0:34 | Dispatch | Assign the rank-1 candidate; switch to the responder window | **"Nearest verified responder, ranked by distance and capability. One click, written in a transaction, so two dispatchers at once produce one assignment. The responder has it in under three seconds — with no citizen identity in his payload."** |
| 0:34–0:48 | Lifecycle | En route → arrived → resolve | **"One button, one next permitted action, enforced server-side against an 11-by-11 transition table. Every event on the timeline has an actor, a role, a timestamp, and a request id — append-only, for every role including admin."** |
| 0:48–1:00 | Analytics | `/analytics`, 7 days | **"That incident is now a row in a daily rollup. Seven days costs about seven reads, which is how we stay inside the free tier. And that spike is the heatwave — the queue gave us unrelated reports, the rollup gave us a pattern. CareGrid AI. Questions."** |

**What the 60-second version deliberately drops:** the location/accuracy beat, the AI panel, the candidate-list detail, the SLA meter, and the responder's acceptance. **What it keeps:** the duplicate turn, the human-in-the-loop dispatch, the realtime propagation, the audit trail, and the analytics. The turn and the resolution are non-negotiable; everything else is compressible.

---

## 9. Post-demo Q&A appendix

Not read during the demo. For the two people who are not driving a browser.

### 9.1 Architecture talking points

| Point | One sentence | Anchor |
| --- | --- | --- |
| One deployable | Next.js 15 App Router serves the UI **and** the API, so there is one auth story, one build, one set of security headers, and one click to roll back | [02](./02_TECHNICAL_REQUIREMENTS_DOCUMENT.md) ADR-005, ADR-011 |
| Server-authoritative roles | Every protected request reads `users/{uid}.role` on the server; the Firebase custom claim is a *mirror* that only Security Rules read. A mismatch is a `403` plus an audit row, not a silent override | [22 §2](./22_USER_ROLES_PERMISSIONS.md) |
| Six enforcement layers | UI affordance, API route, server-side serialisation, Firestore rules, Storage rules, audit log. No single layer is trusted | [22 §6](./22_USER_ROLES_PERMISSIONS.md) |
| Uploads never transit the function | The browser `PUT`s bytes straight to Storage on a 15-minute signed URL, which is why the 4.5 MB serverless body limit is irrelevant | FR-007, DEC-08, ADR-004 |
| AI as a component, not a decision-maker | No tools are configured, so the model cannot call anything. The schema has no status field, no coordinates, and no dispatch field. Strict validation, one repair, then a deterministic fallback | [09 §1.2](./09_AI_GEMINI_SPECIFICATION.md), [09 §4](./09_AI_GEMINI_SPECIFICATION.md) |
| Realtime is a listener, not a poll | A Firestore listener costs zero serverless invocations and exactly one read per changed document per client. Polling costs one invocation *and* one read — more expensive on both axes, as well as being forbidden | [03 §12.2](./03_SYSTEM_ARCHITECTURE.md) |
| The read budget is the architecture | `limit()` everywhere, ≤ 8 listeners, ≤ 50 duplicate candidates, ≤ 150 map documents, ≤ 60 candidate responders, rollups for analytics. The listener registry **throws** on the ninth listener | FR-091, [26 §5.7](./26_PERFORMANCE_REQUIREMENTS.md) |
| Deny by default | The last line of the Firestore rules file is `if false`. A collection not named above is unreachable by every client | [22 §7](./22_USER_ROLES_PERMISSIONS.md) |
| Non-existence opacity | A not-found and a not-yours produce byte-identical responses, so the API is not an existence oracle | US-005, [18 §7.6](./18_TESTING_QA_PLAN.md) |
| The transaction is idempotent | Firestore retries a transaction silently up to five times, so every transaction body must be idempotent. That is a permanent obligation, tested | [07 §12.7](./07_DATABASE_SCHEMA.md) |
| `deletedAt == null` in every query | The most commonly forgotten rule in this design, enforced by review, a lint rule, a custom query scan, and rules tests — because the platform will not enforce it | [07 §12.4](./07_DATABASE_SCHEMA.md) |

### 9.2 The three hardest engineering problems we solved

| # | Problem | Why it was hard | How it was solved | Evidence |
| --: | --- | --- | --- | --- |
| 1 | **Duplicate detection on a database with no geospatial queries** | Firestore has no `near`, no `geoWithin`, no radius. The naive approaches are a nine-query geohash fan-out, or `in` with literal points, which blows the 30-value limit. And the *ten-element* array index limit means the footprint is not a tuning choice — it is exactly ten strings or nothing | A geohash-6 cell plus its eight neighbours, stored as a ten-element `geoCells` array and queried with a single `array-contains`. Because every incident stores *its* neighbours, one query on the query point's own cell is complete — the extra nine are only needed if you choose not to store neighbours. Then exact Haversine in code. And because proximity alone is not proof, four gates in order, with a human merge | `lib/duplicates/score.ts` at 100 % branch coverage; ≥ 20 boundary cases including 499/500/501 m; a test that **fails if the candidate search ever issues more than one read** (TC-GEO-009b) |
| 2 | **Making an LLM safe to put in front of emergency reports** | The model can be injected through the report text itself. It can be induced to emit a `dispatch` field, a diagnosis, a casualty count, or an address. And it is a third party on the critical path of a report | Six defences, in order: untrusted content is wrapped as data and never treated as instructions; invisible Unicode is stripped; PII is redacted before the request leaves the server; the output is schema-constrained and `.strict()`-validated so an extra key is a *validation failure*; deterministic safety rules run in code afterwards and can only **raise** urgency; and there is a mandatory offline keyword fallback so the report survives any AI failure. `tools` is never configured, so the model can call nothing | 50 adversarial fixtures, one per attack, each asserting a specific property; a **property test** over 200 seeded fuzz outputs asserting that no coordinate ever appears in the normalised projection; the fallback's confidence ceiling of 0.55 asserted so a fallback can never look confident |
| 3 | **One assignment per incident, under real concurrency** | "One active dispatch" is a *collection* query, not a document read, so it cannot be enforced by a rule or a check-then-write. Two dispatchers clicking assign at the same moment would each read "no active dispatch" and each write one | A single `runTransaction` that reads the incident, reads the live dispatch set for that incident, and writes the close of the previous plus the creation of the new atomically. And because Firestore retries transactions silently, the body is idempotent — otherwise a retry double-counts `activeIncidentCount` | A transaction suite that fires two parallel dispatches and asserts exactly one survivor, the loser gets `409 ALREADY_ASSIGNED`, `incidents.assigneeUid` matches the survivor, and **no state ever exists with two active dispatches** (TC-LIFE-004c, TC-INT-134) |

### 9.3 The three known weaknesses — stated unprompted

| # | Weakness | The honest statement | What we would do about it |
| --: | --- | --- | --- |
| 1 | **The entire location design is an emulation** | Firestore has no geospatial queries, so proximity is a geohash footprint plus exact Haversine in code. The read cost is one query instead of nine, but the *maintainability* cost is real: the neighbour derivation is an approximation that has to be unit-tested against a reference table, because a wrong neighbour set means **missed duplicates**, which is the product's core value | Validate the offsets against a reference table before real use. If they cannot be made exact, raise the fan-out to a precision-5 scheme and re-verify the read budget. This is open decision `DR-06` and it is on the list to close in week 1 |
| 2 | **A third party is on the critical path of recording an emergency** | Triage happens before the incident is visible in the dispatcher queue, so Gemini's latency and availability are in the report path. The 20-second hard timeout, the local quota guard, and the mandatory fallback bound it, but they do not remove it. And the free tier's quota is not contractual | The fallback is a tested path, not a degraded unknown, and the incident is flagged so a human always knows. The longer-term answer is the same as the first item on our hardening roadmap: measure our own accuracy against a labelled set, because we have not yet measured it, and we should not claim an accuracy we have not observed |
| 3 | **The rate limiter costs a read and a write on every limited request** | There is no Redis, because a free Redis tier is throughput-metered and would add a network dependency to every write. Instead the token bucket is a Firestore transaction: correct across serverless instances, but 1 read + 1 write per limited request, with a 60-second window, and consistency under contention relies on Firestore's transaction retry semantics. We also keep a config value, `RATE_LIMIT_STORE=memory`, that looks free and is **unsafe on Vercel** — serverless instances are ephemeral and per-instance | It is correct, and we would rather be correct and pay the read than be fast and rate-limit per instance. The `memory` value is documented as unsafe and should be blocked at boot in production — that is a one-line fix we have logged as technical debt `TD-19` and have not yet made |

> **Say these before they are asked.** A team that names its own weaknesses is trusted on everything else it says. A team discovered to have missed one is not.

### 9.4 If you only remember three sentences

1. **"A demonstration system, not a certified dispatch system"** — before anything else.
2. **"The AI proposes; a deterministic rule in code can only raise urgency; only a human can lower it, and only a human can merge a duplicate or assign a responder."** — the safety thesis, in one sentence.
3. **"Here is the network response the responder's browser received — there is no reporter field in it at all."** — the privacy claim, as evidence rather than assertion.

---

## 10. Rehearsal checklist

Each run is **timed**. A run without a stopwatch is a walkthrough, not a rehearsal.

| # | Rehearsal | When | Duration | Pass condition | Reference |
| --: | --- | --- | :-: | --- | --- |
| R1 | **Read the whole script aloud once**, with no clicking | T−1 day | 6 min | You can say every narration line without reading it. If you cannot, cut words — do not cut beats | §4 |
| R2 | **Setup dry run**, start to T0, timed | T−1 day | 30 min | All 31 steps in 30 minutes. If it takes 40, drop steps 19 and 21 from the day-of list | §1 |
| R3 | **Full run 1**, timed, against the **deployed preview** | T−1 day | 4 min 30 s | Finishes inside 4:40. Record the actual time | §4 |
| R4 | **Full run 2**, timed, from a cold browser, with the presenter and the driver swapping roles | T−1 day | 5 min | One person can present alone. The driver can drive alone | §4 |
| R5 | **The 60-second version**, timed, three times | T−1 day | 1 min | Under 65 seconds, twice in a row | §8 |
| R6 | **Drills 1–5**, each with the recovery words spoken aloud | T−1 day | 15 min | Every recovery is under 15 s and the words are memorised | §7 |
| R7 | **Role-mixup recovery** — deliberately open the wrong window | T−1 day | 2 min | Recovery in under 5 s | §7.1 |
| R8 | **The architecture narration**, timed, from memory | T−1 day | 1 min | Under 25 s | §5.3 |
| R9 | **Q&A: the twelve questions**, answered aloud, one person asking | T−1 day | 20 min | Every answer under 30 s. Two answers improved by a real question | §6 |
| R10 | **Q&A: the three weaknesses**, stated without notes | T−1 day | 5 min | All three, unprompted, in under 2 minutes total | §9.3 |
| R11 | **Full run 3**, timed, on the **demo machine and network** | T−2 h | 4 min 30 s | Inside 4:40 on the actual hardware. Warm the routes 15 min before | §1 step 15 |
| R12 | **Fallback screenshots** verified offline | T−2 h | 2 min | All six open on a second device with the network off | §1 step 19 |
| R13 | **Health/quota snapshot** read aloud by the watcher | T−1 h | 1 min | Success ≥ 95 %, fallback ≤ 5 %, headroom ≥ 50 %, zero charges | §1 steps 3–5 |
| R14 | **Final seed** and the post-seed re-verification | T−6 min | 2 min | The duplicate partner exists with the expected coordinates and text | §1 steps 25–27 |
| R15 | **Word count check** | T−1 day | 2 min | Total spoken words ≈ 640, i.e. ~4:20 at 150 wpm. If it is over 750, cut narration — never beats | §4 |
| R16 | **No-deploy freeze** | T−34 min | — | Nothing is deployed after this point | [19 §14.4](./19_DEPLOYMENT_DEVOPS.md) |

### 10.1 The rehearsal log

Fill this in for every run. An unlogged rehearsal did not happen.

| Run | Date | Time | Target | Actual | Longest beat | Where the words went wrong | Fixed? |
| --: | --- | --- | --: | --: | --: | --- | :-: |
| 1 | | | 4:30 | | | | |
| 2 | | | 4:30 | | | | |
| 3 | | | 4:30 | | | | |
| 4 | | | 1:00 | | | | |
| 5 (drills) | | | — | | | | |

---

**End of document 29.** This document is the executable contract for the demo dataset: [07 §14](./07_DATABASE_SCHEMA.md), [09 §11](./09_AI_GEMINI_SPECIFICATION.md), and [18 §15.3](./18_TESTING_QA_PLAN.md) all reference it. An amendment here must be reflected in the seed and in `demoDataset()` in the same change, and the duplicate arithmetic in §2.5 must be recomputed if any text, coordinate, or threshold changes.

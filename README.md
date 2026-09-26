# CareGrid AI

**Emergency and community-aid routing for urban crises — documentation package.**

This repository currently contains the complete, implementation-ready documentation set for
CareGrid AI: **35 documents, 39 243 lines**. No application source code has been written yet,
by design.

## Start here

| # | Document | What it is |
| --- | --- | --- |
| 1 | [`docs/DOCUMENTATION_INDEX.md`](./docs/DOCUMENTATION_INDEX.md) | **Read first.** What every document covers and when to open it |
| 2 | [`docs/33_README.md`](./docs/33_README.md) | Project overview, tech stack, honest limitations, contribution rules |
| 3 | [`docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md`](./docs/01_PRODUCT_REQUIREMENTS_DOCUMENT.md) | 133 functional requirements, 30 NFRs, personas, user stories, decision register |
| 4 | [`docs/27_HACKATHON_MVP_SCOPE.md`](./docs/27_HACKATHON_MVP_SCOPE.md) | What is in the MVP, what gets cut, and the cut order if behind schedule |
| 5 | [`docs/30_DEVELOPMENT_PHASE_PLAN.md`](./docs/30_DEVELOPMENT_PHASE_PLAN.md) | Phases 0–11: tasks, files, dependencies, acceptance criteria, cut lists |
| 6 | [`docs/DOCUMENTATION_CONSISTENCY_REPORT.md`](./docs/DOCUMENTATION_CONSISTENCY_REPORT.md) | The cross-document audit: conflicts found, gaps, and how each was resolved |
| 7 | [`docs/32_AI_CODING_AGENT_RULES.md`](./docs/32_AI_CODING_AGENT_RULES.md) | The operating contract for any developer or coding agent working here |

## One-paragraph summary

CareGrid AI lets a citizen report an emergency by text, photo, or voice. Gemini extracts a
category, an urgency, a summary, and a confidence score as a strict JSON schema, refusing to
invent anything the report does not support. The location is resolved from GPS or a manual
pin, nearby reports within 500 m are scored for duplication, and a dispatcher reviews a live
queue before assigning a nearby verified responder, who moves the incident through
`assigned → en_route → on_scene → resolved` in real time. The AI never dispatches anything;
a human always does. It runs on free tiers at a $0 target cost.

## Important

CareGrid AI is a **hackathon demonstration system**. It is not a certified emergency
dispatch system, it has no SLA, and it must not be presented as a replacement for a public
emergency number. See the warning section of [`docs/33_README.md`](./docs/33_README.md).

## Next action

Execute **Phase 0** of the development plan: review and approve this documentation, then set
up the toolchain, repository, CI, and lint/format configuration. **Phase 1 coding does not
begin until the Phase 0 gate conditions are met.**
"# CareGrid-AI" 

# Docs Sync Map

Two parallel trees, one source of truth per topic. Humans read `human/`, AI agents read `agent/`. **When you change one side, update its mirror in the same commit.**

## How to read this

- `human/` — narrative, decisions, ownership, status. Optimized for skim + standup.
- `agent/` — precise specs (file paths, schemas, env vars, function signatures). Optimized for code generation.
- Every file in either tree has a banner at the top pointing to its mirror.
- This file is the index of pairs. Update the "Last synced" column whenever you touch a pair.

## Mirror table

| Topic | Human doc | Agent doc | Owner | Last synced |
|---|---|---|---|---|
| Project overview | [`human/README.md`](./human/README.md) | [`agent/README.md`](./agent/README.md) | All | 2026-05-09 (rev2) |
| 7-step flow, plan, ownership | [`human/01-plan.md`](./human/01-plan.md) | [`agent/09-tasks.md`](./agent/09-tasks.md) | All | 2026-05-09 (rev2) |
| Tech & architecture | [`human/02-tech-decisions.md`](./human/02-tech-decisions.md) | [`agent/01-architecture.md`](./agent/01-architecture.md) | Aryan | 2026-05-09 (rev2) |
| Frontend | [`human/02-tech-decisions.md`](./human/02-tech-decisions.md#frontend) | [`agent/04-frontend-spec.md`](./agent/04-frontend-spec.md) | Howie + Jam | 2026-05-09 (rev2) |
| Backend & API | [`human/02-tech-decisions.md`](./human/02-tech-decisions.md#backend) | [`agent/03-api-contracts.md`](./agent/03-api-contracts.md), [`agent/05-backend-spec.md`](./agent/05-backend-spec.md) | Aryan | 2026-05-09 (rev2) |
| Phase 1 — Vision (Gemini) + Recipes (Backboard memory) | [`human/01-plan.md`](./human/01-plan.md#phase-1) | [`agent/06-phase1-fridge-vision.md`](./agent/06-phase1-fridge-vision.md) | Sahil | 2026-05-09 (rev2) |
| Phase 2 — Pantry locator (MongoDB geospatial) | [`human/01-plan.md`](./human/01-plan.md#phase-2) | [`agent/07-phase2-pantry-locator.md`](./agent/07-phase2-pantry-locator.md) | Sahil | 2026-05-09 (rev2) |
| Phase 3 — Voice calls (Twilio + ElevenLabs) → Sheets | [`human/01-plan.md`](./human/01-plan.md#phase-3) | [`agent/08-phase3-voice-calls.md`](./agent/08-phase3-voice-calls.md) | Sahil | 2026-05-09 (rev2) |
| Step 7 — Final plan + mapped route | [`human/01-plan.md`](./human/01-plan.md#step-7) | [`agent/03-api-contracts.md`](./agent/03-api-contracts.md#plan), [`agent/04-frontend-spec.md`](./agent/04-frontend-spec.md#plan-view) | Howie | 2026-05-09 (rev2) |
| Status / progress | [`human/03-status.md`](./human/03-status.md) | [`agent/09-tasks.md`](./agent/09-tasks.md) | All | 2026-05-09 (rev2) |
| Risks & fallbacks | [`human/04-risks.md`](./human/04-risks.md) | [`agent/02-conventions.md`](./agent/02-conventions.md#fallback-rules) | All | 2026-05-09 (rev2) |

## Revision history

- **rev2 (2026-05-09 11:59 PT):** Stack pivot per Sahil + Jay. Vision = **Gemini VLM**; memory = **Backboard**; DB = **MongoDB Atlas** (replaces Supabase Postgres for pantry/call data); results stream to **Google Sheets** in addition to the dashboard; new step 2 "user adds pantry staples"; new step 7 "final plan + mapped route". Phase 1 endpoint split into vision + recipes.
- **rev1 (2026-05-09 11:46 PT):** Initial draft.

## Update rules

1. **Source of truth lives in `agent/` for anything an AI will implement** (schemas, endpoints, env vars, file paths). The human doc summarizes it.
2. **Source of truth lives in `human/` for decisions, ownership, status, and rationale.** The agent doc only records the resolved decision.
3. When you ship a change, do **both** edits in the same commit. Commit message format: `docs: <topic> — <one-line change>`.
4. If the two ever drift, the side that disagrees with shipped code is wrong. Reconcile immediately.

## File tree

```
docs/
├── SYNC.md                      ← you are here
├── human/
│   ├── README.md
│   ├── 01-plan.md               ← 7-step flow, 20-hour plan, ownership
│   ├── 02-tech-decisions.md     ← stack rationale (Gemini, Mongo, Backboard, Sheets)
│   ├── 03-status.md             ← live checklist
│   └── 04-risks.md              ← what can break, fallbacks
└── agent/
    ├── README.md
    ├── 01-architecture.md       ← diagram + repo layout
    ├── 02-conventions.md        ← env vars, stub mode, fallback rules
    ├── 03-api-contracts.md      ← every endpoint (incl. /api/plan)
    ├── 04-frontend-spec.md      ← routes + components (incl. plan view)
    ├── 05-backend-spec.md       ← Mongo collections, Backboard client, Sheets writer
    ├── 06-phase1-fridge-vision.md   ← Gemini VLM + Backboard recipe memory
    ├── 07-phase2-pantry-locator.md  ← Mongo geospatial + Google Places
    ├── 08-phase3-voice-calls.md     ← Twilio + ElevenLabs + Sheets mirror
    └── 09-tasks.md              ← per-person, per-block task list
```

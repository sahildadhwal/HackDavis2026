# Live Status

> Mirror: [`docs/agent/09-tasks.md`](../agent/09-tasks.md). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Update before every standup (every 4 hours).** Check off completed items, add blockers in [§Blockers](#blockers).

## Current block

- **Block:** A — Setup & decisions
- **T+:** 0
- **Next standup:** T+2

## Block A — Setup (T+0 → T+2)

- [ ] Repo created, branch protections off (hackathon mode)
- [ ] `.env.local` template committed (no secrets)
- [ ] All 7 keys provisioned (Gemini, Mapbox, Google Places, ElevenLabs, Twilio, Backboard, Google service account JSON)
- [ ] Next.js + Tailwind + shadcn scaffolded, deploys to Vercel
- [ ] **MongoDB Atlas** cluster up, connection string in env, all collections + indexes created
- [ ] **Backboard** smoke test (write + read a memory) green
- [ ] Python AI service scaffolded, `/healthz` returns 200
- [ ] Map page renders (empty) at user location
- [ ] Twilio outbound number provisioned and verified
- [ ] **Google Sheet template** created, service account has edit access

## Block B — Skeleton end-to-end (T+2 → T+6)

- [ ] `/api/pantries` returns mock data; markers render
- [ ] Camera upload posts to `/api/fridge/scan` (mocked); ingredients chips render
- [ ] **Staples chip input** works; persists to localStorage
- [ ] `/api/fridge/recipes` returns 3 mocked recipes
- [ ] Marker click → side panel
- [ ] Python service returns ingredients from one test fridge image (Phase 1 vision via **Gemini**)
- [ ] Phase 2 prompt v1 returns 3 fake pantries
- [ ] **Sheets writer** can create a sheet and append a header row

## Block C — Phase 1 + 2 real (T+6 → T+12)

- [ ] Phase 1 vision returns ingredients with **expiry hints** for arbitrary fridge photo
- [ ] **Backboard** writes user staples + reads diet/family-size for recipe generation
- [ ] Phase 1 recipes prioritize a **near-expiry** ingredient when one exists
- [ ] Phase 2 hits Google Places, upserts to **MongoDB** with `2dsphere` index
- [ ] LLM re-ranks pantries by `openNow` + distance + recent notes
- [ ] Map clusters ≥10 pantries cleanly
- [ ] DB caches pantry lookups (Mongo `pantry_lookups` with TTL)

## Block D — Phase 3 voice + Sheets + Plan (T+12 → T+17)

- [ ] ElevenLabs agent + Twilio outbound: one test call works end-to-end
- [ ] `/api/calls/start` accepts N pantries, fans out N parallel calls
- [ ] Live transcripts stream to dashboard via SSE (Mongo change streams)
- [ ] **Per-job Google Sheet** created with row per pantry; rows update live
- [ ] Per-call structured summary (`openUntil`, `hasItems`, `requirements`)
- [ ] Aggregate summary card across all N calls
- [ ] Audio recording stored in Mongo/GridFS or external storage, playable in dashboard
- [ ] **Step 7:** `/plan/[jobId]` route view renders selected pantries + Mapbox optimized route + "Open in Maps" links

## Block E — Polish & demo (T+17 → T+20)

- [ ] Production deploy stable for 30 min straight
- [ ] Seed demo data loaded into Mongo for the demo city
- [ ] 90-sec demo video recorded and uploaded
- [ ] Submission form filled
- [ ] Pre-recorded fallback call ready in case Phase 3 fails on stage
- [ ] Public Google Sheet URL ready to project on the demo screen

## <a id="blockers"></a>Blockers

| Time | Owner | Blocker | Help needed | Resolved? |
|---|---|---|---|---|
| _none yet_ | | | | |

## MVP cuts taken

| Time | What we cut | Why |
|---|---|---|
| _none yet_ | | |

## Demo dry-run results

- [ ] Dry-run 1 at T+18 — runs `_:_:_`, judge questions: ___
- [ ] Dry-run 2 at T+19 — runs `_:_:_`

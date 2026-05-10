# 7-Step Flow, 20-Hour Plan, Ownership & Timeline

> Mirror: [`docs/agent/09-tasks.md`](../agent/09-tasks.md). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Rule:** any change to a task here must be reflected in the agent task list, and vice versa.

## The 7-step flow (Sahil's spec)

| # | Step | Who builds it | Where it lives in the spec |
|---|---|---|---|
| 1 | Snap fridge photo → AI extracts ingredients | Jam (UI) + Sahil (Gemini VLM) | [`agent/06-phase1-fridge-vision.md`](../agent/06-phase1-fridge-vision.md) |
| 2 | User adds pantry staples (flour, salt, etc.) | Jam (chip input) + Aryan (Backboard write) | [`agent/04-frontend-spec.md`](../agent/04-frontend-spec.md), [`agent/05-backend-spec.md#backboard-memory`](../agent/05-backend-spec.md#backboard-memory) |
| 3 | AI suggests 3 meals, identifies missing ingredients | Sahil (Backboard-aware recipe gen) | [`agent/06-phase1-fridge-vision.md`](../agent/06-phase1-fridge-vision.md) |
| 4 | AI searches nearby food pantries with phones | Sahil (Phase 2 agent) + Aryan (Mongo geospatial cache) | [`agent/07-phase2-pantry-locator.md`](../agent/07-phase2-pantry-locator.md) |
| 5 | Voice agent swarm calls in parallel | Sahil (ElevenLabs + Twilio fan-out) | [`agent/08-phase3-voice-calls.md`](../agent/08-phase3-voice-calls.md) |
| 6 | Results stream into Google Sheets + dashboard | Aryan (Sheets writer) + Howie (dashboard) | [`agent/05-backend-spec.md#sheets-writer`](../agent/05-backend-spec.md#sheets-writer), [`agent/04-frontend-spec.md`](../agent/04-frontend-spec.md) |
| 7 | Final plan: where to go, what's there, mapped route | Howie (plan view + Mapbox Directions) | [`agent/04-frontend-spec.md#plan-view`](../agent/04-frontend-spec.md#plan-view), [`agent/03-api-contracts.md#plan`](../agent/03-api-contracts.md#plan) |

## Ownership matrix

| Area | Primary | Backup |
|---|---|---|
| Map (render, markers, popups, geolocation, **route view**) | **Howie** | Jam |
| Camera/upload UI, **staples chip input**, recipe view, ingredients editor | **Jam** | Howie |
| Voice-call live dashboard | **Howie** | Jam |
| Design system (Tailwind tokens, shadcn theme) | **Jam** | — |
| Next.js app shell, routing, anonymous session | **Aryan** | Howie |
| **MongoDB Atlas** schema + queries | **Aryan** | Sahil |
| **Backboard** client + memory writes | **Aryan** | Sahil |
| **Google Sheets writer** (service account, append rows) | **Aryan** | Sahil |
| REST API (Next.js Route Handlers) | **Aryan** | — |
| Deployment (Vercel + AI service host) | **Aryan** | Sahil |
| Phase 1 — Gemini vision + Backboard-aware recipes | **Sahil** | Aryan |
| Phase 2 — pantry locator + ranking | **Sahil** | Aryan |
| Phase 3 — Twilio + ElevenLabs voice swarm | **Sahil** | Aryan |
| Demo script + 90-sec video | **Howie** | Jam |

## Hour-by-hour timeline

> Times are relative to T+0 (kickoff). Each block ends with a 5-min standup.

### Block A — Setup & decisions (T+0 → T+2)

| H | Howie | Jam | Aryan | Sahil |
|---|---|---|---|---|
| 0–1 | Repo clone, Next.js + Tailwind + shadcn scaffold | Figma sketch (4 screens: Home, Scan+Staples, Map, Plan) | **MongoDB Atlas** cluster + collections, Vercel link, env vars | API keys: **Gemini**, Mapbox, Google Places, ElevenLabs, Twilio, **Backboard**, **Google service account JSON** |
| 1–2 | Map page renders empty Mapbox at user location | Camera/upload + staples chip input skeleton | `/api/health`, `/api/session` work; Mongo connection verified | Python AI service scaffold (FastAPI), `/healthz` works; Backboard client smoke test |

**Standup A.** Decisions locked: stack, env, repo conventions. No more bikeshedding.

### Block B — Skeleton works end-to-end (T+2 → T+6)

| H | Howie | Jam | Aryan | Sahil |
|---|---|---|---|---|
| 2–4 | Markers from `/api/pantries` (mock data) | Upload → POST `/api/fridge/scan` (mock); staples chips persist locally | Mock endpoints return canned JSON matching contracts | Phase 1 vision prompt v1, returns ingredients from one test image (Gemini) |
| 4–6 | Marker click → side panel | `/api/fridge/recipes` flow renders 3 mocked recipes | Real Mongo writes for `fridge_scans`, `pantries`. Sheets writer skeleton (creates a sheet, appends a header row) | Phase 1 returns recipes (no Backboard yet); Phase 2 prompt v1 (returns 3 fake pantries) |

**Standup B.** A tester can: upload fridge → see ingredients → add staples → see fake recipes; open map → see fake pantries. **Skeleton must work end-to-end before Block C.**

### Block C — Phase 1 + Phase 2 real (T+6 → T+12)

| H | Howie | Jam | Aryan | Sahil |
|---|---|---|---|---|
| 6–9 | Cluster markers, distance sort, "near me" button | Staples persisted to Backboard via `/api/memory/staples`; preferences UX | Backboard client wired (read/write user memory); cache pantry lookups in Mongo with TTL | Phase 1 polished w/ **Backboard memory** (diet, family size, expiry ranking); Phase 2 calls Google Places, stores in Mongo with 2dsphere index, LLM ranks |
| 9–12 | Map ↔ panel ↔ "Call selected" button + selection chips | Empty/error states, mobile layout, ingredient chips editable | Persist call jobs in Mongo; rate-limit; Sheets writer creates per-job sheet | Phase 1 + 2 production-quality on real demo data |

**Standup C.** Map shows real pantries. Real fridge photos return real recipes. **If behind, see [§MVP cuts](#mvp-cuts).**

### Block D — Phase 3 voice + Sheets stream (T+12 → T+17)

| H | Howie | Jam | Aryan | Sahil |
|---|---|---|---|---|
| 12–14 | Dashboard layout: list of in-flight calls + transcripts | Pantry select UI ("Call these 3"), confirmation modal | `/api/calls/start`, `/api/calls/:id/stream` (SSE backed by Mongo change streams) | ElevenLabs agent + Twilio outbound configured; one real call to a team phone works |
| 14–16 | Stream transcripts live, status badges, summary card | Polish, animations, audio playback of call recordings | **Google Sheets writer**: appends 1 row per pantry on `item_started`, updates same row on `item_finished` | Parallel fan-out; structured summary per call; webhook handlers |
| 16–17 | <a id="step-7"></a>**Step 7: build `/plan/[jobId]` route view** — pick stops, show optimized route on Mapbox, "open in Apple/Google Maps" buttons | Polish staples + recipe screens | `/api/plan/build` endpoint (Mapbox Directions API integration) | Stand by to fix prompt regressions |

**Standup D.** End-to-end demo flow works. **No new features after this.**

### Block E — Polish, demo, fallback (T+17 → T+20)

| H | Howie | Jam | Aryan | Sahil |
|---|---|---|---|---|
| 17–18 | Demo script v1, screen-record raw flows | Visual polish pass, 404/empty states | Production deploy, smoke tests, seed demo data into Mongo | Pre-record one perfect call as fallback, freeze prompts |
| 18–19 | 90-sec video edit | Mobile QA, tweak copy | Lock branch, only hotfix commits | Stand by for fixes |
| 19–20 | Submit, sleep | Submit, sleep | Submit, sleep | Submit, sleep |

## Phase details (the human-readable version)

### <a id="phase-1"></a>Phase 1 — Vision + Backboard-aware recipes

**Goal:** photo of fridge → ingredient list → user-added staples → 3 recipes tailored to memory + expiry.

- **Step 1 (vision):** image (jpeg/png, ≤8MB) → **Gemini VLM** returns `{ingredients: [{name, qty?, confidence, estimatedExpiryDays?}]}`. Each ingredient gets a rough expiry heuristic stamped (produce ~5d, dairy ~7d, raw meat ~3d, leftovers ~3d, unknown ~10d).
- **Step 2 (staples):** user reviews ingredients (add/remove chips) and adds staples they have (flour, salt, oil, garlic, onion, rice, pasta, beans, etc.). Staples are written to Backboard so they auto-fill on next visit.
- **Step 3 (recipes):** server pulls Backboard memory (`dietary_restriction[]`, `cuisine_preference[]`, `family_size`, `excluded_ingredient[]`, recent `pantry_visit` history), merges fridge ingredients + staples + memory, and asks the model for 3 recipes that **prioritize using the soonest-to-expire ingredients first**. Output: `{recipes: [{title, time, servings, ingredientsUsed, ingredientsMissing, expiryUrgencyScore, steps}]}`.

The `ingredientsMissing` of the user's chosen recipe feeds into Phase 2 as the search query.

### <a id="phase-2"></a>Phase 2 — Pantry locator agent (Mongo-backed)

**Goal:** user location + missing ingredients → ranked pantries with hours/phone/distance, persistently cached.

- **Inputs:** `{lat, lng, need[]}`.
- **Outputs:** `[{id, name, lat, lng, address, phone, hours, distanceMeters, openNow, score}]`.
- **Strategy:** Google Places `Nearby Search` for "food pantry" within 10mi. Upsert into MongoDB `pantries` collection (with `2dsphere` geospatial index). LLM agent re-ranks based on `openNow`, distance, and any cached "they had X yesterday" notes from past Phase 3 calls (stored on the pantry document as `recentNotes[]`).
- **Cache:** `pantry_lookups` collection with rounded `(lat, lng)` + need-set hash key, 1h TTL.

### <a id="phase-3"></a>Phase 3 — Voice swarm + Sheets stream

**Goal:** call N pantries in parallel with an AI voice, ask scripted questions, return structured summaries — into both a live dashboard and a Google Sheet.

- **Inputs:** `{pantryIds[], questions[], neededItems[]}`.
- **Outputs:** per call `{pantryId, status, durationSec, transcript, structured: {openUntil, hasItems[], requirements[], notes}, audioUrl, sheetRowUrl}`. Aggregate `summary: {succeeded, failed, openNow, withRequestedItems, sheetUrl, planSuggestionPantryIds}`.
- **Tech:** ElevenLabs Conversational AI agent + Twilio outbound number; one job per pantry, fanned out in parallel via `asyncio.gather`; results written to Mongo `call_events` (change streams drive SSE) and **mirrored to a Google Sheet** (one sheet per job, appended in real time).
- **Ethics gate:** in dev/demo we **only call our own test phone numbers** (Twilio numbers we own / team phones). Never auto-dial real pantries without consent. See [`04-risks.md`](./04-risks.md#ethical-call-policy).

### Step 7 — Final plan + route

**Goal:** turn the swarm-call results into a single actionable plan.

- After Phase 3 finishes (or early-finishes), the user picks 1–3 pantries to actually visit.
- Backend hits **Mapbox Directions API** with the user's origin + selected pantries as waypoints, optimizing for shortest total time.
- Output view: ordered list of stops with what's available at each (from Phase 3 `structured`), driving/walking time, total distance, "Open in Apple Maps" / "Open in Google Maps" buttons, and the route drawn on the map.

## MVP cuts (drop in this order if behind)

1. Drop voice **recordings** download (keep transcript only).
2. Drop **parallel** in Phase 3 — sequential calls of 2 pantries instead of N.
3. Drop **Backboard** entirely — hardcode preferences and skip expiry ranking. (Recipes still work, just not personalized.)
4. Drop **Google Sheets** mirror — dashboard only.
5. Drop **clusters** — plain markers only.
6. Drop **real Phase 2** — return curated 30-pantry seed list from `data/seed_pantries.json`.
7. Drop **Phase 3 entirely** — show pre-recorded call as a video in the demo.
8. Drop **Step 7 route** — show selected pantries as a list, no Mapbox Directions.

If you cut, update [`03-status.md`](./03-status.md) and tell the team in standup.

## Definition of done (demo-ready)

- [ ] Open app on phone → upload fridge photo → see ingredients in <10s.
- [ ] Add a couple of staples → see 3 recipes that prioritize a near-expiry item, in <10s.
- [ ] Open map → see ≥10 real pantries near demo location.
- [ ] Tap "Call these 3 pantries" → see live transcripts in dashboard AND rows appearing in a public Google Sheet → see structured summary in <90s.
- [ ] Tap "Build my plan" → see a routed map with 2 stops in order.
- [ ] Deployed at a public URL, works on judge's phone.
- [ ] 90-sec demo video uploaded.

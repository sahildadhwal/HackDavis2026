# Task List

> Mirror: [`docs/human/01-plan.md`](../human/01-plan.md) and [`docs/human/03-status.md`](../human/03-status.md). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Format:** each task has an `id`, an `owner`, the **block** it belongs to (A/B/C/D/E), the **files** it touches, the **acceptance check**, and **dependencies**. AI agents: pick the next task whose deps are met. Humans: tick boxes in `03-status.md` once the acceptance check passes.

## Block A — Setup (T+0 → T+2)

- **A1 (Aryan, infra)** — Next.js app skeleton.
  - Files: root `package.json`, `app/layout.tsx`, `app/page.tsx`, `tailwind.config.ts`, `tsconfig.json`, `.env.local.example`.
  - Acceptance: `pnpm dev` serves a landing page; `pnpm build` succeeds; deploy to Vercel returns 200.
  - Deps: none.

- **A2 (Aryan, infra)** — **MongoDB Atlas** cluster + connection helper + indexes script.
  - Files: `lib/mongo/client.ts`, `lib/mongo/indexes.ts` (run on Next.js boot), `.env.local.example` adds `MONGODB_URI`, `MONGODB_DB`.
  - Acceptance: `node -e "import('./lib/mongo/indexes.js')"` (or boot script) creates all indexes incl. `2dsphere` on `pantries.location`. A seed pantry inserted with GeoJSON Point is found by `$near`.
  - Deps: A1.

- **A3 (Aryan, backend)** — `lib/server/session.ts`, `lib/server/respond.ts`, `lib/server/logger.ts`, `lib/schemas.ts`. Implement `GET /api/health`, `POST /api/session`.
  - Acceptance: both routes return the envelope from [`03-api-contracts.md`](./03-api-contracts.md).
  - Deps: A2.

- **A4 (Aryan, backend)** — **Backboard client** wrapper + smoke test.
  - Files: `lib/backboard/client.ts`, `services/ai/app/integrations/backboard_client.py`. (Sahil reviews.)
  - Acceptance: `upsert(userId, 'pantry_staple', {value:'salt'})` then `list(userId, 'pantry_staple')` returns `[{value:'salt'}]`. If Backboard SDK signature differs from our spec, update `05-backend-spec.md#backboard-memory` and `02-conventions.md` immediately, both sides.
  - Deps: A1.

- **A5 (Sahil, AI)** — Scaffold Python service.
  - Files: `services/ai/pyproject.toml`, `services/ai/app/main.py`, `services/ai/app/settings.py`, `services/ai/app/schemas.py`, `services/ai/app/routers/health.py`.
  - Acceptance: `uvicorn app.main:app` runs; `GET /healthz` returns `{status:"ok", phase_stub:{...}}`; bearer auth enforced.
  - Deps: none.

- **A6 (Howie, frontend)** — Map page renders empty Mapbox.
  - Files: `app/map/page.tsx`, `components/map/MapView.tsx`, `lib/config.ts` (with `DEMO_CITY_CENTER`).
  - Acceptance: opens to Mapbox Streets v12 centered on demo city; no markers.
  - Deps: A1.

- **A7 (Jam, frontend)** — Camera/upload + ingredients editor + **staples chips** UI shells (no fetch).
  - Files: `app/scan/page.tsx`, `components/fridge/FridgeUploader.tsx`, `components/fridge/IngredientsEditor.tsx`, `components/fridge/StaplesInput.tsx`, `components/fridge/PreferencesForm.tsx`.
  - Acceptance: image preview shows; ingredient + staples chips editable; preferences disclosure works; localStorage persists staples for now.
  - Deps: A1.

- **A8 (Sahil/Aryan, infra)** — Verify all 7 keys (Gemini, Mapbox, Google Places, ElevenLabs, Twilio, Backboard, Google service account JSON). Store in 1Password vault.
  - Acceptance: each key responds to a smoke call.
  - Deps: none.

- **A9 (Aryan, infra)** — Provision Twilio outbound number; verify team phones in trial mode.
  - Acceptance: `twilio.calls.create(to=team_phone, from_=ours, twiml="<Response><Say>Test</Say></Response>")` rings.
  - Deps: A8.

- **A10 (Aryan, infra)** — Create master **Google Sheet**, share with service account; capture `SHEETS_SPREADSHEET_ID`. Implement `lib/sheets/client.ts` `createJobTab` smoke test.
  - Acceptance: calling `createJobTab("smoke")` adds a tab with the correct headers; tab URL opens.
  - Deps: A8.

## Block B — Skeleton end-to-end (T+2 → T+6)

- **B1 (Aryan, backend)** — Implement `POST /api/fridge/scan` Route Handler with stub Python call. Image uploaded to Mongo GridFS or Vercel Blob and a server-readable URL passed to Python.
  - Files: `app/api/fridge/scan/route.ts`, `lib/ai-client.ts`, `lib/mongo/gridfs.ts` (or Vercel Blob helper).
  - Acceptance: posting a multipart image returns the `Phase1VisionResponse` envelope using stub data.
  - Deps: A3, A4, A5.

- **B2 (Aryan, backend)** — `POST /api/fridge/recipes` Route Handler (stub Python call, reads staples from Backboard if not provided).
  - Files: `app/api/fridge/recipes/route.ts`.
  - Acceptance: returns 3 mocked recipes with stub flag on.
  - Deps: B1, A4.

- **B3 (Aryan, backend)** — `GET /api/memory/staples`, `PUT /api/memory/staples`, `GET /api/memory/preferences`, `PUT /api/memory/preferences`.
  - Acceptance: round-trip with Backboard works; with `BACKBOARD_STUB=true` returns canned defaults.
  - Deps: A4.

- **B4 (Aryan, backend)** — `GET /api/pantries` Route Handler: Mongo geospatial fast path + stub Python fallback + `pantry_lookups` cache.
  - Files: `app/api/pantries/route.ts`, `app/api/pantries/[id]/route.ts`.
  - Acceptance: stub data round-trips through the cache; second call within 1h hits cache.
  - Deps: A3, A5.

- **B5 (Sahil, AI)** — Phase 1 vision **stub mode** + minimal real Gemini prompt.
  - Files: `services/ai/app/routers/phase1.py`, `services/ai/app/agents/vision.py`, `services/ai/app/stubs/phase1_vision.json`.
  - Acceptance: with `PHASE_1_VISION_STUB=true`, returns the fixture; with `false`, returns valid response for a single test image via Gemini.
  - Deps: A5, A8.

- **B6 (Sahil, AI)** — Phase 1 recipes stub + minimal real Gemini prompt (no Backboard reads yet).
  - Files: `services/ai/app/agents/recipes.py`, `services/ai/app/stubs/phase1_recipes.json`.
  - Acceptance: stub returns 3 fixture recipes; real call returns 3 valid recipes for `{ingredients, staples}`.
  - Deps: B5.

- **B7 (Sahil, AI)** — Phase 2 stub + Google Places retrieval (no LLM ranking yet); upserts to Mongo.
  - Files: `services/ai/app/routers/phase2.py`, `services/ai/app/integrations/google_places.py`, `services/ai/app/stubs/phase2_locate.json`, `data/seed_pantries.json`.
  - Acceptance: stub returns 10 fixture pantries; real call returns ≥5 within 10mi of demo city; Mongo `pantries` populated with valid GeoJSON Points.
  - Deps: A5, A8, B4.

- **B8 (Howie, frontend)** — Markers from `/api/pantries`; click → empty side panel.
  - Files: `components/map/MapView.tsx`, `components/map/PantryPanel.tsx`.
  - Acceptance: stub data renders pins; clicking a pin opens the panel showing the pantry name.
  - Deps: A6, B4.

- **B9 (Jam, frontend)** — Scan flow: vision call → ingredient chips render → staples step → recipes call → 3 cards visible.
  - Files: `components/fridge/RecipesPanel.tsx`, `components/fridge/RecipeCard.tsx`.
  - Acceptance: full /scan flow runs end-to-end on stub data.
  - Deps: A7, B1, B2.

- **B10 (Aryan, infra)** — Sheets writer skeleton: `createJobTab` + `appendRow` + `updateRow` (in-process row map).
  - Files: `lib/sheets/client.ts`, `services/ai/app/integrations/sheets_client.py`.
  - Acceptance: a manual test creates a tab, appends 3 rows, then updates the middle one in place.
  - Deps: A10.

- **B11 (Aryan, infra)** — Deploy Python service to Render; wire `AI_SERVICE_URL` in Vercel.
  - Acceptance: production Vercel app's `/api/fridge/scan` proxies to deployed Python service successfully.
  - Deps: B1, B5.

## Block C — Phase 1 + 2 real (T+6 → T+12)

- **C1 (Sahil, AI)** — Phase 1 vision production prompt + expiry hints + provider swap (Gemini → OpenAI fallback).
  - Files: `services/ai/app/agents/vision.py`, `services/ai/tests/test_phase1.py`.
  - Acceptance: vision tests green; expiry days populated for every ingredient.
  - Deps: B5.

- **C2 (Sahil, AI)** — Phase 1 recipes Backboard-aware: pulls `dietary_restriction`, `cuisine_preference`, `family_size`, `excluded_ingredient`, recent `fridge_inventory_item`. `expiry_urgency_score` works.
  - Files: `services/ai/app/agents/recipes.py`, `services/ai/app/integrations/backboard_client.py`, `services/ai/tests/test_phase1.py`.
  - Acceptance: all `test_phase1.py` tests green incl. `test_expiry_urgency_when_top_inventory_used`.
  - Deps: B6, A4.

- **C3 (Sahil, AI)** — Phase 2 ranking with Gemini structured output; pull `recentNotes` from `pantries` doc.
  - Files: `services/ai/app/agents/pantry_locator.py`, `services/ai/tests/test_phase2.py`.
  - Acceptance: open pantries outrank closed when `need` is non-empty; ≤`limit` results returned; `test_geojson_lng_first` passes.
  - Deps: B7.

- **C4 (Howie, frontend)** — Marker clustering via `useSupercluster`; "Near me" geolocation button.
  - Files: `components/map/useSupercluster.ts`, `components/map/MapView.tsx`.
  - Acceptance: 25+ pantries cluster smoothly at zoom < 12.
  - Deps: B8.

- **C5 (Howie, frontend)** — Multi-select + sticky `<CallStartBar>`.
  - Files: `components/calls/CallStartBar.tsx`, integrate into `app/map/page.tsx`.
  - Acceptance: ⌘-click adds to selection; bar shows chips; "Call N" button enabled when N≥1.
  - Deps: C4.

- **C6 (Jam, frontend)** — Staples persisted to Backboard via `/api/memory/staples`; preferences persisted via `/api/memory/preferences`. Default suggestion chips shown.
  - Files: `components/fridge/StaplesInput.tsx`, `components/fridge/PreferencesForm.tsx`.
  - Acceptance: staples added on first visit auto-fill on second visit.
  - Deps: B3, B9.

- **C7 (Jam, frontend)** — Recipe card "near-expiry" badge; "Find missing items" button → push to `/map?need=<csv>`.
  - Acceptance: badge appears for `expiryUrgencyScore > 0.6`; map page receives the `need` query.
  - Deps: B9.

- **C8 (Jam, frontend)** — Loading/empty/error states on every fetch; mobile layout pass.
  - Acceptance: pulling Wi-Fi mid-scan shows the error state with retry; map page works on iPhone Safari.
  - Deps: C7.

- **C9 (Aryan, backend)** — Persist fridge scans + pantry lookups in Mongo; rate-limit guard (max 30 req/min per session).
  - Files: `app/api/fridge/scan/route.ts`, `app/api/pantries/route.ts`, `lib/server/ratelimit.ts`.
  - Acceptance: docs appear in collections; rate-limit returns 429.
  - Deps: B1, B4.

## Block D — Phase 3 voice + Sheets stream + Plan (T+12 → T+17)

- **D1 (Sahil, AI)** — Provision ElevenLabs Conversational AI agent with the system prompt template; capture `ELEVENLABS_AGENT_ID`.
  - Acceptance: a manual test from the ElevenLabs dashboard plays back the opening sentence correctly.
  - Deps: A8.

- **D2 (Sahil, AI)** — `start_one_call` end-to-end: ElevenLabs signed URL → Twilio outbound with `<Connect><Stream>` → one team phone rings, AI greets, conversation works.
  - Files: `services/ai/app/integrations/elevenlabs_client.py`, `services/ai/app/integrations/twilio_client.py`, `services/ai/app/agents/caller.py`, `services/ai/app/routers/phase3.py`.
  - Acceptance: a real call lands on a team phone; you can have a 30-second conversation.
  - Deps: D1, A9.

- **D3 (Sahil, AI)** — Webhooks: Twilio status + ElevenLabs transcript → `call_events` in Mongo. Summarization on conversation_ended via Gemini.
  - Files: `services/ai/app/routers/phase3.py` (webhook handlers), `services/ai/app/agents/caller.py` (summarizer).
  - Acceptance: a completed test call leaves `call_events` rows of every kind and `call_jobs.items[].structured` populated.
  - Deps: D2.

- **D4 (Sahil, AI)** — Ethics gate: `DEMO_FALLBACK_PHONES` round-robin, `ALLOW_REAL_PANTRY_CALLS=false` by default.
  - Acceptance: `test_ethics_gate_blocks_real_phone_when_no_allowlist` passes; demo dialing only hits team phones.
  - Deps: D2.

- **D5 (Sahil, AI)** — Parallel fan-out via `asyncio.gather`; stub-mode event emitter for Howie/Jam.
  - Files: `services/ai/app/agents/caller.py`, `services/ai/app/stubs/phase3_events.py`.
  - Acceptance: with `PHASE_3_STUB=true`, three pantries run in parallel and complete in <60s with progressive events.
  - Deps: D3.

- **D6 (Aryan, backend)** — `POST /api/calls/start` (creates Sheet tab + Mongo job) + `GET /api/calls/:jobId/stream` (SSE via Mongo change streams).
  - Files: `app/api/calls/start/route.ts`, `app/api/calls/[jobId]/stream/route.ts`, `lib/mongo/changestream.ts`.
  - Acceptance: opening the SSE connection in the browser receives stub events live; `sheetUrl` returned and works.
  - Deps: D5, B10.

- **D7 (Sahil + Aryan)** — Sheets mirror: `append_row` on `item_started`, `update_row` on `item_finished`. In-process pantry→row map; recovery via column scan.
  - Files: `services/ai/app/integrations/sheets_client.py`, `services/ai/app/agents/caller.py`.
  - Acceptance: during a 3-pantry stub run, the Sheet tab shows 3 rows that update in place as items complete.
  - Deps: D6.

- **D8 (Howie, frontend)** — Voice-call dashboard.
  - Files: `app/calls/[jobId]/page.tsx`, `components/calls/CallDashboard.tsx`.
  - Acceptance: live transcripts stream in role-tagged bubbles; per-call summary card on completion; aggregate summary on `job_finished`; "Open Sheet" button works; "Build my plan" CTA visible.
  - Deps: D6.

- **D9 (Jam, frontend)** — Pantry-select confirmation modal; navigation from `/map` to `/calls/[jobId]`.
  - Files: `components/calls/CallStartModal.tsx`.
  - Acceptance: clicking "Call N pantries" shows the modal; confirm posts to `/api/calls/start` and navigates.
  - Deps: D6, C5.

- **D10 (Aryan, backend)** — `POST /api/plan/build` and `GET /api/plan/:planId`. Calls **Mapbox Directions API** `/optimized-trips/v1` for shortest tour.
  - Files: `app/api/plan/build/route.ts`, `app/api/plan/[planId]/route.ts`, `lib/mapbox/directions.ts`.
  - Acceptance: given 2 pantry IDs + an origin, returns a `Plan` with `routeGeoJSON`, ordered stops, total duration; valid `googleMapsUrl` and `appleMapsUrl`.
  - Deps: D8.

- **D11 (Howie, frontend)** — `<PlanView>` + `<StopPicker>`. The /plan/[planId] page draws the route, ordered stops with Phase-3 results, and the "Open in Maps" buttons.
  - Files: `app/plan/[planId]/page.tsx`, `components/plan/PlanView.tsx`, `components/plan/StopPicker.tsx`, extends `components/map/MapView.tsx` for `routeGeoJSON` + numbered stops.
  - Acceptance: from the dashboard, "Build my plan" → pick 2 stops → `/plan/[planId]` shows the optimized route.
  - Deps: D10.

## Block E — Polish & demo (T+17 → T+20)

- **E1 (Aryan, infra)** — Production deploy stable; smoke-test all endpoints; load seed pantry data into Mongo for demo city.
  - Acceptance: 30 minutes of zero errors in the `errors` collection on prod.
  - Deps: D8, D11.

- **E2 (Jam, frontend)** — Visual polish pass: empty states, copy, mobile QA on iPhone + Android.
  - Acceptance: every screen looks intentional on a 375×812 viewport.
  - Deps: D8, D11.

- **E3 (Sahil, AI)** — Pre-record a perfect call as fallback (mp3 + transcript + Sheet pre-fill); freeze prompts.
  - Acceptance: fallback file exists at `public/demo/fallback-call.mp3`; switching demo to fallback works in 1 click and the fallback Sheet is also linked from the dashboard.
  - Deps: D2.

- **E4 (Howie, demo)** — Demo script v1, dry-run, 90-sec video. Public Google Sheet URL ready for projection.
  - Acceptance: video uploaded; team agrees on the script.
  - Deps: E1.

- **E5 (All, demo)** — Submit. Sleep.
  - Deps: E4.

## Quick "what should I do next?" decision tree (for an AI agent)

1. Are all Block A tasks done? → No: do the next Block A task you're allowed to (your owner field matches your role, deps green).
2. Else: same for Block B.
3. Else: same for Block C.
4. Else: same for Block D.
5. Else: same for Block E.
6. If all your assigned tasks are done and someone else is blocked, switch to backup (see [`docs/human/01-plan.md#ownership-matrix`](../human/01-plan.md#ownership-matrix)) and pick a task whose primary is overloaded.

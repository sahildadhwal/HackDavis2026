# Tech Decisions & Rationale

> Mirrors: [`docs/agent/01-architecture.md`](../agent/01-architecture.md) (system shape), [`docs/agent/04-frontend-spec.md`](../agent/04-frontend-spec.md) (frontend), [`docs/agent/03-api-contracts.md`](../agent/03-api-contracts.md) + [`docs/agent/05-backend-spec.md`](../agent/05-backend-spec.md) (backend). Sync index: [`docs/SYNC.md`](../SYNC.md).

## TL;DR stack

- **Frontend:** Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui + `react-map-gl` + Mapbox GL JS.
- **Backend (app):** Next.js API routes (TypeScript) for CRUD/sessions/streaming. Hosted on Vercel.
- **Backend (AI):** FastAPI (Python) microservice for Phases 1–3, owned by Sahil. Hosted on Render or Fly.io.
- **DB:** **MongoDB Atlas** — collections for `pantries` (with `2dsphere` geospatial index for "near me"), `pantry_lookups` (cache), `call_jobs`, `call_events`, `fridge_scans`, `sessions`. Change streams power live updates.
- **User memory:** **Backboard** — stores dietary restrictions, family size, cuisine preferences, pantry-visit history, and recent fridge inventory items (with expiry hints) per user. Drives personalization and the "use up nearer-expiry items" recipe ranking.
- **Map renderer:** Mapbox GL JS via `react-map-gl`.
- **Pantry data:** Google Places API (`Nearby Search`, keyword=`food pantry`), upserted into MongoDB.
- **AI vision:** **Gemini 1.5 Pro / 2.0 Flash** for ingredient detection (per Jay).
- **AI text (recipes, ranking, summaries):** Gemini for recipes (single-provider), or fall back to OpenAI if Gemini quotas hit.
- **Voice calls:** ElevenLabs Conversational AI agent + **Twilio** outbound voice for Phase 3.
- **Live results destination:** **Google Sheets** (one sheet per call job, appended via Sheets API service account) **+** in-app dashboard.
- **Routing (step 7):** Mapbox Directions API to compute optimized route across selected pantries.
- **Deploy:** Vercel (web) + Render (Python AI service) + MongoDB Atlas + Backboard cloud.

## <a id="frontend"></a>Frontend

- **Why Next.js App Router:** server components let us keep API keys server-side (Mapbox token excepted), file-based routing is fast, Vercel deploy is one click, and SSE streaming for Phase 3 is trivial via Route Handlers.
- **Why Tailwind + shadcn/ui:** copy-paste components, consistent look in <2 hours, no design debate.
- **Why `react-map-gl`:** ergonomic React API around Mapbox GL JS, declarative markers/popups, plays nicely with our component model.
- **New screen — `/scan`:** two-step inline flow: upload → review ingredients (chips) **+ add staples** (chips) → "Generate recipes". Don't push to a new page between steps.
- **New screen — `/plan/[jobId]`:** shows the optimized route across selected pantries with what's available at each stop (from Phase 3 results).

## <a id="backend"></a>Backend

- **Two services, one repo (monorepo).** Next.js app at root, Python AI service in `services/ai/`. Aryan owns the boundary contract.
- **Why MongoDB Atlas (not Postgres/Supabase):** decided by Jay. Wins for us:
  - Geospatial queries (`$near`, `$geoWithin`) baked in — perfect for "pantries within 10mi".
  - Change streams replace Supabase Realtime for live transcript streaming.
  - Document model fits "pantry has an inventory list" naturally.
  - Atlas free M0 tier is enough for hackathon.
- **Why Backboard (not custom Postgres "users.preferences"):** decided by Jay. Backboard is purpose-built for AI memory: it stores typed memories, retrieves the relevant ones for a query, and keeps "recently retrieved" items hot — which is exactly what we need to prioritize fresh fridge items in recipe generation.
- **Why Gemini VLM (not GPT-4o):** decided by Jay. Comparable accuracy at our scale, larger free quota for hackathons, and Jay has prior experience with the SDK so iteration is fast.
- **Why Google Sheets for the live destination:** Sahil's spec calls for it explicitly, and it's brilliant for a hackathon demo: judges open a public sheet URL on their phone and see rows appear live as the AI calls happen. It's also a free audit trail.
- **Streaming Phase 3 transcripts:** Python service writes events to Mongo `call_events` collection → Next.js Route Handler subscribes via Mongo change streams → re-emits as SSE to the browser. In parallel, the Python service appends/updates rows in the per-job Google Sheet via the Sheets API.

## The map decision

We considered four options. **We chose Mapbox + Google Places.**

| Option | Why we considered | Why we passed |
|---|---|---|
| **Mapbox GL JS** ✅ chosen | Best polish per hour spent; great React bindings; free at our scale; good Directions API for step 7 | Needs a token (2-min signup, no card) |
| Google Maps JS API | Best built-in pantry data via Places API | Requires billing card; slower to style; we already get Places data via the server-side API |
| Leaflet + OSM | Zero config, no key | Looks plain; markers/clustering require more glue |
| MapLibre GL | OSS Mapbox alternative | Tile provider story is fiddlier than just using Mapbox |

**Pantry data:** Google Places API (`Nearby Search`) server-side, upserted to MongoDB. Best of both: Mapbox visuals, Google's data, our own persistent cache.

**Geolocation:** `navigator.geolocation` with manual zip/address fallback (Mapbox Geocoding API).

**Routing (step 7):** Mapbox Directions API (`/optimized-trips/v1`) computes the best order to visit selected pantries.

**Fallback:** if Google Places billing is a blocker, we ship a 30-row curated seed dataset for one demo city. See [`04-risks.md`](./04-risks.md#pantry-data-blocked).

## What we said no to

- **Real auth (Clerk/NextAuth).** Anonymous session cookie + Backboard `userId` keyed off the session. Add real auth post-demo.
- **Native mobile app.** PWA + responsive web only.
- **Custom CV model for fridge.** Gemini VLM is faster and more accurate than anything we'd train in 20h.
- **LangChain / LangGraph.** Adds setup cost. We use raw provider SDKs; orchestrate the 3 phases in plain Python.
- **Realtime collab.** Single user only.
- **Internationalization.** English only for demo.
- **Postgres.** MongoDB only — picked by Jay.

## Environment variables (overview)

Owned by Aryan. Full list in [`docs/agent/02-conventions.md`](../agent/02-conventions.md#environment-variables). Stored in 1Password vault "FoodPantryHack" — share with team at T+0.

## Open questions (decide in Block A)

- [ ] Demo city? (affects seed pantry data and the demo `/plan` route) — proposal: **wherever the hackathon is held**.
- [ ] Twilio number provisioned? Aryan to do at T+0 (10-min signup, ~$1/mo).
- [ ] ElevenLabs Conversational AI quota check on our account. Sahil to verify at T+0.
- [ ] **Backboard** account & API key in hand. Sahil to verify at T+0 — confirm the SDK shape (we currently assume `memory.upsert(userId, kind, payload)` / `memory.search(userId, query, kinds, limit)`; align if different).
- [ ] **Google Cloud service account** for Sheets API created and JSON downloaded. Aryan to do at T+0.
- [ ] **MongoDB Atlas** free cluster created, IP allowlist `0.0.0.0/0` for hackathon, connection string in env. Aryan at T+0.

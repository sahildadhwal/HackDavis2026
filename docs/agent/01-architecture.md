# Architecture

> Mirror: [`docs/human/02-tech-decisions.md`](../human/02-tech-decisions.md). Sync index: [`docs/SYNC.md`](../SYNC.md).

## System shape

```
                         ┌────────────────────────┐
                         │    Browser (PWA)       │
                         │  Next.js 15 + RSC      │
                         └────────────┬───────────┘
                                      │ HTTPS
                                      ▼
                         ┌────────────────────────┐
                         │  Next.js (Vercel)      │
                         │  app/ + app/api/       │  ← session, CRUD, SSE
                         └─┬──────────┬───────┬───┘
                           │          │       │
        MongoDB Atlas      │          │       │ HTTP (server-to-server, bearer)
        (pantries,         │          │       │
        fridge_scans,      │          │       ▼
        call_jobs,         │          │  ┌─────────────────────────┐
        call_events)       │          │  │  AI Service (Python)    │
                           │          │  │  FastAPI on Render      │
                           ▼          │  │  Phases 1, 2, 3         │
                   ┌─────────────┐    │  └────┬────────┬───────┬───┘
                   │  MongoDB    │◄───┘       │        │       │
                   │  Atlas      │            │        │       │
                   └─────┬───────┘            ▼        ▼       ▼
                         │           ┌──────────────────────────────────┐
                         │           │  External APIs                    │
                         │           │  - Gemini (vision + recipes)      │
                         │ change    │  - Backboard (user memory)        │
                         │ streams   │  - Google Places (pantry data)    │
                         │           │  - ElevenLabs Conv. AI (voice)    │
                         │           │  - Twilio Voice (PSTN outbound)   │
                         │           │  - Google Sheets API (results)    │
                         │           │  - Mapbox Directions (step 7)     │
                         │           └──────────────────────────────────┘
                         │
                         ▼
                  ┌────────────────────┐         (parallel write)
                  │ Next.js SSE Route  │       ┌──────────────────────┐
                  │ /api/calls/:id/    │       │  Public Google Sheet │
                  │       stream       │       │  (one tab per job)   │
                  └────────────────────┘       └──────────────────────┘
```

## Repo layout

```
food.pantry/
├── app/                          # Next.js App Router (frontend + API routes)
│   ├── (marketing)/page.tsx     # landing
│   ├── scan/page.tsx            # fridge upload + ingredients + staples + recipes
│   ├── map/page.tsx             # pantry map + side panel + selection
│   ├── calls/[jobId]/page.tsx   # voice-call dashboard
│   ├── plan/[jobId]/page.tsx    # final plan + mapped route (step 7)
│   └── api/
│       ├── health/route.ts
│       ├── session/route.ts
│       ├── memory/staples/route.ts          # GET, PUT
│       ├── memory/preferences/route.ts      # GET, PUT
│       ├── fridge/scan/route.ts             # vision only
│       ├── fridge/recipes/route.ts          # recipes (Backboard-aware)
│       ├── pantries/route.ts
│       ├── pantries/[id]/route.ts
│       ├── calls/start/route.ts
│       ├── calls/[jobId]/stream/route.ts    # SSE backed by Mongo change streams
│       ├── plan/build/route.ts              # POST: builds optimized route
│       └── plan/[planId]/route.ts           # GET
├── components/                   # shadcn + custom
│   ├── ui/                       # shadcn primitives
│   ├── map/
│   ├── fridge/                   # uploader, ingredient editor, staples chips, recipe cards
│   ├── calls/
│   └── plan/                     # plan view, route map, stop list
├── lib/
│   ├── mongo/                    # mongo client + helpers
│   ├── backboard/                # Backboard client wrapper
│   ├── sheets/                   # Google Sheets client wrapper
│   ├── ai-client.ts              # typed client for the Python service
│   └── schemas.ts                # zod schemas (shared with API contracts)
├── services/
│   └── ai/                       # Python FastAPI service (Sahil)
│       ├── pyproject.toml
│       ├── app/
│       │   ├── main.py
│       │   ├── routers/
│       │   │   ├── phase1.py             # /vision and /recipes
│       │   │   ├── phase2.py
│       │   │   └── phase3.py
│       │   ├── agents/
│       │   │   ├── vision.py
│       │   │   ├── recipes.py
│       │   │   ├── pantry_locator.py
│       │   │   └── caller.py
│       │   └── integrations/
│       │       ├── gemini_client.py
│       │       ├── backboard_client.py
│       │       ├── google_places.py
│       │       ├── elevenlabs_client.py
│       │       ├── twilio_client.py
│       │       ├── sheets_client.py
│       │       └── mongo_client.py
│       ├── stubs/
│       └── tests/
├── data/
│   └── seed_pantries.json        # 30-row fallback dataset
├── public/
├── docs/                         # this folder
├── .env.local.example
├── package.json
└── README.md
```

## Data flow per phase / step

### Step 1 — vision (`POST /api/fridge/scan`)
1. Browser → `POST /api/fridge/scan` (multipart: image only).
2. Route handler uploads image to MongoDB GridFS (or Vercel Blob), returns a server-readable URL, inserts row in `fridge_scans` with `status="vision_pending"`.
3. Route handler calls Python `POST /v1/phase1/vision` with `imageUrl`.
4. Python: Gemini VLM returns ingredients with rough expiry hints.
5. Route handler updates `fridge_scans` (status=`vision_done`, ingredients), returns to browser.

### Step 2 — staples (`PUT /api/memory/staples`)
1. Browser → `PUT /api/memory/staples` with `{staples: string[]}`.
2. Route handler writes to **Backboard** as `kind="pantry_staple"`, payload `{name}` per staple. Replaces the user's existing staple set.
3. Returns `{staples: string[]}` (the canonical set).

### Step 3 — recipes (`POST /api/fridge/recipes`)
1. Browser → `POST /api/fridge/recipes` with `{scanId, ingredients[] (post-edit), staples[]}` (server reads staples from Backboard if not provided).
2. Route handler reads Backboard for `dietary_restriction[]`, `cuisine_preference[]`, `family_size`, `excluded_ingredient[]`, recent `pantry_visit[]`.
3. Calls Python `POST /v1/phase1/recipes` with the merged context.
4. Python: Gemini text model returns 3 recipes with `expiryUrgencyScore`, prioritizing soon-to-expire fridge items.
5. Route handler updates `fridge_scans` (status=`done`, recipes), returns to browser.
6. Side effect: writes each detected fridge ingredient to Backboard as `kind="fridge_inventory_item"` with `lastSeenAt` timestamp + estimated expiry.

### Step 4 — pantry locator (`GET /api/pantries`)
1. Browser → `GET /api/pantries?lat=..&lng=..&need=tomato,bread`.
2. Route handler checks `pantry_lookups` collection cache (key: rounded lat/lng + need-set), returns cached result if <1h old.
3. On miss, calls Python `POST /v1/phase2/locate` with `{lat,lng,need[]}`.
4. Python: Google Places `Nearby Search` (keyword=`food pantry`, radius=10mi) → upserts into `pantries` Mongo collection (with `2dsphere` index) → Gemini tool call ranks the list using `openNow`, distance, and historical Phase-3 notes embedded on each pantry doc.
5. Route handler writes `pantry_lookups` row, returns ranked list.

### Step 5–6 — voice fan-out + Sheets (`POST /api/calls/start`)
1. Browser → `POST /api/calls/start` with `{pantryIds[], questions[], neededItems[]}`.
2. Route handler creates `call_jobs` doc + N embedded `items[]` (status=`queued`), creates a new tab in the master Google Sheet for this job, returns `{jobId, sheetUrl}`.
3. Forwards to Python `POST /v1/phase3/start`.
4. Python: spawns N async tasks via `asyncio.gather`. For each:
   - Creates an ElevenLabs Conversational AI signed agent URL (with dynamic vars: pantry name, needed items, questions).
   - Triggers a Twilio outbound call from our Twilio number to the (allowlisted) phone, with TwiML `<Connect><Stream url={signedUrl}/></Connect>`.
   - Writes `call_events` rows to Mongo as transcript chunks arrive via webhooks.
   - Mirrors each `item_started` / `item_finished` event to the per-job Google Sheet (1 row per pantry, updated in place).
   - On hangup, runs a "summarize" Gemini tool call → updates the `items[]` entry's `structured` field.
5. Browser opens SSE `GET /api/calls/:jobId/stream` → Mongo change streams → re-emits to browser.

### Step 7 — plan (`POST /api/plan/build`)
1. Browser (after viewing dashboard) → `POST /api/plan/build` with `{jobId, selectedPantryIds[], origin: {lat, lng}}`.
2. Route handler reads selected pantries from Mongo, calls **Mapbox Directions API** `/optimized-trips/v1/mapbox/driving/<coords>?source=first&destination=last&roundtrip=false` to get the optimal stop order + route geometry.
3. Builds a `Plan` document in Mongo `plans` collection with stops (each containing the pantry's Phase-3 `structured` summary), distances, durations, and the route GeoJSON.
4. Returns `{planId, stops[], totalDistanceMeters, totalDurationSec, googleMapsUrl, appleMapsUrl, routeGeoJSON}`.
5. Browser navigates to `/plan/[planId]`, renders the route on Mapbox.

## MongoDB collections

See [`05-backend-spec.md#mongo-collections`](./05-backend-spec.md#mongo-collections) for the canonical schema. Top-level collections:

- `sessions`
- `fridge_scans`
- `pantries` (with `2dsphere` index on `location`)
- `pantry_lookups` (with TTL index on `createdAt`)
- `call_jobs` (with embedded `items[]`)
- `call_events` (with change-stream subscription for SSE)
- `plans`

Backboard stores user memory (kind-tagged) — **not** in Mongo.

## Deployment topology

- **Vercel:** Next.js app. Env vars set in Vercel dashboard.
- **Render** (or Fly.io): Python FastAPI service. One small instance is enough.
- **MongoDB Atlas:** free M0 cluster. IP allowlist `0.0.0.0/0` for hackathon. Mark as tech debt.
- **Backboard:** managed cloud, one project / one app token shared by Next.js + Python.
- **Google Sheets:** one master spreadsheet, service account invited as editor; new tab per call job.
- **Twilio:** one outbound number provisioned by Aryan.
- **ElevenLabs:** one Conversational AI agent provisioned by Sahil.

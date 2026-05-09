# Backend Spec

> Mirror summary in [`docs/human/02-tech-decisions.md#backend`](../human/02-tech-decisions.md#backend). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Owner:** Aryan (Next.js Route Handlers, Mongo, Backboard, Sheets), Sahil (Python AI service).

## Two services

1. **Next.js Route Handlers** under `app/api/` — thin layer for auth (session cookie), validation, Mongo writes, Backboard reads/writes, Sheets writes, and proxying to the Python service. Hosted on Vercel.
2. **Python FastAPI service** under `services/ai/` — owns all AI logic. Hosted on Render.

The browser **never** talks to the Python service directly. Always proxied through Next.js so we can:
- Hide the `AI_SERVICE_TOKEN`.
- Persist requests in Mongo.
- Write to Backboard (Python also does this, but Next.js owns the staples/preferences endpoints).
- Apply rate limiting and timeouts uniformly.

## Next.js Route Handlers — implementation rules

Every handler:

```ts
// app/api/<route>/route.ts
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/respond';
import { logger } from '@/lib/server/logger';

export async function POST(req: Request) {
  const session = await getSession(req); // ensures cookie, upserts row
  const log = logger.child({ requestId: crypto.randomUUID(), sessionId: session.id });
  try {
    const body = SomeSchema.parse(await req.json());
    // ...do the work...
    return ok({ /* data */ });
  } catch (e) {
    log.error({ err: e }, 'route failed');
    return fail(e);
  }
}
```

Helpers `ok` / `fail` enforce the envelope shape from [`03-api-contracts.md`](./03-api-contracts.md#error-shape).

## Calling the Python service

`lib/ai-client.ts` exposes typed functions:

```ts
export const ai = {
  phase1Vision: (req: Phase1VisionRequest) => post<Phase1VisionResponse>('/v1/phase1/vision', req),
  phase1Recipes: (req: Phase1RecipesRequest) => post<Phase1RecipesResponse>('/v1/phase1/recipes', req),
  phase2Locate: (req: Phase2Request) => post<Phase2Response>('/v1/phase2/locate', req),
  phase3Start: (req: Phase3Request) => post<Phase3Response>('/v1/phase3/start', req),
};
```

`post` adds bearer auth, sets a 12s timeout via `AbortController`, and parses with the matching zod schema.

## <a id="mongo-collections"></a>MongoDB collections

Connection in `lib/mongo/client.ts` — singleton `MongoClient` with `serverSelectionTimeoutMS: 5000`.

```ts
// lib/mongo/indexes.ts — idempotent, run on Next.js boot
await db.collection('sessions').createIndex({ createdAt: 1 });

await db.collection('fridge_scans').createIndex({ sessionId: 1, createdAt: -1 });

await db.collection('pantries').createIndex({ location: '2dsphere' });
await db.collection('pantries').createIndex({ source: 1, sourceId: 1 }, { unique: true });

await db.collection('pantry_lookups').createIndex({ latQ: 1, lngQ: 1, needKey: 1, createdAt: -1 });
await db.collection('pantry_lookups').createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 }); // 1h TTL

await db.collection('call_jobs').createIndex({ sessionId: 1, createdAt: -1 });

await db.collection('call_events').createIndex({ jobId: 1, _id: 1 });

await db.collection('plans').createIndex({ jobId: 1 });
```

### Document shapes (informative, validated by zod / pydantic at the boundaries)

```ts
// sessions
{ _id: ObjectId, createdAt: Date }

// fridge_scans
{
  _id, sessionId: ObjectId, imageUrl: string,
  status: 'vision_pending'|'vision_done'|'recipes_done'|'failed',
  ingredients?: { name, qty?, confidence, estimatedExpiryDays }[],
  staples?: string[],
  recipes?: Recipe[],
  error?: string, createdAt: Date
}

// pantries
{
  _id, source: 'google_places'|'seed', sourceId: string,
  name: string,
  location: { type: 'Point', coordinates: [lng: number, lat: number] }, // GeoJSON
  address: string, phone?: string,
  hours?: { day: 0..6, open: 'HH:mm', close: 'HH:mm' }[],
  tags: string[],
  recentNotes?: { askedAt: Date, openUntil?: string, hasItems?: string[], notes?: string }[], // capped at 5
  lastSeenAt: Date
}

// pantry_lookups
{
  _id, latQ: number, lngQ: number, needKey: string,
  results: PantrySummary[], createdAt: Date
}

// call_jobs
{
  _id, sessionId: ObjectId,
  pantryIds: ObjectId[],
  questions: string[],
  neededItems: string[],
  sheetTabId: number,
  sheetUrl: string,
  status: 'queued'|'running'|'done'|'failed',
  items: {
    id: string,                   // also referenced as itemId in events
    pantryId: ObjectId,
    status: 'queued'|'dialing'|'in_progress'|'done'|'failed',
    startedAt?: Date, endedAt?: Date,
    transcript?: string,
    structured?: { openUntil?, hasItems?, missingItems?, requirements?, notes? },
    audioUrl?: string,
    sheetRowUrl?: string,
    error?: string
  }[],
  summary?: { totalItems, succeeded, failed, openNow, withRequestedItems, planSuggestionPantryIds: ObjectId[] },
  createdAt: Date
}

// call_events  — drives SSE via change streams
{ _id, jobId: ObjectId, jobItemId?: string, kind: string, payload: object, createdAt: Date }

// plans
{
  _id, jobId: ObjectId, sessionId: ObjectId,
  origin: { lat, lng }, mode: 'driving'|'walking'|'cycling',
  stops: PlanStop[],
  totalDistanceMeters: number, totalDurationSec: number,
  routeGeoJSON: GeoJSON.LineString,
  googleMapsUrl: string, appleMapsUrl: string,
  createdAt: Date
}
```

### Geospatial query (Phase 2 cache hit)

```ts
db.collection('pantries').find({
  location: {
    $near: {
      $geometry: { type: 'Point', coordinates: [lng, lat] },
      $maxDistance: radiusM
    }
  }
}).limit(limit).toArray();
```

### Change-stream subscription (SSE backend)

```ts
const stream = db.collection('call_events').watch(
  [{ $match: { 'fullDocument.jobId': jobOid } }],
  { fullDocument: 'updateLookup' }
);
for await (const change of stream) {
  const doc = change.fullDocument;
  controller.enqueue(`data: ${JSON.stringify({ kind: doc.kind, ...doc.payload })}\n\n`);
}
```

## <a id="backboard-memory"></a>Backboard memory client

`lib/backboard/client.ts` (TS) and `services/ai/app/integrations/backboard_client.py` (Python). Same conceptual API in both. **At T+0, Sahil verifies the actual Backboard SDK signature; if it differs, update both files and this doc.**

```ts
// expected interface
type Kind = 'dietary_restriction' | 'cuisine_preference' | 'family_size'
          | 'excluded_ingredient' | 'pantry_staple' | 'pantry_visit'
          | 'fridge_inventory_item';

export interface BackboardClient {
  upsert(userId: string, kind: Kind, payload: object): Promise<void>;
  list(userId: string, kind: Kind, limit?: number): Promise<{ payload: any, updatedAt: Date }[]>;
  search(userId: string, query: string, kinds: Kind[], limit?: number): Promise<{ payload: any, score: number }[]>;
  deleteByKind(userId: string, kind: Kind): Promise<void>;     // for "replace whole set" PUTs
}
```

When `BACKBOARD_STUB=true` or Backboard returns 5xx → fall through to a stub that returns canned data per [`02-conventions.md#stub-mode`](./02-conventions.md#stub-mode).

### Memory-as-context for recipes

`POST /v1/phase1/recipes` reads:

```python
diets    = await backboard.list(user_id, 'dietary_restriction')
cuisines = await backboard.list(user_id, 'cuisine_preference')
fam      = await backboard.list(user_id, 'family_size', limit=1)
exclude  = await backboard.list(user_id, 'excluded_ingredient')
visits   = await backboard.list(user_id, 'pantry_visit', limit=5)
recent   = await backboard.search(user_id, 'fridge inventory', kinds=['fridge_inventory_item'], limit=20)
```

These are passed to the recipe prompt — see [`06-phase1-fridge-vision.md`](./06-phase1-fridge-vision.md).

After each scan, write each detected ingredient as `fridge_inventory_item` with `lastSeenAt = now()` and `estimatedExpiry = now() + estimatedExpiryDays`. This becomes "recently retrieved memory" that prioritizes recipes using items about to expire.

## <a id="sheets-writer"></a>Google Sheets writer

`lib/sheets/client.ts` (TS) and `services/ai/app/integrations/sheets_client.py` (Python).

Setup (Block A, Aryan):
1. Create one master spreadsheet manually. Capture ID → `SHEETS_SPREADSHEET_ID`.
2. Create a Google Cloud service account, enable Sheets API, download JSON. Base64 → `GOOGLE_SERVICE_ACCOUNT_JSON_B64`.
3. Share the spreadsheet with the service account email as **Editor**.

Per call job:
- `POST /api/calls/start` (Next.js side) calls `sheets.createJobTab(jobId)`:
  - Adds a new sheet (tab) named `job-<shortId>`.
  - Writes header row: `Pantry Name | Phone (display) | Status | Open Until | Has Items | Missing Items | Requirements | Notes | Audio URL`.
  - Returns `{tabId: number, sheetUrl: string}`.
- The Python service's webhook handlers call `sheets.appendRow(jobId, tabId, pantry)` on `item_started` and `sheets.updateRow(jobId, tabId, pantry, structured)` on `item_finished`.
- Track `pantryId → rowIndex` in memory for the duration of the job. Fall back to a search-by-pantryId on cold misses.

If `SHEETS_STUB=true` or the API errors, log a warning and continue (non-fatal).

## Python service — structure

```
services/ai/
├── pyproject.toml          # uv-managed; deps: fastapi, uvicorn, httpx, pydantic v2,
│                           #   google-generativeai (Gemini), openai (fallback),
│                           #   twilio, elevenlabs, motor (Mongo async),
│                           #   gspread (Sheets), backboard-sdk (or generic httpx)
├── app/
│   ├── main.py             # FastAPI app, mounts routers, auth middleware, mongo init
│   ├── settings.py         # pydantic-settings, reads env
│   ├── schemas.py          # all pydantic models matching 03-api-contracts.md
│   ├── routers/
│   │   ├── health.py
│   │   ├── phase1.py       # /vision and /recipes
│   │   ├── phase2.py
│   │   └── phase3.py
│   ├── agents/
│   │   ├── vision.py
│   │   ├── recipes.py
│   │   ├── pantry_locator.py
│   │   └── caller.py
│   ├── integrations/
│   │   ├── gemini_client.py
│   │   ├── backboard_client.py
│   │   ├── google_places.py
│   │   ├── elevenlabs_client.py
│   │   ├── twilio_client.py
│   │   ├── sheets_client.py
│   │   └── mongo_client.py
│   └── stubs/
│       ├── phase1_vision.json
│       ├── phase1_recipes.json
│       ├── phase2_locate.json
│       └── phase3_events.py
└── tests/
```

### Auth middleware

`app/main.py` checks `Authorization: Bearer ${AI_SERVICE_TOKEN}` on every route except `/healthz`. 401 if missing.

### Timeouts & retries

- Outbound HTTP via `httpx.AsyncClient(timeout=httpx.Timeout(12.0))`.
- Gemini: at most 1 retry on 5xx with 500ms backoff. On hard 4xx quota errors → swap to OpenAI if `OPENAI_API_KEY` set.
- Google Places: no retries (failures fall back to seed).
- Backboard: no retries on writes; reads gracefully degrade to defaults.
- ElevenLabs/Twilio: 1 retry on 429/5xx.
- Sheets: best-effort, no retries.

### Concurrency

- Phase 3 fans out N pantries with `asyncio.gather(return_exceptions=True)`. Cap N at 5.

### Health

`GET /healthz` returns `{status:"ok", phase_stub: {...}}`. Used by Aryan's deploy verification.

## Errors collection

```ts
// errors
{ _id, requestId?: string, sessionId?: ObjectId, scope: string, code: string, message: string, details?: object, createdAt: Date }
```

Both TS and Python write here on any caught exception that originated from an external API. TTL 7 days.

# API Contracts

> Mirror summary in [`docs/human/02-tech-decisions.md#backend`](../human/02-tech-decisions.md#backend). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Source of truth.** The frontend, the Next.js Route Handlers, and the Python service must match these shapes exactly. Defined as `zod` schemas in `lib/schemas.ts` (TS) and `pydantic` models in `services/ai/app/schemas.py` (Python).

## <a id="error-shape"></a>Common envelope

Every Next.js API route returns one of:

```ts
type Ok<T>   = { ok: true;  data: T }
type Fail    = { ok: false; error: { code: string; message: string; details?: unknown } }
```

HTTP status: 2xx for `Ok`, 4xx for client errors, 5xx for server errors. The body shape is the same regardless of status.

Standard error codes:
- `unauthorized` — missing or invalid session.
- `bad_request` — input failed validation.
- `not_found` — resource doesn't exist.
- `upstream_failed` — Gemini/Backboard/Google/ElevenLabs/Twilio/Sheets errored.
- `timeout` — exceeded `with_timeout(12s)` budget.
- `internal` — anything else.

## Auth

Every browser request sends a cookie `fp_session=<uuid>`. If absent, the route handler creates one and sets the cookie. The session id is the FK for everything **and the `userId` for Backboard**.

Service-to-service (Next.js → Python) uses `Authorization: Bearer ${AI_SERVICE_TOKEN}`.

---

## Next.js routes (`app/api/`)

### `GET /api/health`

```ts
// 200
{ ok: true, data: { status: 'ok', commit: string, time: string } }
```

### `POST /api/session`

Idempotent. Ensures cookie exists, upserts row in `sessions`.

```ts
// 200
{ ok: true, data: { sessionId: string, isNew: boolean } }
```

### `GET /api/memory/staples`

Reads from Backboard.

```ts
// 200
{ ok: true, data: { staples: string[] } }
```

### `PUT /api/memory/staples`

Replaces the user's staple set.

```ts
// request
{ staples: string[] }

// 200
{ ok: true, data: { staples: string[] } }
```

### `GET /api/memory/preferences`

```ts
// 200
{
  ok: true,
  data: {
    dietaryRestriction: ('vegetarian'|'vegan'|'gluten_free'|'halal'|'kosher')[],
    cuisinePreference: string[],
    familySize: number,
    excludedIngredient: string[]
  }
}
```

### `PUT /api/memory/preferences`

Same payload shape as the data field above. Replaces the user's preferences in Backboard.

### `POST /api/fridge/scan` (Step 1 — vision only)

Multipart form. Field `image` (file, ≤8MB). No preferences in this call.

```ts
// 200
{
  ok: true,
  data: {
    scanId: string,
    ingredients: { name: string; qty?: string; confidence: number; estimatedExpiryDays: number }[]
  }
}
```

### `POST /api/fridge/recipes` (Step 3 — Backboard-aware)

```ts
// request
{
  scanId: string,
  ingredients: { name: string; qty?: string; estimatedExpiryDays: number }[],   // post-edit
  staples?: string[]            // if omitted, server reads from Backboard
}

// 200
{
  ok: true,
  data: {
    recipes: {
      title: string;
      cuisine?: string;
      timeMinutes: number;
      servings: number;
      ingredientsUsed: string[];
      ingredientsMissing: string[];   // <-- feed into Phase 2
      expiryUrgencyScore: number;     // 0..1; higher = uses-up-soonest-expiring
      steps: string[];
      sourceNote?: string;
    }[]
  }
}
```

### `GET /api/pantries?lat=&lng=&need=`

Query: `lat` (float), `lng` (float), `need` (CSV, optional), `radiusM` (int, default 16093 = 10mi), `limit` (int, default 25).

```ts
// 200
{
  ok: true,
  data: {
    queriedAt: string,
    pantries: {
      id: string;
      name: string;
      lat: number;
      lng: number;
      address: string;
      phone?: string;          // E.164
      hours?: { day: 0|1|2|3|4|5|6; open: string; close: string }[];
      openNow: boolean;
      distanceMeters: number;
      score: number;           // 0..1, higher = better match for `need`
      tags?: string[];
    }[]
  }
}
```

### `GET /api/pantries/:id`

```ts
// 200
{
  ok: true,
  data: {
    pantry: { /* same single shape as above */ },
    recentCallNotes?: { askedAt: string, openUntil?: string, hasItems?: string[], notes?: string }[]
  }
}
```

### `POST /api/calls/start`

```ts
// request
{
  pantryIds: string[];     // 1..5
  questions?: string[];    // override default question set
  neededItems?: string[];  // injected into the agent prompt
}

// 200
{
  ok: true,
  data: {
    jobId: string,
    sheetUrl: string,        // public Google Sheet tab URL for this job
    items: { id: string, pantryId: string, status: 'queued' }[]
  }
}
```

Constraints:
- `pantryIds.length` between 1 and 5.
- Server enforces `DEMO_FALLBACK_PHONES`: pantry `phone` is replaced with the next number from the list (round-robin) before dialing, unless `ALLOW_REAL_PANTRY_CALLS=true`.

### `GET /api/calls/:jobId/stream`

Server-Sent Events. The Route Handler subscribes to a Mongo change stream on `call_events` filtered by `jobId` and forwards.

Event types (all JSON-encoded `data:` lines):

```ts
// kind = "item_started"
{ kind: 'item_started', itemId: string, pantryId: string }

// kind = "transcript_chunk"
{ kind: 'transcript_chunk', itemId: string, role: 'agent'|'pantry', text: string, at: string }

// kind = "item_finished"
{
  kind: 'item_finished',
  itemId: string,
  status: 'done'|'failed',
  durationSec: number,
  structured: {
    openUntil?: string,
    hasItems?: string[],
    missingItems?: string[],
    requirements?: string[],
    notes?: string
  } | null,
  audioUrl?: string,
  sheetRowUrl?: string         // direct link to this pantry's row in the sheet
}

// kind = "job_finished"
{
  kind: 'job_finished',
  summary: {
    totalItems: number,
    succeeded: number,
    failed: number,
    openNow: number,
    withRequestedItems: number,
    sheetUrl: string,
    planSuggestionPantryIds: string[]   // top 3 pantries to consider visiting
  }
}
```

Connection closes on `job_finished` or after 4 minutes, whichever first.

### <a id="plan"></a>`POST /api/plan/build` (Step 7)

```ts
// request
{
  jobId: string,
  selectedPantryIds: string[],   // 1..3
  origin: { lat: number, lng: number },
  mode?: 'driving'|'walking'|'cycling'   // default 'driving'
}

// 200
{
  ok: true,
  data: {
    planId: string,
    stops: {
      pantryId: string,
      order: number,
      name: string,
      lat: number,
      lng: number,
      address: string,
      phone?: string,
      etaSeconds: number,        // arrival time from origin in seconds
      legDistanceMeters: number, // distance from previous stop
      legDurationSec: number,    // duration from previous stop
      structured?: {             // from Phase 3 results
        openUntil?: string,
        hasItems?: string[],
        requirements?: string[],
        notes?: string
      }
    }[],
    totalDistanceMeters: number,
    totalDurationSec: number,
    routeGeoJSON: GeoJSON.LineString,
    googleMapsUrl: string,
    appleMapsUrl: string
  }
}
```

### `GET /api/plan/:planId`

Returns the same `data` shape as `POST /api/plan/build`.

---

## Python AI service routes (`services/ai/app/routers/`)

All requests must include `Authorization: Bearer ${AI_SERVICE_TOKEN}`.

### `GET /healthz` → `{status:"ok", phase_stub: {1_vision: bool, 1_recipes: bool, 2: bool, 3: bool}}`

### `POST /v1/phase1/vision`

```python
class Phase1VisionRequest(BaseModel):
    image_url: str            # server-readable URL (Mongo GridFS or blob)

class Ingredient(BaseModel):
    name: str
    qty: str | None = None
    confidence: float
    estimated_expiry_days: int

class Phase1VisionResponse(BaseModel):
    ingredients: list[Ingredient]
```

### `POST /v1/phase1/recipes`

```python
class Phase1RecipesRequest(BaseModel):
    user_id: str                          # for Backboard reads
    ingredients: list[Ingredient]         # post-edit
    staples: list[str]
    # server pulls additional context from Backboard:
    #   dietary_restriction, cuisine_preference, family_size, excluded_ingredient,
    #   recent pantry_visit (last 5)
    # caller may override:
    overrides: dict | None = None

class Recipe(BaseModel):
    title: str
    cuisine: str | None = None
    time_minutes: int
    servings: int
    ingredients_used: list[str]
    ingredients_missing: list[str]
    expiry_urgency_score: float           # 0..1
    steps: list[str]
    source_note: str | None = None

class Phase1RecipesResponse(BaseModel):
    recipes: list[Recipe]                 # exactly 3
```

See [`06-phase1-fridge-vision.md`](./06-phase1-fridge-vision.md).

### `POST /v1/phase2/locate`

```python
class Phase2Request(BaseModel):
    user_id: str
    lat: float
    lng: float
    need: list[str] = []
    radius_m: int = 16093
    limit: int = 25

class Pantry(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    address: str
    phone: str | None = None
    hours: list[dict] | None = None
    open_now: bool
    distance_meters: float
    score: float
    tags: list[str] = []

class Phase2Response(BaseModel):
    pantries: list[Pantry]
```

See [`07-phase2-pantry-locator.md`](./07-phase2-pantry-locator.md).

### `POST /v1/phase3/start`

```python
class PantryDial(BaseModel):
    item_id: str          # call_jobs.items[].id
    id: str               # pantry id
    phone: str            # E.164 (post ethics-gate substitution)
    name: str

class Phase3Request(BaseModel):
    job_id: str
    user_id: str
    pantries: list[PantryDial]
    questions: list[str]
    needed_items: list[str] = []
    sheet_tab_id: int     # the tab created by Next.js for this job

class Phase3Response(BaseModel):
    job_id: str
    accepted: int
```

Returns 202 immediately. All real work happens async; events written to `call_events` collection in Mongo and rows appended to the job's Sheet tab.

See [`08-phase3-voice-calls.md`](./08-phase3-voice-calls.md).

### `POST /v1/phase3/webhook/twilio` and `POST /v1/phase3/webhook/elevenlabs`

Internal webhook receivers from Twilio (call status) and ElevenLabs (transcript chunks, agent turn completed). Bodies match upstream provider docs. Each handler validates the upstream signature header, writes a `call_events` row in Mongo, and (for `item_started`/`item_finished`) updates the corresponding Sheet row.

---

## Validation rule

If a request fails zod/pydantic validation, return:

```json
{ "ok": false, "error": { "code": "bad_request", "message": "<field>: <reason>", "details": {...} } }
```

Status 400. Never crash with a stack trace.

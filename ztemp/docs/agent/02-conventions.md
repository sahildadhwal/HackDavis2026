# Conventions

> Mirrors: [`docs/human/02-tech-decisions.md`](../human/02-tech-decisions.md) and [`docs/human/04-risks.md`](../human/04-risks.md). Sync index: [`docs/SYNC.md`](../SYNC.md).

## Languages & versions

- Node 20, pnpm 9, TypeScript 5.x.
- Python 3.11, `uv` for env management, `ruff` for lint, `pytest` for tests.

## Code style

### TypeScript
- Strict mode on. No `any` unless justified with a `// reason:` comment.
- Server-only modules in `lib/server/`. Never import them from `app/**/page.tsx` client components.
- All API request/response shapes defined as `zod` schemas in `lib/schemas.ts` and re-exported as types.
- Components: named exports, PascalCase, one per file unless trivial.
- Tailwind classes: no arbitrary values when a token works; use `cn()` helper from `lib/utils.ts`.

### Python
- `ruff check . --fix` and `ruff format .` before commit.
- `pydantic` v2 models for every external boundary (request, response, integration).
- Async-only. No sync HTTP calls in handlers.
- One module per agent in `app/agents/`. One module per integration in `app/integrations/`.

## MongoDB conventions

- All location fields stored as GeoJSON `Point`: `{ type: "Point", coordinates: [lng, lat] }`. **Order matters: longitude first.** Never store as `{lat, lng}` numbers.
- All timestamps stored as native BSON dates, not ISO strings.
- `_id` is ObjectId by default; expose to clients as 24-char hex string.
- Indexes are declared in `lib/mongo/indexes.ts` and re-applied on Next.js boot via a one-shot script.

## Backboard conventions

- All memory writes attributed to `userId = sessionId` (the cookie value).
- Use these `kind` values exclusively (don't invent new ones without updating this doc and [`05-backend-spec.md#backboard-memory`](./05-backend-spec.md#backboard-memory)):
  - `dietary_restriction` — payload `{value: "vegan"|"vegetarian"|"gluten_free"|"halal"|"kosher"}`
  - `cuisine_preference` — payload `{value: string}` (e.g. "italian")
  - `family_size` — payload `{value: int}` (singleton; upsert replaces)
  - `excluded_ingredient` — payload `{value: string}`
  - `pantry_staple` — payload `{value: string}` (e.g. "salt")
  - `pantry_visit` — payload `{pantryId, name, visitedAt, gotItems: string[], notes?: string}`
  - `fridge_inventory_item` — payload `{name, qty?, lastSeenAt, estimatedExpiry: ISOdate}`
- Never store PII in payloads.
- Read calls always include the same `userId`. There is no admin/cross-user query.

## Google Sheets conventions

- One **master** spreadsheet, service account invited as editor. ID stored in `SHEETS_SPREADSHEET_ID`.
- One **tab per call job**, named `job-<shortId>`.
- Header row (A1:I1):
  `Pantry Name | Phone (display) | Status | Open Until | Has Items | Missing Items | Requirements | Notes | Audio URL`
- One row per pantry, written on `item_started` (status="dialing"), updated in place on `item_finished`.
- Sheet failures are non-fatal: log a warning and continue. The dashboard is the primary surface; the Sheet is the artifact.

## Commits & branches

- Branch naming: `<initials>/<short-slug>`, e.g. `sa/phase1-vision`, `ho/plan-route-view`.
- Commit message format: `<scope>: <imperative one-liner>`. Scope examples: `frontend`, `backend`, `phase1`, `phase2`, `phase3`, `plan`, `sheets`, `mongo`, `backboard`, `docs`, `infra`.

## <a id="environment-variables"></a>Environment variables

Single canonical list. Keep `.env.local.example` in sync with this table.

| Var | Where | Used by | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Next.js (browser) | Map render + Directions | Public token, not secret |
| `NEXT_PUBLIC_APP_URL` | Next.js | Various | e.g. `https://foodpantry.vercel.app` |
| `MONGODB_URI` | Next.js (server) + Python | Mongo client | `mongodb+srv://...` |
| `MONGODB_DB` | Next.js (server) + Python | DB name | e.g. `foodpantry` |
| `BACKBOARD_API_KEY` | Next.js (server) + Python | Backboard memory | Server-only |
| `BACKBOARD_PROJECT_ID` | Next.js (server) + Python | Backboard scope | |
| `AI_SERVICE_URL` | Next.js (server) | Calls Python service | e.g. `https://ai-foodpantry.onrender.com` |
| `AI_SERVICE_TOKEN` | Next.js (server) + Python | Shared bearer for service-to-service auth | Generate with `openssl rand -hex 32` |
| `GEMINI_API_KEY` | Python (vision + recipes), Phase 2 ranking, Phase 3 summarization | | |
| `GEMINI_VISION_MODEL` | Python | default `gemini-2.0-flash-exp` (or `gemini-1.5-pro`) | Override per phase if needed |
| `GEMINI_TEXT_MODEL` | Python | default `gemini-1.5-pro` | |
| `OPENAI_API_KEY` | Python (optional fallback) | Vision swap if Gemini quota hits | |
| `GOOGLE_PLACES_API_KEY` | Python | Phase 2 nearby search | |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | Next.js (server) + Python | Sheets API auth | Base64 of the downloaded JSON |
| `SHEETS_SPREADSHEET_ID` | Next.js (server) + Python | Master spreadsheet | |
| `ELEVENLABS_API_KEY` | Python | Phase 3 voice agent | |
| `ELEVENLABS_AGENT_ID` | Python | Phase 3 | The pre-configured Conversational AI agent |
| `TWILIO_ACCOUNT_SID` | Python | Phase 3 outbound | |
| `TWILIO_AUTH_TOKEN` | Python | Phase 3 outbound | |
| `TWILIO_FROM_NUMBER` | Python | Phase 3 outbound | E.164, e.g. `+15558675309` |
| `PHASE_1_VISION_STUB` | Python | Stub mode | `true`/`false`, default `false` |
| `PHASE_1_RECIPES_STUB` | Python | Stub mode | |
| `PHASE_2_STUB` | Python | Stub mode | |
| `PHASE_3_STUB` | Python | Stub mode | |
| `BACKBOARD_STUB` | Next.js + Python | If `true`, Backboard reads return canned data, writes are no-op | Useful when Backboard is down |
| `SHEETS_STUB` | Next.js + Python | If `true`, Sheets writes are no-op | |
| `DEMO_FALLBACK_PHONES` | Python | Phase 3 ethical demo | Comma-separated E.164 numbers we own; agent dials these instead of real pantries |
| `ALLOW_REAL_PANTRY_CALLS` | Python | Ethics gate | Default `false`. Only set true in a manually-confirmed env. |

## <a id="stub-mode"></a>Stub mode

When a `*_STUB=true` flag is set, the corresponding subsystem must return a deterministic canned response within 1 second and **must not** hit any external API.

| Subsystem | Stub fixture / behavior |
|---|---|
| `POST /v1/phase1/vision` (`PHASE_1_VISION_STUB`) | `stubs/phase1_vision.json` |
| `POST /v1/phase1/recipes` (`PHASE_1_RECIPES_STUB`) | `stubs/phase1_recipes.json` |
| `POST /v1/phase2/locate` (`PHASE_2_STUB`) | `stubs/phase2_locate.json` |
| `POST /v1/phase3/start` (`PHASE_3_STUB`) | Inserts canned `call_events` over 30s on a timer; appends fake rows to a stub sheet (or no-op if `SHEETS_STUB=true`) |
| Backboard reads (`BACKBOARD_STUB`) | Returns `{dietary_restriction:["vegetarian"], family_size:2, excluded_ingredient:[], cuisine_preference:["italian","mexican"], pantry_staple:["salt","pepper","olive oil","garlic","onion"]}` |
| Backboard writes (`BACKBOARD_STUB`) | No-op, log a debug line |
| Sheets writes (`SHEETS_STUB`) | No-op, log a debug line |

Frontend never knows the difference. Stub mode is the **default** in CI and in local dev for Howie/Jam who don't need real AI.

## <a id="fallback-rules"></a>Fallback rules (resilience)

- Any external API call wrapped in `with_timeout(seconds=12)`. Past 12s → return graceful error to client, log to Mongo `errors` collection.
- If `GEMINI_API_KEY` is missing or returns 4xx, vision falls back to OpenAI GPT-4o (if `OPENAI_API_KEY` set), else returns a "Gemini unavailable" error.
- If `BACKBOARD_API_KEY` is missing or Backboard returns 5xx, set `BACKBOARD_STUB=true` for that request and log a warning. Recipes still generate, just less personalized.
- If `GOOGLE_PLACES_API_KEY` is missing or returns 4xx, Phase 2 falls back to a curated seed loaded from `data/seed_pantries.json` and ingested into Mongo on boot.
- If Sheets API fails, log warning and continue. Dashboard is unaffected.
- If ElevenLabs/Twilio fail in Phase 3, mark the call item as `status=failed` and continue with the others. The job summary degrades gracefully.
- Never throw an unhandled error to the browser. Every API route must return `{ok:true,data}` or `{ok:false,error:{code,message}}` per [`03-api-contracts.md`](./03-api-contracts.md#error-shape).

## Logging

- Server: structured JSON logs to stdout. Vercel and Render both ingest these.
- Required fields per log: `level`, `at` (ISO), `msg`, `requestId`, `sessionId?`, `phase?`.
- **Never log PII** beyond the session id. **Never log API keys**, full transcripts at info level (transcripts only at `debug`), or Backboard payload contents at info.

## Testing

- Hackathon mode: tests are optional but encouraged for the prompt-heavy code in `services/ai/app/agents/`.
- Each agent has at least one snapshot test using a fixture image / fixture pantry list.

## What you must NOT do (agent reminders)

- Don't introduce new dependencies without updating `package.json` / `pyproject.toml` and noting in the PR description.
- Don't change the API contract in [`03-api-contracts.md`](./03-api-contracts.md) without also updating the frontend caller, the backend handler, and the human-side mirror.
- Don't store coordinates as `{lat, lng}` in Mongo. Always GeoJSON `Point` with `[lng, lat]`.
- Don't write to `main` if a teammate has uncommitted changes in the same file (check with `git status` and ping them).
- Don't commit `.env.local`, fixtures with real phone numbers, audio recordings of real people, or the Google service account JSON.

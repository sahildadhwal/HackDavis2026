# Phase 2 — Pantry Locator Agent (MongoDB Geospatial + Google Places)

> Mirror summary in [`docs/human/01-plan.md#phase-2`](../human/01-plan.md#phase-2). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Owner:** Sahil. Files live in `services/ai/app/agents/pantry_locator.py`, `services/ai/app/integrations/google_places.py`, `services/ai/app/integrations/mongo_client.py`, `services/ai/app/routers/phase2.py`.

## Goal

Given a user location and (optional) list of needed items, return a ranked list of nearby food pantries with hours, phone, distance, and a relevance score.

## Endpoint

`POST /v1/phase2/locate` — see schema in [`03-api-contracts.md`](./03-api-contracts.md).

## Strategy

Three stages:

1. **Mongo fast path** — geospatial query against the `pantries` collection. If we have ≥10 fresh-enough pantries within radius (`lastSeenAt` within 30 days), skip Google.
2. **Retrieval (cache miss)** — Google Places `Nearby Search` for "food pantry" within `radius_m` of `(lat, lng)`. Take up to 60 raw results. Upsert each into the `pantries` collection.
3. **Ranking** — Gemini tool call with the candidate list + the `need[]` items + each pantry's `recentNotes` from the DB. Returns a re-ranked, deduped, capped list.

If `GOOGLE_PLACES_API_KEY` is missing or returns 4xx → load `data/seed_pantries.json` (also ingested into Mongo on boot) and skip retrieval. The ranking step still runs.

## Mongo fast path

```python
async def fast_path(lat, lng, radius_m, limit) -> list[Pantry]:
    cursor = mongo.pantries.find({
        "location": {
            "$near": {
                "$geometry": {"type": "Point", "coordinates": [lng, lat]},
                "$maxDistance": radius_m,
            }
        },
        "lastSeenAt": {"$gte": datetime.utcnow() - timedelta(days=30)},
    }).limit(limit)
    return [pantry_from_doc(d) for d in await cursor.to_list(limit)]
```

If `len(fast) >= 10`, return them. Else proceed to retrieval.

## Retrieval (Google Places)

Use the **Places API (New)** v1 endpoint `places:searchNearby`:

```
POST https://places.googleapis.com/v1/places:searchNearby
X-Goog-Api-Key: ${GOOGLE_PLACES_API_KEY}
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,
                  places.internationalPhoneNumber,places.regularOpeningHours,places.currentOpeningHours,
                  places.types

{
  "includedTypes": ["food_bank"],
  "maxResultCount": 20,
  "locationRestriction": {
    "circle": { "center": {"latitude": lat, "longitude": lng}, "radius": radius_m }
  }
}
```

If `food_bank` returns < 5 results, also run `places:searchText` with `textQuery="food pantry"`.

### Upsert into Mongo

For each Google result:

```python
doc = {
  "source": "google_places",
  "sourceId": place["id"],
  "name": place["displayName"]["text"],
  "location": {"type": "Point", "coordinates": [lng_, lat_]},  # GeoJSON, lng first!
  "address": place.get("formattedAddress"),
  "phone": normalize_e164(place.get("internationalPhoneNumber")),
  "hours": convert_hours(place.get("regularOpeningHours")),
  "lastSeenAt": datetime.utcnow(),
}
await mongo.pantries.update_one(
    {"source": "google_places", "sourceId": place["id"]},
    {"$set": doc, "$setOnInsert": {"recentNotes": []}},
    upsert=True,
)
```

`openNow` is computed at query time from `currentOpeningHours.openNow` (if present in the upstream response we just fetched) or derived from `hours` + current time.

## Ranking (Gemini tool call)

### Instruction

```
You re-rank food pantries for a user who needs help today. Inputs:
- candidates: list of pantries with name, address, openNow, distanceMeters, hours, recentNotes (optional).
- need: list of items the user is looking for (may be empty).
- now_iso: the current time in the user's timezone.

Score each pantry 0..1 by:
- openNow weight 0.45 (closed pantries score ≤ 0.3 unless need is empty AND we want a list of options for tomorrow).
- distanceMeters weight 0.25 (closer is better; treat >16000m as 0).
- recentNotes match against need weight 0.20 (pantry's recentNotes mention an item in need → boost).
- generic completeness (has phone, has hours) weight 0.10.

Return at most `limit` pantries, sorted by score desc. Dedupe by (name, address). Output exactly the JSON schema given. No prose.
```

### Response schema (Gemini `responseSchema`)

```python
PHASE2_RANK_SCHEMA = {
  "type": "object",
  "properties": {
    "pantries": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "score"],
        "properties": {
          "id":    {"type": "string"},
          "score": {"type": "number"},
          "tags":  {"type": "array", "items": {"type": "string"}}
        }
      }
    }
  },
  "required": ["pantries"]
}
```

The model only returns `(id, score, tags)`. The Python code joins back with the full pantry record from the candidates list. Keeps output small and avoids hallucinated fields.

## Implementation sketch

```python
# services/ai/app/agents/pantry_locator.py
async def run_phase2(req: Phase2Request) -> Phase2Response:
    if settings.PHASE_2_STUB:
        return load_stub("phase2_locate.json")

    candidates = await fast_path(req.lat, req.lng, req.radius_m, limit=60)
    if len(candidates) < 10:
        if settings.GOOGLE_PLACES_API_KEY:
            await fetch_and_upsert_google(req.lat, req.lng, req.radius_m)
        else:
            await ensure_seed_loaded()
        candidates = await fast_path(req.lat, req.lng, req.radius_m, limit=60)

    if not candidates:
        return Phase2Response(pantries=[])

    enriched = await attach_recent_notes(candidates)
    ranked = await rank_with_gemini(enriched, req.need, req.lat, req.lng)
    by_id = {p.id: p for p in candidates}
    out = []
    for r in ranked.pantries[:req.limit]:
        if r.id in by_id:
            p = by_id[r.id].model_copy(update={"score": r.score, "tags": r.tags})
            out.append(p)
    return Phase2Response(pantries=out)
```

## Caching

Caller (`Next.js Route Handler /api/pantries`) checks `pantry_lookups` collection:
- Cache key: `{latQ: round(lat, 4), lngQ: round(lng, 4), needKey: hash(sorted_csv(need))}`.
- TTL: 1 hour (Mongo TTL index on `createdAt`).
- On hit: return cached `results` directly, skip Python service call.
- On miss: call Python, then write `pantry_lookups` doc.

## Acceptance tests

`services/ai/tests/test_phase2.py`:

- `test_seed_fallback_when_google_key_missing` — unset key → returns ≥5 from seed, all in Mongo.
- `test_open_now_outranks_closed_when_need_present`.
- `test_dedupe_by_name_and_address`.
- `test_limit_respected`.
- `test_phone_normalized_to_e164` — output phones are valid E.164 or omitted.
- `test_geojson_lng_first` — every stored pantry has `location.coordinates[0]` in `[-180, 180]` and `coordinates[1]` in `[-90, 90]` (catches lat/lng swap).

## Stub fixture (`services/ai/app/stubs/phase2_locate.json`)

10 entries from `data/seed_pantries.json`, pre-ranked. Frontend dev (Howie) can render the map immediately without any external API.

## Seed data (`data/seed_pantries.json`)

Sahil generates this once at T+1 with a single Gemini call: "List 30 real food pantries near {demo city} with name, address, phone, approximate hours, lat, lng. Validate addresses." Spot-check 5 entries before committing.

On Python service boot, if Mongo `pantries` is empty, ingest the seed file (only those pantries from the demo city). Idempotent via the `(source, sourceId)` unique index where `source="seed"`.

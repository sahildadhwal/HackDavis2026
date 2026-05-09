# Phase 1 — Fridge Vision (Gemini) + Backboard-Aware Recipes

> Mirror summary in [`docs/human/01-plan.md#phase-1`](../human/01-plan.md#phase-1). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Owner:** Sahil. Files live in `services/ai/app/agents/vision.py`, `services/ai/app/agents/recipes.py`, and `services/ai/app/routers/phase1.py`.

## Goal

Two endpoints, called sequentially as the user moves through `/scan`:

1. **`POST /v1/phase1/vision`** — fridge photo → ingredient list (with rough expiry hints).
2. **`POST /v1/phase1/recipes`** — ingredients + staples + Backboard memory → 3 recipes that prioritize using soonest-to-expire items first.

This split matches the user's two-tap flow: "snap photo → review chips → add staples → tap Generate".

## Endpoints

See schemas in [`03-api-contracts.md`](./03-api-contracts.md).

## Strategy

**Vision = single Gemini multimodal call** with structured output via responseSchema. **Recipes = single Gemini text call** with structured output. Two separate calls, not chained, so we can iterate on prompts independently.

If `GEMINI_API_KEY` is missing or returns 4xx with quota errors, swap to OpenAI GPT-4o behind the same agent interface (the agent module exposes `def call_vision(...)` which selects the provider via env).

## Vision call

### System / instruction

```
You are a kitchen assistant. The user sent a single photo of their refrigerator. List visible food items.

Rules:
1. Be conservative — only list items you can clearly see. Provide a confidence between 0 and 1.
2. Estimate quantity in human terms ("about half a carton", "3 eggs"). Leave blank if unsure.
3. Estimate days until each item likely expires from the photo, using these heuristics:
   - leafy greens / berries: 4
   - other produce: 7
   - dairy (milk/yogurt/soft cheese): 7
   - eggs: 21
   - hard cheese / cured meat: 14
   - raw meat / fish: 3
   - cooked leftovers (in containers): 3
   - condiments (jars/bottles): 60
   - unknown: 10
4. Don't list pantry staples (salt, oil, flour, etc.) — those come from the staples step.
5. Output exactly the JSON schema given. No prose.
```

### Response schema (Gemini `responseSchema`)

```python
PHASE1_VISION_SCHEMA = {
  "type": "object",
  "properties": {
    "ingredients": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "confidence", "estimated_expiry_days"],
        "properties": {
          "name": {"type": "string"},
          "qty":  {"type": "string"},
          "confidence": {"type": "number"},
          "estimated_expiry_days": {"type": "integer"}
        }
      }
    }
  },
  "required": ["ingredients"]
}
```

### Implementation sketch

```python
# services/ai/app/agents/vision.py
async def run_phase1_vision(image_url: str) -> Phase1VisionResponse:
    if settings.PHASE_1_VISION_STUB:
        return load_stub("phase1_vision.json")

    image_bytes = await fetch_bytes(image_url)
    response = await gemini.generate_content_async(
        model=settings.GEMINI_VISION_MODEL,
        contents=[
            {"role": "user", "parts": [
                {"text": VISION_INSTRUCTION},
                {"inline_data": {"mime_type": guess_mime(image_bytes), "data": image_bytes}},
            ]}
        ],
        generation_config={
            "response_mime_type": "application/json",
            "response_schema": PHASE1_VISION_SCHEMA,
            "temperature": 0.2,
        },
        request_options={"timeout": 12},
    )
    parsed = json.loads(response.text)
    return Phase1VisionResponse.model_validate(parsed)
```

After the vision response, **the Next.js route handler** (not the Python service) writes each ingredient to Backboard as `kind="fridge_inventory_item"`:

```ts
for (const ing of result.ingredients) {
  await backboard.upsert(sessionId, 'fridge_inventory_item', {
    name: ing.name,
    qty: ing.qty,
    lastSeenAt: new Date().toISOString(),
    estimatedExpiry: new Date(Date.now() + ing.estimatedExpiryDays * 86400 * 1000).toISOString(),
  });
}
```

This is what makes the recipe step "memory-aware" — Backboard can search for `fridge_inventory_item` and surface the soonest-to-expire ones.

## Recipes call

### Pre-prompt context assembly

Pull from Backboard (Python side, via `app/integrations/backboard_client.py`):

```python
diets    = [m.payload['value'] for m in await backboard.list(user_id, 'dietary_restriction')]
cuisines = [m.payload['value'] for m in await backboard.list(user_id, 'cuisine_preference')]
fam_list = await backboard.list(user_id, 'family_size', limit=1)
family_size = fam_list[0].payload['value'] if fam_list else 2
exclude  = [m.payload['value'] for m in await backboard.list(user_id, 'excluded_ingredient')]
visits   = await backboard.list(user_id, 'pantry_visit', limit=5)
recent   = await backboard.search(user_id, 'fridge inventory', kinds=['fridge_inventory_item'], limit=20)

# rank "now in fridge" by soonest expiry
now = datetime.utcnow()
ranked_inventory = sorted(
    [m.payload for m in recent if 'estimatedExpiry' in m.payload],
    key=lambda p: p['estimatedExpiry']
)[:8]
```

### System / instruction

```
You are a kitchen assistant. Propose exactly 3 recipes the user can make tonight. Inputs:
- ingredients: items detected in their fridge (from a recent photo).
- staples: pantry items the user told us they have (flour, salt, oil, etc.).
- ranked_inventory: items in their fridge sorted by soonest expiry. STRONGLY PREFER recipes that use the top 3 of these.
- diets, cuisines, family_size, exclude: hard preferences from memory.

Hard rules:
1. If diets includes "vegan" → no animal products. "vegetarian" → no meat/fish. "gluten_free" → no wheat. "halal"/"kosher" → no pork/no shellfish, etc.
2. cuisines non-empty → all 3 recipes match one of the listed cuisines.
3. exclude non-empty → none of those ingredients appear anywhere.
4. servings = family_size for every recipe.
5. timeMinutes ≤ 45 unless user inventory only supports a longer recipe.

Output rules:
6. ingredientsUsed = items the user clearly has (from ingredients OR staples). ingredientsMissing = items they need to obtain. Pantry staples NEVER appear in ingredientsMissing.
7. expiryUrgencyScore is a 0..1 score reflecting how many of the top-3 ranked_inventory items the recipe uses (0 = uses none, 1 = uses all three).
8. steps: 4–8 short imperative sentences. No fluff.
9. Output exactly the JSON schema given. No prose.
```

### Response schema

```python
PHASE1_RECIPES_SCHEMA = {
  "type": "object",
  "properties": {
    "recipes": {
      "type": "array",
      "minItems": 3, "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["title","time_minutes","servings","ingredients_used","ingredients_missing","expiry_urgency_score","steps"],
        "properties": {
          "title": {"type": "string"},
          "cuisine": {"type": "string"},
          "time_minutes": {"type": "integer"},
          "servings": {"type": "integer"},
          "ingredients_used": {"type": "array", "items": {"type": "string"}},
          "ingredients_missing": {"type": "array", "items": {"type": "string"}},
          "expiry_urgency_score": {"type": "number"},
          "steps": {"type": "array", "items": {"type": "string"}},
          "source_note": {"type": "string"}
        }
      }
    }
  },
  "required": ["recipes"]
}
```

### Implementation sketch

```python
# services/ai/app/agents/recipes.py
async def run_phase1_recipes(req: Phase1RecipesRequest) -> Phase1RecipesResponse:
    if settings.PHASE_1_RECIPES_STUB:
        return load_stub("phase1_recipes.json")

    ctx = await load_backboard_context(req.user_id)
    user_text = format_user_text(
        ingredients=req.ingredients,
        staples=req.staples,
        ranked_inventory=ctx.ranked_inventory,
        diets=ctx.diets, cuisines=ctx.cuisines,
        family_size=ctx.family_size, exclude=ctx.exclude,
    )

    response = await gemini.generate_content_async(
        model=settings.GEMINI_TEXT_MODEL,
        contents=[
            {"role": "user", "parts": [
                {"text": RECIPES_INSTRUCTION + "\n\n" + user_text},
            ]}
        ],
        generation_config={
            "response_mime_type": "application/json",
            "response_schema": PHASE1_RECIPES_SCHEMA,
            "temperature": 0.5,
        },
        request_options={"timeout": 12},
    )
    parsed = json.loads(response.text)
    return Phase1RecipesResponse.model_validate(parsed)
```

## Acceptance tests

`services/ai/tests/test_phase1.py`:

- `test_vegan_pref_excludes_animal_products` — `dietary_restriction=["vegan"]`, no recipe contains "egg", "chicken", "milk", "cheese", "butter", "yogurt".
- `test_returns_exactly_3_recipes`.
- `test_respects_family_size_servings`.
- `test_pantry_staples_not_in_missing` — "salt" and "pepper" never appear in any `ingredients_missing` (assuming they're in `staples`).
- `test_expiry_urgency_when_top_inventory_used` — given a `ranked_inventory` with `["spinach","tomato","feta"]`, the recipe that uses all 3 has `expiry_urgency_score >= 0.9`.
- `test_stub_mode_returns_canned`.

## Stub fixture (`services/ai/app/stubs/phase1_vision.json`)

```json
{
  "ingredients": [
    {"name": "eggs", "qty": "6", "confidence": 0.95, "estimated_expiry_days": 21},
    {"name": "spinach", "qty": "small bag", "confidence": 0.8, "estimated_expiry_days": 4},
    {"name": "cherry tomatoes", "qty": "about a cup", "confidence": 0.85, "estimated_expiry_days": 7},
    {"name": "feta cheese", "qty": "small block", "confidence": 0.7, "estimated_expiry_days": 7}
  ]
}
```

## Stub fixture (`services/ai/app/stubs/phase1_recipes.json`)

Three recipes; the first uses spinach + tomato + feta (top expiry items) and has `expiry_urgency_score: 0.95`. Sahil writes the full file in Block A.

## Memory write-back

After successful recipes generation, the **Next.js route handler** also writes a `pantry_visit` placeholder if the user later confirms they actually picked up items at a pantry — that's a Phase 3 / step 7 follow-up, not part of Phase 1 itself. See [`08-phase3-voice-calls.md`](./08-phase3-voice-calls.md) and the plan view in [`04-frontend-spec.md#plan-view`](./04-frontend-spec.md#plan-view).

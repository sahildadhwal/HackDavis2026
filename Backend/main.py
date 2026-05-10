"""
FridgeBridge — AI-Powered Food Pantry Coordinator
HackDavis 2026

Run:
  cd Backend
  pip3 install -r requirements.txt
  uvicorn main:app --reload --port 8000

For real Twilio calls, also run:
  ngrok http 8000
  → set BASE_URL in .env to the ngrok URL
"""

import os
import json
import uuid
import asyncio
import base64
import time
import re
import math
from pathlib import Path

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from dotenv import load_dotenv
from twilio.rest import Client as TwilioClient
from twilio.twiml.voice_response import VoiceResponse, Gather
from google import genai
from google.genai import types


load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GOOGLE_GEMINI_API_KEY = os.getenv("GOOGLE_GEMINI_API_KEY")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")
GEMINI_TEXT_MODEL = os.getenv("GEMINI_TEXT_MODEL", "gemini-2.5-flash")
GEMINI_VISION_MODEL = os.getenv("GEMINI_VISION_MODEL", GEMINI_TEXT_MODEL)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_TEXT_MODEL = os.getenv("GROQ_TEXT_MODEL", "llama-3.3-70b-versatile")
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")

AUDIO_DIR = Path("audio")
AUDIO_DIR.mkdir(exist_ok=True)

# ─── In-memory state ─────────────────────────────────────────────────────────
sessions: dict = {}
ws_connections: dict = {}
call_states: dict = {}

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="FridgeBridge API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/audio", StaticFiles(directory="audio"), name="audio")


# ─── Helpers ──────────────────────────────────────────────────────────────────
async def call_groq(
    messages: list,
    system: str = "",
    max_tokens: int = 1024,
    json_mode: bool = False,
) -> str:
    if not GROQ_API_KEY:
        raise RuntimeError("Groq API key not configured")
    groq_messages = []
    if system:
        groq_messages.append({"role": "system", "content": system})
    for msg in messages:
        groq_messages.append({"role": msg["role"], "content": msg["content"]})
    payload: dict = {"model": GROQ_TEXT_MODEL, "messages": groq_messages, "max_tokens": max_tokens}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"]
    print("GROQ RESPONSE:", text, flush=True)
    return text


async def call_groq_vision(image_b64: str, media_type: str, prompt: str) -> str:
    if not GROQ_API_KEY:
        raise RuntimeError("Groq API key not configured")
    payload = {
        "model": GROQ_VISION_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
            {"type": "text", "text": prompt},
        ]}],
        "max_tokens": 1024,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"]
    print("GROQ VISION RESPONSE:", text, flush=True)
    return text


async def call_claude(
    messages: list,
    system: str = "",
    max_tokens: int = 1024,
    json_mode: bool = False,
    response_schema: dict | None = None,
    use_google_search: bool = False,
) -> str:
    try:
        client = genai.Client(api_key=GOOGLE_GEMINI_API_KEY)
        contents = [
            types.Content(
                role="user" if msg["role"] == "user" else "model",
                parts=[types.Part(text=msg["content"])]
            )
            for msg in messages
        ]
        config = types.GenerateContentConfig(
            system_instruction=system or None,
            max_output_tokens=max_tokens,
            response_mime_type="application/json" if json_mode and not use_google_search else None,
            response_schema=response_schema if not use_google_search else None,
            tools=[types.Tool(google_search=types.GoogleSearch())] if use_google_search else None,
        )
        response = await client.aio.models.generate_content(
            model=GEMINI_TEXT_MODEL,
            contents=contents,
            config=config,
        )
        parsed = getattr(response, "parsed", None)
        if json_mode and parsed is not None:
            try:
                if hasattr(parsed, "model_dump"):
                    return json.dumps(parsed.model_dump())
                return json.dumps(parsed)
            except TypeError:
                pass
        print("GEMINI RESPONSE:", response.text, flush=True)
        return response.text
    except Exception as gemini_err:
        print(f"Gemini failed ({type(gemini_err).__name__}: {gemini_err}), falling back to Groq", flush=True)
        try:
            # use_google_search calls always ask for JSON but set json_mode=False for Gemini;
            # Groq needs json_mode=True explicitly or it returns conversational text around the JSON
            groq_json_mode = json_mode or use_google_search
            return await call_groq(messages, system, max_tokens, groq_json_mode)
        except Exception as groq_err:
            print(f"Groq fallback also failed ({type(groq_err).__name__}: {groq_err})", flush=True)
            raise gemini_err


async def call_claude_vision(image_b64: str, media_type: str, prompt: str) -> str:
    print(f"DEBUG: GOOGLE_GEMINI_API_KEY set={bool(GOOGLE_GEMINI_API_KEY)}", flush=True)
    try:
        client = genai.Client(api_key=GOOGLE_GEMINI_API_KEY)
        image_bytes = base64.b64decode(image_b64)
        response = await client.aio.models.generate_content(
            model=GEMINI_VISION_MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_bytes(data=image_bytes, mime_type=media_type),
                        types.Part(text=prompt),
                    ],
                )
            ],
        )
        print("GEMINI RESPONSE:", response.text, flush=True)
        return response.text
    except Exception as gemini_err:
        import traceback as tb
        print(f"GEMINI ERROR type={type(gemini_err).__name__} msg={gemini_err}", flush=True)
        print(tb.format_exc(), flush=True)
        print("Falling back to Groq vision", flush=True)
        try:
            return await call_groq_vision(image_b64, media_type, prompt)
        except Exception as groq_err:
            print(f"Groq vision fallback also failed ({type(groq_err).__name__}: {groq_err})", flush=True)
            raise gemini_err

    
async def generate_speech(text: str) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
            headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={"text": text, "model_id": "eleven_monolingual_v1", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
        )
        filename = f"{uuid.uuid4().hex}.mp3"
        filepath = AUDIO_DIR / filename
        filepath.write_bytes(resp.content)
        return f"{BASE_URL}/audio/{filename}"


async def notify_ws(session_id: str, data: dict):
    ws = ws_connections.get(session_id)
    if ws:
        try:
            await ws.send_json(data)
        except Exception:
            pass


async def update_google_sheet(row_data: list):
    if not GOOGLE_SHEETS_ID or not GOOGLE_SERVICE_ACCOUNT_JSON:
        return
    try:
        import gspread
        from google.oauth2.service_account import Credentials
        creds = Credentials.from_service_account_info(json.loads(GOOGLE_SERVICE_ACCOUNT_JSON), scopes=["https://www.googleapis.com/auth/spreadsheets"])
        gc = gspread.authorize(creds)
        gc.open_by_key(GOOGLE_SHEETS_ID).sheet1.append_row(row_data)
    except Exception as e:
        print(f"Google Sheets error: {e}")


def escape_control_chars_in_json_strings(text: str) -> str:
    out = []
    in_string = False
    escaped = False
    for char in text:
        if escaped:
            out.append(char)
            escaped = False
            continue
        if char == "\\" and in_string:
            out.append(char)
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            out.append(char)
            continue
        if in_string and char == "\n":
            out.append("\\n")
            continue
        if in_string and char == "\r":
            out.append("\\r")
            continue
        if in_string and char == "\t":
            out.append("\\t")
            continue
        out.append(char)
    return "".join(out)


def parse_json(text):
    if isinstance(text, (dict, list)):
        return text
    cleaned = str(text).strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start_candidates = [i for i in (cleaned.find("{"), cleaned.find("[")) if i != -1]
        if start_candidates:
            start = min(start_candidates)
            end = max(cleaned.rfind("}"), cleaned.rfind("]"))
            if end > start:
                cleaned = cleaned[start:end + 1]
        return json.loads(escape_control_chars_in_json_strings(cleaned))


MEALS_SCHEMA = {
    "type": "OBJECT",
    "required": ["meals"],
    "properties": {
        "meals": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": ["name", "description", "have", "missing", "difficulty", "time_minutes"],
                "properties": {
                    "name": {"type": "STRING"},
                    "description": {"type": "STRING"},
                    "have": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "missing": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "difficulty": {"type": "STRING", "enum": ["easy", "medium", "hard"]},
                    "time_minutes": {"type": "INTEGER"},
                },
            },
        },
    },
}

PANTRIES_SCHEMA = {
    "type": "OBJECT",
    "required": ["pantries"],
    "properties": {
        "pantries": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": ["name", "address", "phone", "hours", "notes", "lat", "lng"],
                "properties": {
                    "name": {"type": "STRING"},
                    "address": {"type": "STRING"},
                    "phone": {"type": "STRING"},
                    "hours": {"type": "STRING"},
                    "notes": {"type": "STRING"},
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"},
                },
            },
        },
    },
}

RECIPE_SCHEMA = {
    "type": "OBJECT",
    "required": ["steps", "tips", "servings"],
    "properties": {
        "steps": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": ["action"],
                "properties": {
                    "action": {"type": "STRING"},
                    "heat": {"type": "STRING"},
                    "time": {"type": "STRING"},
                    "cue": {"type": "STRING"},
                    "stir": {"type": "STRING"},
                    "tips": {"type": "STRING"},
                },
            },
        },
        "tips": {"type": "ARRAY", "items": {"type": "STRING"}},
        "servings": {"type": "STRING"},
    },
}

PLAN_SCHEMA = {
    "type": "OBJECT",
    "required": ["plan", "still_missing", "recipe_modifications", "summary"],
    "properties": {
        "plan": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": ["pantry_name", "address", "items_to_get", "visit_order"],
                "properties": {
                    "pantry_name": {"type": "STRING"},
                    "address": {"type": "STRING"},
                    "items_to_get": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "visit_order": {"type": "INTEGER"},
                },
            },
        },
        "still_missing": {"type": "ARRAY", "items": {"type": "STRING"}},
        "recipe_modifications": {"type": "STRING"},
        "summary": {"type": "STRING"},
    },
}


def clean_string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def normalize_meals(data: dict) -> dict:
    meals = []
    for meal in data.get("meals", []) if isinstance(data, dict) else []:
        if not isinstance(meal, dict):
            continue
        try:
            time_minutes = int(meal.get("time_minutes") or 30)
        except (TypeError, ValueError):
            time_minutes = 30
        meals.append({
            "name": str(meal.get("name", "Untitled meal")).strip() or "Untitled meal",
            "description": str(meal.get("description", "")).strip(),
            "have": clean_string_list(meal.get("have", [])),
            "missing": clean_string_list(meal.get("missing", [])),
            "difficulty": meal.get("difficulty") if meal.get("difficulty") in {"easy", "medium", "hard"} else "easy",
            "time_minutes": time_minutes,
        })
    return {"meals": meals}


def fallback_meals(ingredients: list, specific_request: str = "") -> dict:
    available = clean_string_list(ingredients)
    staples = {"salt", "pepper", "olive oil", "butter", "garlic", "onion", "rice", "pasta", "flour"}
    visible = [item for item in available if item.lower() not in staples]
    base_items = visible or available or ["pantry staples"]
    focus = specific_request.strip()
    meal_names = [
        f"{base_items[0].title()} Skillet",
        f"{base_items[min(1, len(base_items) - 1)].title()} Rice Bowl",
        f"{base_items[min(2, len(base_items) - 1)].title()} Pasta",
        f"{base_items[0].title()} Soup",
        f"{base_items[min(1, len(base_items) - 1)].title()} Tacos",
        f"{base_items[min(2, len(base_items) - 1)].title()} Frittata",
    ]
    if focus:
        meal_names[0] = f"{focus.title()} with {base_items[0].title()}"
    fallback = []
    for idx, name in enumerate(meal_names):
        have = available[:6]
        missing_options = ["protein or beans", "fresh greens", "sauce or seasoning", "broth", "tortillas", "eggs"]
        missing = [missing_options[idx]]
        fallback.append({
            "name": name,
            "description": "Simple, flexible meal using what you already have.",
            "have": have,
            "missing": missing,
            "difficulty": "easy",
            "time_minutes": 25 + idx * 5,
        })
    return {"meals": fallback}


def fallback_recipe_steps(meal_name: str, have: list, missing: list, time_minutes: int = 30) -> dict:
    available = clean_string_list(have)
    missing_items = clean_string_list(missing)
    main_items = ", ".join(available[:5]) or "your available ingredients"
    hero_item = available[0] if available else meal_name or "main ingredient"
    secondary_items = ", ".join(available[1:4]) if len(available) > 1 else "any vegetables or pantry staples you have"
    missing_text = ", ".join(missing_items[:3])
    try:
        cook_time = int(time_minutes)
    except (TypeError, ValueError):
        cook_time = 30
    prep_time = max(5, min(12, cook_time // 3))
    active_time = max(10, cook_time - prep_time)
    steps = [
        f"Set out {main_items}, a cutting board, knife, measuring spoon, skillet or saucepan, and a serving bowl. Pat wet ingredients dry so they brown instead of steaming.",
        f"Spend about {prep_time} minutes prepping: cut {hero_item} into even bite-size pieces, slice or mince {secondary_items}, and keep fast-cooking items separate from firm ones.",
        "Warm 1-2 tablespoons oil or butter in the pan over medium heat for 60-90 seconds. The fat should shimmer, but it should not smoke.",
        "Cook aromatics or firm vegetables first with a pinch of salt for 3-5 minutes, stirring every 30 seconds, until softened and lightly golden at the edges.",
        f"Add {hero_item} and spread it into a single layer. Let it sit undisturbed for 1-2 minutes before stirring so it develops color and deeper flavor.",
        f"Fold in the remaining ingredients and cook for {max(5, active_time // 2)}-{max(8, active_time // 2 + 4)} minutes, adjusting heat between medium-low and medium so the pan sizzles gently.",
        "Season in layers: add salt, pepper, acid such as lemon or vinegar, and a little sauce or spice. Taste, then adjust until it tastes balanced rather than flat.",
        "Finish off heat for 2 minutes so the food settles. Add a small splash of water, broth, or milk only if it looks dry, then plate while warm.",
    ]
    if missing_text:
        steps.insert(2, f"For the missing {missing_text}, choose the closest match: beans or eggs for protein, frozen vegetables for greens, or broth plus spices for sauce.")
    return {
        "steps": steps,
        "tips": [
            "If the food tastes dull, add acid first, then salt.",
            "If anything browns too quickly, lower the heat and add one tablespoon of water.",
            "Keep pieces similar in size so the texture feels intentional.",
        ],
        "servings": "2-4 servings",
    }


def _normalize_step(item) -> str | None:
    _skip = {"none", "n/a", "-", ""}
    if isinstance(item, dict):
        action = str(item.get("action", "")).strip()
        if not action:
            return None
        parts = [action.rstrip(".")]
        meta = []
        if (heat := str(item.get("heat", "")).strip().lower()) and heat not in _skip:
            meta.append(f"{item['heat']} heat")
        if (t := str(item.get("time", "")).strip().lower()) and t not in _skip:
            meta.append(str(item["time"]))
        if meta:
            parts[0] += f" ({', '.join(meta)})"
        if (cue := str(item.get("cue", "")).strip()) and cue.lower() not in _skip:
            parts.append(f"Look for: {cue.rstrip('.')}.")
        if (step_tips := str(item.get("tips", "")).strip()) and step_tips.lower() not in _skip:
            parts.append(f"Tip: {step_tips.rstrip('.')}.")
        return " ".join(parts)
    if isinstance(item, str):
        return re.sub(r"^Step\s*\d+[:.]\s*", "", item).strip() or None
    return None


def normalize_recipe(data: dict, meal_name: str, have: list, missing: list, time_minutes: int) -> dict:
    raw_steps = data.get("steps", []) if isinstance(data, dict) else []
    steps = [s for item in raw_steps if (s := _normalize_step(item)) is not None]
    tips = clean_string_list(data.get("tips", [])) if isinstance(data, dict) else []
    servings = str(data.get("servings", "2-4 servings")).strip() if isinstance(data, dict) else "2-4 servings"
    avg_words = sum(len(s.split()) for s in steps) / max(len(steps), 1)
    if len(steps) < 5 or avg_words < 10:
        return fallback_recipe_steps(meal_name, have, missing, time_minutes)
    return {
        "steps": steps,
        "tips": tips,
        "servings": servings or "2-4 servings",
    }


def normalize_pantries(data: dict) -> dict:
    pantries = []
    seen = set()
    for pantry in data.get("pantries", []) if isinstance(data, dict) else []:
        if not isinstance(pantry, dict):
            continue
        name = str(pantry.get("name", "")).strip()
        address = str(pantry.get("address") or pantry.get("street_address", "")).strip()
        if not name or not address:
            continue
        key = (name.lower(), address.lower())
        if key in seen:
            continue
        seen.add(key)
        raw_lat = pantry.get("lat") if pantry.get("lat") is not None else pantry.get("latitude")
        raw_lng = pantry.get("lng") if pantry.get("lng") is not None else pantry.get("longitude")
        try:
            lat = float(raw_lat)
            lng = float(raw_lng)
        except (TypeError, ValueError):
            lat = None
            lng = None
        pantries.append({
            "name": name,
            "address": address,
            "phone": str(pantry.get("phone") or pantry.get("phone_number", "")).strip(),
            "hours": str(pantry.get("hours") or pantry.get("public_hours", "Call to confirm hours")).strip() or "Call to confirm hours",
            "notes": str(pantry.get("notes") or pantry.get("note", "")).strip(),
            "lat": lat,
            "lng": lng,
        })
    return {"pantries": pantries}


# ─── API Routes ───────────────────────────────────────────────────────────────

def parse_coordinates(value: str):
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", str(value or ""))
    if not match:
        return None
    lat = float(match.group(1))
    lng = float(match.group(2))
    if -90 <= lat <= 90 and -180 <= lng <= 180:
        return lat, lng
    return None


def distance_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 3958.8
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def geocode_location(location: str):
    coords = parse_coordinates(location)
    if coords:
        return coords
    if not str(location).strip():
        return None
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": location, "format": "json", "limit": 1},
                headers={"User-Agent": "FridgeBridge-HackDavis2026/1.0"},
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as e:
        print(f"Nominatim geocode error: {e}", flush=True)
    return None


def pantry_from_osm_element(element: dict, origin):
    tags = element.get("tags", {})
    name = str(tags.get("name", "")).strip()
    searchable = " ".join(
        str(tags.get(key, ""))
        for key in ("name", "amenity", "social_facility", "description", "operator")
    ).lower()
    keywords = ("food", "pantry", "bank", "soup", "meal", "kitchen", "hunger", "community cupboard")
    if not name or not any(keyword in searchable for keyword in keywords):
        return None

    lat = element.get("lat") or element.get("center", {}).get("lat")
    lng = element.get("lon") or element.get("center", {}).get("lon")
    if lat is None or lng is None:
        return None
    lat = float(lat)
    lng = float(lng)
    address_parts = [
        tags.get("addr:housenumber"),
        tags.get("addr:street"),
        tags.get("addr:city"),
        tags.get("addr:state"),
        tags.get("addr:postcode"),
    ]
    address = " ".join(str(part).strip() for part in address_parts if part)
    if not address:
        address = tags.get("addr:full") or f"{lat:.5f}, {lng:.5f}"
    notes = tags.get("description") or tags.get("operator") or ""
    if origin:
        miles = distance_miles(origin[0], origin[1], lat, lng)
        notes = f"{notes} {miles:.1f} miles away".strip()
    return {
        "name": name,
        "address": address,
        "phone": str(tags.get("phone") or tags.get("contact:phone") or "").strip(),
        "hours": str(tags.get("opening_hours") or "Call to confirm hours").strip(),
        "notes": notes,
        "lat": lat,
        "lng": lng,
    }


async def find_osm_pantries(location: str, coords=None, radius_m: int = 16000) -> dict:
    origin = coords or await geocode_location(location)
    if not origin:
        return {"pantries": []}
    lat, lng = origin
    query = f"""
    [out:json][timeout:12];
    (
      node["social_facility"~"food_bank|soup_kitchen"](around:{radius_m},{lat},{lng});
      way["social_facility"~"food_bank|soup_kitchen"](around:{radius_m},{lat},{lng});
      relation["social_facility"~"food_bank|soup_kitchen"](around:{radius_m},{lat},{lng});
      node["name"~"food pantry|food bank|soup kitchen|community cupboard|free food",i](around:{radius_m},{lat},{lng});
      way["name"~"food pantry|food bank|soup kitchen|community cupboard|free food",i](around:{radius_m},{lat},{lng});
      relation["name"~"food pantry|food bank|soup kitchen|community cupboard|free food",i](around:{radius_m},{lat},{lng});
    );
    out center tags 40;
    """
    try:
        async with httpx.AsyncClient(timeout=18) as client:
            resp = await client.post(
                "https://overpass-api.de/api/interpreter",
                data={"data": query},
                headers={"User-Agent": "FridgeBridge-HackDavis2026/1.0"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        print(f"Overpass pantry search error: {e}", flush=True)
        return {"pantries": []}

    pantries = []
    for element in data.get("elements", []):
        pantry = pantry_from_osm_element(element, origin)
        if pantry:
            pantries.append(pantry)
    return normalize_pantries({"pantries": pantries})


def merge_pantry_lists(*lists: list) -> list:
    merged = []
    seen = set()
    for pantries in lists:
        for pantry in pantries or []:
            name = str(pantry.get("name", "")).strip()
            address = str(pantry.get("address", "")).strip()
            if not name or not address:
                continue
            key = (name.lower(), address.lower())
            if key in seen:
                continue
            seen.add(key)
            merged.append(pantry)
    return merged


@app.get("/")
def root():
    return {"status": "ok", "service": "FridgeBridge API"}


@app.post("/api/analyze-fridge")
async def analyze_fridge(image: UploadFile = File(...)):
    contents = await image.read()
    b64 = base64.b64encode(contents).decode()
    media_type = image.content_type or "image/jpeg"

    result = await call_claude_vision(b64, media_type, """Look at this photo of food/fridge/pantry items.
            Extract every visible food ingredient. Be specific (e.g., "cheddar cheese" not just "cheese").
            Return ONLY a JSON array of strings, no other text. Example:
            ["eggs", "whole milk", "cheddar cheese", "spinach"]""")
    print(">>> call_claude_vision called", flush=True)

    try:
        ingredients = parse_json(result)
    except:
        ingredients = [i.strip().strip('"\'') for i in result.strip("[]").split(",")]

    session_id = uuid.uuid4().hex
    sessions[session_id] = {"ingredients": ingredients, "missing": [], "meals": [], "pantries": [], "call_results": []}
    return {"session_id": session_id, "ingredients": ingredients}


@app.post("/api/suggest-meals")
async def suggest_meals(request: Request):
    body = await request.json()
    session_id = body.get("session_id", "")
    ingredients = body.get("ingredients", [])
    specific_request = body.get("specific_request", "")

    if session_id in sessions:
        sessions[session_id]["ingredients"] = ingredients

    extra = f"\n\nThe user specifically wants: {specific_request}. Prioritize this." if specific_request else ""

    try:
        result = await call_claude(
            [{"role": "user", "content": f"""Given these ingredients: {json.dumps(ingredients)}{extra}
Suggest exactly 6 practical meals. Keep each description under 18 words.
For each meal, list ingredients the user already has and important missing ingredients."""}],
            system="Helpful cooking assistant for budget-friendly meals. Return only JSON.",
            max_tokens=2048,
            json_mode=True,
            response_schema=MEALS_SCHEMA,
        )
        data = normalize_meals(parse_json(result))
    except Exception as e:
        print(f"Gemini meal suggestion error: {e}", flush=True)
        data = fallback_meals(ingredients, specific_request)

    if session_id in sessions:
        sessions[session_id]["meals"] = data.get("meals", [])
    return data


@app.post("/api/find-pantries")
async def find_pantries(request: Request):
    body = await request.json()
    location = body.get("location", "")
    session_id = body.get("session_id", "")
    coords = None
    if isinstance(body.get("coords"), dict):
        try:
            coords = (float(body["coords"]["lat"]), float(body["coords"]["lng"]))
        except (KeyError, TypeError, ValueError):
            coords = None
    coords = coords or parse_coordinates(location)
    osm_data = await find_osm_pantries(location, coords)
    local_pantries = osm_data.get("pantries", [])

    try:
        local_context = json.dumps(local_pantries[:8])
        coordinate_context = f"{coords[0]},{coords[1]}" if coords else location
        result = await call_claude(
            [{"role": "user", "content": f"""Find 3-5 real food pantries, food banks, or community food distribution sites near {location}.
Use this coordinate/location as the center of the search: {coordinate_context}.
Known local candidates from OpenStreetMap: {local_context}
For each result include name, street address, phone number if available, public hours if available, a short note, latitude, and longitude.
Prefer local organizations near the provided coordinate over broad regional directories. Return only JSON with a top-level pantries array."""}],
            system="Social services assistant. Use Google Search to verify real food resources. Return only JSON.",
            max_tokens=2048,
            json_mode=False,
            use_google_search=True,
        )
        gemini_data = normalize_pantries(parse_json(result))
        ai_pantries = gemini_data.get("pantries", [])
        # geocode any AI-returned pantries that are missing coordinates
        for p in ai_pantries:
            if p.get("lat") is None or p.get("lng") is None:
                resolved = await geocode_location(p.get("address", ""))
                if resolved:
                    p["lat"], p["lng"] = resolved
        data = {"pantries": merge_pantry_lists(local_pantries, ai_pantries)[:6]}
    except Exception as e:
        print(f"AI pantry lookup error: {e}", flush=True)
        data = {"pantries": local_pantries[:6]}


    # ✅ Add this — prepend your demo pantry
    demo_pantry = {
        "name": "HackDavis Food Pantry - Demo",
        "address": "UC Davis, Davis, CA 95616",
        "phone": "+17078632820",  # your number
        "hours": "Open Now",
        "notes": "Demo pantry for HackDavis 2026",
        "lat": 38.5382,
        "lng": -121.7617
    }
    data["pantries"] = merge_pantry_lists(data.get("pantries", []), [demo_pantry])


    if session_id in sessions:
        sessions[session_id]["pantries"] = data.get("pantries", [])
    return data


@app.post("/api/call-pantries")
async def call_pantries(request: Request):
    body = await request.json()
    session_id = body.get("session_id", "")
    pantries = body.get("pantries", [])
    missing_ingredients = body.get("missing_ingredients", [])
    selected_meal = body.get("selected_meal", "")

    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        return JSONResponse(status_code=400, content={"error": "Twilio not configured"})

    twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    call_ids = []

    for pantry in pantries:
        phone = pantry.get("phone", "")
        if not phone:
            continue
        call_id = uuid.uuid4().hex
        call_states[call_id] = {
            "session_id": session_id, "pantry": pantry, "missing_ingredients": missing_ingredients,
            "selected_meal": selected_meal, "conversation": [], "results": {}, "status": "initiating",
        }
        try:
            call = twilio_client.calls.create(
                to=phone, from_=TWILIO_PHONE_NUMBER,
                url=f"{BASE_URL}/api/twilio/voice/{call_id}",
                status_callback=f"{BASE_URL}/api/twilio/status/{call_id}",
                status_callback_event=["completed"], timeout=30,
            )
            call_states[call_id]["twilio_sid"] = call.sid
            call_states[call_id]["status"] = "ringing"
            call_ids.append(call_id)
            await notify_ws(session_id, {"type": "call_started", "call_id": call_id, "pantry": pantry["name"], "status": "ringing"})
        except Exception as e:
            call_states[call_id]["status"] = "failed"
            await notify_ws(session_id, {"type": "call_error", "call_id": call_id, "pantry": pantry["name"], "error": str(e)})

    return {"call_ids": call_ids}


@app.api_route("/api/twilio/voice/{call_id}", methods=["GET", "POST"])
async def twilio_voice_webhook(call_id: str):
    state = call_states.get(call_id)
    if not state:
        resp = VoiceResponse()
        resp.say("Sorry, an error occurred.")
        resp.hangup()
        return HTMLResponse(str(resp), media_type="application/xml")

    ingredients_list = ", ".join(state["missing_ingredients"][:5])
    greeting = (f"Hello! I'm calling on behalf of someone in the community who needs help "
                f"finding a few food items. Could you let me know if you currently have any of "
                f"the following available: {ingredients_list}? Please let me know which ones you have.")

    state["conversation"].append({"role": "assistant", "text": greeting})
    state["status"] = "in_progress"
    await notify_ws(state["session_id"], {"type": "call_update", "call_id": call_id, "pantry": state["pantry"]["name"], "status": "connected", "message": "Agent speaking with pantry..."})

    resp = VoiceResponse()
    try:
        if ELEVENLABS_API_KEY:
            resp.play(await generate_speech(greeting))
        else:
            resp.say(greeting, voice="Polly.Joanna")
    except:
        resp.say(greeting, voice="Polly.Joanna")

    gather = Gather(input="speech", action=f"{BASE_URL}/api/twilio/gather/{call_id}", timeout=8, speech_timeout="auto", language="en-US")
    resp.append(gather)
    resp.say("I didn't catch that. Thank you, goodbye.")
    resp.hangup()
    return HTMLResponse(str(resp), media_type="application/xml")


@app.api_route("/api/twilio/gather/{call_id}", methods=["GET", "POST"])
async def twilio_gather_webhook(call_id: str, request: Request):
    form = await request.form()
    speech_result = form.get("SpeechResult", "")
    state = call_states.get(call_id)
    if not state:
        resp = VoiceResponse()
        resp.say("Thank you. Goodbye.")
        resp.hangup()
        return HTMLResponse(str(resp), media_type="application/xml")

    state["conversation"].append({"role": "pantry", "text": speech_result})
    await notify_ws(state["session_id"], {"type": "call_update", "call_id": call_id, "pantry": state["pantry"]["name"], "status": "listening", "message": f"Pantry said: {speech_result}"})

    convo = "\n".join([f"{'Agent' if c['role']=='assistant' else 'Pantry'}: {c['text']}" for c in state["conversation"]])
    analysis = await call_claude(
        [{"role": "user", "content": f"""Analyzing AI agent ↔ food pantry call.
Looking for: {json.dumps(state['missing_ingredients'])}
Conversation:\n{convo}
Return ONLY JSON: {{"available": [...], "unavailable": [...], "unclear": [...], "should_continue": bool, "follow_up_message": "...", "substitutions_to_ask": [...]}}"""}],
        system="Analyze food pantry call. Return only JSON."
    )

    try:
        result = parse_json(analysis)
    except:
        result = {"available": [], "unavailable": [], "unclear": [], "should_continue": False, "follow_up_message": "Thank you! Goodbye!", "substitutions_to_ask": []}

    state["results"] = {"available": result.get("available", []), "unavailable": result.get("unavailable", []), "substitutions_to_ask": result.get("substitutions_to_ask", [])}

    resp = VoiceResponse()
    if result.get("should_continue") and len(state["conversation"]) < 8:
        msg = result.get("follow_up_message", "Thank you!")
        state["conversation"].append({"role": "assistant", "text": msg})
        try:
            resp.play(await generate_speech(msg)) if ELEVENLABS_API_KEY else resp.say(msg, voice="Polly.Joanna")
        except:
            resp.say(msg, voice="Polly.Joanna")
        gather = Gather(input="speech", action=f"{BASE_URL}/api/twilio/gather/{call_id}", timeout=8, speech_timeout="auto", language="en-US")
        resp.append(gather)
        resp.say("Thank you, goodbye!")
        resp.hangup()
    else:
        msg = result.get("follow_up_message", "Thank you so much!")
        state["conversation"].append({"role": "assistant", "text": msg})
        state["status"] = "completed"
        try:
            resp.play(await generate_speech(msg)) if ELEVENLABS_API_KEY else resp.say(msg, voice="Polly.Joanna")
        except:
            resp.say(msg, voice="Polly.Joanna")
        resp.hangup()
        await notify_ws(state["session_id"], {"type": "call_complete", "call_id": call_id, "pantry": state["pantry"]["name"], "results": state["results"]})
        await update_google_sheet([time.strftime("%Y-%m-%d %H:%M"), state["pantry"]["name"], state["pantry"].get("phone", ""), json.dumps(state["results"].get("available", [])), json.dumps(state["results"].get("unavailable", [])), state.get("selected_meal", "")])

    return HTMLResponse(str(resp), media_type="application/xml")


@app.api_route("/api/twilio/status/{call_id}", methods=["GET", "POST"])
async def twilio_status_callback(call_id: str, request: Request):
    form = await request.form()
    state = call_states.get(call_id)
    if state:
        state["status"] = form.get("CallStatus", "")
        await notify_ws(state["session_id"], {"type": "call_status", "call_id": call_id, "pantry": state["pantry"]["name"], "status": state["status"]})
    return HTMLResponse("OK")

@app.post("/api/recipe-steps")
async def recipe_steps(request: Request):
    body = await request.json()
    meal_name = body.get("meal_name", "")
    have = body.get("have", [])
    missing = body.get("missing", [])
    time_minutes = body.get("time_minutes", 30)

    try:
        result = await call_claude(
            [{"role": "user", "content": f"""Provide sophisticated but beginner-readable cooking instructions for: {meal_name}
Ingredients available: {json.dumps(have)}
Missing ingredients (note substitutions if possible): {json.dumps(missing)}
Target cooking time: about {time_minutes} minutes.

Requirements:
- Return 6-9 steps.
- Each step should be specific enough to cook from: include heat level, approximate minutes, visual or texture cues, and when to stir/taste.
- Use approximate quantities where helpful, such as 1-2 tbsp oil, a pinch of salt, or 1/4 cup water.
- Include substitutions for missing ingredients inside the relevant step.
- Avoid vague lines like "cook until done", "prepare ingredients", or "season to taste" unless you explain how and what to look for.
- Include 2-3 concise general cooking tips in the top-level tips field (e.g., common mistakes to avoid, helpful techniques, or storage and serving ideas)."""}],
            system="Expert chef. Write polished, practical, sensory step-by-step cooking instructions. Return only JSON with steps, tips, and servings.",
            max_tokens=2600,
            json_mode=True,
            response_schema=RECIPE_SCHEMA,
        )
        data = parse_json(result)
        return normalize_recipe(data, meal_name, have, missing, time_minutes)
    except Exception as e:
        print(f"Gemini recipe steps error: {e}", flush=True)
        return fallback_recipe_steps(meal_name, have, missing, time_minutes)


@app.post("/api/optimize-plan")
async def optimize_plan(request: Request):
    body = await request.json()
    try:
        result = await call_claude(
            [{"role": "user", "content": f"""Given food pantry results, create optimal pickup plan.
Meal: {body.get('selected_meal', '')}
Location: {body.get('user_location', '')}
Results: {json.dumps(body.get('call_results', []))}
Return a practical plan ordered by likely convenience and item coverage."""}],
            system="Logistics optimizer. Return only JSON.",
            json_mode=True,
            response_schema=PLAN_SCHEMA,
        )
        return parse_json(result)
    except Exception as e:
        print(f"Gemini optimize plan error: {e}", flush=True)
        return {"plan": [], "still_missing": [], "recipe_modifications": "", "summary": "Could not generate a pickup plan yet."}


# ─── Demo mode ────────────────────────────────────────────────────────────────

@app.post("/api/demo/call-pantries")
async def demo_call_pantries(request: Request):
    body = await request.json()
    session_id = body.get("session_id", "")
    pantries = body.get("pantries", [])
    missing = body.get("missing_ingredients", [])

    async def simulate(pantry, delay):
        await asyncio.sleep(delay)
        cid = uuid.uuid4().hex
        await notify_ws(session_id, {"type": "call_started", "call_id": cid, "pantry": pantry["name"], "status": "ringing"})
        await asyncio.sleep(2)
        await notify_ws(session_id, {"type": "call_update", "call_id": cid, "pantry": pantry["name"], "status": "connected", "message": "Agent speaking with pantry..."})

        try:
            r = await call_claude([{"role": "user", "content": f"""Simulate food pantry "{pantry['name']}" inventory for: {json.dumps(missing)}
Pantries typically have: canned goods, pasta, rice, beans, bread, PB, cereal, milk, eggs, some produce.
Return ONLY JSON: {{"available": [...], "unavailable": [...], "substitutions": {{}}}}"""}], system="Simulate realistic pantry inventory. JSON only.")
            data = parse_json(r)
        except:
            import random
            avail = random.sample(missing, min(len(missing), len(missing)//2+1))
            data = {"available": avail, "unavailable": [i for i in missing if i not in avail], "substitutions": {}}

        await asyncio.sleep(3)
        await notify_ws(session_id, {"type": "call_complete", "call_id": cid, "pantry": pantry["name"], "results": data})
        return {"pantry": pantry["name"], "results": data}

    results = await asyncio.gather(*[simulate(p, i*1.5) for i, p in enumerate(pantries)])
    return {"results": results}


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    ws_connections[session_id] = websocket
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_connections.pop(session_id, None)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

"""
PantryPal — AI-Powered Food Pantry Coordinator
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
from pathlib import Path

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from dotenv import load_dotenv
from twilio.rest import Client as TwilioClient
from twilio.twiml.voice_response import VoiceResponse, Gather

load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
GOOGLE_SHEETS_ID = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")

AUDIO_DIR = Path("audio")
AUDIO_DIR.mkdir(exist_ok=True)

# ─── In-memory state ─────────────────────────────────────────────────────────
sessions: dict = {}
ws_connections: dict = {}
call_states: dict = {}

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="PantryPal API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/audio", StaticFiles(directory="audio"), name="audio")


# ─── Helpers ──────────────────────────────────────────────────────────────────
async def call_claude(messages: list, system: str = "", max_tokens: int = 1024) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        body = {
            "model": "llama-3.3-70b-versatile",
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if system:
            body["messages"] = [{"role": "system", "content": system}] + messages
        resp = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {ANTHROPIC_API_KEY}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        data = resp.json()
        print("GROQ RESPONSE:", data, flush=True)
        # return data["content"][0]["text"]
        return data["choices"][0]["message"]["content"]


async def call_claude_vision(image_b64: str, media_type: str, prompt: str) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {ANTHROPIC_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "meta-llama/llama-4-scout-17b-16e-instruct",
                
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ]}],
            },
        )
        data = resp.json()
        print("GROQ RESPONSE:", data, flush=True)
        return data["choices"][0]["message"]["content"] 

    
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


def parse_json(text: str):
    return json.loads(text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())


# ─── API Routes ───────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "service": "PantryPal API"}


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

    result = await call_claude(
        [{"role": "user", "content": f"""Given these ingredients: {json.dumps(ingredients)}{extra}
Suggest 3-5 meals. For each, list what they have and what's missing.
Return ONLY JSON: {{"meals": [{{"name": "...", "description": "...", "have": [...], "missing": [...], "difficulty": "easy|medium|hard", "time_minutes": 30}}]}}"""}],
        system="Helpful cooking assistant for budget-friendly meals. Return only JSON."
    )

    try:
        data = parse_json(result)
    except:
        data = {"meals": []}

    if session_id in sessions:
        sessions[session_id]["meals"] = data.get("meals", [])
    return data


@app.post("/api/find-pantries")
async def find_pantries(request: Request):
    body = await request.json()
    location = body.get("location", "")
    session_id = body.get("session_id", "")

    result = await call_claude(
        [{"role": "user", "content": f"""Find real food pantries, food banks near {location}. Need 3-5 with phone numbers.
Return ONLY JSON: {{"pantries": [{{"name": "...", "address": "...", "phone": "+1XXXXXXXXXX", "hours": "...", "notes": "...", "lat": 0.0, "lng": 0.0}}]}}
Include lat/lng coordinates for mapping."""}],
        system="Social services assistant. Find real food resources. Return only JSON.",
        max_tokens=2048,
    )

    try:
        data = parse_json(result)
    except:
        data = {"pantries": []}


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
    data["pantries"] = [demo_pantry] + data.get("pantries", [])


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

    if True:
        resp = VoiceResponse()
        # default twilio voice (DONT USE, too ROBOTIC)
        gather = Gather(input="speech", action=f"{BASE_URL}/api/twilio/gather/{call_id}", timeout=10, speech_timeout="auto", language="en-US")
        gather.say(greeting, voice="Polly.Joanna")
        resp.append(gather)
        resp.say("I didn't catch that. Thank you, goodbye.")
        resp.hangup()
#   
    # print(">>> twilio_voice_webhook reached response building", flush=True)
    # print(f">>> ELEVENLABS_API_KEY set: {bool(ELEVENLABS_API_KEY)}", flush=True)
    # resp = VoiceResponse()
    # gather = Gather(input="speech", action=f"{BASE_URL}/api/twilio/gather/{call_id}", timeout=10, speech_timeout="auto", language="en-US")
    # try:
    #     if ELEVENLABS_API_KEY:
    #         gather.say(greeting, voice="Polly.Joanna-Neural")

    #     else:
    #         print(">>> using Polly fallback", flush=True)
    #         gather.say(greeting, voice="Polly.Joanna-Neural")
    # except Exception as e:
    #     print(f">>> ELEVENLABS ERROR: {e}", flush=True)
    #     gather.say(greeting, voice="Polly.Joanna-Neural")
    # resp.append(gather)
    # print(f">>> XML being returned: {str(resp)}", flush=True)
    # resp.say("I didn't catch that. Thank you, goodbye.")
    # resp.hangup()

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


@app.post("/api/optimize-plan")
async def optimize_plan(request: Request):
    body = await request.json()
    result = await call_claude(
        [{"role": "user", "content": f"""Given food pantry results, create optimal pickup plan.
Meal: {body.get('selected_meal', '')}
Location: {body.get('user_location', '')}
Results: {json.dumps(body.get('call_results', []))}
Return ONLY JSON: {{"plan": [{{"pantry_name": "...", "address": "...", "items_to_get": [...], "visit_order": 1}}], "still_missing": [...], "recipe_modifications": "...", "summary": "..."}}"""}],
        system="Logistics optimizer. Return only JSON."
    )
    try:
        return parse_json(result)
    except:
        return {"plan": [], "still_missing": [], "recipe_modifications": "", "summary": result}


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
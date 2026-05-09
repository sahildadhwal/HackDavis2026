# Phase 3 — Parallel Voice Calls (Twilio + ElevenLabs) → Mongo + Google Sheets

> Mirror summary in [`docs/human/01-plan.md#phase-3`](../human/01-plan.md#phase-3) and ethical policy in [`docs/human/04-risks.md#ethical-call-policy`](../human/04-risks.md#ethical-call-policy). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Owner:** Sahil. Files live in `services/ai/app/agents/caller.py`, `services/ai/app/integrations/elevenlabs_client.py`, `services/ai/app/integrations/twilio_client.py`, `services/ai/app/integrations/sheets_client.py`, `services/ai/app/routers/phase3.py`.

## Goal

Given N pantry IDs (1 ≤ N ≤ 5), make N **parallel** outbound phone calls using an AI voice agent (ElevenLabs Conversational AI), ask a scripted set of questions, write transcripts to **MongoDB `call_events`** in real time (which drives the SSE dashboard via change streams), AND mirror per-pantry results to a **Google Sheet** tab created for this job.

## Ethics gate (read first)

- **Default behavior:** the Python service refuses to dial unless `pantry.phone` is in the `DEMO_FALLBACK_PHONES` allowlist (env var) **OR** `ALLOW_REAL_PANTRY_CALLS=true` is explicitly set.
- For demo, set `DEMO_FALLBACK_PHONES` to 3 numbers we own (team phones or Twilio test numbers). The service round-robins these in place of the real `pantry.phone`. The UI + Sheet still show the real pantry name + address — the only thing swapped is the dialed number.
- The agent's first sentence on every call is: **"Hi, this is an AI assistant calling on behalf of someone looking for food pantry information. Is now an okay time for a 1-minute call?"** Enforced in the agent's system prompt; not configurable per call.

## Endpoints

- `POST /v1/phase3/start` — see [`03-api-contracts.md`](./03-api-contracts.md).
- `POST /v1/phase3/webhook/twilio` — Twilio status webhook.
- `POST /v1/phase3/webhook/elevenlabs` — ElevenLabs transcript/turn webhooks.

## Architecture

```
   POST /v1/phase3/start                                  +-------------------------+
        │                                                 |   Twilio outbound       |
        ▼                                                 |   POST /Calls           |
+-----------------+        asyncio.gather                 |   With <Connect><Stream>|
| Phase 3 router  |─── for each pantry ──┐                +-----------+-------------+
+-----------------+                       │                            │ bidirectional
                                          ▼                            ▼
                                +-----------------+        +------------------------+
                                | caller.py       |        |  ElevenLabs Conv AI    |
                                | start_one_call()├────────►|  agent (signed url)   |
                                +-----------------+        |                        |
                                          │                |  emits webhooks:       |
                                          │                |  - transcript chunk    |
                       writes call_events │                |  - agent_response      |
                       writes Sheets row  │                |  - call_ended          |
                                          ▼                +------------+-----------+
                                ┌────────────────────┐                  │
                                │  MongoDB           │ ◄────────────────┘
                                │  call_events       │
                                └─────────┬──────────┘
                                          │ change stream
                                          ▼
                          Next.js SSE /api/calls/:id/stream
                                          │
                                          ▼
                                       Browser

                         (in parallel)
                                          ▼
                          ┌────────────────────────────┐
                          │  Google Sheet (this job's  │
                          │  tab)                      │
                          └────────────────────────────┘
```

**Key choice:** Twilio originates the PSTN call. The audio is streamed (via Twilio Media Streams `<Connect><Stream>`) into ElevenLabs Conversational AI agent, which responds with synthesized voice. ElevenLabs sends transcript and turn webhooks to our service, which writes them to Mongo `call_events` AND updates the per-job Google Sheet.

## Setup steps (Sahil + Aryan, T+0 → T+12)

1. **Twilio** (Aryan, Block A): provision an outbound voice number. Verify the demo target numbers in `DEMO_FALLBACK_PHONES` so trial mode allows them.
2. **ElevenLabs Conversational AI** (Sahil, Block A): create one agent in the dashboard. Voice: any pleasant English voice. System prompt: see template below. Capture `ELEVENLABS_AGENT_ID`.
3. **Google Sheet** (Aryan, Block A): create the master spreadsheet, share with the service account email as Editor, capture `SHEETS_SPREADSHEET_ID`.
4. Configure ElevenLabs agent webhook URL → `${AI_SERVICE_URL}/v1/phase3/webhook/elevenlabs`.
5. Configure Twilio number's status callback → `${AI_SERVICE_URL}/v1/phase3/webhook/twilio`.

## ElevenLabs agent system prompt (template)

```
You are an AI assistant placing brief outbound calls to food pantries on behalf of a user. Your goals:

1. Open with: "Hi, this is an AI assistant calling on behalf of someone looking for food pantry information. Is now an okay time for a 1-minute call?" If they say no, thank them and end the call.
2. If they say yes, ask the questions in order. For each question, wait for their full answer before moving on. Be polite, brisk, and don't repeat yourself.
3. Questions to ask (you will receive them in dynamic context):
   - Are you open today, and until what time?
   - Do you have any of the following items available right now: {NEEDED_ITEMS}?
   - Is there anything someone needs to bring (ID, proof of address, etc.)?
4. End with: "Thank you so much for your time. Have a great day."
5. NEVER pretend to be a human. If asked, confirm you are an AI assistant.
6. If the line is busy, an automated menu, or voicemail, politely end the call without leaving a message.
7. Total call duration must be under 90 seconds. If you've been on the call for 75 seconds, wrap up politely.
```

Dynamic variables passed per call: `{NEEDED_ITEMS}` (comma-separated), `{PANTRY_NAME}`, `{LANGUAGE_HINT}` (default English).

## Implementation sketch

```python
# services/ai/app/agents/caller.py
async def start_phase3(req: Phase3Request) -> Phase3Response:
    if settings.PHASE_3_STUB:
        asyncio.create_task(emit_stub_events(req))
        return Phase3Response(job_id=req.job_id, accepted=len(req.pantries))

    # Ethics gate
    fallback = settings.DEMO_FALLBACK_PHONES_LIST
    allow_real = settings.ALLOW_REAL_PANTRY_CALLS
    safe = []
    for i, p in enumerate(req.pantries):
        dial = (fallback[i % len(fallback)]
                if fallback else (p.phone if allow_real else None))
        if not dial:
            await write_event(req.job_id, p.item_id, "item_finished",
                              {"itemId": p.item_id, "status": "failed", "error": "no_safe_phone"})
            await sheets.update_row(req.sheet_tab_id, p.id, status="skipped",
                                    notes="No safe phone for demo")
            continue
        safe.append(p.copy(update={"dial_number": dial}))

    await mongo.call_jobs.update_one({"_id": ObjectId(req.job_id)},
                                     {"$set": {"status": "running"}})

    asyncio.gather(*[
        start_one_call(req.job_id, req.sheet_tab_id, p, req.questions, req.needed_items)
        for p in safe
    ], return_exceptions=True)
    return Phase3Response(job_id=req.job_id, accepted=len(safe))


async def start_one_call(job_id, sheet_tab_id, pantry, questions, needed_items):
    await mark_item(job_id, pantry.item_id, status="dialing")
    await write_event(job_id, pantry.item_id, "item_started",
                      {"itemId": pantry.item_id, "pantryId": pantry.id})
    await sheets.append_row(sheet_tab_id, pantry, status="dialing")

    signed_url = await elevenlabs.create_signed_agent_url(
        agent_id=settings.ELEVENLABS_AGENT_ID,
        dynamic_vars={
            "NEEDED_ITEMS": ", ".join(needed_items) or "any non-perishable food",
            "PANTRY_NAME": pantry.name,
            "QUESTIONS": "\n- " + "\n- ".join(questions),
        },
        metadata={"job_id": job_id, "item_id": pantry.item_id, "sheet_tab_id": sheet_tab_id},
    )

    twiml = f"""
        <Response>
          <Connect>
            <Stream url="{signed_url}" />
          </Connect>
        </Response>
    """
    await twilio.calls.create(
        to=pantry.dial_number,
        from_=settings.TWILIO_FROM_NUMBER,
        twiml=twiml,
        status_callback=f"{settings.PUBLIC_URL}/v1/phase3/webhook/twilio?item_id={pantry.item_id}",
        status_callback_event=["initiated","ringing","answered","completed"],
    )
```

The webhooks then drive the rest:

- **Twilio webhook** (`call_status`): on `answered` → mark item `in_progress`, update Sheet status; on `completed` → mark `done` (or `failed`), set `endedAt`.
- **ElevenLabs webhook** (`agent_response_delta`, `user_transcript`): for each transcript chunk, write a `call_events` row of kind `transcript_chunk` with role `agent` or `pantry`. Sheets are NOT updated per chunk (too noisy).
- **ElevenLabs webhook** (`conversation_ended`): summarize the full transcript via a Gemini structured output call (schema below). Update `call_jobs.items[]` entry's `structured`. Update the Sheet row with `Open Until`, `Has Items`, `Missing Items`, `Requirements`, `Notes`. Write `item_finished` event. When all items finished, write `job_finished` event with `summary` (incl. `planSuggestionPantryIds` = top 3 by "open AND has at least one needed item").

## Summarization schema (Gemini `responseSchema`)

```python
PHASE3_SUMMARY_SCHEMA = {
  "type": "object",
  "required": ["status"],
  "properties": {
    "open_until":    {"type": "string"},
    "has_items":     {"type": "array", "items": {"type": "string"}},
    "missing_items": {"type": "array", "items": {"type": "string"}},
    "requirements":  {"type": "array", "items": {"type": "string"}},
    "notes":         {"type": "string"},
    "status":        {"type": "string", "enum": ["reached","voicemail","no_answer","busy","refused","other"]}
  }
}
```

## Streaming to the browser

The Next.js SSE Route Handler subscribes to a Mongo change stream:

```ts
const stream = db.collection('call_events').watch(
  [{ $match: { 'fullDocument.jobId': new ObjectId(jobId) } }],
  { fullDocument: 'updateLookup' }
);
for await (const change of stream) {
  if (change.operationType !== 'insert') continue;
  const doc = change.fullDocument;
  controller.enqueue(`data: ${JSON.stringify({ kind: doc.kind, ...doc.payload })}\n\n`);
  if (doc.kind === 'job_finished') break;
}
```

## Sheets writer wiring

The Sheets client maintains an in-process `pantryId → rowIndex` map per job for low-latency updates. On Render restart this map is lost; recover via a one-time scan of the tab's column B (which holds `pantryId` for lookup).

```python
# services/ai/app/integrations/sheets_client.py
HEADERS = ["Pantry Name", "Phone", "Status", "Open Until", "Has Items",
           "Missing Items", "Requirements", "Notes", "Audio URL"]

async def create_job_tab(job_id: str) -> tuple[int, str]:
    short = job_id[:8]
    sheet = await sheets.spreadsheets().batchUpdate(
        spreadsheetId=settings.SHEETS_SPREADSHEET_ID,
        body={"requests": [{"addSheet": {"properties": {"title": f"job-{short}"}}}]}
    ).execute()
    tab_id = sheet["replies"][0]["addSheet"]["properties"]["sheetId"]
    await write_header_row(tab_id)
    sheet_url = f"https://docs.google.com/spreadsheets/d/{settings.SHEETS_SPREADSHEET_ID}/edit#gid={tab_id}"
    return tab_id, sheet_url

async def append_row(tab_id: int, pantry, status: str):
    row = [pantry.name, mask_phone(pantry.phone), status, "", "", "", "", "", ""]
    # ...append via values.append
async def update_row(tab_id: int, pantry_id: str, **fields):
    # find row by pantry_id (in hidden column J), update via values.update
```

If `SHEETS_STUB=true` or any call errors → log warning, continue. Sheets is a best-effort mirror of the dashboard data.

## Acceptance tests

- `test_ethics_gate_blocks_real_phone_when_no_allowlist`.
- `test_first_sentence_identifies_as_ai` (snapshot of agent prompt or a recorded fake call).
- `test_max_5_parallel`.
- `test_call_summary_schema_valid`.
- `test_stub_mode_emits_progressive_events` — with `PHASE_3_STUB=true`, the events fixture (`stubs/phase3_events.py`) emits item_started → 6× transcript_chunk → item_finished over ~30s for each pantry, AND appends rows to a stub sheet (or no-ops with `SHEETS_STUB=true`).
- `test_sheets_row_index_recovery` — after process restart, updates still find the right row by pantry_id.

## Stub event emitter (`services/ai/app/stubs/phase3_events.py`)

A small async coroutine that, for each pantry, sleeps and writes 8 fake `call_events` over 30s. Lets Howie/Jam build the full dashboard UI without any real calls.

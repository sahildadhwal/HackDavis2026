# Risks & Fallbacks

> Mirror: [`docs/agent/02-conventions.md#fallback-rules`](../agent/02-conventions.md#fallback-rules). Sync index: [`docs/SYNC.md`](../SYNC.md).

## Top risks (in order of likelihood)

### 1. ElevenLabs / Twilio outbound calling won't work on time

**Why:** outbound voice agents are the most failure-prone piece. Twilio account verification can take time, ElevenLabs Conversational AI quotas may need approval, and audio plumbing is fiddly.

**Detection:** at **T+14**, if we don't have one real outbound call working end-to-end, escalate.

**Fallback ladder (apply in order):**
1. Drop parallel — call 2 pantries sequentially (still demos the idea).
2. Drop live transcript streaming — show the transcript only after the call completes.
3. Replace live call with a **pre-recorded** call we made earlier today, played back as if live; pre-fill the Google Sheet with the recorded results so the Sheet still updates "live".
4. Show a static "what this would look like" mock screen with a voiceover in the demo video.

### 2. <a id="pantry-data-blocked"></a>Google Places billing card requirement blocks us

**Why:** Google requires a credit card to enable Places API even on the free tier.

**Detection:** at **T+1**, if no one on the team is willing to attach a card.

**Fallback:**
- Use **Mapbox Geocoding + a curated 30-pantry seed dataset** for the demo city, loaded directly into MongoDB. Sahil generates this with a single Gemini call from public data; Aryan loads it. Demo still works; Phase 2 just queries Mongo geospatially against the seed set instead of Google.

### 3. Backboard SDK shape doesn't match our assumptions

**Why:** we're assuming `memory.upsert(userId, kind, payload)` / `memory.search(userId, query, kinds, limit)` based on Jay's brief. The actual SDK may be different.

**Detection:** at **T+1**, Sahil writes a 5-line smoke test that actually stores and retrieves a memory. If the API is different, update [`docs/agent/05-backend-spec.md#backboard-memory`](../agent/05-backend-spec.md#backboard-memory) and the Phase 1 spec immediately, both human + agent mirrors.

**Fallback:**
- If Backboard is unreachable or unstable, use a **`user_memory` collection in MongoDB** with the same conceptual API (kind, payload). Lose the smart retrieval but keep personalization.
- If even that's too much: hardcode "no diet, family of 2, no excluded items" and skip step 2's "remembered staples" prefill. Recipes still work, just not personalized — drop expiry-aware ranking too.

### 4. Gemini VLM misreads fridge contents

**Why:** vision models are good but not perfect; weird angles, glare, opaque containers will trip them up.

**Fallback:**
- Allow user to **edit the ingredient list** before generating recipes (this is the staples step's UX twin — ship both together in Block B).
- Provide a "Use sample fridge" button that runs the demo on a known-good test image. Critical for the demo so we can recover if the live photo fails.
- If Gemini quotas hit, swap the vision call to OpenAI GPT-4o vision behind the same Python interface. The Phase 1 spec describes this as a swap, not a rewrite.

### 5. MongoDB geospatial queries return nothing

**Why:** missing `2dsphere` index, wrong coordinate order (`[lng, lat]` vs `[lat, lng]`), or stored coordinates as numbers instead of GeoJSON `{type:"Point", coordinates:[lng,lat]}`.

**Mitigation:**
- Aryan writes a smoke test in Block A that inserts one pantry and queries it via `$near`. Catch it in the first hour.
- Always store coordinates as GeoJSON `Point`. The schema spec in [`agent/05-backend-spec.md`](../agent/05-backend-spec.md#mongo-collections) is explicit about this; agents must not deviate.

### 6. Google Sheets API rate-limits or auth fails mid-demo

**Why:** the service account may not be invited to the spreadsheet, or we exceed quotas under load.

**Mitigation:**
- Pre-create the Sheet template in Block A; share with the service account email; capture the spreadsheet ID in env.
- Each new call job copies (or creates) a sheet within the same spreadsheet — one tab per job.
- If Sheets fails, the dashboard still works (it reads from Mongo change streams). Mark Sheets as best-effort in code.

### 7. Single point of failure: Sahil

**Why:** Sahil owns all 3 AI phases. If he gets stuck or sleep-deprived, the demo collapses.

**Mitigation:**
- Aryan is the backup on every phase. Aryan reviews Phase 1 end-of-Block-B, Phase 2 end-of-Block-C, and pairs on Phase 3 in Block D.
- Each phase has a "**stub-mode**" env flag (`PHASE_1_STUB=true` etc.) that returns canned responses. Frontend never knows the difference. See [`docs/agent/02-conventions.md`](../agent/02-conventions.md#stub-mode).

### 8. Mobile Safari quirks

**Why:** judges will likely open it on iPhone. Safari hates: large image uploads, getUserMedia without HTTPS, autoplay audio.

**Mitigation:**
- Test on a real iPhone at end of Block C and Block D.
- Always ship over HTTPS (Vercel handles this).
- Audio playback in the call dashboard requires user gesture — gate it behind a play button.

## <a id="ethical-call-policy"></a>Ethical call policy

We are an AI calling real businesses. We must:

- **Never auto-dial real pantries during dev or demo.** Use Twilio test numbers we own.
- For the live demo, our "pantries" are 3 of our own phones (or Twilio numbers), each running a script that simulates a pantry receptionist. This still exercises the full pipeline and looks real to judges.
- The agent must **identify itself as an AI** in the first sentence of every call. ElevenLabs prompt enforces this.
- Submit project with a `README` note acknowledging this and proposing real-world consent flow (pantries opt in to receive AI inquiries) as future work.

## Demo-day backup plan

- **Primary:** live demo on judge's phone via deployed URL, judge-facing Google Sheet projected on the room screen.
- **Backup 1:** live demo on our own laptop on tethered hotspot (no conference Wi-Fi dependency).
- **Backup 2:** pre-recorded 90-sec demo video on a USB stick.
- **Backup 3:** screenshots in slides.

Always have all four ready.

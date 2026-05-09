# Food Pantry App — Human Docs

> Mirror: [`docs/agent/README.md`](../agent/README.md). Sync index: [`docs/SYNC.md`](../SYNC.md).

A 20-hour hackathon project. We help people who are food-insecure (or just curious) **see what's in their fridge, get recipe ideas that prioritize ingredients about to expire, find nearby food pantries on a map, let an AI voice swarm call them in parallel to ask what's in stock, and then get a routed plan of where to go**.

## The 30-second pitch

> "Snap your fridge. Our AI lists what's in there, you add the staples you already have at home (flour, salt, oil), and we suggest 3 recipes that use up your soonest-to-expire ingredients first — tuned to your dietary restrictions and family size, which we remember between visits. If you're missing items, our agent finds the nearest food pantries on a map. Tap one button and an AI voice swarm calls them all at once asking 'do you have X, are you open, do I need ID' — answers stream live into a Google Sheet AND a dashboard. Then we hand you a final routed plan: which pantries to visit, in what order, with the fastest path on the map."

## The 7-step user flow (Sahil's spec)

1. User snaps a fridge photo → AI extracts ingredients (Gemini VLM).
2. User adds pantry staples they already have (flour, salt, oil, etc.) — chip input, persisted to memory.
3. AI suggests 3 meals + identifies missing ingredients (Backboard memory: diet, family size, prior pantry visits, expiry-aware ranking).
4. AI searches for nearby food pantries with phone numbers (Google Places + MongoDB Atlas geospatial cache).
5. Voice agent swarm calls them simultaneously (Twilio + ElevenLabs Conversational AI, up to 5 in parallel).
6. Results stream into Google Sheets in real-time (and a live dashboard).
7. User sees a final plan: where to go, what's there, mapped route (Mapbox Directions API).

## The team

| Name | Role | Owns |
|---|---|---|
| **Howie** | Frontend | Map UI, pantry detail panel, voice-call dashboard, **final plan / route view** |
| **Jam** | Frontend | Camera/upload UI, ingredients + **staples chip input**, recipe view, design system |
| **Aryan** | Backend | API, MongoDB Atlas schema, Backboard client, Sheets writer, integration glue, deployment |
| **Sahil** | AI (3 phases) | Phase 1 (Gemini vision + Backboard-aware recipes), Phase 2 (pantry locator), Phase 3 (Twilio + ElevenLabs voice swarm) |

## Doc map (this folder)

- [`01-plan.md`](./01-plan.md) — 7-step flow, 20-hour plan, ownership matrix, hour-by-hour timeline, MVP cuts.
- [`02-tech-decisions.md`](./02-tech-decisions.md) — stack rationale: why Gemini, why Backboard, why MongoDB, why Sheets, the map choice.
- [`03-status.md`](./03-status.md) — live checklist. Update at every standup.
- [`04-risks.md`](./04-risks.md) — what can break, fallback plans, demo backup, ethical call policy.

## Doc map (the AI side)

If you want the precise specs an AI coding agent will read, see [`docs/agent/`](../agent/). Pairs are listed in [`docs/SYNC.md`](../SYNC.md).

## Standup cadence

Every 4 hours: 5-minute standup. Each person says (1) what shipped, (2) what's blocking, (3) next 4-hour goal. Update [`03-status.md`](./03-status.md) before standing up.

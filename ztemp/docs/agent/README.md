# Agent Docs — Food Pantry App

> Mirror: [`docs/human/README.md`](../human/README.md). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **You are an AI coding agent.** Read this folder, not `human/`. The human folder is narrative; this folder is spec.

## Reading order

1. [`01-architecture.md`](./01-architecture.md) — system shape, repo layout, data flow.
2. [`02-conventions.md`](./02-conventions.md) — code style, env vars, fallback rules. **Read before writing any code.**
3. [`03-api-contracts.md`](./03-api-contracts.md) — every HTTP/SSE endpoint, request/response schemas.
4. [`04-frontend-spec.md`](./04-frontend-spec.md) — Next.js routes, components, state.
5. [`05-backend-spec.md`](./05-backend-spec.md) — Next.js Route Handlers and Python AI service endpoints.
6. [`06-phase1-fridge-vision.md`](./06-phase1-fridge-vision.md) — vision → ingredients → recipes.
7. [`07-phase2-pantry-locator.md`](./07-phase2-pantry-locator.md) — agent that finds pantries.
8. [`08-phase3-voice-calls.md`](./08-phase3-voice-calls.md) — ElevenLabs + Twilio fan-out.
9. [`09-tasks.md`](./09-tasks.md) — actionable tasks per teammate per block.

## Hard rules for agents

- **Do not invent endpoints, schemas, env var names, or file paths.** They are listed in [`03-api-contracts.md`](./03-api-contracts.md), [`02-conventions.md`](./02-conventions.md), and [`01-architecture.md`](./01-architecture.md). If something is missing, **ask** rather than guess.
- **Honor stub mode.** If a `*_STUB=true` flag is set, the corresponding endpoint/subsystem must return canned data without calling external APIs. See [`02-conventions.md#stub-mode`](./02-conventions.md#stub-mode).
- **Never write API keys to logs, repo, or client bundles.** All secrets are server-side only. Mapbox public token is the only exception.
- **One PR = one concern.** Don't pile Phase 1, Phase 2, and a UI refactor into one diff.
- **When you change behavior, update the matching human doc** in `docs/human/`. The mirror map is in [`docs/SYNC.md`](../SYNC.md).
- **MongoDB:** all coordinates are GeoJSON `Point` with `[lng, lat]` (longitude first). Never `{lat, lng}` numbers.
- **Backboard:** all reads/writes scoped to `userId = sessionId`. Use only the documented `kind` values in [`02-conventions.md`](./02-conventions.md#backboard-conventions).
- **Sheets writes are best-effort.** Never block the dashboard on a Sheets failure.

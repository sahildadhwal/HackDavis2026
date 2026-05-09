# Frontend Spec

> Mirror summary in [`docs/human/02-tech-decisions.md#frontend`](../human/02-tech-decisions.md#frontend). Sync index: [`docs/SYNC.md`](../SYNC.md).
>
> **Owners:** Howie, Jam.

## Stack

- Next.js 15, App Router, TypeScript strict.
- Tailwind v4, shadcn/ui (use `pnpm dlx shadcn@latest add <component>` as needed).
- `react-map-gl` v7 + `mapbox-gl` v3.
- **MongoDB change streams** consumed server-side; the browser sees only SSE.
- `zod` shared schemas from `lib/schemas.ts`.
- `lucide-react` for icons.
- `framer-motion` only if time permits.

## Routes

| Path | Purpose | Server/Client |
|---|---|---|
| `/` | Landing, "Scan your fridge" CTA, link to map | Server |
| `/scan` | Inline 3-step flow: upload → ingredients + staples → 3 recipes | Client (camera) |
| `/map` | Pantry map with side panel + "Call selected" button | Client (map) |
| `/calls/[jobId]` | Live voice call dashboard (mirrors a public Google Sheet) | Client (SSE) |
| `/plan/[planId]` | Final plan + mapped route + "Open in Maps" | Client (map) |

Layout: shared header with logo, "Scan", "Map", session badge, "Sheets" link (when a job is in flight).

## Components

### `<MapView>` — `components/map/MapView.tsx`

Props:
```ts
type Props = {
  pantries: Pantry[];
  initialCenter: { lat: number; lng: number };
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onPantryClick: (id: string) => void;
  routeGeoJSON?: GeoJSON.LineString;   // when present, draws the route (used in /plan)
  numberedStops?: { lat: number; lng: number; order: number }[];
};
```

Behavior:
- Mapbox Streets style v12. Token from `NEXT_PUBLIC_MAPBOX_TOKEN`.
- Cluster markers via `useSupercluster` hook (`components/map/useSupercluster.ts`).
- Single marker: pantry icon, color = green if `openNow`, gray otherwise.
- Cluster marker: circle with count.
- Click marker → fires `onPantryClick(id)`.
- Multi-select: ⌘/Ctrl-click adds to selection; otherwise replaces.
- Geolocation button (top-right) recenters to user.
- When `routeGeoJSON` is provided: draws a single `Source` + `Layer` line with stops as numbered circle markers.

### `<PantryPanel>` — `components/map/PantryPanel.tsx`

Slide-in side panel (mobile = bottom sheet) that shows the clicked pantry. Fetches `GET /api/pantries/:id`. Includes:
- Name, address, distance, openNow badge, hours table.
- Phone (`tel:` link).
- "Add to call list" button (toggles selection).
- Recent call notes (if any).

### `<CallStartBar>` — `components/calls/CallStartBar.tsx`

Sticky bar at bottom of `/map` showing selected pantries (chip list) + a "Call these N pantries" button. Disabled until 1+ selected. Click → confirmation modal → `POST /api/calls/start` → router push to `/calls/[jobId]`.

### `<FridgeUploader>` — `components/fridge/FridgeUploader.tsx`

- Drag-drop or `<input type="file" accept="image/*" capture="environment">`.
- Image client-side compressed to ≤2MB, ≤2048px long edge using `browser-image-compression` if size exceeds.
- Preview thumbnail.
- Triggers `POST /api/fridge/scan` (vision only).

### `<IngredientsEditor>` — `components/fridge/IngredientsEditor.tsx`

After vision returns, show ingredients as editable chips:
- Each chip has the ingredient name, optional qty, and a small expiry badge ("3d") derived from `estimatedExpiryDays`.
- Add via input field.
- Remove via chip "x".

### `<StaplesInput>` — `components/fridge/StaplesInput.tsx` ✱ new in rev2

Below the ingredients editor.
- Heading "What pantry staples do you already have?" with helper "(flour, salt, oil, etc.)"
- Chip multi-select with **prefilled defaults** from `GET /api/memory/staples` (server reads Backboard).
- Suggestions row of 12 common staples (`salt, pepper, sugar, flour, olive oil, vegetable oil, butter, garlic, onion, rice, pasta, canned beans`) — click to add.
- Free-text input to add arbitrary items.
- On change: PATCH-style debounced `PUT /api/memory/staples` so the user's set persists across sessions automatically.

### `<RecipesPanel>` — `components/fridge/RecipesPanel.tsx`

"Generate recipes" button below `<StaplesInput>`. Disables while loading. Posts to `POST /api/fridge/recipes` with `{scanId, ingredients, staples}`. Renders 3 `<RecipeCard>`s.

### `<RecipeCard>` — `components/fridge/RecipeCard.tsx`

- Title, time, servings.
- "Used" ingredients (green chips) and "Missing" ingredients (red chips).
- A small "uses up soon-to-expire X" badge if `expiryUrgencyScore > 0.6`.
- Expandable steps.
- "Find missing items" button → router push to `/map?need=<csv>` with the missing items pre-filled.

### `<PreferencesForm>` — `components/fridge/PreferencesForm.tsx`

Optional disclosure under `<StaplesInput>`. Fields:
- Cuisine: chip multi-select.
- Diet: checkbox group.
- Family size: stepper (1–8).
- Excluded ingredients: comma-separated.

On change: `PUT /api/memory/preferences`. Persisted via Backboard.

### `<CallDashboard>` — `components/calls/CallDashboard.tsx`

Two columns (mobile: tabs):
- Left: list of call items with live status badge (`queued` → `dialing` → `in-progress` → `done`/`failed`), duration timer.
- Right: selected item's transcript stream, role-tagged bubbles (`agent` blue, `pantry` neutral), structured summary card on completion, audio playback (gated by user gesture).
- Footer: aggregate summary card on `job_finished` PLUS a prominent **"Build my plan"** button → router push to a stub plan flow that calls `POST /api/plan/build`.
- Top-right: "Open Sheet" button (`sheetUrl` from the start response) — opens the live Google Sheet in a new tab.

SSE consumption: `new EventSource(`/api/calls/${jobId}/stream`)`. On message JSON, dispatch to a reducer (`useReducer` over `CallJobState`).

### <a id="plan-view"></a>`<PlanView>` — `components/plan/PlanView.tsx` ✱ new in rev2

Lives at `/plan/[planId]`. Two sections:
- **Top:** the map (uses `<MapView>` with `routeGeoJSON` + numbered stops).
- **Bottom:** ordered stop list. Each stop card shows:
  - Order number, pantry name, address, ETA, leg distance.
  - Pulled-forward Phase 3 results: `Open until`, `Has items`, `Requirements`, `Notes`.
  - "Call" button (`tel:` link to the real pantry number).
  - "Open in Apple Maps" / "Open in Google Maps" buttons.
- **Header CTA:** "Open all stops in Google Maps" with the multi-stop URL.

### `<StopPicker>` (modal triggered from CallDashboard)

Lets the user pick which 1–3 pantries from the completed call results to actually visit. Default selection: pantries where `structured.openUntil` exists AND `hasItems` overlaps with `neededItems`. On confirm: `POST /api/plan/build` then navigate to `/plan/[planId]`.

## State management

- Local component state + `useReducer` for the call dashboard.
- No Redux/Zustand. Keep it small.
- Server-fetched data via `fetch` in client components or React Server Components for `/`. No `react-query`.

## Map seed center

If geolocation denied: center on demo city coords from `lib/config.ts` (`DEMO_CITY_CENTER`). Set in Block A.

## Performance budget

- LCP < 2.5s on 4G mobile.
- Bundle: only ship `mapbox-gl` on `/map` and `/plan` (lazy via `dynamic(() => import(...), { ssr: false })`).
- No heavy fonts; system font stack.

## Accessibility minimums

- All interactive elements keyboard reachable.
- Status badges have `aria-label`.
- Audio playback control has visible label.
- Map: provide a "List view" toggle that renders the same pantries as a `<ul>` for screen-reader users.
- Plan view stops are a semantic `<ol>`, not `<div>`s.

## Empty / loading / error states

Every fetch must render all four states explicitly: idle, loading (skeleton), error (shadcn `Alert` with retry), success. No silent failures.

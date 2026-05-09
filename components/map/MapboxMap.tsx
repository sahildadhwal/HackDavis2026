"use client";

import Map from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";

const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/** Default: continental US; swap for your demo city. */
const INITIAL_VIEW = {
  longitude: -98.5795,
  latitude: 39.8283,
  zoom: 3.2,
} as const;

export function MapboxMap() {
  if (!token) {
    return (
      <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 bg-neutral-100 p-6 text-center">
        <p className="font-medium text-neutral-800">Mapbox token missing</p>
        <p className="max-w-md text-sm text-neutral-600">
          Create{" "}
          <code className="rounded bg-white px-1.5 py-0.5 text-xs">
            .env.local
          </code>{" "}
          in the project root with:
        </p>
        <pre className="rounded-lg bg-white p-4 text-left text-xs text-neutral-800 shadow-sm">
          {`NEXT_PUBLIC_MAPBOX_TOKEN=pk.your_token_here`}
        </pre>
        <p className="text-xs text-neutral-500">
          Copy the default public token from{" "}
          <span className="text-neutral-700">console.mapbox.com</span> →
          Account → Tokens.
        </p>
      </div>
    );
  }

  return (
    <Map
      mapboxAccessToken={token}
      initialViewState={INITIAL_VIEW}
      style={{ width: "100%", height: "100%" }}
      mapStyle="mapbox://styles/mapbox/streets-v12"
    />
  );
}

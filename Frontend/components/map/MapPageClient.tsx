"use client";

import dynamic from "next/dynamic";

const MapboxMap = dynamic(
  () => import("@/components/map/MapboxMap").then((m) => m.MapboxMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[min(70vh,560px)] items-center justify-center bg-neutral-100 text-neutral-500">
        Loading map…
      </div>
    ),
  },
);

export function MapPageClient() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Pantry map</h1>
        <p className="text-sm text-neutral-600">
          Basemap only — markers and pantry data come next.
        </p>
      </header>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <MapboxMap />
        </div>
      </div>
    </div>
  );
}

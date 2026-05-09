import Map from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";

const token = import.meta.env.VITE_MAPBOX_TOKEN;

const INITIAL_VIEW = {
  longitude: -98.5795,
  latitude: 39.8283,
  zoom: 3.2,
} as const;

export function MapView() {
  if (!token) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-neutral-100 p-8 text-center">
        <p className="font-medium text-neutral-800">Missing Mapbox token</p>
        <p className="max-w-md text-sm text-neutral-600">
          Add{" "}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
            VITE_MAPBOX_TOKEN
          </code>{" "}
          to{" "}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
            frontend/.env.local
          </code>
          :
        </p>
        <pre className="rounded-lg bg-white p-4 text-left font-mono text-xs text-neutral-800 shadow-sm">
          VITE_MAPBOX_TOKEN=pk.your_token_here
        </pre>
        <p className="max-w-sm text-xs text-neutral-500">
          Use the default public token from mapbox.com (starts with{" "}
          <span className="font-mono">pk.</span>).
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

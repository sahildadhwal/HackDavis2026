import { MapView } from "./components/MapView";

function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-neutral-50">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-neutral-900">Food Pantry</h1>
        <p className="text-sm text-neutral-600">
          Mapbox GL JS via react-map-gl — add pantries as markers next.
        </p>
      </header>
      <div className="relative min-h-[min(70vh,560px)] flex-1">
        <div className="absolute inset-0">
          <MapView />
        </div>
      </div>
    </div>
  );
}

export default App;

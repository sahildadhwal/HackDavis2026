"use client";

import Map, { Marker, Popup } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { useState, useMemo } from "react";

const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

interface Pantry {
  name: string;
  address: string;
  phone: string;
  hours?: string;
  lat?: number;
  lng?: number;
}

interface PantryMapProps {
  pantries: Pantry[];
}

export function PantryMap({ pantries }: PantryMapProps) {
  const [popupIdx, setPopupIdx] = useState<number | null>(null);

  const validPantries = useMemo(
    () => pantries.filter((p) => p.lat && p.lng),
    [pantries]
  );

  const center = useMemo(() => {
    if (validPantries.length === 0) return { lat: 38.5449, lng: -121.7405 };
    const avgLat = validPantries.reduce((s, p) => s + (p.lat || 0), 0) / validPantries.length;
    const avgLng = validPantries.reduce((s, p) => s + (p.lng || 0), 0) / validPantries.length;
    return { lat: avgLat, lng: avgLng };
  }, [validPantries]);

  if (!token) {
    return (
      <div className="flex h-48 items-center justify-center bg-neutral-100 text-neutral-500 text-sm p-4 text-center">
        Add <code className="bg-white px-1.5 py-0.5 rounded text-xs mx-1">NEXT_PUBLIC_MAPBOX_TOKEN</code> to <code className="bg-white px-1.5 py-0.5 rounded text-xs mx-1">.env.local</code> for the map
      </div>
    );
  }

  if (validPantries.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center bg-neutral-100 text-neutral-500 text-sm">
        No pantry coordinates available for map
      </div>
    );
  }

  return (
    <div className="h-64">
      <Map
        mapboxAccessToken={token}
        initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 11 }}
        style={{ width: "100%", height: "100%" }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
      >
        {validPantries.map((p, i) => (
          <Marker key={i} longitude={p.lng!} latitude={p.lat!} anchor="bottom" onClick={(e) => { e.originalEvent.stopPropagation(); setPopupIdx(i); }}>
            <div className="text-2xl cursor-pointer hover:scale-110 transition-transform">📍</div>
          </Marker>
        ))}
        {popupIdx !== null && validPantries[popupIdx] && (
          <Popup
            longitude={validPantries[popupIdx].lng!}
            latitude={validPantries[popupIdx].lat!}
            anchor="top"
            onClose={() => setPopupIdx(null)}
            closeOnClick={false}
          >
            <div className="p-1">
              <div className="font-bold text-sm">{validPantries[popupIdx].name}</div>
              <div className="text-xs text-neutral-500">{validPantries[popupIdx].address}</div>
              <div className="text-xs text-green-600">{validPantries[popupIdx].phone}</div>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}

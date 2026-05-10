"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

const PantryMap = dynamic(
  () => import("@/components/map/PantryMap").then((m) => m.PantryMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center bg-neutral-100 text-neutral-500 rounded-xl">
        Loading map…
      </div>
    ),
  },
);

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const STAPLES = [
  "flour",
  "sugar",
  "salt",
  "pepper",
  "butter",
  "olive oil",
  "garlic",
  "onion",
  "rice",
  "pasta",
  "baking soda",
  "vanilla extract",
  "soy sauce",
  "vinegar",
];
const TOTAL_STEPS = 5;

interface Meal {
  name: string;
  description: string;
  have: string[];
  missing: string[];
  difficulty: string;
  time_minutes: number;
  personalized_reason?: string | null;
}

interface Pantry {
  name: string;
  address: string;
  phone: string;
  hours?: string;
  notes?: string;
  lat?: number;
  lng?: number;
}

interface CallStatus {
  type?: string;
  call_id?: string;
  pantry?: string;
  status?: string;
  message?: string;
  error?: string;
  results?: {
    available?: string[];
    unavailable?: string[];
    substitutions?: Record<string, string>;
    rejected?: boolean;
  };
}

interface RecipeDetail {
  steps: string[];
  tips: string[];
  servings: string;
}

interface Plan {
  plan: {
    pantry_name: string;
    address: string;
    items_to_get: string[];
    visit_order: number;
  }[];
  still_missing: string[];
  recipe_modifications: string;
  summary: string;
}

export function FridgeBridge() {
  const [step, setStep] = useState(0);
  const [sessionId, setSessionId] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [newIngredient, setNewIngredient] = useState("");
  const [addedStaples, setAddedStaples] = useState<Set<string>>(new Set());
  const [meals, setMeals] = useState<Meal[]>([]);
  const [selectedMeal, setSelectedMeal] = useState<number | null>(null);
  const [specificRequest, setSpecificRequest] = useState("");
  const [location, setLocation] = useState("95616");
  const [pantries, setPantries] = useState<Pantry[]>([]);
  const [selectedPantries, setSelectedPantries] = useState<Set<number>>(
    new Set(),
  );
  const [callStatuses, setCallStatuses] = useState<Record<string, CallStatus>>(
    {},
  );
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState("");
  const [viewingMealIdx, setViewingMealIdx] = useState<number | null>(null);
  const [recipeDetail, setRecipeDetail] = useState<RecipeDetail | null>(null);
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [userCoords, setUserCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [userId, setUserId] = useState("");
  const [memories, setMemories] = useState<string[]>([]);
  const [personalized, setPersonalized] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const geoInitiatedRef = useRef(false);

  // Generate or restore userId
  useEffect(() => {
    let id = localStorage.getItem("fb_user_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("fb_user_id", id);
    }
    setUserId(id);
  }, []);

  // Poll memory when we have a userId
  useEffect(() => {
    if (!userId) return;
    const fetchMemory = async () => {
      try {
        const res = await fetch(`${API}/api/memory/${userId}`);
        const data = await res.json();
        setMemories(data.memories || []);
      } catch {
        /* ignore */
      }
    };
    fetchMemory();
    const interval = setInterval(fetchMemory, 8000);
    return () => clearInterval(interval);
  }, [userId]);

  const rememberRecipe = (mealIdx: number) => {
    if (!userId || mealIdx === null) return;
    const meal = meals[mealIdx];
    if (!meal) return;
    const have = meal.have?.join(", ") || "none";
    const missing = meal.missing?.join(", ") || "none";
    const event = `The user chose to cook "${meal.name}" (${meal.difficulty ?? "unknown"} difficulty, ~${meal.time_minutes ?? "?"} min). They already have: ${have}. They still need: ${missing}.`;
    fetch(`${API}/api/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, event }),
    }).catch(() => {});
  };

  // WebSocket connection
  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/${sessionId}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setCallStatuses((prev: Record<string, CallStatus>) => {
        const key = data.pantry || data.call_id;
        return { ...prev, [key]: { ...(prev[key] || {}), ...data } };
      });
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  // Auto-geolocate when entering the pantries step
  useEffect(() => {
    if (
      step !== 2 ||
      pantries.length > 0 ||
      geoInitiatedRef.current ||
      locationDenied
    )
      return;
    if (!navigator.geolocation) {
      setLocationDenied(true);
      return;
    }
    geoInitiatedRef.current = true;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setUserCoords({ lat: latitude, lng: longitude });
        let loc = `${latitude},${longitude}`;
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
          );
          const d = await r.json();
          const city =
            d.address?.city || d.address?.town || d.address?.village || "";
          const state = d.address?.state_code || d.address?.state || "";
          if (city) loc = `${city}, ${state}`;
        } catch {
          /* use coords fallback */
        }
        setLocation(loc);
        setLocating(false);
        findPantries(loc);
      },
      () => {
        setLocating(false);
        setLocationDenied(true);
        findPantries("95616");
      },
    );
  }, [step, pantries.length, locationDenied]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const analyzeFridge = async () => {
    if (!image) return;
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("image", image);
      const res = await fetch(`${API}/api/analyze-fridge`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setSessionId(data.session_id);
      setIngredients(data.ingredients);
      setStep(1);
    } catch {
      setError("Failed to analyze image. Is the backend running?");
    }
    setLoading(false);
  };

  const addIngredient = () => {
    const trimmed = newIngredient.trim().toLowerCase();
    if (trimmed && !ingredients.includes(trimmed)) {
      setIngredients([...ingredients, trimmed]);
      setNewIngredient("");
    }
  };

  const removeIngredient = (item: string) => {
    setIngredients(ingredients.filter((i) => i !== item));
    setAddedStaples((prev) => {
      const n = new Set(prev);
      n.delete(item);
      return n;
    });
  };

  const toggleStaple = (staple: string) => {
    if (addedStaples.has(staple)) {
      setAddedStaples((prev) => {
        const n = new Set(prev);
        n.delete(staple);
        return n;
      });
      setIngredients(ingredients.filter((i) => i !== staple));
    } else {
      setAddedStaples((prev) => new Set(prev).add(staple));
      if (!ingredients.includes(staple))
        setIngredients([...ingredients, staple]);
    }
  };

  const suggestMeals = useCallback(async () => {
    if (ingredients.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/suggest-meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          ingredients,
          specific_request: specificRequest,
          user_id: userId,
        }),
      });
      const data = await res.json();
      setMeals(data.meals || []);
      setPersonalized(data.personalized || false);
    } catch {
      setError("Failed to get meal suggestions.");
    }
    setLoading(false);
  }, [sessionId, ingredients, specificRequest, userId]);

  useEffect(() => {
    if (step !== 1 || ingredients.length === 0) return;
    const timer = setTimeout(suggestMeals, 800);
    return () => clearTimeout(timer);
  }, [suggestMeals, step]);

  const findPantries = async (locationOverride?: string) => {
    const loc = locationOverride ?? location;
    if (!loc.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/find-pantries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, location: loc }),
      });
      const data = await res.json();
      setPantries(data.pantries || []);
      setSelectedPantries(new Set());
      setStep(2);
    } catch {
      setError("Failed to find pantries.");
    }
    setLoading(false);
  };

  const togglePantry = (idx: number) => {
    setSelectedPantries((prev) => {
      const n = new Set(prev);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });
  };

  const getMissingIngredients = () => {
    if (selectedMeal === null) return meals.flatMap((m) => m.missing || []);
    return meals[selectedMeal]?.missing || [];
  };
  const callPantries = async () => {
    const selected = pantries.filter((_, i) => selectedPantries.has(i));
    if (selected.length === 0) return;
    setLoading(true);
    setStep(3);
    setCallStatuses({});
    const endpoint = demoMode
      ? "/api/demo/call-pantries"
      : "/api/call-pantries";
    try {
      await fetch(`${API}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          pantries: selected,
          missing_ingredients: getMissingIngredients(),
          selected_meal: selectedMeal !== null ? meals[selectedMeal]?.name : "",
        }),
      });
    } catch {
      setError("Failed to initiate calls.");
    }
    setLoading(false);
  };

  const getOptimalPlan = async () => {
    setLoading(true);
    const callResults = Object.entries(callStatuses)
      .filter(([_, v]) => v.type === "call_complete")
      .map(([k, v]) => ({ pantry: k, ...v.results }));
    try {
      const res = await fetch(`${API}/api/optimize-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          call_results: callResults,
          user_location: location,
          selected_meal: selectedMeal !== null ? meals[selectedMeal]?.name : "",
          user_has: ingredients,
        }),
      });
      setPlan(await res.json());
      setStep(4);
    } catch {
      setError("Failed to generate plan.");
    }
    setLoading(false);
  };

  const allCallsDone =
    Object.values(callStatuses).length > 0 &&
    Object.values(callStatuses).every(
      (s) => s.type === "call_complete" || s.type === "call_error",
    );

  const openRecipeDetail = async (idx: number) => {
    const meal = meals[idx];
    setViewingMealIdx(idx);
    setRecipeDetail(null);
    setLoadingRecipe(true);
    try {
      const res = await fetch(`${API}/api/recipe-steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meal_name: meal.name,
          have: meal.have,
          missing: meal.missing,
          time_minutes: meal.time_minutes,
        }),
      });
      setRecipeDetail(await res.json());
    } catch {
      setRecipeDetail({
        steps: ["Could not load steps. Please try again."],
        tips: [],
        servings: "",
      });
    }
    setLoadingRecipe(false);
  };

  const closeRecipeDetail = () => {
    setViewingMealIdx(null);
    setRecipeDetail(null);
  };

  const resetAll = () => {
    setStep(0);
    setImage(null);
    setImagePreview("");
    setIngredients([]);
    setMeals([]);
    setSelectedMeal(null);
    setPantries([]);
    setPlan(null);
    setCallStatuses({});
    setError("");
    setLocation("");
    setLocating(false);
    setLocationDenied(false);
    setUserCoords(null);
    setViewingMealIdx(null);
    setRecipeDetail(null);
    geoInitiatedRef.current = false;
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#FCEEAD" }}>
      {/* ─── Memory widget ─── */}
      <div
        className="fixed top-4 right-4 z-50 w-64 rounded-2xl border-2 p-3 shadow-lg"
        style={{ backgroundColor: "#FCEEAD", borderColor: "#2d1f0e" }}
      >
        <div
          className="text-xs mb-2"
          style={{ color: "#2d1f0e", fontFamily: "var(--font-krona)" }}
        >
          Your preferences
        </div>
        {memories.length === 0 ? (
          <div
            className="text-xs"
            style={{ color: "#2d1f0e99", fontFamily: "var(--font-libertinus)" }}
          >
            No memories yet
          </div>
        ) : (
          <ul className="space-y-1">
            {memories.map((m, i) => (
              <li
                key={i}
                className="text-xs leading-snug"
                style={{
                  color: "#2d1f0e99",
                  fontFamily: "var(--font-libertinus)",
                }}
              >
                • {m}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ─── STEP 0: Landing page ─── */}
      {step === 0 && (
        <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
          {/* Bottom-left plants */}
          <div className="absolute bottom-0 left-0 pointer-events-none select-none flower-from-left">
            <img
              src="/flower2.png"
              alt=""
              className="w-64 h-auto"
              style={{ transform: "rotate(15deg) translate(-10%, 15%)" }}
            />
          </div>
          <div
            className="absolute bottom-0 left-0 pointer-events-none select-none flower-from-left"
            style={{ animationDelay: "0.08s" }}
          >
            <img
              src="/flower3.png"
              alt=""
              className="w-60 h-auto"
              style={{ transform: "rotate(25deg) translateX(30%)" }}
            />
          </div>

          {/* Top-right plant */}
          <div className="absolute top-0 right-0 pointer-events-none select-none flower-from-top-right">
            <img
              src="/flower4.png"
              alt=""
              className="w-56 h-auto"
              style={{ transform: "translate(-15%, -15%) rotate(230deg)" }}
            />
          </div>

          {/* Bottom-right plant */}
          <div className="absolute bottom-0 right-0 pointer-events-none select-none flower-from-right">
            <img
              src="/flower1.png"
              alt=""
              className="w-72 h-auto"
              style={{ transform: "rotate(-5deg) translate(20%, 15%)" }}
            />
          </div>

          {/* Main content */}
          <div className="intro-content relative z-10 flex flex-col items-center text-center px-8">
            <h1
              className="mb-7 leading-none"
              style={{
                fontSize: "clamp(2.8rem, 12vw, 5rem)",
                color: "#2d1f0e",
                fontFamily: "var(--font-krona)",
                letterSpacing: "-0.05em",
                WebkitTextStroke: "1.5px #2d1f0e",
              }}
            >
              <span style={{ position: "relative", top: "-0.35em" }}>
                fridge
              </span>
              <span>bridge</span>
            </h1>

            <p
              className="text-3xl mb-12 leading-tight"
              style={{
                color: "#2d1f0e",
                fontFamily: "var(--font-libertinus)",
                letterSpacing: "-0.05em",
              }}
            >
              Snap your fridge. We&apos;ll find a meal
              <br />
              and call nearby pantries for what&apos;s missing.
            </p>

            <div
              className="w-[32rem] h-80 rounded-3xl cursor-pointer flex items-center justify-center mb-10 transition-all hover:brightness-95 overflow-hidden border-2"
              style={{ backgroundColor: "#b5af7a", borderColor: "#2d1f0e" }}
              onClick={() => fileInputRef.current?.click()}
            >
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Fridge"
                  className="w-full h-full object-cover"
                />
              ) : (
                <svg width="52" height="46" viewBox="0 0 52 46" fill="none">
                  <path
                    d="M4 16h6l4-6h24l4 6h6a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V19a3 3 0 0 1 3-3z"
                    stroke="#7a7550"
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="26"
                    cy="28"
                    r="8"
                    stroke="#7a7550"
                    strokeWidth="2.5"
                    fill="none"
                  />
                </svg>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleImageSelect}
              className="hidden"
            />

            {imagePreview && (
              <button
                onClick={analyzeFridge}
                disabled={loading}
                className="w-72 py-2.5 rounded-full border-2 text-sm font-medium transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: "#2d1f0e",
                  borderColor: "#2d1f0e",
                  color: "#FCEEAD",
                  fontFamily: "var(--font-krona)",
                }}
              >
                {loading ? "Analyzing..." : "Analyze →"}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="min-h-screen relative overflow-x-hidden">
          {/* Plants */}
          <img
            src="/flower2.png"
            alt=""
            className="fixed bottom-0 left-0 w-64 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(15deg) translate(-10%, 15%)" }}
          />
          <img
            src="/flower3.png"
            alt=""
            className="fixed bottom-0 left-0 w-60 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(25deg) translateX(30%)" }}
          />
          <img
            src="/flower4.png"
            alt=""
            className="fixed top-0 right-0 w-56 h-auto pointer-events-none select-none z-0"
            style={{ transform: "translate(-15%, -15%) rotate(230deg)" }}
          />
          <img
            src="/flower1.png"
            alt=""
            className="fixed bottom-0 right-0 w-72 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(-5deg) translate(20%, 15%)" }}
          />

          <div className="relative z-10 max-w-2xl mx-auto px-6 py-8 animate-fade-up">
            {/* Fridge photo */}
            {imagePreview && (
              <img
                src={imagePreview}
                alt="Fridge"
                className="w-full rounded-2xl mb-5 border-2"
                style={{ borderColor: "#2d1f0e" }}
              />
            )}

            {/* Ingredient pills */}
            <div className="flex flex-wrap gap-2 mb-5">
              {ingredients.map((item, i) => (
                <button
                  key={i}
                  onClick={() => removeIngredient(item)}
                  className="px-3 py-1.5 rounded-full border-2 text-sm font-medium transition-colors hover:opacity-70"
                  style={{
                    borderColor: "#2d1f0e",
                    color: "#2d1f0e",
                    fontFamily: "var(--font-krona)",
                    backgroundColor: "rgba(255,255,255,0.45)",
                  }}
                >
                  {item}
                </button>
              ))}
              {showAddInput ? (
                <input
                  autoFocus
                  className="px-3 py-1.5 rounded-full border-2 text-sm focus:outline-none w-36"
                  style={{
                    borderColor: "#2d1f0e",
                    fontFamily: "var(--font-krona)",
                    backgroundColor: "rgba(255,255,255,0.45)",
                    color: "#2d1f0e",
                  }}
                  placeholder="ingredient..."
                  value={newIngredient}
                  onChange={(e) => setNewIngredient(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      addIngredient();
                      setShowAddInput(false);
                    }
                    if (e.key === "Escape") setShowAddInput(false);
                  }}
                  onBlur={() => {
                    addIngredient();
                    setShowAddInput(false);
                  }}
                />
              ) : (
                <button
                  onClick={() => setShowAddInput(true)}
                  className="px-3 py-1.5 rounded-full border-2 text-sm font-medium transition-colors hover:opacity-70"
                  style={{
                    borderColor: "#2d1f0e",
                    color: "#2d1f0e",
                    fontFamily: "var(--font-krona)",
                    backgroundColor: "rgba(255,255,255,0.45)",
                  }}
                >
                  + Add more
                </button>
              )}
            </div>

            {/* Quick add staples */}
            <div className="mb-5">
              <div
                className="text-xl mb-2"
                style={{
                  color: "#2d1f0e",
                  fontFamily: "var(--font-libertinus)",
                }}
              >
                Quick add pantry staples
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STAPLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => toggleStaple(s)}
                    className="px-3 py-1 rounded-full border-2 text-xs font-medium transition-colors hover:opacity-70"
                    style={{
                      borderColor: "#2d1f0e",
                      color: "#2d1f0e",
                      fontFamily: "var(--font-krona)",
                      backgroundColor: addedStaples.has(s)
                        ? "rgba(255,255,255,0.75)"
                        : "rgba(255,255,255,0.45)",
                    }}
                  >
                    {addedStaples.has(s) ? "✓ " : "+ "}
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Recipes */}
            <div
              className="text-xl mb-3"
              style={{ color: "#2d1f0e", fontFamily: "var(--font-libertinus)" }}
            >
              Recipes you can make
            </div>
            {loading ? (
              <div className="text-sm text-neutral-400 italic py-2">
                Finding recipes...
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {meals.map((meal, i) => (
                  <div
                    key={i}
                    className="p-4 rounded-2xl border-2 flex flex-col cursor-pointer hover:opacity-80 transition-opacity"
                    style={{
                      borderColor: "#2d1f0e",
                      backgroundColor: "rgba(255,255,255,0.45)",
                    }}
                    onClick={() => {
                      rememberRecipe(i);
                      setSelectedMeal(i);
                      setStep(2);
                    }}
                  >
                    {" "}
                    <div
                      className="font-medium text-sm mb-1"
                      style={{
                        color: "#2d1f0e",
                        fontFamily: "var(--font-krona)",
                      }}
                    >
                      {meal.name}
                    </div>
                    {meal.personalized_reason && (
                      <div className="text-xs mb-1 italic" style={{ color: "#2d1f0e", fontFamily: "var(--font-libertinus)" }}>
                        {meal.personalized_reason}
                      </div>
                    )}
                    <div
                      className="text-xs mb-3 flex flex-wrap gap-x-2 flex-1"
                      style={{
                        color: "#2d1f0e99",
                        fontFamily: "var(--font-libertinus)",
                      }}
                    >
                      {meal.have?.map((item) => (
                        <span key={item}>✓ {item}</span>
                      ))}
                      {meal.missing?.map((item) => (
                        <span key={item}>✗ {item}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm">
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="min-h-screen relative overflow-x-hidden">
          <img
            src="/flower2.png"
            alt=""
            className="fixed bottom-0 left-0 w-64 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(15deg) translate(-10%, 15%)" }}
          />
          <img
            src="/flower3.png"
            alt=""
            className="fixed bottom-0 left-0 w-60 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(25deg) translateX(30%)" }}
          />
          <img
            src="/flower4.png"
            alt=""
            className="fixed top-0 right-0 w-56 h-auto pointer-events-none select-none z-0"
            style={{ transform: "translate(-15%, -15%) rotate(230deg)" }}
          />
          <img
            src="/flower1.png"
            alt=""
            className="fixed bottom-0 right-0 w-72 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(-5deg) translate(20%, 15%)" }}
          />

          <div className="relative z-10 max-w-2xl mx-auto px-6 py-8">
            {pantries.length === 0 ? (
              <div className="py-16 text-center">
                {locating || loading ? (
                  <p
                    className="animate-pulse"
                    style={{
                      color: "#2d1f0e",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    Finding pantries near you...
                  </p>
                ) : locationDenied ? (
                  <div>
                    <p
                      className="mb-4 text-sm"
                      style={{
                        color: "#2d1f0e",
                        fontFamily: "var(--font-libertinus)",
                      }}
                    >
                      Location access denied. Enter your location:
                    </p>
                    <input
                      autoFocus
                      className="w-full px-4 py-2.5 rounded-full border-2 text-sm focus:outline-none mb-3"
                      style={{
                        borderColor: "#2d1f0e",
                        fontFamily: "var(--font-krona)",
                        backgroundColor: "rgba(255,255,255,0.45)",
                        color: "#2d1f0e",
                      }}
                      placeholder="city or zip code..."
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && findPantries()}
                    />
                    <button
                      onClick={() => findPantries()}
                      disabled={!location.trim()}
                      className="w-full py-2.5 rounded-full border-2 text-sm font-medium transition-colors disabled:opacity-50"
                      style={{
                        borderColor: "#2d1f0e",
                        color: "#FCEEAD",
                        fontFamily: "var(--font-krona)",
                        backgroundColor: "#2d1f0e",
                      }}
                    >
                      Find pantries
                    </button>
                  </div>
                ) : null}
                <button
                  onClick={() => {
                    setStep(1);
                    geoInitiatedRef.current = false;
                  }}
                  className="mt-6 text-sm hover:opacity-70 transition-opacity"
                  style={{ color: "#2d1f0e", fontFamily: "var(--font-krona)" }}
                >
                  ← Back
                </button>
              </div>
            ) : (
              <>
                <div
                  className="mb-5 rounded-2xl overflow-hidden border-2"
                  style={{ borderColor: "#7aa4c8" }}
                >
                  <PantryMap pantries={pantries} userCoords={userCoords} />
                </div>

                <div
                  className="text-xl mb-4"
                  style={{
                    color: "#2d1f0e",
                    fontFamily: "var(--font-libertinus)",
                  }}
                >
                  Call nearby pantries
                </div>

                {pantries.map((p, i) => (
                  <div
                    key={i}
                    onClick={() => togglePantry(i)}
                    className="flex items-center gap-3 px-5 py-3 mb-3 rounded-full border-2 cursor-pointer transition-all"
                    style={{
                      borderColor: "#2d1f0e",
                      backgroundColor: selectedPantries.has(i)
                        ? "rgba(134,196,100,0.25)"
                        : "rgba(255,255,255,0.6)",
                    }}
                  >
                    <div
                      className="w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: "#2d1f0e",
                        backgroundColor: selectedPantries.has(i)
                          ? "#2d1f0e"
                          : "transparent",
                      }}
                    >
                      {selectedPantries.has(i) && (
                        <span className="text-xs" style={{ color: "#FCEEAD" }}>
                          ✓
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm font-medium"
                        style={{
                          color: "#2d1f0e",
                          fontFamily: "var(--font-krona)",
                        }}
                      >
                        {p.name}
                      </div>
                      <div
                        className="text-xs"
                        style={{
                          color: "#2d1f0e99",
                          fontFamily: "var(--font-libertinus)",
                        }}
                      >
                        {p.hours || p.address}
                        {p.phone ? ` · ${p.phone}` : ""}
                        {(p as { recent_note?: string }).recent_note && (
                          <span className="ml-1 italic">
                            {" "}
                            · {(p as { recent_note?: string }).recent_note}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {error && (
                  <div
                    className="mb-3 p-3 rounded-2xl text-sm"
                    style={{
                      color: "#c0392b",
                      fontFamily: "var(--font-libertinus)",
                      backgroundColor: "rgba(255,100,100,0.15)",
                    }}
                  >
                    {error}
                  </div>
                )}

                <button
                  onClick={callPantries}
                  disabled={selectedPantries.size === 0 || loading}
                  className="w-full py-2.5 rounded-full border-2 text-sm font-medium mt-1 transition-all disabled:opacity-40"
                  style={{
                    borderColor: "#2d1f0e",
                    color: "#FCEEAD",
                    fontFamily: "var(--font-krona)",
                    backgroundColor: "#2d1f0e",
                  }}
                >
                  {loading
                    ? "Deploying agents..."
                    : `Call ${selectedPantries.size} pantries`}
                </button>
                <button
                  onClick={() => {
                    setPantries([]);
                    setStep(1);
                    geoInitiatedRef.current = false;
                  }}
                  className="w-full mt-2 py-2 text-sm hover:opacity-70 transition-opacity"
                  style={{ color: "#2d1f0e", fontFamily: "var(--font-krona)" }}
                >
                  ← Back
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="min-h-screen relative overflow-x-hidden">
          <img
            src="/flower2.png"
            alt=""
            className="fixed bottom-0 left-0 w-64 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(15deg) translate(-10%, 15%)" }}
          />
          <img
            src="/flower3.png"
            alt=""
            className="fixed bottom-0 left-0 w-60 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(25deg) translateX(30%)" }}
          />
          <img
            src="/flower4.png"
            alt=""
            className="fixed top-0 right-0 w-56 h-auto pointer-events-none select-none z-0"
            style={{ transform: "translate(-15%, -15%) rotate(230deg)" }}
          />
          <img
            src="/flower1.png"
            alt=""
            className="fixed bottom-0 right-0 w-72 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(-5deg) translate(20%, 15%)" }}
          />

          <div className="relative z-10 max-w-2xl mx-auto px-6 py-8">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <div
                className="text-xl"
                style={{
                  color: "#2d1f0e",
                  fontFamily: "var(--font-libertinus)",
                }}
              >
                Calling pantries...
              </div>
            </div>
            <p
              className="text-sm mb-6"
              style={{
                color: "#2d1f0e99",
                fontFamily: "var(--font-libertinus)",
              }}
            >
              AI agents are calling simultaneously. Watch results come in live.
            </p>

            {Object.entries(callStatuses).map(([key, status]) => (
              <div
                key={key}
                className="flex items-start gap-3 px-5 py-3 mb-3 rounded-2xl border-2"
                style={{
                  borderColor: "#2d1f0e",
                  backgroundColor:
                    status.type === "call_complete"
                      ? "rgba(134,196,100,0.25)"
                      : "rgba(255,255,255,0.6)",
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div
                      className="text-sm font-medium"
                      style={{
                        color: "#2d1f0e",
                        fontFamily: "var(--font-krona)",
                      }}
                    >
                      {status.pantry || key}
                    </div>
                    <span
                      className="text-xs ml-2 flex-shrink-0"
                      style={{
                        color: "#2d1f0e99",
                        fontFamily: "var(--font-libertinus)",
                      }}
                    >
                      {status.status === "ringing"
                        ? "📞 Ringing"
                        : status.status === "connected" ||
                            status.status === "listening"
                          ? "🗣 On call"
                          : status.type === "call_complete" &&
                              status.results?.rejected
                            ? "❌ Rejected"
                            : status.type === "call_complete"
                              ? "Done"
                              : status.type === "call_error"
                                ? "Failed"
                                : status.status}
                    </span>
                  </div>
                  {status.message && (
                    <div
                      className="text-xs italic mb-1"
                      style={{
                        color: "#2d1f0e99",
                        fontFamily: "var(--font-libertinus)",
                      }}
                    >
                      {status.message}
                    </div>
                  )}
                  {status.results && (
                    <div className="flex flex-wrap gap-x-3 mt-1">
                      {status.results.available?.map(
                        (item: unknown, i: number) => (
                          <span
                            key={i}
                            className="text-xs"
                            style={{
                              color: "#3a7d44",
                              fontFamily: "var(--font-libertinus)",
                            }}
                          >
                            ✓{" "}
                            {typeof item === "string"
                              ? item
                              : ((item as Record<string, string>).item ??
                                JSON.stringify(item))}
                          </span>
                        ),
                      )}
                      {status.results.unavailable?.map(
                        (item: unknown, i: number) => (
                          <span
                            key={i}
                            className="text-xs line-through"
                            style={{
                              color: "#2d1f0e66",
                              fontFamily: "var(--font-libertinus)",
                            }}
                          >
                            ✗{" "}
                            {typeof item === "string"
                              ? item
                              : ((item as Record<string, string>).item ??
                                JSON.stringify(item))}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {error && (
              <div
                className="mb-3 p-3 rounded-2xl text-sm"
                style={{
                  color: "#c0392b",
                  fontFamily: "var(--font-libertinus)",
                  backgroundColor: "rgba(255,100,100,0.15)",
                }}
              >
                {error}
              </div>
            )}

            {allCallsDone && (
              <button
                onClick={getOptimalPlan}
                disabled={loading}
                className="w-full py-2.5 rounded-full border-2 text-sm font-medium mt-2 transition-all disabled:opacity-40"
                style={{
                  borderColor: "#2d1f0e",
                  color: "#FCEEAD",
                  fontFamily: "var(--font-krona)",
                  backgroundColor: "#2d1f0e",
                }}
              >
                {loading ? "Optimizing..." : "Get my plan →"}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 4 && plan && (
        <div className="min-h-screen relative overflow-x-hidden">
          <img
            src="/flower2.png"
            alt=""
            className="fixed bottom-0 left-0 w-64 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(15deg) translate(-10%, 15%)" }}
          />
          <img
            src="/flower3.png"
            alt=""
            className="fixed bottom-0 left-0 w-60 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(25deg) translateX(30%)" }}
          />
          <img
            src="/flower4.png"
            alt=""
            className="fixed top-0 right-0 w-56 h-auto pointer-events-none select-none z-0"
            style={{ transform: "translate(-15%, -15%) rotate(230deg)" }}
          />
          <img
            src="/flower1.png"
            alt=""
            className="fixed bottom-0 right-0 w-72 h-auto pointer-events-none select-none z-0"
            style={{ transform: "rotate(-5deg) translate(20%, 15%)" }}
          />

          <div className="relative z-10 max-w-2xl mx-auto px-6 py-8">
            <div
              className="text-xl mb-5"
              style={{ color: "#2d1f0e", fontFamily: "var(--font-libertinus)" }}
            >
              Your plan
            </div>

            {plan.plan?.map((stop, i) => (
              <div
                key={i}
                className="flex items-start gap-3 px-5 py-3 mb-3 rounded-2xl border-2"
                style={{
                  borderColor: "#2d1f0e",
                  backgroundColor: "rgba(255,255,255,0.6)",
                }}
              >
                <div
                  className="w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 text-xs font-medium mt-0.5"
                  style={{
                    borderColor: "#2d1f0e",
                    color: "#2d1f0e",
                    fontFamily: "var(--font-krona)",
                  }}
                >
                  {stop.visit_order || i + 1}
                </div>
                <div>
                  <div
                    className="text-sm font-medium mb-0.5"
                    style={{
                      color: "#2d1f0e",
                      fontFamily: "var(--font-krona)",
                    }}
                  >
                    {stop.pantry_name}
                  </div>
                  <div
                    className="text-xs"
                    style={{
                      color: "#2d1f0e99",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    {stop.address}
                  </div>
                  <div
                    className="text-xs mt-1"
                    style={{
                      color: "#3a7d44",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    Pick up: {stop.items_to_get?.join(", ")}
                  </div>
                </div>
              </div>
            ))}

            {plan.still_missing?.length > 0 && (
              <div
                className="px-5 py-3 mb-3 rounded-2xl border-2"
                style={{
                  borderColor: "#2d1f0e",
                  backgroundColor: "rgba(255,200,100,0.3)",
                }}
              >
                <div
                  className="text-sm font-medium mb-1"
                  style={{ color: "#2d1f0e", fontFamily: "var(--font-krona)" }}
                >
                  Still missing
                </div>
                <div
                  className="text-sm"
                  style={{
                    color: "#2d1f0e99",
                    fontFamily: "var(--font-libertinus)",
                  }}
                >
                  {plan.still_missing.join(", ")}
                </div>
              </div>
            )}

            {plan.summary && (
              <div
                className="px-5 py-3 mb-3 rounded-2xl border-2"
                style={{
                  borderColor: "#2d1f0e",
                  backgroundColor: "rgba(255,255,255,0.6)",
                }}
              >
                <div
                  className="text-sm leading-relaxed"
                  style={{
                    color: "#2d1f0e99",
                    fontFamily: "var(--font-libertinus)",
                  }}
                >
                  {plan.summary}
                </div>
              </div>
            )}

            {error && (
              <div
                className="mb-3 p-3 rounded-2xl text-sm"
                style={{
                  color: "#c0392b",
                  fontFamily: "var(--font-libertinus)",
                  backgroundColor: "rgba(255,100,100,0.15)",
                }}
              >
                {error}
              </div>
            )}

            <button
              onClick={resetAll}
              className="w-full py-2.5 rounded-full border-2 text-sm font-medium mt-2 transition-all hover:opacity-70"
              style={{
                borderColor: "#2d1f0e",
                color: "#2d1f0e",
                fontFamily: "var(--font-krona)",
                backgroundColor: "rgba(255,255,255,0.45)",
              }}
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {/* ─── Recipe Detail Modal ─── */}
      {viewingMealIdx !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={closeRecipeDetail}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-2xl max-h-[88vh] overflow-y-auto shadow-2xl animate-fade-up rounded-t-3xl border-t-2 border-x-2"
            style={{ backgroundColor: "#FCEEAD", borderColor: "#2d1f0e" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div
                className="w-10 h-1 rounded-full"
                style={{ backgroundColor: "#2d1f0e44" }}
              />
            </div>

            <div className="px-6 pb-10 pt-3">
              {/* Header */}
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1 pr-3">
                  <h3
                    className="text-xl"
                    style={{
                      color: "#2d1f0e",
                      fontFamily: "var(--font-krona)",
                      letterSpacing: "-0.03em",
                    }}
                  >
                    {meals[viewingMealIdx]?.name}
                  </h3>
                  <p
                    className="text-sm mt-1"
                    style={{
                      color: "#2d1f0e99",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    {meals[viewingMealIdx]?.description}
                  </p>
                  <div
                    className="flex gap-3 mt-2 text-xs"
                    style={{
                      color: "#2d1f0e99",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    <span>⏱ {meals[viewingMealIdx]?.time_minutes} min</span>
                    <span>· {meals[viewingMealIdx]?.difficulty}</span>
                    {recipeDetail?.servings && (
                      <span>· {recipeDetail.servings}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={closeRecipeDetail}
                  className="w-8 h-8 flex items-center justify-center rounded-full border-2 text-lg flex-shrink-0 hover:opacity-70 transition-opacity"
                  style={{ borderColor: "#2d1f0e", color: "#2d1f0e" }}
                >
                  ×
                </button>
              </div>

              {/* Ingredients */}
              <div className="flex gap-2 mb-5 flex-wrap">
                {meals[viewingMealIdx]?.have?.map((item, j) => (
                  <span
                    key={j}
                    className="px-3 py-1 rounded-full border-2 text-xs"
                    style={{
                      borderColor: "#2d1f0e",
                      color: "#3a7d44",
                      fontFamily: "var(--font-krona)",
                      backgroundColor: "rgba(255,255,255,0.45)",
                    }}
                  >
                    ✓ {item}
                  </span>
                ))}
                {meals[viewingMealIdx]?.missing?.map((item, j) => (
                  <span
                    key={j}
                    className="px-3 py-1 rounded-full border-2 text-xs"
                    style={{
                      borderColor: "#2d1f0e",
                      color: "#c0392b",
                      fontFamily: "var(--font-krona)",
                      backgroundColor: "rgba(255,255,255,0.45)",
                    }}
                  >
                    ✗ {item}
                  </span>
                ))}
              </div>

              {/* Steps */}
              <div className="mb-4">
                <div
                  className="text-sm mb-3"
                  style={{
                    color: "#2d1f0e",
                    fontFamily: "var(--font-libertinus)",
                  }}
                >
                  Step-by-step instructions
                </div>

                {loadingRecipe ? (
                  <div className="flex flex-col gap-2">
                    {[1, 2, 3, 4].map((n) => (
                      <div
                        key={n}
                        className="h-10 rounded-2xl animate-pulse"
                        style={{ backgroundColor: "rgba(45,31,14,0.1)" }}
                      />
                    ))}
                  </div>
                ) : (
                  recipeDetail?.steps?.map((step, j) => (
                    <div key={j} className="flex gap-3 mb-3">
                      <span
                        className="w-6 h-6 rounded-full border-2 text-xs font-medium flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{
                          borderColor: "#2d1f0e",
                          color: "#2d1f0e",
                          fontFamily: "var(--font-krona)",
                        }}
                      >
                        {j + 1}
                      </span>
                      <p
                        className="text-sm leading-relaxed"
                        style={{
                          color: "#2d1f0e",
                          fontFamily: "var(--font-libertinus)",
                        }}
                      >
                        {step.replace(/^Step\s*\d+[:.]\s*/i, "")}
                      </p>
                    </div>
                  ))
                )}
              </div>

              {/* Tips */}
              {recipeDetail?.tips && recipeDetail.tips.length > 0 && (
                <div
                  className="px-4 py-3 rounded-2xl border-2 mb-5"
                  style={{
                    borderColor: "#2d1f0e",
                    backgroundColor: "rgba(255,255,255,0.45)",
                  }}
                >
                  <div
                    className="text-xs mb-2"
                    style={{
                      color: "#2d1f0e",
                      fontFamily: "var(--font-libertinus)",
                    }}
                  >
                    Tips
                  </div>
                  {recipeDetail.tips.map((tip, j) => (
                    <div
                      key={j}
                      className="text-sm mb-1"
                      style={{
                        color: "#2d1f0e99",
                        fontFamily: "var(--font-libertinus)",
                      }}
                    >
                      • {tip}
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => {
                  if (viewingMealIdx !== null) rememberRecipe(viewingMealIdx);
                  setSelectedMeal(viewingMealIdx);
                  closeRecipeDetail();
                  setStep(2);
                }}
                className="w-full py-2.5 rounded-full border-2 text-sm font-medium transition-all hover:opacity-80"
                style={{
                  borderColor: "#2d1f0e",
                  color: "#FCEEAD",
                  fontFamily: "var(--font-krona)",
                  backgroundColor: "#2d1f0e",
                }}
              >
                Find pantries for this meal →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

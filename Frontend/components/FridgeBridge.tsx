"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";

const PantryMap = dynamic(() => import("@/components/map/PantryMap").then(m => m.PantryMap), {
  ssr: false,
  loading: () => <div className="flex h-64 items-center justify-center bg-neutral-100 text-neutral-500 rounded-xl">Loading map…</div>,
});

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const STAPLES = ["flour", "sugar", "salt", "pepper", "butter", "olive oil", "garlic", "onion", "rice", "pasta", "baking soda", "vanilla extract", "soy sauce", "vinegar"];
const TOTAL_STEPS = 6;

interface Meal {
  name: string;
  description: string;
  have: string[];
  missing: string[];
  difficulty: string;
  time_minutes: number;
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
  };
}

interface RecipeDetail {
  steps: string[];
  tips: string[];
  servings: string;
}

interface Plan {
  plan: { pantry_name: string; address: string; items_to_get: string[]; visit_order: number }[];
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
  const [location, setLocation] = useState("");
  const [pantries, setPantries] = useState<Pantry[]>([]);
  const [selectedPantries, setSelectedPantries] = useState<Set<number>>(new Set());
  const [callStatuses, setCallStatuses] = useState<Record<string, CallStatus>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(true);
  const [error, setError] = useState("");
  const [viewingMealIdx, setViewingMealIdx] = useState<number | null>(null);
  const [recipeDetail, setRecipeDetail] = useState<RecipeDetail | null>(null);
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // WebSocket connection
  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/${sessionId}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setCallStatuses((prev) => {
        const key = data.pantry || data.call_id;
        return { ...prev, [key]: { ...(prev[key] || {}), ...data } };
      });
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

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
      const res = await fetch(`${API}/api/analyze-fridge`, { method: "POST", body: formData });
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
    setAddedStaples((prev) => { const n = new Set(prev); n.delete(item); return n; });
  };

  const toggleStaple = (staple: string) => {
    if (addedStaples.has(staple)) {
      setAddedStaples((prev) => { const n = new Set(prev); n.delete(staple); return n; });
      setIngredients(ingredients.filter((i) => i !== staple));
    } else {
      setAddedStaples((prev) => new Set(prev).add(staple));
      if (!ingredients.includes(staple)) setIngredients([...ingredients, staple]);
    }
  };

  const suggestMeals = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/suggest-meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, ingredients, specific_request: specificRequest }),
      });
      const data = await res.json();
      setMeals(data.meals || []);
      setStep(2);
    } catch {
      setError("Failed to get meal suggestions.");
    }
    setLoading(false);
  };

  const findPantries = async () => {
    if (!location.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/find-pantries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, location }),
      });
      const data = await res.json();
      setPantries(data.pantries || []);
      setSelectedPantries(new Set(data.pantries?.map((_: Pantry, i: number) => i) || []));
      setStep(3);
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
    if (selectedMeal === null) return [];
    return meals[selectedMeal]?.missing || [];
  };

  const callPantries = async () => {
    const selected = pantries.filter((_, i) => selectedPantries.has(i));
    if (selected.length === 0) return;
    setLoading(true);
    setStep(4);
    setCallStatuses({});
    const endpoint = demoMode ? "/api/demo/call-pantries" : "/api/call-pantries";
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
        }),
      });
      setPlan(await res.json());
      setStep(5);
    } catch {
      setError("Failed to generate plan.");
    }
    setLoading(false);
  };

  const allCallsDone = Object.values(callStatuses).length > 0 &&
    Object.values(callStatuses).every((s) => s.type === "call_complete" || s.type === "call_error");

  const openRecipeDetail = async (idx: number) => {
    const meal = meals[idx];
    setViewingMealIdx(idx);
    setRecipeDetail(null);
    setLoadingRecipe(true);
    try {
      const res = await fetch(`${API}/api/recipe-steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_name: meal.name, have: meal.have, missing: meal.missing, time_minutes: meal.time_minutes }),
      });
      setRecipeDetail(await res.json());
    } catch {
      setRecipeDetail({ steps: ["Could not load steps. Please try again."], tips: [], servings: "" });
    }
    setLoadingRecipe(false);
  };

  const closeRecipeDetail = () => {
    setViewingMealIdx(null);
    setRecipeDetail(null);
  };

  const resetAll = () => {
    setStep(0); setImage(null); setImagePreview(""); setIngredients([]); setMeals([]);
    setSelectedMeal(null); setPantries([]); setPlan(null); setCallStatuses({}); setError("");
    setViewingMealIdx(null); setRecipeDetail(null);
  };

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-gradient-to-br from-green-800 to-green-900 px-5 py-6 text-white">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <span className="text-3xl">🥫</span> FridgeBridge
        </h1>
        <p className="text-green-200 text-sm mt-1">AI-powered food pantry coordinator</p>
      </header>

      {/* Progress bar */}
      <div className="flex gap-1.5 px-5 py-3 bg-white border-b border-neutral-100 sticky top-0 z-10">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <div key={i} className={`flex-1 h-1 rounded-full transition-colors ${i === step ? "bg-green-500" : i < step ? "bg-green-700" : "bg-neutral-200"}`} />
        ))}
      </div>

      {/* Content */}
      <main className="max-w-lg mx-auto px-5 py-6 pb-24">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm flex justify-between">
            {error}
            <button onClick={() => setError("")} className="text-red-400 ml-2">×</button>
          </div>
        )}

        {/* ─── STEP 0: Scan fridge ─── */}
        {step === 0 && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-1">Scan your fridge</h2>
            <p className="text-sm text-neutral-500 mb-6">Take a photo of your fridge, pantry, or whatever food you have.</p>

            <div
              className={`border-2 border-dashed rounded-2xl cursor-pointer transition-all ${imagePreview ? "border-none p-0 overflow-hidden" : "border-neutral-300 hover:border-green-400 hover:bg-green-50 p-12 text-center bg-white"}`}
              onClick={() => fileInputRef.current?.click()}
            >
              {imagePreview ? (
                <img src={imagePreview} alt="Fridge" className="w-full rounded-2xl" />
              ) : (
                <>
                  <div className="text-5xl mb-3">📸</div>
                  <div className="font-medium text-neutral-700">Tap to take a photo or upload</div>
                  <div className="text-sm text-neutral-400 mt-1">JPG, PNG — snap your fridge or countertop</div>
                </>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleImageSelect} className="hidden" />

            {imagePreview && (
              <button onClick={() => { setImage(null); setImagePreview(""); }} className="mt-3 w-full py-2.5 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-600 hover:bg-neutral-50">
                Retake photo
              </button>
            )}
            <button onClick={analyzeFridge} disabled={!image || loading} className="mt-3 w-full py-4 rounded-2xl bg-green-600 text-white font-bold text-base disabled:bg-neutral-300 disabled:cursor-not-allowed hover:bg-green-700 transition-colors">
              {loading ? "⏳ Analyzing..." : "Analyze my food"}
            </button>
          </div>
        )}

        {/* ─── STEP 1: Edit ingredients ─── */}
        {step === 1 && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-1">Your ingredients</h2>
            <p className="text-sm text-neutral-500 mb-6">Add anything AI missed — especially pantry staples.</p>

            <div className="flex flex-wrap gap-2 mb-4">
              {ingredients.map((item, i) => (
                <span key={i} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-neutral-200 rounded-full text-sm animate-slide-in" style={{ animationDelay: `${i * 30}ms` }}>
                  {item}
                  <button onClick={() => removeIngredient(item)} className="w-4 h-4 rounded-full bg-neutral-100 hover:bg-red-100 text-neutral-400 hover:text-red-500 text-xs flex items-center justify-center">×</button>
                </span>
              ))}
            </div>

            <div className="flex gap-2 mb-4">
              <input className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:border-green-400" placeholder="Add an ingredient..." value={newIngredient} onChange={(e) => setNewIngredient(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addIngredient()} />
              <button onClick={addIngredient} className="px-4 py-2.5 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700">Add</button>
            </div>

            <div className="mb-5">
              <div className="text-xs uppercase tracking-wider text-neutral-400 font-medium mb-2">Quick add pantry staples</div>
              <div className="flex flex-wrap gap-1.5">
                {STAPLES.map((s) => (
                  <button key={s} onClick={() => toggleStaple(s)} className={`px-3 py-1 rounded-full text-xs border transition-colors ${addedStaples.has(s) ? "bg-green-100 border-green-400 text-green-700" : "bg-neutral-50 border-neutral-200 text-neutral-600 hover:bg-green-50"}`}>
                    {addedStaples.has(s) ? "✓ " : "+ "}{s}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 bg-amber-50 rounded-xl border border-amber-100 mb-5">
              <label className="text-sm font-medium text-amber-600 mb-1 block">🍕 Want something specific?</label>
              <input className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm focus:outline-none focus:border-amber-400 bg-white" placeholder='e.g., "pizza" or "something warm"' value={specificRequest} onChange={(e) => setSpecificRequest(e.target.value)} />
            </div>

            <button onClick={suggestMeals} disabled={ingredients.length === 0 || loading} className="w-full py-4 rounded-2xl bg-green-600 text-white font-bold disabled:bg-neutral-300 hover:bg-green-700 transition-colors">
              {loading ? "⏳ Thinking..." : "What can I make?"}
            </button>
          </div>
        )}

        {/* ─── STEP 2: Meal suggestions ─── */}
        {step === 2 && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-1">Meal ideas</h2>
            <p className="text-sm text-neutral-500 mb-6">Pick a meal — we&apos;ll find the missing ingredients at pantries near you.</p>

            {meals.map((meal, i) => (
              <div key={i} onClick={() => setSelectedMeal(i)} className={`p-4 mb-3 rounded-2xl border cursor-pointer transition-all bg-white ${selectedMeal === i ? "border-green-500 bg-green-50 shadow-sm" : "border-neutral-100 hover:border-green-300"}`}>
                <div className="font-bold text-lg">{selectedMeal === i ? "✓ " : ""}{meal.name}</div>
                <div className="text-sm text-neutral-500 mt-0.5 mb-2">{meal.description}</div>
                <div className="flex gap-3 text-xs text-neutral-400 mb-2">
                  <span>⏱ {meal.time_minutes} min</span>
                  <span>📊 {meal.difficulty}</span>
                  <span className={meal.missing?.length > 0 ? "text-amber-500" : "text-green-600"}>
                    {meal.missing?.length > 0 ? `Missing ${meal.missing.length}` : "✓ Have all!"}
                  </span>
                </div>
                {selectedMeal === i && (
                  <div className="flex gap-4 mt-3 pt-3 border-t border-neutral-100 animate-fade-up">
                    <div className="flex-1">
                      <div className="text-xs uppercase tracking-wider text-neutral-400 mb-1">✓ You have</div>
                      {meal.have?.map((item, j) => <div key={j} className="text-sm text-green-600">{item}</div>)}
                    </div>
                    <div className="flex-1">
                      <div className="text-xs uppercase tracking-wider text-neutral-400 mb-1">✗ Missing</div>
                      {meal.missing?.map((item, j) => <div key={j} className="text-sm text-red-500">{item}</div>)}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); openRecipeDetail(i); }}
                      className="self-end px-3 py-2 bg-green-600 text-white text-xs font-bold rounded-xl hover:bg-green-700 transition-colors whitespace-nowrap"
                    >
                      📖 How to cook
                    </button>
                  </div>
                )}
              </div>
            ))}

            <div className="mt-4 mb-3">
              <div className="font-bold text-sm mb-2">Where are you located?</div>
              <input className="w-full px-4 py-2.5 border border-neutral-200 rounded-xl text-sm focus:outline-none focus:border-green-400" placeholder="Zip code or city (e.g., Davis, CA)" value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => e.key === "Enter" && findPantries()} />
            </div>

            <button onClick={findPantries} disabled={selectedMeal === null || !location.trim() || loading} className="w-full py-4 rounded-2xl bg-green-600 text-white font-bold disabled:bg-neutral-300 hover:bg-green-700 transition-colors">
              {loading ? "⏳ Finding pantries..." : "Find food pantries near me"}
            </button>
            <button onClick={() => setStep(1)} className="w-full mt-2 py-3 rounded-2xl border border-neutral-200 bg-white text-neutral-700 text-sm font-medium hover:bg-neutral-50">← Back to ingredients</button>
          </div>
        )}

        {/* ─── STEP 3: Select pantries ─── */}
        {step === 3 && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-1">Nearby pantries</h2>
            <p className="text-sm text-neutral-500 mb-4">Select which pantries to call. Our AI agents will check availability.</p>

            <label className="flex items-center gap-2 p-3 mb-4 bg-amber-50 border border-amber-100 rounded-xl cursor-pointer text-sm text-amber-600">
              <input type="checkbox" checked={demoMode} onChange={(e) => setDemoMode(e.target.checked)} className="accent-amber-500" />
              <span><strong>Demo mode</strong> — simulates calls with AI (no Twilio needed)</span>
            </label>

            <div className="text-sm text-neutral-500 mb-3">
              Looking for: <strong>{getMissingIngredients().join(", ")}</strong>
            </div>

            {pantries.length > 0 && (
              <div className="mb-4 rounded-xl overflow-hidden border border-neutral-200">
                <PantryMap pantries={pantries} />
              </div>
            )}

            {pantries.map((p, i) => (
              <div key={i} onClick={() => togglePantry(i)} className={`p-4 mb-2 rounded-xl border cursor-pointer transition-all ${selectedPantries.has(i) ? "border-green-500 bg-green-50" : "border-neutral-100 bg-white"}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-sm">{p.name}</div>
                    <div className="text-xs text-neutral-400">{p.address}</div>
                    <div className="text-xs text-green-600 mt-1">{p.phone}</div>
                    {p.hours && <div className="text-xs text-neutral-400">{p.hours}</div>}
                  </div>
                  <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center text-xs flex-shrink-0 ${selectedPantries.has(i) ? "bg-green-500 border-green-500 text-white" : "border-neutral-300"}`}>
                    {selectedPantries.has(i) ? "✓" : ""}
                  </div>
                </div>
              </div>
            ))}

            <button onClick={callPantries} disabled={selectedPantries.size === 0 || loading} className="w-full py-4 rounded-2xl bg-green-600 text-white font-bold disabled:bg-neutral-300 hover:bg-green-700 transition-colors">
              {loading ? "⏳ Deploying agents..." : `Call ${selectedPantries.size} pantries simultaneously`}
            </button>
            <button onClick={() => setStep(2)} className="w-full mt-2 py-3 rounded-2xl border border-neutral-200 bg-white text-neutral-700 text-sm font-medium hover:bg-neutral-50">← Back to meals</button>
          </div>
        )}

        {/* ─── STEP 4: Calling ─── */}
        {step === 4 && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-1 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              Calling pantries...
            </h2>
            <p className="text-sm text-neutral-500 mb-6">AI agents are calling simultaneously. Watch results come in live.</p>

            {Object.entries(callStatuses).map(([key, status]) => (
              <div key={key} className="p-4 mb-3 rounded-xl border border-neutral-100 bg-white animate-slide-in">
                <div className="flex justify-between items-center mb-2">
                  <div className="font-bold text-sm">{status.pantry || key}</div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    status.status === "ringing" ? "bg-amber-100 text-amber-600" :
                    status.status === "connected" || status.status === "listening" ? "bg-green-100 text-green-700" :
                    status.type === "call_complete" ? "bg-green-600 text-white" :
                    status.type === "call_error" ? "bg-red-100 text-red-500" : "bg-neutral-100 text-neutral-500"
                  }`}>
                    {status.status === "ringing" ? "📞 Ringing" :
                     status.status === "connected" || status.status === "listening" ? "🗣 On Call" :
                     status.type === "call_complete" ? "✅ Done" :
                     status.type === "call_error" ? "❌ Failed" : status.status}
                  </span>
                </div>
                {status.message && <div className="text-sm text-neutral-500 italic">{status.message}</div>}
                {status.results && (
                  <div className="mt-2 pt-2 border-t border-neutral-50">
                    {status.results.available?.map((item, i) => <div key={i} className="text-sm text-green-600">✓ {item}</div>)}
                    {status.results.unavailable?.map((item, i) => <div key={i} className="text-sm text-neutral-400 line-through">✗ {item}</div>)}
                    {status.results.substitutions && Object.entries(status.results.substitutions).map(([k, v]) => (
                      <div key={k} className="text-sm text-amber-600">↺ {k} → {v}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {allCallsDone && (
              <button onClick={getOptimalPlan} disabled={loading} className="w-full py-4 rounded-2xl bg-green-600 text-white font-bold hover:bg-green-700 transition-colors animate-fade-up">
                {loading ? "⏳ Optimizing..." : "Get my plan →"}
              </button>
            )}
          </div>
        )}

        {/* ─── STEP 5: Results ─── */}
        {step === 5 && plan && (
          <div className="animate-fade-up">
            <h2 className="text-2xl font-bold text-neutral-900 mb-4">Your plan</h2>

            <div className="bg-gradient-to-br from-green-700 to-green-900 rounded-2xl p-6 text-white mb-4">
              <div className="text-lg font-bold mb-3">🗺 Pickup route</div>
              {plan.plan?.map((stop, i) => (
                <div key={i} className="bg-white/10 rounded-xl p-3 mb-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">{stop.visit_order || i + 1}</span>
                    <span className="font-bold">{stop.pantry_name}</span>
                  </div>
                  <div className="text-sm opacity-90 ml-8">Pick up: {stop.items_to_get?.join(", ")}</div>
                </div>
              ))}
            </div>

            {plan.still_missing?.length > 0 && (
              <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl mb-3">
                <div className="font-bold text-sm text-amber-600 mb-1">Still missing</div>
                <div className="text-sm text-amber-600">{plan.still_missing.join(", ")}</div>
              </div>
            )}

            {plan.recipe_modifications && (
              <div className="p-4 bg-white border border-neutral-100 rounded-xl mb-3">
                <div className="font-bold text-sm mb-1">💡 Recipe adjustments</div>
                <div className="text-sm text-neutral-600 leading-relaxed">{plan.recipe_modifications}</div>
              </div>
            )}

            {plan.summary && (
              <div className="p-4 bg-green-50 border border-green-100 rounded-xl mb-3">
                <div className="text-sm text-green-700 leading-relaxed">{plan.summary}</div>
              </div>
            )}

            <button onClick={resetAll} className="w-full mt-2 py-3 rounded-2xl border border-neutral-200 bg-white text-neutral-700 text-sm font-medium hover:bg-neutral-50">
              Start over
            </button>
          </div>
        )}
      </main>

      {/* ─── Recipe Detail Modal ─── */}
      {viewingMealIdx !== null && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={closeRecipeDetail}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-lg bg-white rounded-t-3xl max-h-[85vh] overflow-y-auto shadow-2xl animate-fade-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-neutral-200" />
            </div>

            <div className="px-5 pb-8 pt-3">
              {/* Header */}
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1 pr-3">
                  <h3 className="text-xl font-bold text-neutral-900">{meals[viewingMealIdx]?.name}</h3>
                  <p className="text-sm text-neutral-500 mt-1">{meals[viewingMealIdx]?.description}</p>
                  <div className="flex gap-3 mt-2 text-xs text-neutral-400">
                    <span>⏱ {meals[viewingMealIdx]?.time_minutes} min</span>
                    <span>📊 {meals[viewingMealIdx]?.difficulty}</span>
                    {recipeDetail?.servings && <span>🍽 {recipeDetail.servings}</span>}
                  </div>
                </div>
                <button onClick={closeRecipeDetail} className="w-8 h-8 flex items-center justify-center rounded-full bg-neutral-100 text-neutral-500 hover:bg-neutral-200 text-lg font-light flex-shrink-0">
                  ×
                </button>
              </div>

              {/* Ingredients */}
              <div className="flex gap-3 mb-5">
                <div className="flex-1 p-3 bg-green-50 rounded-xl">
                  <div className="text-xs uppercase tracking-wider text-green-600 font-medium mb-2">✓ You have</div>
                  {meals[viewingMealIdx]?.have?.map((item, j) => (
                    <div key={j} className="text-sm text-green-700">{item}</div>
                  ))}
                </div>
                {meals[viewingMealIdx]?.missing?.length > 0 && (
                  <div className="flex-1 p-3 bg-red-50 rounded-xl">
                    <div className="text-xs uppercase tracking-wider text-red-400 font-medium mb-2">✗ Missing</div>
                    {meals[viewingMealIdx]?.missing?.map((item, j) => (
                      <div key={j} className="text-sm text-red-500">{item}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* Steps */}
              <div className="mb-4">
                <div className="text-sm font-bold text-neutral-900 mb-3">Step-by-step instructions</div>
                {loadingRecipe ? (
                  <div className="flex flex-col gap-2">
                    {[1, 2, 3, 4].map((n) => (
                      <div key={n} className="h-10 bg-neutral-100 rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : recipeDetail?.steps?.map((step, j) => (
                  <div key={j} className="flex gap-3 mb-3">
                    <span className="w-6 h-6 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {j + 1}
                    </span>
                    <p className="text-sm text-neutral-700 leading-relaxed">{step.replace(/^Step\s*\d+[:.]\s*/i, "")}</p>
                  </div>
                ))}
              </div>

              {/* Tips */}
              {recipeDetail?.tips && recipeDetail.tips.length > 0 && (
                <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl mb-5">
                  <div className="text-xs uppercase tracking-wider text-amber-600 font-medium mb-2">💡 Tips</div>
                  {recipeDetail.tips.map((tip, j) => (
                    <div key={j} className="text-sm text-amber-700 mb-1">• {tip}</div>
                  ))}
                </div>
              )}

              <button
                onClick={() => { setSelectedMeal(viewingMealIdx); closeRecipeDetail(); }}
                className="w-full py-4 rounded-2xl bg-green-600 text-white font-bold hover:bg-green-700 transition-colors"
              >
                {selectedMeal === viewingMealIdx ? "✓ This meal is selected" : "Cook this meal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

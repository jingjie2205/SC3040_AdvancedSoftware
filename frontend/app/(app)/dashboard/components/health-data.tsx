"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, Ruler, Save, Scale, X } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function computeBmi(heightCm: number, weightKg: number) {
  const heightM = heightCm / 100;
  if (heightM <= 0) return 0;
  return weightKg / (heightM * heightM);
}

function bmiCategory(bmi: number) {
  if (bmi < 18.5)
    return {
      label: "Underweight",
      color: "text-sky-400",
      bg: "bg-sky-500/10",
      border: "border-sky-500/20",
      bar: "bg-sky-500",
    };
  if (bmi < 25)
    return {
      label: "Normal",
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
      bar: "bg-emerald-500",
    };
  if (bmi < 30)
    return {
      label: "Overweight",
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
      bar: "bg-amber-500",
    };
  return {
    label: "Obese",
    color: "text-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/20",
    bar: "bg-rose-500",
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export default function HealthData() {
  // Health data
  const [height, setHeight] = useState<number | null>(null);
  const [weight, setWeight] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingHealth, setEditingHealth] = useState(false);
  const [userHeight, setUserHeight] = useState("");
  const [userWeight, setUserWeight] = useState("");

  const bmi = useMemo(() => {
    if (height && weight) return computeBmi(height, weight);
    return null;
  }, [height, weight]);
  const bmiInfo = bmi ? bmiCategory(bmi) : null;

  useEffect(() => {
    async function fetchUserData() {
      setLoading(true);
      try {
        const response = await fetch("/api/user");
        if (!response.ok) {
          throw new Error("Failed to fetch user data");
        }
        const user = await response.json();
        if (user.height) {
          setHeight(user.height);
          setUserHeight(String(user.height));
        }
        if (user.weight) {
          setWeight(user.weight);
          setUserWeight(String(user.weight));
        }
      } catch (error) {
        console.error("Error fetching user data:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchUserData();
  }, []);

  function startEditHealth() {
    setUserHeight(height ? String(height) : "");
    setUserWeight(weight ? String(weight) : "");
    setEditingHealth(true);
  }

  async function saveHealth() {
    const h = parseFloat(userHeight);
    const w = parseFloat(userWeight);

    try {
      const response = await fetch("/api/user", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ height: h, weight: w }),
      });

      if (!response.ok) {
        throw new Error("Failed to update user data");
      }

      const updatedUser = await response.json();

      setHeight(updatedUser.height);
      setWeight(updatedUser.weight);
      setEditingHealth(false);
    } catch (error) {
      console.error("Error saving health data:", error);
    }
  }

  return (
    <div className="lg:col-span-2 rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-white">Health data</h3>
          <p className="text-xs text-slate-400">
            Height, weight & body mass index
          </p>
        </div>
        <div className="flex items-center gap-2"></div>
        {/* Edit button */}
        <div className="flex items-center gap-2">
          {!editingHealth ? (
            <button
              onClick={startEditHealth}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit manually
            </button>
          ) : (
            <>
              <button
                onClick={() => setEditingHealth(false)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                onClick={saveHealth}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black transition hover:opacity-90"
              >
                <Save className="h-3.5 w-3.5" /> Save changes
              </button>
            </>
          )}
        </div>
      </div>

      {!editingHealth ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Ruler className="h-3.5 w-3.5 text-cyan-400" /> Height
              </span>
            </div>
            <div className="mt-2 text-2xl font-black text-white">
              {loading ? (
                "-"
              ) : height ? (
                <>
                  {height}{" "}
                  <span className="text-sm font-medium text-slate-400">cm</span>
                </>
              ) : (
                "-"
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Scale className="h-3.5 w-3.5 text-cyan-400" /> Weight
              </span>
            </div>
            <div className="mt-2 text-2xl font-black text-white">
              {loading ? (
                "-"
              ) : weight ? (
                <>
                  {weight}{" "}
                  <span className="text-sm font-medium text-slate-400">kg</span>
                </>
              ) : (
                "-"
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">BMI</span>
              {bmiInfo && (
                <span
                  className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${bmiInfo.bg} ${bmiInfo.color} border ${bmiInfo.border}`}
                >
                  {bmiInfo.label}
                </span>
              )}
            </div>
            <div className="mt-2 text-2xl font-black text-white">
              {loading ? "-" : bmi ? bmi.toFixed(1) : "-"}
            </div>
            {bmi && bmiInfo && (
              <div className="mt-2 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-full ${bmiInfo.bar}`}
                  style={{ width: `${Math.min(100, (bmi / 40) * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-slate-400">Height (cm)</span>
            <input
              type="number"
              value={userHeight}
              onChange={(e) => setUserHeight(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Weight (kg)</span>
            <input
              type="number"
              value={userWeight}
              onChange={(e) => setUserWeight(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
            />
          </label>
        </div>
      )}
    </div>
  );
}

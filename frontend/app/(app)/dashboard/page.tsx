"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Apple,
  BadgeCheck,
  //Calendar,
  Check,
  Flame,
  Footprints,
  Heart,
  Loader2,
  Pencil,
  Plus,
  Ruler,
  Save,
  Scale,
  Smartphone,
  Sparkles,
  Watch,
  X,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

import Calendar from "../../components/calendar";

/* ------------------------------------------------------------------ */
/* Mock data                                                          */
/* ------------------------------------------------------------------ */

type TrainingView = "daily" | "weekly" | "latest";
type FoodView = "daily" | "weekly";

const DAILY_TRAINING = [
  { label: "Mon", mileage: 4.2, avgHr: 138 },
  { label: "Tue", mileage: 0, avgHr: 0 },
  { label: "Wed", mileage: 6.8, avgHr: 151 },
  { label: "Thu", mileage: 3.1, avgHr: 129 },
  { label: "Fri", mileage: 0, avgHr: 0 },
  { label: "Sat", mileage: 9.5, avgHr: 146 },
  { label: "Sun", mileage: 5.4, avgHr: 133 },
];

const WEEKLY_TRAINING = [
  { label: "Wk 1", mileage: 22.4, avgHr: 136 },
  { label: "Wk 2", mileage: 27.1, avgHr: 141 },
  { label: "Wk 3", mileage: 18.6, avgHr: 132 },
  { label: "Wk 4", mileage: 31.8, avgHr: 144 },
  { label: "Wk 5", mileage: 29.0, avgHr: 139 },
  { label: "Wk 6", mileage: 33.5, avgHr: 147 },
];

const LATEST_ACTIVITY = {
  type: "Morning Threshold Run",
  date: "Today, 6:42 AM",
  distanceKm: 9.5,
  durationMin: 52,
  avgHr: 146,
  maxHr: 168,
  pace: "5:28 /km",
  calories: 612,
};

const DAILY_FOOD = [
  { label: "Mon", intake: 2140, goal: 2300 },
  { label: "Tue", intake: 2380, goal: 2300 },
  { label: "Wed", intake: 1980, goal: 2300 },
  { label: "Thu", intake: 2510, goal: 2300 },
  { label: "Fri", intake: 2260, goal: 2300 },
  { label: "Sat", intake: 2740, goal: 2300 },
  { label: "Sun", intake: 2050, goal: 2300 },
];

const WEEKLY_FOOD = [
  { label: "Wk 1", intake: 2180, goal: 2300 },
  { label: "Wk 2", intake: 2260, goal: 2300 },
  { label: "Wk 3", intake: 2390, goal: 2300 },
  { label: "Wk 4", intake: 2230, goal: 2300 },
  { label: "Wk 5", intake: 2310, goal: 2300 },
  { label: "Wk 6", intake: 2170, goal: 2300 },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
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
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HomePage() {
  // Health data
  const [height, setHeight] = useState<number | null>(null);
  const [weight, setWeight] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingHealth, setEditingHealth] = useState(false);
  const [userHeight, setUserHeight] = useState("");
  const [userWeight, setUserWeight] = useState("");

  // Import state
  const [importingSource, setImportingSource] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Training / food view toggles
  const [trainingView, setTrainingView] = useState<TrainingView>("latest");
  const [foodView, setFoodView] = useState<FoodView>("daily");

  const bmi = useMemo(() => {
    if (height && weight) return computeBmi(height, weight);
    return null;
  }, [height, weight]);
  const bmiInfo = bmi ? bmiCategory(bmi) : null;

  const trainingData =
    trainingView === "daily" ? DAILY_TRAINING : WEEKLY_TRAINING;
  const foodData = foodView === "daily" ? DAILY_FOOD : WEEKLY_FOOD;

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
    <div className="min-h-screen bg-slate-950 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              Today
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Your health, training and nutrition, all in one place.
            </p>
          </div>
          {syncMessage && (
            <span className="text-xs font-medium text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20 w-fit">
              {syncMessage}
            </span>
          )}
        </div>

        {/* Health data + Check-in row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Health data overview & editing */}
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
                        <span className="text-sm font-medium text-slate-400">
                          cm
                        </span>
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
                        <span className="text-sm font-medium text-slate-400">
                          kg
                        </span>
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

          {/* Daily check-in */}

          <Calendar />
        </div>

        {/* Training overview */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5">
            <div>
              <h3 className="text-base font-bold text-white">
                Training overview
              </h3>
              <p className="text-xs text-slate-400">
                Mileage and average heart rate
              </p>
            </div>
            <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1 w-fit">
              {(["daily", "weekly", "latest"] as TrainingView[]).map((view) => (
                <button
                  key={view}
                  onClick={() => setTrainingView(view)}
                  className={`px-3 py-1 rounded-md text-xs font-semibold capitalize transition ${
                    trainingView === view
                      ? "bg-emerald-500 text-black"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {view}
                </button>
              ))}
            </div>
          </div>

          {trainingView === "latest" ? (
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
              <div className="sm:col-span-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <Footprints className="h-4 w-4 text-emerald-400" />
                  {LATEST_ACTIVITY.type}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {LATEST_ACTIVITY.date}
                </p>
              </div>
              <StatBlock
                label="Distance"
                value={`${LATEST_ACTIVITY.distanceKm} km`}
              />
              <StatBlock
                label="Duration"
                value={`${LATEST_ACTIVITY.durationMin} min`}
              />
              <StatBlock
                label="Avg HR"
                value={`${LATEST_ACTIVITY.avgHr} bpm`}
                icon={<Heart className="h-3.5 w-3.5 text-rose-400" />}
              />
              <StatBlock label="Pace" value={LATEST_ACTIVITY.pace} />
              <StatBlock
                label="Calories"
                value={`${LATEST_ACTIVITY.calories} kcal`}
              />
            </div>
          ) : (
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trainingData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                  <YAxis yAxisId="left" stroke="#64748b" fontSize={11} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="#64748b"
                    fontSize={11}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      borderColor: "#334155",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="mileage"
                    fill="#10b981"
                    opacity={0.6}
                    radius={[4, 4, 0, 0]}
                    name="Mileage (km)"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="avgHr"
                    stroke="#38bdf8"
                    strokeWidth={2.5}
                    dot={false}
                    name="Avg HR"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Food consumption overview */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5">
            <div>
              <h3 className="text-base font-bold text-white">
                Food consumption
              </h3>
              <p className="text-xs text-slate-400">
                Calorie intake vs. daily goal
              </p>
            </div>
            <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1 w-fit">
              {(["daily", "weekly"] as FoodView[]).map((view) => (
                <button
                  key={view}
                  onClick={() => setFoodView(view)}
                  className={`px-3 py-1 rounded-md text-xs font-semibold capitalize transition ${
                    foodView === view
                      ? "bg-emerald-500 text-black"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {view}
                </button>
              ))}
            </div>
          </div>

          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={foodData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    borderColor: "#334155",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="intake" radius={[4, 4, 0, 0]} name="Calories">
                  {foodData.map((entry, idx) => (
                    <Cell
                      key={idx}
                      fill={entry.intake > entry.goal ? "#f59e0b" : "#10b981"}
                    />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="goal"
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  dot={false}
                  name="Goal"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small presentational helper                                        */
/* ------------------------------------------------------------------ */

function StatBlock({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <span className="text-xs text-slate-400 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <div className="mt-2 text-lg font-black text-white">{value}</div>
    </div>
  );
}

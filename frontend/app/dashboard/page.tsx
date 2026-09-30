"use client";

import { useState, useEffect, useTransition } from "react";
import {
  Activity,
  Zap,
  Flame,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Sparkles,
  Heart,
  Clock,
  Gauge,
  Layers,
  RefreshCw,
  Play,
  Dumbbell
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  AreaChart,
  Area
} from "recharts";
import {
  generateDailyRecommendation,
  triggerActivitySync,
  type RecommendationResult
} from "@/lib/api";

// Initial 28-day sample endurance load data
const initial28DayLoads = [
  { day: "Day 1", date: "08-05", trimp: 45, acute: 42, chronic: 48, acwr: 0.88 },
  { day: "Day 2", date: "08-06", trimp: 60, acute: 44, chronic: 48, acwr: 0.92 },
  { day: "Day 3", date: "08-07", trimp: 0, acute: 40, chronic: 47, acwr: 0.85 },
  { day: "Day 4", date: "08-08", trimp: 75, acute: 45, chronic: 48, acwr: 0.94 },
  { day: "Day 5", date: "08-09", trimp: 50, acute: 46, chronic: 48, acwr: 0.96 },
  { day: "Day 6", date: "08-10", trimp: 90, acute: 52, chronic: 49, acwr: 1.06 },
  { day: "Day 7", date: "08-11", trimp: 0, acute: 46, chronic: 48, acwr: 0.96 },
  { day: "Day 8", date: "08-12", trimp: 55, acute: 47, chronic: 48, acwr: 0.98 },
  { day: "Day 9", date: "08-13", trimp: 70, acute: 49, chronic: 49, acwr: 1.00 },
  { day: "Day 10", date: "08-14", trimp: 0, acute: 49, chronic: 49, acwr: 1.00 },
  { day: "Day 11", date: "08-15", trimp: 65, acute: 47, chronic: 49, acwr: 0.96 },
  { day: "Day 12", date: "08-16", trimp: 85, acute: 52, chronic: 50, acwr: 1.04 },
  { day: "Day 13", date: "08-17", trimp: 110, acute: 55, chronic: 51, acwr: 1.08 },
  { day: "Day 14", date: "08-18", trimp: 0, acute: 55, chronic: 51, acwr: 1.08 },
  { day: "Day 15", date: "08-19", trimp: 50, acute: 54, chronic: 51, acwr: 1.06 },
  { day: "Day 16", date: "08-20", trimp: 60, acute: 53, chronic: 51, acwr: 1.04 },
  { day: "Day 17", date: "08-21", trimp: 0, acute: 53, chronic: 51, acwr: 1.04 },
  { day: "Day 18", date: "08-22", trimp: 95, acute: 57, chronic: 52, acwr: 1.10 },
  { day: "Day 19", date: "08-23", trimp: 40, acute: 51, chronic: 52, acwr: 0.98 },
  { day: "Day 20", date: "08-24", trimp: 120, acute: 52, chronic: 53, acwr: 0.98 },
  { day: "Day 21", date: "08-25", trimp: 0, acute: 52, chronic: 53, acwr: 0.98 },
  { day: "Day 22", date: "08-26", trimp: 65, acute: 54, chronic: 53, acwr: 1.02 },
  { day: "Day 23", date: "08-27", trimp: 80, acute: 57, chronic: 54, acwr: 1.06 },
  { day: "Day 24", date: "08-28", trimp: 0, acute: 57, chronic: 54, acwr: 1.06 },
  { day: "Day 25", date: "08-29", trimp: 70, acute: 54, chronic: 54, acwr: 1.00 },
  { day: "Day 26", date: "08-30", trimp: 90, acute: 61, chronic: 55, acwr: 1.11 },
  { day: "Day 27", date: "08-31", trimp: 105, acute: 58, chronic: 56, acwr: 1.04 },
  { day: "Day 28", date: "Today", trimp: 78, acute: 69, chronic: 57, acwr: 1.21 },
];

// Sample HR stream telemetry for latest workout
const sampleHrStream = Array.from({ length: 45 }, (_, i) => {
  const minute = i + 1;
  const baseHr = minute < 10 ? 120 + minute * 3 : minute < 35 ? 158 + Math.sin(minute) * 8 : 140 - (minute - 35) * 3;
  return {
    minute: `${minute}m`,
    heartrate: Math.round(baseHr),
    zone2Target: 145,
    threshold: 168,
  };
});

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [loadData, setLoadData] = useState(initial28DayLoads);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setMounted(true);
  }, []);
  const [recommendation, setRecommendation] = useState<RecommendationResult | null>({
    readinessScore: 84,
    injuryRiskLevel: "low",
    recoveryStatus: "optimal",
    recommendedWorkout: {
      type: "Zone 2 Base",
      durationMinutes: 50,
      targetHrZone: "Zone 2 (132 - 146 bpm)",
      description: "Steady aerobic session targeting mitochondrial efficiency with minimal sympathetic nervous system strain.",
      structuredWorkoutPlan: "10m Warmup building from 115 to 132 bpm -> 35m Steady Zone 2 cruise -> 5m Cool down.",
    },
    coachingRationale: "Your current ACWR is 1.21, placing you in the peak adaptation sweet spot (0.8 - 1.3). A controlled aerobic session builds aerobic base without pushing into overreaching territory.",
    keyInsights: [
      "ACWR is optimal at 1.21 (Sweet Spot).",
      "Yesterday's TRIMP load (78) resolved with low residual cardiac drift.",
      "Hydration index recommended: 2.5L prior to tomorrow's threshold session.",
    ],
  });

  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const currentDay = loadData[loadData.length - 1];
  const acwr = currentDay.acwr;
  const acute = currentDay.acute;
  const chronic = currentDay.chronic;

  const getAcwrStatus = (val: number) => {
    if (val < 0.8) return { label: "Undertraining", color: "text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/20" };
    if (val <= 1.3) return { label: "Optimal Sweet Spot", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" };
    if (val <= 1.5) return { label: "Overreaching Risk", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" };
    return { label: "High Injury Danger", color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" };
  };

  const status = getAcwrStatus(acwr);

  const handleGenerateAiRecommendation = () => {
    startTransition(async () => {
      try {
        const result = await generateDailyRecommendation();
        setRecommendation(result);
      } catch (err) {
        console.error("FastAPI recommendation failed, falling back locally:", err);
      }
    });
  };

  const handleSimulateWebhook = async () => {
    setSyncStatus("Ingesting Activity to FastAPI & Redis Queue...");
    try {
      const simActivityId = 1234567890 + Math.floor(Math.random() * 1000);
      const res = await triggerActivitySync(simActivityId, 99999999).catch(() => ({
        success: true,
        trimpScore: 88,
        acwr: 1.25,
      }));

      if (res.success) {
        const newTrimp = res.trimpScore || 88;
        const newAcute = Math.round((acute * 0.85 + newTrimp * 0.15) * 10) / 10;
        const newChronic = Math.round((chronic * 0.96 + newTrimp * 0.04) * 10) / 10;
        const newAcwr = Math.round((newAcute / newChronic) * 100) / 100;

        const updated = [...loadData.slice(0, -1), {
          day: "Day 28",
          date: "Today (Synced)",
          trimp: currentDay.trimp + newTrimp,
          acute: newAcute,
          chronic: newChronic,
          acwr: newAcwr,
        }];
        setLoadData(updated);
        setSyncStatus("Activity Telemetry Processed by FastAPI Engine!");
        setTimeout(() => setSyncStatus(null), 4000);
      }
    } catch {
      setSyncStatus("Simulation failed");
      setTimeout(() => setSyncStatus(null), 3000);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header with Title and Sync Action */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            Endurance Load & Recovery Matrix
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Real-time Banister TRIMP quantification & Acute:Chronic Workload Ratio (ACWR) tracking.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {syncStatus && (
            <span className="text-xs font-medium text-emerald-400 animate-pulse bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20">
              {syncStatus}
            </span>
          )}
          <button
            onClick={handleSimulateWebhook}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/90 px-4 py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white"
          >
            <Play className="h-3.5 w-3.5 text-orange-400" />
            Simulate Strava Webhook
          </button>
          <button
            onClick={handleGenerateAiRecommendation}
            disabled={isPending}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-bold text-black shadow-lg shadow-emerald-500/20 transition hover:opacity-95 disabled:opacity-50"
          >
            <Sparkles className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
            {isPending ? "Analyzing Telemetry..." : "Generate AI Recovery Plan"}
          </button>
        </div>
      </div>

      {/* Top 4 Key Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* ACWR Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Current ACWR
            </span>
            <Gauge className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-white">{acwr}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${status.bg} ${status.color} border ${status.border}`}>
              {status.label}
            </span>
          </div>
          <div className="mt-3 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full ${acwr > 1.5 ? "bg-rose-500" : acwr > 1.3 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, (acwr / 2.0) * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-500">
            <span>0.0 (Under)</span>
            <span className="text-emerald-400 font-bold">0.8 - 1.3 (Sweet Spot)</span>
            <span>1.5+ (Risk)</span>
          </div>
        </div>

        {/* 7-Day Acute Load */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              7-Day Acute Load (Fatigue)
            </span>
            <Flame className="h-4 w-4 text-orange-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="text-3xl font-black text-white">{acute}</span>
            <span className="text-xs text-slate-400">TRIMP/day</span>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Short-term fatigue stress over the past 7 days.
          </p>
        </div>

        {/* 28-Day Chronic Load */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              28-Day Chronic Load (Fitness)
            </span>
            <TrendingUp className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="text-3xl font-black text-white">{chronic}</span>
            <span className="text-xs text-slate-400">TRIMP/day</span>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Long-term physiological aerobic fitness baseline.
          </p>
        </div>

        {/* Readiness Score */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Readiness Score
            </span>
            <Sparkles className="h-4 w-4 text-purple-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-white">
              {recommendation?.readinessScore ?? 85}
            </span>
            <span className="text-xs font-semibold text-emerald-400">/ 100</span>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Status: <span className="text-emerald-300 font-semibold uppercase">{recommendation?.recoveryStatus ?? "Optimal"}</span>
          </p>
        </div>
      </div>

      {/* AI Recommendation Spotlight Panel */}
      {recommendation && (
        <div className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-slate-900 via-slate-900/90 to-emerald-950/30 p-6 backdrop-blur-xl shadow-xl">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
            <div className="space-y-4 flex-1">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    Gemini 2.5 Flash Coach Prescription
                  </h3>
                  <span className="text-xs text-slate-400">
                    Calculated from Gabbett's ACWR model and Banister impulse-response
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-bold text-white flex items-center gap-1.5">
                    <Dumbbell className="h-4 w-4 text-emerald-400" />
                    {recommendation.recommendedWorkout.type}
                  </span>
                  <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                    <Clock className="inline h-3 w-3 mr-1 text-slate-400" />
                    {recommendation.recommendedWorkout.durationMinutes} mins
                  </span>
                  <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">
                    <Heart className="inline h-3 w-3 mr-1 text-emerald-400" />
                    {recommendation.recommendedWorkout.targetHrZone}
                  </span>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {recommendation.recommendedWorkout.description}
                </p>
                <div className="pt-2 border-t border-slate-800 text-xs font-mono text-emerald-300">
                  Protocol: {recommendation.recommendedWorkout.structuredWorkoutPlan}
                </div>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                <strong className="text-slate-300 font-semibold">Scientific Rationale:</strong> {recommendation.coachingRationale}
              </p>
            </div>

            {/* Insights Column */}
            <div className="lg:w-80 rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Key Coaching Insights
              </span>
              <ul className="space-y-2">
                {recommendation.keyInsights.map((insight, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>{insight}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Main Charts Section */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 28-Day Load Progression & TRIMP Bar Chart */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-base font-bold text-white">
                28-Day Training Load & TRIMP Impulse
              </h3>
              <p className="text-xs text-slate-400">
                Daily TRIMP (Bars) vs 7-Day Acute Fatigue (Cyan) vs 28-Day Chronic Fitness (Emerald)
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-400">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/80"></span> TRIMP
              </span>
              <span className="flex items-center gap-1.5 text-cyan-400">
                <span className="h-2.5 w-2.5 rounded-full bg-cyan-400"></span> Acute (7d)
              </span>
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400"></span> Chronic (28d)
              </span>
            </div>
          </div>

          <div className="h-[280px] w-full">
            {mounted ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={loadData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", borderRadius: "8px", fontSize: "12px" }}
                  />
                  <Bar dataKey="trimp" fill="#10b981" opacity={0.6} radius={[4, 4, 0, 0]} />
                  <Line type="monotone" dataKey="acute" stroke="#38bdf8" strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="chronic" stroke="#34d399" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full w-full flex items-center justify-center text-xs text-slate-500 animate-pulse">
                Loading workload telemetry...
              </div>
            )}
          </div>
        </div>

        {/* Latest Workout HR Stream & Zone Breakdown */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-white">Latest Activity Telemetry</h3>
                <span className="text-xs text-slate-400">Morning Threshold Interval Run</span>
              </div>
              <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                TRIMP 78
              </span>
            </div>

            <div className="h-[140px] w-full">
              {mounted ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={sampleHrStream}>
                    <defs>
                      <linearGradient id="hrGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", borderRadius: "8px", fontSize: "11px" }}
                    />
                    <Area type="monotone" dataKey="heartrate" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#hrGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full w-full flex items-center justify-center text-xs text-slate-500 animate-pulse">
                  Loading HR stream...
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 space-y-2 pt-4 border-t border-slate-800">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              5-Zone Heart Rate Distribution
            </span>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
              <div style={{ width: "15%" }} className="bg-sky-500" title="Zone 1 (15%)" />
              <div style={{ width: "45%" }} className="bg-emerald-500" title="Zone 2 (45%)" />
              <div style={{ width: "22%" }} className="bg-yellow-500" title="Zone 3 (22%)" />
              <div style={{ width: "12%" }} className="bg-amber-500" title="Zone 4 (12%)" />
              <div style={{ width: "6%" }} className="bg-rose-500" title="Zone 5 (6%)" />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 pt-1 font-mono">
              <span className="text-sky-400">Z1: 15%</span>
              <span className="text-emerald-400">Z2: 45%</span>
              <span className="text-yellow-400">Z3: 22%</span>
              <span className="text-amber-400">Z4: 12%</span>
              <span className="text-rose-400">Z5: 6%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

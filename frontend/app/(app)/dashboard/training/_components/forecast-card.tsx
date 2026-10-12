"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { trainingApi } from "@/lib/training/api";
import { formatShortDate } from "@/lib/training/dates";
import type { ForecastView, TrainingPlan } from "@/lib/training/types";
import { ErrorBox, Loading, cardClass } from "./ui";

interface Row {
  label: string;
  load?: number;
  fitted?: number;
  forecast?: number;
  band?: [number, number];
}

/** The chart's rows: every week of history, then the weeks ahead (the dashed line starts from the model's level now). */
function chartRows(view: ForecastView): Row[] {
  const fitted = new Map(view.fitted.map((w) => [w.weekStart, w.load]));
  const rows: Row[] = view.history.map((w) => ({
    label: formatShortDate(w.weekStart),
    load: w.load,
    fitted: fitted.get(w.weekStart),
  }));
  if (view.method === "holt" && view.level !== null && rows.length > 0) rows[rows.length - 1].forecast = view.level;
  for (const week of view.ahead) {
    rows.push({ label: formatShortDate(week.weekStart), forecast: week.value, band: [week.low, week.high] });
  }
  return rows;
}

const pct = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-bold text-white">{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}

/**
 * How the plan's weekly progression is worked out from the athlete's own training: their weekly load, the forecast
 * fitted to it, and each step from that trend to the rate the plan uses. Only completed workouts count: Strava
 * activities are never used, and nothing from the readiness score is involved.
 */
export function ForecastCard({ plan, refreshKey }: { plan: TrainingPlan | null; refreshKey: number }) {
  const [view, setView] = useState<ForecastView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    trainingApi
      .getForecast()
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your load forecast");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retry]);

  const rows = useMemo(() => (view ? chartRows(view) : []), [view]);

  if (error) return <ErrorBox message={error} onRetry={() => setRetry((n) => n + 1)} />;
  if (!view) return <Loading label="Loading your load forecast…" />;

  const fitted = view.method === "holt";
  // The trend only steers the rate as far as it did well on the athlete's own earlier weeks.
  const learned = fitted && (view.backtest?.trust ?? 0) > 0;
  const planRate = plan?.progressionPct ?? view.planProgressionPct;
  const apply =
    plan && planRate !== null && Math.abs(planRate - view.progressionPct) >= 0.05
      ? `Your plan was built at ${pct(planRate)} a week; today's forecast says ${pct(view.progressionPct)}. Adapt your plan to use it.`
      : !plan
        ? "Generate a plan and it will use this rate."
        : null;

  return (
    <div className={cardClass}>
      <div className="mb-4">
        <h3 className="text-base font-bold text-white">Load forecast</h3>
        <p className="text-xs text-slate-400">
          How fast your plan builds up is worked out from your own completed training, not a fixed number.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Weekly progression"
          value={pct(view.progressionPct)}
          hint={`${learned ? "learned from you" : fitted ? "standard rate, trend unproven" : "standard rate"} · cap ${pct(view.capPct)}`}
        />
        <Stat
          label="Your trend"
          value={view.trendPct === null ? "Not yet" : `${view.trendPct > 0 ? "+" : ""}${view.trendPct.toFixed(1)}% / wk`}
          hint={view.level === null ? "needs more weeks" : `level ${Math.round(view.level)} pts a week`}
        />
        <Stat
          label="History"
          value={fitted ? `${view.weeksOfHistory} weeks` : `${view.weeksOfHistory} of ${view.weeksNeeded} weeks`}
          hint={fitted ? `enough to fit your trend (needs ${view.weeksNeeded})` : "needed to fit your trend"}
        />
        <Stat
          label="Plan completion"
          value={view.adherence === null ? "n/a" : pct(Math.round(view.adherence * 100))}
          hint="of recent planned load done"
        />
      </div>

      {rows.length > 0 ? (
        <div className="mt-5 h-[260px] w-full" role="img" aria-label="Weekly completed load with the forecast">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip
                cursor={{ fill: "rgba(148, 163, 184, 0.08)" }}
                contentStyle={{
                  backgroundColor: "#0f172a",
                  borderColor: "#334155",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                labelStyle={{ color: "#f1f5f9" }}
                itemStyle={{ color: "#cbd5e1" }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="load" name="Completed (pts)" fill="#38bdf8" opacity={0.7} radius={[4, 4, 0, 0]} />
              {fitted && (
                <Area dataKey="band" name="80% range" stroke="none" fill="#f59e0b" fillOpacity={0.15} />
              )}
              {fitted && (
                <Line dataKey="fitted" name="Model, one week ahead" stroke="#10b981" dot={false} strokeWidth={2} connectNulls />
              )}
              {fitted && (
                <Line
                  dataKey="forecast"
                  name="Forecast"
                  stroke="#f59e0b"
                  strokeDasharray="5 4"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
          Nothing logged in the past weeks yet. Log your workouts and this chart fills in.
        </p>
      )}

      <h4 className="mt-5 text-sm font-semibold text-white">How your rate was set</h4>
      <ol className="mt-2 space-y-2">
        {view.steps.map((step, index) => (
          <li key={step.key} className="flex gap-3 text-xs text-slate-300">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700 text-[10px] font-bold text-slate-300">
              {index + 1}
            </span>
            <span>
              <span className="font-semibold text-white">{step.label}. </span>
              {step.detail}
            </span>
          </li>
        ))}
      </ol>

      {apply &&<p className="mt-3 text-xs text-amber-200">{apply}</p>}

      <p className="mt-3 text-[11px] text-slate-400">
        Built only from workouts you completed. Strava activities and readiness data are never used, and every plan
        still has to pass the weekly safety check.
      </p>
    </div>
  );
}

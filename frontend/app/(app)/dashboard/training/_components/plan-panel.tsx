"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { trainingApi } from "@/lib/training/api";
import { TRAINING_RULES as R } from "@/lib/training/config";
import { addDays, formatDay, formatShortDate } from "@/lib/training/dates";
import { fieldErrorsFrom, generatePlanSchema, numberFromInput } from "@/lib/training/schemas";
import type { Goal, Schedule, TrainingPlan, TrainingPreferences } from "@/lib/training/types";
import { ForecastCard } from "./forecast-card";
import {
  ConfirmDialog,
  ErrorBox,
  FieldError,
  Loading,
  btnPrimary,
  btnSecondary,
  cardClass,
  inputClass,
} from "./ui";

/** What the plan's goal did to it. Only activities the user chose are ever used, hence "when you've chosen them". */
const GOAL_NOTE: Record<Goal | "none", string> = {
  lose_weight: "Weight loss. Run and cycling sessions get extra turns in your mix, when you've chosen them.",
  build_muscle: "Muscle gain. Gym and bodyweight sessions get extra turns in your mix, when you've chosen them.",
  maintain: "Maintenance. Your chosen activities are mixed evenly.",
  none: "No goal found in your profile, so your chosen activities are mixed evenly.",
};

function GoalNote({ goal }: { goal: Goal | null }) {
  return (
    <p className="mt-3 text-xs text-slate-400">
      <span className="font-semibold text-slate-300">Goal: </span>
      {GOAL_NOTE[goal ?? "none"]}{" "}
      <Link href="/dashboard/settings" className="font-semibold text-emerald-400 hover:underline">
        Change it in Settings
      </Link>
      . It applies the next time a plan is generated or adapted.
    </p>
  );
}

function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${swatch}`} aria-hidden="true" />
      {label}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface WeekRow {
  week: number;
  label: string;
  start: string;
  end: string;
  deload: boolean;
  target: number;
  done: number;
  sessionsDone: number;
  sessionsTotal: number;
}

function weekRows(plan: TrainingPlan, schedule: Schedule): WeekRow[] {
  const sessions = schedule.sessions.filter((s) => s.planId === plan.id);
  return Array.from({ length: plan.weeks }, (_, i) => {
    const start = addDays(plan.startDate, i * 7);
    const end = addDays(start, 6);
    const inWeek = sessions.filter((s) => s.date >= start && s.date <= end);
    return {
      week: i + 1,
      label: `Wk ${i + 1}`,
      start,
      end,
      deload: inWeek.some((s) => s.intensityBand === "deload"),
      target: inWeek.reduce((sum, s) => sum + s.targetVolume, 0),
      done: schedule.workouts
        .filter((w) => w.date >= start && w.date <= end)
        .reduce((sum, w) => sum + w.actualVolume, 0),
      sessionsDone: inWeek.filter((s) => s.status === "completed" || s.status === "partial").length,
      sessionsTotal: inWeek.length,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function PlanPanel({
  preferences,
  plan,
  refreshKey,
  onChanged,
  onNotice,
  onGoToPreferences,
}: {
  preferences: TrainingPreferences | null;
  plan: TrainingPlan | null;
  refreshKey: number;
  onChanged: () => void;
  onNotice: (message: string) => void;
  onGoToPreferences: () => void;
}) {
  const [weeks, setWeeks] = useState(String(R.planWeeks.default));
  const [weeksError, setWeeksError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<"replace" | "adapt" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const planId = plan?.id;
  const planStart = plan?.startDate;
  const planEnd = plan?.endDate;
  useEffect(() => {
    if (!planStart || !planEnd) {
      setSchedule(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    trainingApi
      .getSchedule(planStart, planEnd)
      .then((data) => {
        if (!cancelled) setSchedule(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your plan");
      });
    return () => {
      cancelled = true;
    };
  }, [planId, planStart, planEnd, refreshKey, retry]);

  const rows = useMemo(() => (plan && schedule ? weekRows(plan, schedule) : []), [plan, schedule]);

  function validateWeeks() {
    const parsed = generatePlanSchema.safeParse({ weeks: numberFromInput(weeks) });
    if (!parsed.success) {
      setWeeksError(fieldErrorsFrom(parsed.error).weeks);
      return null;
    }
    setWeeksError(undefined);
    return parsed.data.weeks;
  }

  function handleGenerate() {
    setError(null);
    const count = validateWeeks();
    if (count === null) return;
    if (plan) setConfirm("replace");
    else void runGenerate(count, false);
  }

  async function runGenerate(count: number, confirmReplace: boolean) {
    setBusy(true);
    setError(null);
    const result = await trainingApi.generatePlan({ weeks: count, confirmReplace });
    setBusy(false);
    setConfirm(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onNotice(`New ${count}-week plan created`);
    onChanged();
  }

  async function runAdapt() {
    setBusy(true);
    setError(null);
    const result = await trainingApi.recalculatePlan();
    setBusy(false);
    setConfirm(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onNotice("Plan adapted. The banner above explains what changed and why.");
    onChanged();
  }

  const canGenerate = preferences !== null;

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-bold text-white">
              {plan ? "Your training plan" : "Generate a training plan"}
            </h3>
            <p className="text-xs text-slate-400">
              {plan
                ? `${formatDay(plan.startDate)} to ${formatDay(plan.endDate)} · ${plan.weeks} weeks · baseline ${plan.baselineVolume} pts/week${plan.progressionPct !== null ? ` · +${plan.progressionPct.toFixed(1)}% a week` : ""}`
                : "Built from your preferences, your profile goal and activity level, and the last 4 weeks of completed training."}
            </p>
            {plan && <GoalNote goal={plan.goal} />}
          </div>
        </div>

        {!canGenerate && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            <span>Set your training preferences before generating a plan.</span>
            <button type="button" onClick={onGoToPreferences} className={btnSecondary}>
              Set preferences
            </button>
          </div>
        )}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="block sm:w-56">
            <span className="text-xs text-slate-400">
              Plan length in weeks ({R.planWeeks.min}–{R.planWeeks.max})
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={R.planWeeks.min}
              max={R.planWeeks.max}
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
              disabled={!canGenerate}
              aria-invalid={Boolean(weeksError)}
              className={`${inputClass} disabled:opacity-50`}
            />
            <FieldError message={weeksError} />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate || busy}
              className={btnPrimary}
            >
              {busy && confirm === null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {plan ? "Replace plan" : "Generate plan"}
            </button>
            {plan && (
              <button
                type="button"
                onClick={() => setConfirm("adapt")}
                disabled={busy}
                className={btnSecondary}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Adapt plan
              </button>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
            {error}
          </p>
        )}

        {plan && (
          <p className="mt-4 text-xs text-slate-400">
            Your plan also adapts on its own after {R.missedSessionsTrigger} missed sessions in a
            row, or {R.lowReadinessDaysTrigger} days in a row of low readiness. You&apos;ll always
            be told when it happens and why. You can also plan sessions yourself on the Schedule tab.
            Adapting rebuilds the weeks still to come, including those.
          </p>
        )}
      </div>

      <ForecastCard plan={plan} refreshKey={refreshKey} />

      {plan && (
        <div className="flex gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{plan.notice}</p>
        </div>
      )}

      {plan && loadError && <ErrorBox message={loadError} onRetry={() => setRetry((n) => n + 1)} />}
      {plan && !schedule && !loadError && <Loading label="Loading plan…" />}

      {plan && schedule && (
        <>
          <div className={cardClass}>
            <div className="mb-5">
              <h3 className="text-base font-bold text-white">Weekly load</h3>
              <p className="text-xs text-slate-400">Planned load against what you completed.</p>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-300">
                <LegendItem swatch="bg-emerald-500/60" label="Planned" />
                <LegendItem swatch="bg-amber-500/60" label="Planned (deload week)" />
                <LegendItem swatch="bg-sky-400" label="Completed" />
              </ul>
            </div>
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows}>
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
                  <Bar dataKey="target" name="Planned (pts)" radius={[4, 4, 0, 0]} opacity={0.6}>
                    {rows.map((row) => (
                      <Cell key={row.week} fill={row.deload ? "#f59e0b" : "#10b981"} />
                    ))}
                  </Bar>
                  <Bar dataKey="done" name="Completed (pts)" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className={`${cardClass} overflow-x-auto`}>
            <h3 className="mb-4 text-base font-bold text-white">Week by week</h3>
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="pb-2 font-semibold">Week</th>
                  <th className="pb-2 font-semibold">Dates</th>
                  <th className="pb-2 font-semibold">Type</th>
                  <th className="pb-2 text-right font-semibold">Planned</th>
                  <th className="pb-2 text-right font-semibold">Completed</th>
                  <th className="pb-2 text-right font-semibold">Sessions</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {rows.map((row) => (
                  <tr key={row.week} className="border-t border-slate-800">
                    <td className="py-2 font-semibold text-white">{row.week}</td>
                    <td className="py-2">
                      {formatShortDate(row.start)} – {formatShortDate(row.end)}
                    </td>
                    <td className="py-2">{row.deload ? "Deload" : "Loading"}</td>
                    <td className="py-2 text-right">{row.target} pts</td>
                    <td className="py-2 text-right">{row.done} pts</td>
                    <td className="py-2 text-right">
                      {row.sessionsDone}/{row.sessionsTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirm === "replace" && (
        <ConfirmDialog
          title="Replace your current plan?"
          confirmLabel="Replace plan"
          busy={busy}
          onConfirm={() => {
            const count = validateWeeks();
            if (count !== null) void runGenerate(count, true);
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>
            A new plan replaces your current one. Sessions still to come are removed, including any you
            added or moved yourself. Anything you already logged stays in your history.
          </p>
        </ConfirmDialog>
      )}

      {confirm === "adapt" && (
        <ConfirmDialog
          title="Adapt your plan?"
          confirmLabel="Adapt plan"
          busy={busy}
          onConfirm={runAdapt}
          onCancel={() => setConfirm(null)}
        >
          <p>
            Your plan is rebuilt from what you actually completed, not from what was planned. Only
            the weeks still to come change, and sessions you added, moved or edited in them are rebuilt
            too. You&apos;ll be shown what changed and why.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

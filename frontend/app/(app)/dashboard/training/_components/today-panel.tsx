"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  Check,
  Clock,
  Info,
  Loader2,
  Lock,
  Minus,
  Plus,
  Repeat,
  SkipForward,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { trainingApi, type SessionResponse } from "@/lib/training/api";
import { formatDay } from "@/lib/training/dates";
import { MOVABLE_STATUSES, LOGGABLE_STATUSES } from "@/lib/training/rules";
import type {
  ActivityType,
  ReadinessFactor,
  ReadinessScore,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
} from "@/lib/training/types";
import { LogWorkoutDialog, type LogTarget } from "./log-workout-dialog";
import { ScorerNote } from "./scorer-note";
import {
  ACTIVITY_LABEL,
  ActivityIcon,
  BAND_META,
  BandBadge,
  ErrorBox,
  Loading,
  StatusBadge,
  ToggleChip,
  btnHero,
  btnPrimary,
  btnSecondary,
  cardClass,
} from "./ui";

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function TodayPanel({
  preferences,
  plan,
  refreshKey,
  onChanged,
  onNotice,
  onGoTo,
}: {
  preferences: TrainingPreferences | null;
  plan: TrainingPlan | null;
  refreshKey: number;
  onChanged: () => void;
  onNotice: (message: string) => void;
  onGoTo: (tab: "plan" | "preferences") => void;
}) {
  const [view, setView] = useState<TodayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    trainingApi
      .getToday()
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load today's workout");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retry]);

  async function respond(response: SessionResponse, message: string) {
    if (!view?.planned) return;
    setBusy(true);
    setActionError(null);
    const result = await trainingApi.respondToSession(view.planned.id, response);
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setSwapping(false);
    onNotice(message);
    onChanged();
  }

  if (loadError) return <ErrorBox message={loadError} onRetry={() => setRetry((n) => n + 1)} />;
  if (!view) return <Loading label="Loading today's workout…" />;

  const { planned, recommendation, logged, readiness } = view;
  const canRespond = planned !== null && MOVABLE_STATUSES.includes(planned.status);
  const canLog = planned !== null && LOGGABLE_STATUSES.includes(planned.status);
  const swapChoices: ActivityType[] = (preferences?.activityTypes ?? []).filter(
    (type) => type !== planned?.activityType,
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <ReadinessCard readiness={readiness} />

      <div className={`${cardClass} lg:col-span-2 flex flex-col`}>
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-white">Today&apos;s workout</h3>
            <p className="text-xs text-slate-400">{formatDay(view.date)}</p>
          </div>
          {planned && <StatusBadge status={planned.status} />}
        </div>

        {!planned ? (
          <NoSessionToday
            hasPlan={plan !== null}
            hasPreferences={preferences !== null}
            onGoTo={onGoTo}
            onLogAdHoc={() => setLogTarget({ session: null, date: view.date })}
          />
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-xs text-slate-400">Planned</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-white">
                <span className="flex items-center gap-1.5 font-bold">
                  <ActivityIcon type={planned.activityType} className="h-4 w-4 text-emerald-400" />
                  {ACTIVITY_LABEL[planned.activityType]}
                </span>
                <BandBadge band={planned.intensityBand} />
                <span className="flex items-center gap-1 text-slate-300">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {planned.targetDurationMin} min
                </span>
                <span className="text-slate-300">{planned.targetVolume} pts</span>
              </div>
            </div>

            {canRespond && recommendation && (
              <div
                className={`rounded-xl border p-4 ${
                  recommendation.downgraded
                    ? "border-sky-500/30 bg-sky-500/5"
                    : "border-emerald-500/20 bg-emerald-500/5"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-slate-300">Recommended today</p>
                  <BandBadge band={recommendation.intensityBand} />
                  {recommendation.downgraded && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-sky-300">
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      Adjusted down from {BAND_META[planned.intensityBand].label}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white">
                  <span className="flex items-center gap-1 text-slate-200">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {recommendation.targetDurationMin} min
                  </span>
                  <span className="text-slate-200">{recommendation.targetVolume} pts</span>
                </div>
                <p className="mt-3 flex gap-2 text-xs text-slate-300">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                  {recommendation.explanation}
                </p>
              </div>
            )}

            {logged && (
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
                <p className="text-xs text-slate-400">Logged</p>
                <p className="mt-1">
                  {logged.actualDurationMin} min · {logged.actualVolume} pts
                  {logged.rpe !== null && ` · RPE ${logged.rpe}`}
                  {logged.avgHr !== null && ` · ${logged.avgHr} bpm avg`}
                </p>
              </div>
            )}

            {planned.status === "missed" && (
              <p className="text-xs text-slate-400">
                This session is marked as missed. If you did it after all, you can still log it.
              </p>
            )}

            {actionError && (
              <p role="alert" className="text-xs text-rose-400">
                {actionError}
              </p>
            )}

            {swapping && (
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="mb-2 text-xs text-slate-400">Swap today&apos;s activity to</p>
                <div className="flex flex-wrap gap-2">
                  {swapChoices.map((type) => (
                    <ToggleChip
                      key={type}
                      pressed={false}
                      onClick={() =>
                        respond(
                          { action: "swap", activityType: type },
                          `Swapped to ${ACTIVITY_LABEL[type].toLowerCase()}`,
                        )
                      }
                    >
                      <ActivityIcon type={type} />
                      {ACTIVITY_LABEL[type]}
                    </ToggleChip>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {canRespond && planned.status !== "accepted" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond({ action: "accept" }, "Session accepted")}
                  className={btnPrimary}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Accept
                </button>
              )}
              {canLog && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setLogTarget({ session: planned, date: view.date })}
                  className={planned.status === "accepted" || planned.status === "missed" ? btnPrimary : btnSecondary}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Log workout
                </button>
              )}
              {canRespond && (
                <>
                  <button
                    type="button"
                    disabled={busy || swapChoices.length === 0}
                    onClick={() => setSwapping((s) => !s)}
                    aria-expanded={swapping}
                    title={swapChoices.length === 0 ? "Add another activity type in Preferences to swap" : undefined}
                    className={btnSecondary}
                  >
                    <Repeat className="h-3.5 w-3.5" aria-hidden="true" />
                    Swap
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      respond({ action: "skip" }, "Session skipped. It counts as a missed session.")
                    }
                    className={btnSecondary}
                  >
                    <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
                    Skip
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {logTarget && (
        <LogWorkoutDialog
          target={logTarget}
          onClose={() => setLogTarget(null)}
          onLogged={(message) => {
            onNotice(message);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

function ReadinessCard({ readiness }: { readiness: ReadinessScore }) {
  const meta = BAND_META[readiness.classification];
  return (
    <div className={cardClass}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-white">Readiness</h3>
          <p className="text-xs text-slate-400">Daily score</p>
        </div>
        <span className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Only visible to you
        </span>
      </div>

      <div className="flex items-center gap-4">
        <ReadinessGauge score={readiness.score} stroke={meta.stroke} />
        <div className="space-y-2">
          <BandBadge band={readiness.classification} />
          <p className="text-sm font-semibold text-white">{meta.hint}</p>
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-300">{readiness.explanation}</p>

      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold text-slate-300">What&apos;s driving this score</p>
        <ul className="space-y-2">
          {readiness.factors.map((factor) => (
            <FactorRow key={factor.key} factor={factor} />
          ))}
        </ul>
      </div>

      <ScorerNote />
    </div>
  );
}

function ReadinessGauge({ score, stroke }: { score: number; stroke: string }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg
        viewBox="0 0 120 120"
        className="h-full w-full -rotate-90"
        role="img"
        aria-label={`Readiness score ${score} out of 100`}
      >
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(circumference * score) / 100} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black text-white">{score}</span>
        <span className="text-[10px] text-slate-400">out of 100</span>
      </div>
    </div>
  );
}

const FACTOR_META = {
  positive: { icon: TrendingUp, label: "Helping", color: "text-emerald-400" },
  negative: { icon: TrendingDown, label: "Hurting", color: "text-rose-400" },
  neutral: { icon: Minus, label: "Neutral", color: "text-slate-400" },
} as const;

function FactorRow({ factor }: { factor: ReadinessFactor }) {
  const meta = FACTOR_META[factor.impact];
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.color}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white">{factor.label}</span>
          <span className={`text-[10px] font-semibold ${meta.color}`}>{meta.label}</span>
        </div>
        <p className="text-[11px] text-slate-400">{factor.detail}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

function NoSessionToday({
  hasPlan,
  hasPreferences,
  onGoTo,
  onLogAdHoc,
}: {
  hasPlan: boolean;
  hasPreferences: boolean;
  onGoTo: (tab: "plan" | "preferences") => void;
  onLogAdHoc: () => void;
}) {
  if (!hasPlan) {
    const steps = [
      { label: "Set your training preferences", done: hasPreferences },
      { label: "Generate a plan", done: false },
      { label: "Follow today's recommended workout", done: false },
    ];
    return (
      <div className="flex flex-1 flex-col justify-center gap-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h4 className="text-base font-bold text-white">Let&apos;s build your plan</h4>
            <p className="mt-1 text-sm text-slate-400">
              {hasPreferences
                ? "Your preferences are saved. Generate a plan and today's recommended workout shows up here."
                : "Tell us how you like to train, then generate a plan. Today's recommended workout shows up here."}
            </p>
          </div>
        </div>

        <ol className="space-y-2">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm"
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${
                  step.done
                    ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-400"
                    : "border-slate-700 bg-slate-800 text-slate-400"
                }`}
              >
                {step.done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
              </span>
              <span className={step.done ? "text-slate-400 line-through" : "text-slate-200"}>
                {step.label}
              </span>
              <span className="sr-only">{step.done ? "(done)" : "(to do)"}</span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onGoTo(hasPreferences ? "plan" : "preferences")}
            className={btnHero}
          >
            {hasPreferences ? "Generate my plan" : "Set preferences"}
          </button>
          <button type="button" onClick={onLogAdHoc} className={btnSecondary}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Log ad hoc session
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-300">
        Rest day. Nothing is scheduled today, so recovery is the workout.
      </p>
      <button type="button" onClick={onLogAdHoc} className={btnSecondary}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Log ad hoc session
      </button>
    </div>
  );
}

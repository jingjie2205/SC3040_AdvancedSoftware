"use client";

import { Dumbbell, Flame, Loader2, Sparkles, type LucideIcon } from "lucide-react";
import type { ChallengeMetric } from "@/lib/gamification/types";

/*
 * Same class strings and pieces as dashboard/training/_components/ui.tsx so the pages look alike.
 * Move both into a shared components folder once the training branch is merged.
 */

export const cardClass =
  "rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md";

export const tileClass = "rounded-xl border border-slate-800 bg-slate-950/60 p-4";

export const inputClass =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500";

// Names arrive with the friends feature (F-1); until then only the current user is named.
export function displayName({ userId, isCurrentUser }: { userId: string; isCurrentUser: boolean }): string {
  return isCurrentUser ? "You" : `Athlete ${userId.slice(-4).toUpperCase()}`;
}

export const CHALLENGE_METRIC_INFO: Record<
  ChallengeMetric,
  { label: string; unit: string; hint: string; icon: LucideIcon; defaultTarget: number }
> = {
  xp: { label: "XP earned", unit: "XP", hint: "XP from check-ins, workouts and meal logs", icon: Sparkles, defaultTarget: 500 },
  checkin_streak: { label: "Check-in streak", unit: "days", hint: "Longest run of daily check-ins", icon: Flame, defaultTarget: 7 },
  sessions: { label: "Workouts", unit: "workouts", hint: "Workouts logged on the Training page", icon: Dumbbell, defaultTarget: 10 },
};

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-rose-400">
      {message}
    </p>
  );
}

export const btnPrimary =
  "flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const btnSecondary =
  "flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";

export function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-base font-bold text-white">{title}</h3>
      <p className="text-xs text-slate-400">{subtitle}</p>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={btnSecondary}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition ${
            value === option.value ? "bg-emerald-500 text-black" : "text-slate-400 hover:text-white"
          }`}
        >
          {option.icon && <option.icon className="h-3.5 w-3.5" aria-hidden="true" />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

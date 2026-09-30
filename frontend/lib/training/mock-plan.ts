/**
 * Fixture-only plan generation. Stands in for the real generator until the backend exists,
 * so the UI has something realistic to render. Not the source of truth for any rule.
 */
import { TRAINING_RULES as R } from "./config";
import { addDays, diffDays, startOfWeek } from "./dates";
import type { TrainingPreferencesInput } from "./schemas";
import { WEEKDAYS } from "./types";
import type { IntensityBand, PlannedSession, WorkoutSession } from "./types";

const BAND_WEIGHT: Record<IntensityBand, number> = { push: 1, light: 0.7, deload: 0.6 };
const DURATION_FACTOR: Record<IntensityBand, number> = { push: 1, light: 0.75, deload: 0.6 };

const roundTo5 = (n: number) => Math.max(15, Math.round(n / 5) * 5);

export type SessionDraft = Omit<PlannedSession, "id" | "planId">;

export interface Baseline {
  volume: number;
  sessionCount: number;
  usedDefault: boolean;
}

/**
 * Mean weekly volume over the last few complete weeks before the week containing `asOf`,
 * counting only weeks with training. Whole weeks are used so no week is cut in half.
 */
export function baselineFromHistory(workouts: WorkoutSession[], asOf: string): Baseline {
  const end = startOfWeek(asOf);
  const from = addDays(end, -7 * R.baselineWindowWeeks);
  const recent = workouts.filter((w) => w.date >= from && w.date < end);
  const weeks = new Set(recent.map((w) => startOfWeek(w.date)));
  if (weeks.size < R.minHistoryWeeksForBaseline) {
    return { volume: R.defaultBaselineVolume, sessionCount: recent.length, usedDefault: true };
  }
  const total = recent.reduce((sum, w) => sum + w.actualVolume, 0);
  return { volume: Math.round(total / weeks.size), sessionCount: recent.length, usedDefault: false };
}

export interface WeekTarget {
  volume: number;
  deload: boolean;
}

/** `weekOffset` keeps the deload rhythm aligned when only the remaining weeks are regenerated. */
export function weeklyTargets(baseline: number, weeks: number, weekOffset = 0): WeekTarget[] {
  const targets: WeekTarget[] = [];
  let loading = baseline;
  for (let w = 0; w < weeks; w++) {
    if ((w + weekOffset + 1) % R.deloadEveryNWeeks === 0) {
      targets.push({ volume: Math.round(loading * R.deloadVolumeFactor), deload: true });
    } else {
      if (w > 0) loading *= 1 + R.weeklyProgressionPct / 100;
      targets.push({ volume: Math.round(loading), deload: false });
    }
  }
  return targets;
}

/**
 * Index of the first week whose increase exceeds the safe threshold, or -1.
 * A loading week is compared with the previous loading week, so the rebound after a deload is fine.
 */
export function firstUnsafeWeek(targets: WeekTarget[]): number {
  let previous: number | null = null;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].deload) continue;
    if (previous !== null && ((targets[i].volume - previous) / previous) * 100 > R.maxWeeklyIncreasePct) {
      return i;
    }
    previous = targets[i].volume;
  }
  return -1;
}

export function planEndDate(startDate: string, weeks: number): string {
  return addDays(startDate, weeks * 7 - 1);
}

interface BuildArgs {
  prefs: TrainingPreferencesInput;
  /** Monday of the first week to generate. */
  startDate: string;
  targets: WeekTarget[];
  /** Sessions before this date are left out (already in the past). */
  fromDate: string;
}

export function buildSessions({ prefs, startDate, targets, fromDate }: BuildArgs): SessionDraft[] {
  const available = WEEKDAYS.flatMap((day, index) => (prefs.restDays.includes(day) ? [] : [index]));
  const perWeek = Math.min(prefs.daysPerWeek, available.length);
  if (perWeek === 0) return [];

  const drafts: SessionDraft[] = [];
  // Every third session is a push, and a push never follows another on the next day, even across weeks.
  let lastPush: string | null = null;
  targets.forEach((target, week) => {
    const weekStart = addDays(startDate, week * 7);
    const unbanded = Array.from({ length: perWeek }, (_, i) => ({
      order: i,
      date: addDays(weekStart, available[Math.floor((i * available.length) / perWeek)]),
    })).filter((slot) => slot.date >= fromDate);
    if (unbanded.length === 0) return;

    const slots = unbanded.map((slot) => {
      let band: IntensityBand = target.deload ? "deload" : slot.order % 3 === 0 ? "push" : "light";
      if (band === "push") {
        if (lastPush !== null && diffDays(slot.date, lastPush) <= 1) band = "light";
        else lastPush = slot.date;
      }
      return { ...slot, band };
    });
    const weightTotal = slots.reduce((sum, s) => sum + BAND_WEIGHT[s.band], 0);
    const weekVolume = (target.volume * slots.length) / perWeek;

    for (const slot of slots) {
      const band = slot.band;
      drafts.push({
        date: slot.date,
        activityType: prefs.activityTypes[(slot.order + week) % prefs.activityTypes.length],
        targetVolume: Math.round((weekVolume * BAND_WEIGHT[band]) / weightTotal),
        targetDurationMin: roundTo5(prefs.sessionDurationMin * DURATION_FACTOR[band]),
        intensityBand: band,
        status: "planned",
      });
    }
  });
  return drafts;
}

/** Session targets after readiness pulls it to a different band. */
export function rescaleForBand(
  session: Pick<PlannedSession, "targetVolume" | "targetDurationMin" | "intensityBand">,
  band: IntensityBand,
) {
  const from = session.intensityBand;
  return {
    targetVolume: Math.round((session.targetVolume / BAND_WEIGHT[from]) * BAND_WEIGHT[band]),
    targetDurationMin: roundTo5((session.targetDurationMin / DURATION_FACTOR[from]) * DURATION_FACTOR[band]),
  };
}

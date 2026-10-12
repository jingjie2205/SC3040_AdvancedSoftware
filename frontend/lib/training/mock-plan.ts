/**
 * Fixture-only plan generation. Stands in for the real generator until the backend exists,
 * so the UI has something realistic to render. Not the source of truth for any rule.
 */
import { TRAINING_RULES as R } from "./config";
import { addDays, diffDays, startOfWeek } from "./dates";
import type { TrainingPreferencesInput } from "./schemas";
import { WEEKDAYS } from "./types";
import type {
  ActivityType,
  Goal,
  IntensityBand,
  PlannedSession,
  TrainingPlan,
  WorkoutSession,
} from "./types";

const BAND_WEIGHT: Record<IntensityBand, number> = R.bandWeight;
const DURATION_FACTOR: Record<IntensityBand, number> = R.bandDurationFactor;

const roundTo5 = (n: number) => Math.max(R.sessionDurationMin.min, Math.round(n / 5) * 5);

/** Mirrors the backend: a goal gives the activities it favours extra turns in the weekly rotation. */
const GOAL_TURNS: Record<Goal, Partial<Record<ActivityType, number>>> = {
  lose_weight: { run: 2, cycling: 2 },
  build_muscle: { gym: 2, bodyweight: 2 },
  maintain: {},
};

/** The user's own list when nothing is favoured; otherwise the favoured types repeat, interleaved. */
export function activityRotation(types: ActivityType[], goal: Goal | null): ActivityType[] {
  const turns = goal ? GOAL_TURNS[goal] : {};
  const counts = types.map((type) => Math.max(1, turns[type] ?? 1));
  const rotation: ActivityType[] = [];
  for (let round = 0; round < Math.max(...counts); round++) {
    types.forEach((type, index) => {
      if (round < counts[index]) rotation.push(type);
    });
  }
  return rotation;
}

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
export function weeklyTargets(
  baseline: number,
  weeks: number,
  weekOffset = 0,
  progressionPct: number | null = null,
): WeekTarget[] {
  // The weekly increase learned from the athlete's own history (forecast.ts), or the standard one without it.
  const step = progressionPct ?? R.weeklyProgressionPct;
  const targets: WeekTarget[] = [];
  let loading = baseline;
  for (let w = 0; w < weeks; w++) {
    if ((w + weekOffset + 1) % R.deloadEveryNWeeks === 0) {
      targets.push({ volume: Math.round(loading * R.deloadVolumeFactor), deload: true });
    } else {
      if (w > 0) loading *= 1 + step / 100;
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
  /** Tilts which of the user's activities come up more often. */
  goal?: Goal | null;
}

/** How many sessions a full week of the plan has: the days wanted, or every free day if there are fewer. */
export function sessionsPerWeek(prefs: Pick<TrainingPreferencesInput, "daysPerWeek" | "restDays">): number {
  return Math.min(prefs.daysPerWeek, WEEKDAYS.filter((day) => !prefs.restDays.includes(day)).length);
}

export function buildSessions({ prefs, startDate, targets, fromDate, goal = null }: BuildArgs): SessionDraft[] {
  const available = WEEKDAYS.flatMap((day, index) => (prefs.restDays.includes(day) ? [] : [index]));
  const perWeek = sessionsPerWeek(prefs);
  if (perWeek === 0) return [];
  const rotation = activityRotation(prefs.activityTypes, goal);

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
        activityType: rotation[(slot.order + week) % rotation.length],
        targetVolume: Math.round((weekVolume * BAND_WEIGHT[band]) / weightTotal),
        targetDurationMin: roundTo5(prefs.sessionDurationMin * DURATION_FACTOR[band]),
        intensityBand: band,
        status: "planned",
      });
    }
  });
  return drafts;
}

/**
 * The load the plan itself set for the Monday-to-Sunday week starting `weekMonday`, or null for a week it doesn't
 * cover or one an adaptation has already left behind. Mirrors the server's `plan_week_target`.
 */
export function planWeekTarget(plan: TrainingPlan, weekMonday: string): number | null {
  const index = Math.floor(diffDays(weekMonday, plan.startDate) / 7);
  if (index < 0 || index >= plan.weeks) return null;
  const elapsed = plan.lastAdaptation
    ? Math.max(0, Math.floor(diffDays(startOfWeek(plan.lastAdaptation.adaptedOn), plan.startDate) / 7))
    : 0;
  if (index < elapsed) return null;
  return weeklyTargets(plan.baselineVolume, plan.weeks - elapsed, elapsed, plan.progressionPct)[index - elapsed].volume;
}

/** What a session counts for when a week's load is shared out: intensity times length. */
export const weightOf = (band: IntensityBand, minutes: number) => BAND_WEIGHT[band] * minutes;

/**
 * The points a week's sessions still to do share once there are `sessionsAfter` of them. The week carries the plan's
 * load (`target`) with the usual number of sessions (`perWeek`) and a proportional share with fewer, as the generator
 * builds a week that is already partly gone. Mirrors the server's `week_pool`.
 */
export function weekPool(
  target: number,
  finished: number,
  now: number,
  sessionsAfter: number,
  perWeek: number,
): number {
  const usual = perWeek > 0 ? Math.round((target * sessionsAfter) / perWeek) : target;
  return Math.max(now, Math.min(target - finished, usual));
}

export interface WeekShare {
  newVolume: number;
  others: Record<string, number>;
}

/** `total` in whole points in proportion to `basis`, adding up exactly: the biggest remainders get the spare points. */
function split(total: number, basis: number[]): number[] {
  if (basis.length === 0) return [];
  const sum = basis.reduce((a, b) => a + b, 0);
  const exact = basis.map((part) => (total * part) / sum);
  const parts = exact.map((value) => Math.floor(value));
  const byRemainder = parts
    .map((_, i) => i)
    .sort((a, b) => exact[b] - parts[b] - (exact[a] - parts[a]) || a - b);
  const spare = total - parts.reduce((a, b) => a + b, 0);
  for (const i of byRemainder.slice(0, spare)) parts[i] += 1;
  return parts;
}

/**
 * A session joins a week that has `pool` points left to do, or one already in it changes weight. It takes its share
 * by weight, and the others keep their proportions to one another and split what is left, so the week still adds up
 * to `pool`. Every session keeps at least one point. Mirrors the server's `share_week`.
 */
export function shareWeek(
  pool: number,
  others: { id: string; volume: number; weight: number }[],
  newWeight: number,
): WeekShare {
  const totalWeight = others.reduce((sum, s) => sum + s.weight, 0) + newWeight;
  const newVolume = Math.round((pool * newWeight) / totalWeight);
  const current = others.map((s) => s.volume);
  const basis = current.reduce((a, b) => a + b, 0) > 0 ? current : others.map((s) => s.weight);
  const volumes = [newVolume, ...split(Math.max(pool - newVolume, 0), basis)];
  for (let i = 0; i < volumes.length; i++) {
    while (volumes[i] < 1) {
      const donor = volumes.indexOf(Math.max(...volumes));
      if (volumes[donor] <= 1) break;
      volumes[donor] -= 1;
      volumes[i] += 1;
    }
  }
  return {
    newVolume: volumes[0],
    others: Object.fromEntries(others.map((s, i) => [s.id, volumes[i + 1]])),
  };
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

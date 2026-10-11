import { TRAINING_RULES } from "./config";
import { addDays, diffDays } from "./dates";
import type { IntensityBand, PlannedSession, SessionStatus, TrainingPlan } from "./types";

export const MOVABLE_STATUSES: readonly SessionStatus[] = ["planned", "accepted", "moved"];
export const LOGGABLE_STATUSES: readonly SessionStatus[] = ["planned", "accepted", "moved", "missed"];

export type MoveRefusalCode =
  | "NOT_MOVABLE"
  | "NO_CHANGE"
  | "IN_PAST"
  | "OUT_OF_PLAN"
  | "DAY_OCCUPIED"
  | "CONSECUTIVE_HIGH_INTENSITY";

export type MoveCheck =
  | { ok: true }
  | { ok: false; code: MoveRefusalCode; reason: string; suggestedDate: string | null };

export interface MoveContext {
  /** Every session the athlete has in and around the plan's days, whichever plan it belongs to. */
  sessions: PlannedSession[];
  planStart: string;
  planEnd: string;
  today: string;
}

const isHighIntensity = (s: PlannedSession) => s.intensityBand === TRAINING_RULES.highIntensityBand;

/** Whether `session` may sit on `target`: today or later, inside the plan, a free day, no push beside a push. */
function placementRefusal(
  session: PlannedSession,
  target: string,
  ctx: MoveContext,
): { code: MoveRefusalCode; reason: string } | null {
  if (target < ctx.today) {
    return { code: "IN_PAST", reason: "A session can't be on a day that has already passed." };
  }
  if (target < ctx.planStart || target > ctx.planEnd) {
    return { code: "OUT_OF_PLAN", reason: "That date is outside your plan." };
  }
  const others = ctx.sessions.filter((s) => s.id !== session.id);
  if (others.some((s) => s.date === target)) {
    return { code: "DAY_OCCUPIED", reason: "Another session is already on that day." };
  }
  if (isHighIntensity(session)) {
    const before = addDays(target, -1);
    const after = addDays(target, 1);
    const clash = others.some(
      (s) =>
        isHighIntensity(s) &&
        s.status !== "missed" &&
        (s.date === before || s.date === after),
    );
    if (clash) {
      return {
        code: "CONSECUTIVE_HIGH_INTENSITY",
        reason: "Two high-intensity (push) sessions can't be on consecutive days.",
      };
    }
  }
  return null;
}

function findRefusal(
  session: PlannedSession,
  target: string,
  ctx: MoveContext,
  moving: boolean,
): { code: MoveRefusalCode; reason: string } | null {
  if (moving) {
    if (!MOVABLE_STATUSES.includes(session.status)) {
      return { code: "NOT_MOVABLE", reason: "Completed, partial and missed sessions can't be moved." };
    }
    if (target === session.date) {
      return { code: "NO_CHANGE", reason: "That session is already on this day." };
    }
  }
  return placementRefusal(session, target, ctx);
}

/** Nearest day to `target` (later day preferred on a tie) where the move would be allowed. */
function nearestValidDate(
  session: PlannedSession,
  target: string,
  ctx: MoveContext,
  moving: boolean,
): string | null {
  for (let offset = 1; offset <= 14; offset++) {
    for (const candidate of [addDays(target, offset), addDays(target, -offset)]) {
      if (findRefusal(session, candidate, ctx, moving) === null) return candidate;
    }
  }
  return null;
}

function check(session: PlannedSession, target: string, ctx: MoveContext, moving: boolean): MoveCheck {
  const refusal = findRefusal(session, target, ctx, moving);
  if (!refusal) return { ok: true };
  const canSuggest = refusal.code !== "NOT_MOVABLE" && refusal.code !== "NO_CHANGE";
  return {
    ok: false,
    ...refusal,
    suggestedDate: canSuggest ? nearestValidDate(session, target, ctx, moving) : null,
  };
}

/**
 * Shared by the reschedule dialog (to warn early) and the API layer (which is authoritative).
 */
export function checkMove(session: PlannedSession, target: string, ctx: MoveContext): MoveCheck {
  return check(session, target, ctx, true);
}

/**
 * The same day rules for a session that isn't on the calendar yet, or one whose intensity is changing where it
 * stands. Staying on its own day is the point here, so there is no "no change".
 */
export function checkPlacement(session: PlannedSession, target: string, ctx: MoveContext): MoveCheck {
  return check(session, target, ctx, false);
}

/* ------------------------------------------------------------------ */
/* Planning a week by hand                                             */
/* ------------------------------------------------------------------ */

/** Whether the plan's week starting `weekMonday` is a deload week (every session in it is a deload). */
export function isDeloadWeek(plan: TrainingPlan, weekMonday: string): boolean {
  const index = Math.floor(diffDays(weekMonday, plan.startDate) / 7);
  return index >= 0 && index < plan.weeks && (index + 1) % TRAINING_RULES.deloadEveryNWeeks === 0;
}

/** The intensities a hand-planned session can have in that week: deload weeks stay all-deload and the others never hold one. */
export function bandsForWeek(plan: TrainingPlan, weekMonday: string): IntensityBand[] {
  return isDeloadWeek(plan, weekMonday) ? ["deload"] : ["push", "light"];
}

/** Why a hand-planned session can't have this intensity in this week, or null. Same wording as the server's. */
export function bandRefusal(band: IntensityBand, deloadWeek: boolean): string | null {
  if (deloadWeek && band !== "deload") return "This is a deload week, so its sessions stay at Deload intensity.";
  if (!deloadWeek && band === "deload") return "Deload is only for deload weeks. Pick Light or Push.";
  return null;
}

/** How long a session at this intensity is when nobody picks a length: the preferred length scaled by the band. */
export function defaultDurationMin(preferredMin: number, band: IntensityBand): number {
  const scaled = Math.round((preferredMin * TRAINING_RULES.bandDurationFactor[band]) / 5) * 5;
  return Math.max(TRAINING_RULES.sessionDurationMin.min, scaled);
}

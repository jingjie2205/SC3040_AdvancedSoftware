import { TRAINING_RULES } from "./config";
import { addDays } from "./dates";
import type { PlannedSession, SessionStatus } from "./types";

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
  sessions: PlannedSession[];
  planStart: string;
  planEnd: string;
  today: string;
}

const isHighIntensity = (s: PlannedSession) => s.intensityBand === TRAINING_RULES.highIntensityBand;

function findRefusal(
  session: PlannedSession,
  target: string,
  ctx: MoveContext,
): { code: MoveRefusalCode; reason: string } | null {
  if (!MOVABLE_STATUSES.includes(session.status)) {
    return { code: "NOT_MOVABLE", reason: "Completed, partial and missed sessions can't be moved." };
  }
  if (target === session.date) {
    return { code: "NO_CHANGE", reason: "That session is already on this day." };
  }
  if (target < ctx.today) {
    return { code: "IN_PAST", reason: "Sessions can't be moved to a past date." };
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

/** Nearest day to `target` (later day preferred on a tie) where the move would be allowed. */
function nearestValidDate(session: PlannedSession, target: string, ctx: MoveContext): string | null {
  for (let offset = 1; offset <= 14; offset++) {
    for (const candidate of [addDays(target, offset), addDays(target, -offset)]) {
      if (findRefusal(session, candidate, ctx) === null) return candidate;
    }
  }
  return null;
}

/**
 * Shared by the reschedule dialog (to warn early) and the API layer (which is authoritative).
 */
export function checkMove(session: PlannedSession, target: string, ctx: MoveContext): MoveCheck {
  const refusal = findRefusal(session, target, ctx);
  if (!refusal) return { ok: true };
  const canSuggest = refusal.code !== "NOT_MOVABLE" && refusal.code !== "NO_CHANGE";
  return {
    ok: false,
    ...refusal,
    suggestedDate: canSuggest ? nearestValidDate(session, target, ctx) : null,
  };
}

import { describe, expect, it } from "vitest";
import {
  bandRefusal,
  bandsForWeek,
  checkMove,
  checkPlacement,
  defaultDurationMin,
  isDeloadWeek,
  type MoveContext,
} from "@/lib/training/rules";
import type { IntensityBand, PlannedSession, SessionStatus, TrainingPlan } from "@/lib/training/types";

/*
 * Black-box tests of the rules that decide where a session may stand (T-7 Reschedule). They are plain functions, so
 * each test states the situation (a plan, "today", the other sessions), the move asked for and the answer expected.
 * The plan runs Monday 2 November to Sunday 29 November 2026 and today is Wednesday 4 November.
 */

const PLAN_START = "2026-11-02";
const PLAN_END = "2026-11-29";
const TODAY = "2026-11-04";

function session(id: string, date: string, band: IntensityBand, status: SessionStatus = "planned"): PlannedSession {
  return {
    id,
    planId: "plan-1",
    date,
    activityType: "run",
    targetVolume: 40,
    targetDurationMin: 45,
    intensityBand: band,
    status,
  };
}

const context = (sessions: PlannedSession[], today = TODAY): MoveContext => ({
  sessions,
  planStart: PLAN_START,
  planEnd: PLAN_END,
  today,
});

const REFUSED = { ok: false } as const;

describe("T-7 moving a session", () => {
  it("T-7.03: a planned session can move to a free day inside the plan", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, "2026-11-08", context([light]))).toEqual({ ok: true });
  });

  it.each<SessionStatus>(["planned", "accepted", "moved"])("T-7.04: a %s session can be moved", (status) => {
    const mover = session("m", "2026-11-07", "light", status);
    expect(checkMove(mover, "2026-11-10", context([mover]))).toEqual({ ok: true });
  });

  it.each<SessionStatus>(["completed", "partial", "missed"])(
    "T-7.04: a %s session can't be moved and no other day is suggested",
    (status) => {
      const mover = session("m", "2026-11-07", "light", status);
      expect(checkMove(mover, "2026-11-10", context([mover]))).toEqual({
        ok: false,
        code: "NOT_MOVABLE",
        reason: "Completed, partial and missed sessions can't be moved.",
        suggestedDate: null,
      });
    },
  );

  it("T-7.05: moving a session to the day it is already on is refused", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, "2026-11-07", context([light]))).toEqual({
      ok: false,
      code: "NO_CHANGE",
      reason: "That session is already on this day.",
      suggestedDate: null,
    });
  });

  it("T-7.06: moving a session to a day that has passed is refused and today is suggested", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, "2026-11-03", context([light]))).toEqual({
      ok: false,
      code: "IN_PAST",
      reason: "A session can't be on a day that has already passed.",
      suggestedDate: "2026-11-04",
    });
  });

  it("T-7.06: today itself is allowed (boundary)", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, TODAY, context([light]))).toEqual({ ok: true });
  });

  it("T-7.07: the day after the plan ends is refused and the last plan day is suggested", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, "2026-11-30", context([light]))).toEqual({
      ok: false,
      code: "OUT_OF_PLAN",
      reason: "That date is outside your plan.",
      suggestedDate: PLAN_END,
    });
  });

  it("T-7.07: the last day of the plan is allowed (boundary)", () => {
    const light = session("light", "2026-11-07", "light");
    expect(checkMove(light, PLAN_END, context([light]))).toEqual({ ok: true });
  });

  it("T-7.07: the day before a plan that has not started is refused, its first day is allowed", () => {
    const light = session("light", "2026-11-07", "light");
    const early = context([light], "2026-10-28");
    expect(checkMove(light, "2026-11-01", early)).toMatchObject({
      ok: false,
      code: "OUT_OF_PLAN",
      suggestedDate: PLAN_START,
    });
    expect(checkMove(light, PLAN_START, early)).toEqual({ ok: true });
  });
});

describe("T-7 no two push sessions on the same or consecutive days", () => {
  const anchor = session("anchor", "2026-11-12", "push"); // Thursday
  const mover = session("mover", "2026-11-09", "push"); // Monday
  const sessions = [anchor, mover];
  const reason = "Two high-intensity (push) sessions can't be on the same day or on consecutive days.";

  it.each([
    ["the day before", "2026-11-11"],
    ["the same day as", "2026-11-12"],
    ["the day after", "2026-11-13"],
  ])("T-7.08: a push moved to %s another push is refused (%s)", (_where, target) => {
    expect(checkMove(mover, target, context(sessions))).toMatchObject({
      ...REFUSED,
      code: "CONSECUTIVE_HIGH_INTENSITY",
      reason,
    });
  });

  it.each([
    ["two days before", "2026-11-10"],
    ["two days after", "2026-11-14"],
  ])("T-7.08: a push moved %s another push is allowed (boundary)", (_where, target) => {
    expect(checkMove(mover, target, context(sessions))).toEqual({ ok: true });
  });

  it("T-7.09: the nearest valid day is suggested", () => {
    expect(checkMove(mover, "2026-11-11", context(sessions))).toMatchObject({ suggestedDate: "2026-11-10" });
    expect(checkMove(mover, "2026-11-13", context(sessions))).toMatchObject({ suggestedDate: "2026-11-14" });
  });

  it("T-7.09: when a day before and a day after are equally near, the later one is suggested", () => {
    expect(checkMove(mover, "2026-11-12", context(sessions))).toMatchObject({ suggestedDate: "2026-11-14" });
  });

  it("T-7.10: a light session may share a day with a push", () => {
    const light = session("light", "2026-11-09", "light");
    expect(checkMove(light, "2026-11-12", context([anchor, light]))).toEqual({ ok: true });
  });

  it("T-7.10: a deload session may be next to a push", () => {
    const deload = session("deload", "2026-11-09", "deload");
    expect(checkMove(deload, "2026-11-13", context([anchor, deload]))).toEqual({ ok: true });
  });

  it("T-7.10: a missed push no longer counts against the rule", () => {
    const missed = session("anchor", "2026-11-12", "push", "missed");
    expect(checkMove(mover, "2026-11-13", context([missed, mover]))).toEqual({ ok: true });
  });

  it("T-7.10: a completed push still counts", () => {
    const done = session("anchor", "2026-11-12", "push", "completed");
    expect(checkMove(mover, "2026-11-13", context([done, mover]))).toMatchObject({
      code: "CONSECUTIVE_HIGH_INTENSITY",
    });
  });

  it("T-7.10: the session being moved never counts against itself", () => {
    expect(checkMove(mover, "2026-11-10", context([mover]))).toEqual({ ok: true });
  });
});

describe("T-7 placing a session that is not on the calendar yet", () => {
  const anchor = session("anchor", "2026-11-12", "push");

  it("T-7.11: staying on its own day is not 'no change' for a session being added or edited", () => {
    const fresh = session("fresh", "2026-11-09", "light");
    expect(checkPlacement(fresh, "2026-11-09", context([fresh]))).toEqual({ ok: true });
  });

  it("T-7.11: a new push beside an existing push is refused with a suggestion", () => {
    const fresh = session("fresh", "2026-11-13", "push");
    expect(checkPlacement(fresh, "2026-11-13", context([anchor, fresh]))).toMatchObject({
      ok: false,
      code: "CONSECUTIVE_HIGH_INTENSITY",
      suggestedDate: "2026-11-14",
    });
  });

  it("T-7.11: a day in the past or outside the plan is refused", () => {
    const fresh = session("fresh", "2026-11-09", "light");
    expect(checkPlacement(fresh, "2026-11-03", context([fresh]))).toMatchObject({ ok: false, code: "IN_PAST" });
    expect(checkPlacement(fresh, "2026-12-01", context([fresh]))).toMatchObject({ ok: false, code: "OUT_OF_PLAN" });
  });
});

/* ------------------------------------------------------------------ hand planning: intensity and length by week */

const plan: TrainingPlan = {
  id: "plan-1",
  startDate: PLAN_START,
  endDate: "2026-12-27",
  weeks: 8,
  status: "active",
  baselineVolume: 100,
  createdAt: "2026-11-02T08:00:00Z",
  notice: "",
  goal: null,
  lastAdaptation: null,
  progressionPct: null,
};

describe("T-7 deload weeks when planning by hand", () => {
  it.each([
    ["2026-11-02", false],
    ["2026-11-09", false],
    ["2026-11-16", false],
    ["2026-11-23", true], // the 4th week
    ["2026-11-30", false],
    ["2026-12-21", true], // the 8th week
  ])("T-7.12: the plan week starting %s is a deload week: %s", (monday, expected) => {
    expect(isDeloadWeek(plan, monday)).toBe(expected);
  });

  it("T-7.12: weeks before or after the plan are never deload weeks", () => {
    expect(isDeloadWeek(plan, "2026-10-26")).toBe(false);
    expect(isDeloadWeek(plan, "2026-12-28")).toBe(false);
  });

  it("T-7.12: a deload week takes only deload sessions, any other week takes push or light", () => {
    expect(bandsForWeek(plan, "2026-11-23")).toEqual(["deload"]);
    expect(bandsForWeek(plan, "2026-11-09")).toEqual(["push", "light"]);
  });

  it.each<[IntensityBand, boolean, string | null]>([
    ["push", true, "This is a deload week, so its sessions stay at Deload intensity."],
    ["light", true, "This is a deload week, so its sessions stay at Deload intensity."],
    ["deload", true, null],
    ["deload", false, "Deload is only for deload weeks. Pick Light or Push."],
    ["push", false, null],
    ["light", false, null],
  ])("T-7.12: %s in a deload week (%s) gives the refusal %j", (band, deloadWeek, refusal) => {
    expect(bandRefusal(band, deloadWeek)).toBe(refusal);
  });
});

describe("T-7 default length of a hand-planned session", () => {
  it.each<[number, IntensityBand, number]>([
    [45, "push", 45],
    [45, "light", 35],
    [45, "deload", 25],
    [60, "light", 45],
    [60, "deload", 35],
    [180, "push", 180],
    [15, "push", 15],
  ])("T-7.13: a preferred length of %s min at %s intensity gives %s min", (preferred, band, expected) => {
    expect(defaultDurationMin(preferred, band)).toBe(expected);
  });

  it("T-7.13: the length never falls under the 15 minute minimum", () => {
    expect(defaultDurationMin(20, "deload")).toBe(15);
  });
});

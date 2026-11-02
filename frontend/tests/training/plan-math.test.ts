import { describe, expect, it } from "vitest";
import { addDays, diffDays, weekdayIndex } from "@/lib/training/dates";
import {
  activityRotation,
  baselineFromHistory,
  buildSessions,
  firstUnsafeWeek,
  planEndDate,
  planWeekTarget,
  rescaleForBand,
  sessionsPerWeek,
  shareWeek,
  weekPool,
  weeklyTargets,
} from "@/lib/training/mock-plan";
import type { TrainingPreferencesInput } from "@/lib/training/schemas";
import type { ActivityType, Goal, TrainingPlan, WorkoutSession } from "@/lib/training/types";

/*
 * Black-box tests of the arithmetic behind T-2 (generate a plan) and the load sharing that T-7 relies on. Every test
 * states the inputs, runs one function and checks the numbers it should give. Weeks start on a Monday; the plan used
 * throughout starts on Monday 2 November 2026.
 */

const START = "2026-11-02";

function workout(date: string, volume: number, source: WorkoutSession["source"] = "manual"): WorkoutSession {
  return {
    id: `w-${date}-${volume}`,
    plannedSessionId: null,
    date,
    activityType: "run",
    actualVolume: volume,
    actualDurationMin: 40,
    rpe: null,
    avgHr: null,
    calories: null,
    distanceM: null,
    source,
    externalId: null,
    createdAt: `${date}T08:00:00Z`,
  };
}

/* ------------------------------------------------------------------ T-2 weekly targets: deload rhythm and progression */

describe("T-2 weekly volume targets", () => {
  it("T-2.02: the default plan adds 5% a week and every fourth week is a deload at 70% of the load before it", () => {
    const targets = weeklyTargets(100, 8);
    expect(targets.map((t) => t.volume)).toEqual([100, 105, 110, 77, 116, 122, 128, 89]);
    expect(targets.map((t) => t.deload)).toEqual([false, false, false, true, false, false, false, true]);
  });

  it("T-2.02: a plan shorter than four weeks has no deload week", () => {
    expect(weeklyTargets(100, 3).some((t) => t.deload)).toBe(false);
  });

  it("T-2.02: regenerating only the remaining weeks keeps the deload rhythm of the original plan", () => {
    // Two weeks have gone, so the first of the four weeks left is the plan's 3rd and the second its 4th (a deload).
    const targets = weeklyTargets(100, 4, 2);
    expect(targets.map((t) => t.deload)).toEqual([false, true, false, false]);
    expect(targets.map((t) => t.volume)).toEqual([100, 70, 105, 110]);
  });

  it("T-2.03: a learned weekly rate replaces the standard 5%", () => {
    expect(weeklyTargets(100, 3, 0, 8).map((t) => t.volume)).toEqual([100, 108, 117]);
  });

  it("T-2.03: a rate of 0% keeps the load flat", () => {
    expect(weeklyTargets(100, 3, 0, 0).map((t) => t.volume)).toEqual([100, 100, 100]);
  });
});

describe("T-2 the safe week-on-week increase", () => {
  const loading = (...volumes: number[]) => volumes.map((volume) => ({ volume, deload: false }));

  it("T-2.04: a plan at the standard rate is safe", () => {
    expect(firstUnsafeWeek(weeklyTargets(100, 16))).toBe(-1);
  });

  it("T-2.04: the highest learned rate allowed (8%) stays safe", () => {
    expect(firstUnsafeWeek(weeklyTargets(100, 16, 0, 8))).toBe(-1);
  });

  it("T-2.04: an increase of exactly 10% is safe and one just over it is not (boundary)", () => {
    expect(firstUnsafeWeek(loading(100, 110))).toBe(-1);
    expect(firstUnsafeWeek(loading(1000, 1101))).toBe(1);
  });

  it("T-2.04: the first week over the limit is reported", () => {
    expect(firstUnsafeWeek(loading(100, 105, 120, 140))).toBe(2);
  });

  it("T-2.04: a rate of 11% a week is unsafe from the second week", () => {
    expect(firstUnsafeWeek(weeklyTargets(100, 8, 0, 11))).toBe(1);
  });

  it("T-2.04: a fall in load is never unsafe", () => {
    expect(firstUnsafeWeek(loading(100, 80, 60))).toBe(-1);
  });

  it("T-2.04: the rebound after a deload week is compared with the loading week before it", () => {
    const rebound = (volume: number) => [
      { volume: 100, deload: false },
      { volume: 70, deload: true },
      { volume, deload: false },
    ];
    expect(firstUnsafeWeek(rebound(105))).toBe(-1);
    expect(firstUnsafeWeek(rebound(115))).toBe(2);
  });
});

/* ------------------------------------------------------------------ T-2 baseline from history */

describe("T-2 baseline weekly volume", () => {
  const ASOF = "2026-11-04"; // Wednesday; the weeks counted are the whole weeks before Monday 2 November

  it("T-2.05: with no history the conservative default of 100 is used", () => {
    expect(baselineFromHistory([], ASOF)).toEqual({ volume: 100, sessionCount: 0, usedDefault: true });
  });

  it("T-2.05: with only one week of history the default is still used (fewer than 2 weeks)", () => {
    const history = [workout("2026-10-27", 60), workout("2026-10-29", 90)];
    expect(baselineFromHistory(history, ASOF)).toEqual({ volume: 100, sessionCount: 2, usedDefault: true });
  });

  it("T-2.05: with two weeks of history the baseline is their mean weekly volume", () => {
    const history = [
      workout("2026-10-20", 60),
      workout("2026-10-22", 40), // week of 19 Oct: 100
      workout("2026-10-27", 90),
      workout("2026-10-30", 50), // week of 26 Oct: 140
    ];
    expect(baselineFromHistory(history, ASOF)).toEqual({ volume: 120, sessionCount: 4, usedDefault: false });
  });

  it("T-2.05: the current week is left out, and so is anything older than the last four whole weeks", () => {
    const history = [
      workout("2026-10-04", 500), // Sunday of the fifth week back
      workout("2026-10-06", 80),
      workout("2026-10-27", 120),
      workout("2026-11-03", 900), // this week
    ];
    expect(baselineFromHistory(history, ASOF)).toEqual({ volume: 100, sessionCount: 2, usedDefault: false });
  });

  it("T-2.05: weeks without any training are not counted in the mean", () => {
    const history = [workout("2026-10-06", 100), workout("2026-10-27", 200)];
    expect(baselineFromHistory(history, ASOF).volume).toBe(150);
  });

  it("T-2.05: a half point rounds up", () => {
    const history = [workout("2026-10-13", 100), workout("2026-10-27", 101)];
    expect(baselineFromHistory(history, ASOF).volume).toBe(101);
  });

  it("HR-3.01: a user who trained nothing in the last weeks gets the conservative default, not a plan that assumes they did", () => {
    const history = [workout("2026-09-15", 200), workout("2026-09-17", 200), workout("2026-09-22", 200)];
    expect(baselineFromHistory(history, ASOF)).toEqual({ volume: 100, sessionCount: 0, usedDefault: true });
  });
});

/* ------------------------------------------------------------------ T-2 sessions: how many, where, how hard */

const prefs: TrainingPreferencesInput = {
  daysPerWeek: 3,
  sessionDurationMin: 45,
  activityTypes: ["run", "gym"],
  restDays: ["sat", "sun"],
  examDates: [],
};

describe("T-2 sessions in a plan", () => {
  it.each<[number, TrainingPreferencesInput["restDays"], number]>([
    [4, ["sat", "sun"], 4],
    [5, ["mon", "tue", "wed", "thu", "fri"], 2],
    [7, [], 7],
    [1, [], 1],
  ])("T-2.06: %s days a week with rest days %j gives %s sessions a week", (daysPerWeek, restDays, expected) => {
    expect(sessionsPerWeek({ daysPerWeek, restDays })).toBe(expected);
  });

  it("T-2.07: an 8 week plan starting on 2 November ends on Sunday 27 December", () => {
    expect(planEndDate(START, 8)).toBe("2026-12-27");
    expect(planEndDate(START, 2)).toBe("2026-11-15");
  });

  it("T-2.08: three days a week gives three sessions a week on free days only, the first one a push", () => {
    const drafts = buildSessions({ prefs, startDate: START, targets: weeklyTargets(100, 8), fromDate: START });
    expect(drafts).toHaveLength(24);
    expect(drafts.slice(0, 3).map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-05"]);
    expect(drafts.slice(0, 3).map((d) => d.intensityBand)).toEqual(["push", "light", "light"]);
    expect(drafts.every((d) => weekdayIndex(d.date) <= 4)).toBe(true); // never on Saturday or Sunday
    expect(drafts.every((d) => d.status === "planned")).toBe(true);
  });

  it("T-2.08: the week's load is shared by intensity and the session length follows the intensity", () => {
    const drafts = buildSessions({ prefs, startDate: START, targets: weeklyTargets(100, 8), fromDate: START });
    expect(drafts.slice(0, 3).map((d) => d.targetVolume)).toEqual([42, 29, 29]);
    expect(drafts.slice(0, 3).map((d) => d.targetDurationMin)).toEqual([45, 35, 35]);
  });

  it("T-2.08: each week's sessions add up to the week's target within rounding", () => {
    const targets = weeklyTargets(100, 8);
    const drafts = buildSessions({ prefs, startDate: START, targets, fromDate: START });
    targets.forEach((target, week) => {
      const weekStart = addDays(START, week * 7);
      const total = drafts
        .filter((d) => diffDays(d.date, weekStart) >= 0 && diffDays(d.date, weekStart) < 7)
        .reduce((sum, d) => sum + d.targetVolume, 0);
      expect(Math.abs(total - target.volume)).toBeLessThanOrEqual(2);
    });
  });

  it("T-2.08: a deload week holds only deload sessions", () => {
    const drafts = buildSessions({ prefs, startDate: START, targets: weeklyTargets(100, 8), fromDate: START });
    const deloadWeeks = [3, 7].flatMap((week) =>
      drafts.filter((d) => Math.floor(diffDays(d.date, START) / 7) === week),
    );
    expect(deloadWeeks).toHaveLength(6);
    expect(deloadWeeks.every((d) => d.intensityBand === "deload")).toBe(true);
    expect(drafts.filter((d) => d.intensityBand === "deload")).toHaveLength(6);
  });

  it("T-2.08: sessions before the starting date are left out and the rest keep their intensity", () => {
    const drafts = buildSessions({ prefs, startDate: START, targets: weeklyTargets(100, 4), fromDate: "2026-11-04" });
    expect(drafts[0].date).toBe("2026-11-05");
    expect(drafts[0].intensityBand).toBe("light");
    expect(drafts).toHaveLength(10); // Thursday of the first week, then three sessions in each of the other three weeks
  });

  it("T-2.08: with seven training days no push follows another push on the next day, even across weeks", () => {
    const everyDay: TrainingPreferencesInput = { ...prefs, daysPerWeek: 7, restDays: [] };
    const drafts = buildSessions({ prefs: everyDay, startDate: START, targets: weeklyTargets(100, 8), fromDate: START });
    const pushDays = drafts.filter((d) => d.intensityBand === "push").map((d) => d.date);
    expect(pushDays.length).toBeGreaterThan(0);
    for (let i = 1; i < pushDays.length; i++) expect(diffDays(pushDays[i], pushDays[i - 1])).toBeGreaterThanOrEqual(2);
    // Sunday 8 November is a push, so Monday 9 November is a light session instead of a push.
    expect(drafts.find((d) => d.date === "2026-11-08")?.intensityBand).toBe("push");
    expect(drafts.find((d) => d.date === "2026-11-09")?.intensityBand).toBe("light");
  });

  it("T-2.08: the activities rotate through the ones chosen", () => {
    const drafts = buildSessions({ prefs, startDate: START, targets: weeklyTargets(100, 2), fromDate: START });
    expect(drafts.slice(0, 6).map((d) => d.activityType)).toEqual(["run", "gym", "run", "gym", "run", "gym"]);
  });

  it("T-2.08: seven training days a week gives seven sessions in each week", () => {
    const everyDay: TrainingPreferencesInput = { ...prefs, daysPerWeek: 7, restDays: [] };
    const drafts = buildSessions({ prefs: everyDay, startDate: START, targets: weeklyTargets(100, 2), fromDate: START });
    expect(drafts).toHaveLength(14);
  });
});

describe("T-2 the fitness goal tilts the activity mix", () => {
  it.each<[Goal | null, ActivityType[], ActivityType[]]>([
    [null, ["run", "gym"], ["run", "gym"]],
    ["maintain", ["run", "gym"], ["run", "gym"]],
    ["build_muscle", ["run", "gym"], ["run", "gym", "gym"]],
    ["lose_weight", ["run", "gym", "cycling", "bodyweight"], ["run", "gym", "cycling", "bodyweight", "run", "cycling"]],
    ["lose_weight", ["gym"], ["gym"]],
  ])("T-2.09: goal %s with the activities %j rotates as %j", (goal, types, expected) => {
    expect(activityRotation(types, goal)).toEqual(expected);
  });
});

/* ------------------------------------------------------------------ T-7 a week's load stays the same when sessions move */

const plan: TrainingPlan = {
  id: "plan-1",
  startDate: START,
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

describe("T-7 the weekly load the plan sets", () => {
  it("T-7.14: a plan week carries the load the plan set for it, a deload week 70% of the one before", () => {
    expect(planWeekTarget(plan, "2026-11-02")).toBe(100);
    expect(planWeekTarget(plan, "2026-11-09")).toBe(105);
    expect(planWeekTarget(plan, "2026-11-23")).toBe(77);
  });

  it("T-7.14: a week outside the plan has no target", () => {
    expect(planWeekTarget(plan, "2026-10-26")).toBeNull();
    expect(planWeekTarget(plan, "2026-12-28")).toBeNull();
  });

  it("T-7.14: a week an adaptation has already left behind has no target", () => {
    const adapted: TrainingPlan = {
      ...plan,
      lastAdaptation: {
        trigger: "manual",
        reason: "test",
        adaptedAt: "2026-11-16T09:00:00Z",
        adaptedOn: "2026-11-16",
        acknowledged: false,
      },
    };
    expect(planWeekTarget(adapted, "2026-11-09")).toBeNull();
    expect(planWeekTarget(adapted, "2026-11-16")).toBe(100);
  });

  it.each([
    // target, finished, now, sessions still to come, usual sessions a week -> points the rest of the week shares
    [100, 0, 0, 3, 3, 100],
    [100, 0, 0, 1, 3, 33],
    [100, 30, 0, 3, 3, 70],
    [100, 0, 150, 4, 3, 150],
    [100, 0, 0, 2, 0, 100],
  ])(
    "T-7.14: a week targeting %s with %s done and %s already held, %s sessions to come of %s usual, shares %s points",
    (target, finished, now, sessionsAfter, perWeek, expected) => {
      expect(weekPool(target, finished, now, sessionsAfter, perWeek)).toBe(expected);
    },
  );

  it("T-7.14: a session added to a week takes its share by weight and the others keep their proportions", () => {
    const result = shareWeek(
      100,
      [
        { id: "a", volume: 40, weight: 45 },
        { id: "b", volume: 60, weight: 70 },
      ],
      45,
    );
    expect(result.newVolume).toBe(28);
    expect(result.others).toEqual({ a: 29, b: 43 });
  });

  it("T-7.14: a week still adds up to its pool, and no session falls under 1 point, whatever is shared", () => {
    let seed = 12345; // a fixed seed, so a failure can be repeated
    const next = (limit: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    for (let run = 0; run < 300; run++) {
      const count = next(5);
      const others = Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        volume: 1 + next(60),
        weight: 10 + next(60),
      }));
      const pool = count + 1 + next(150);
      const result = shareWeek(pool, others, 10 + next(60));
      const volumes = [result.newVolume, ...Object.values(result.others)];
      expect(volumes.reduce((a, b) => a + b, 0)).toBe(pool);
      expect(Math.min(...volumes)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("T-4 a session pulled to another intensity", () => {
  const push = { targetVolume: 42, targetDurationMin: 45, intensityBand: "push" as const };

  it.each([
    ["light", { targetVolume: 29, targetDurationMin: 35 }],
    ["deload", { targetVolume: 25, targetDurationMin: 25 }],
    ["push", { targetVolume: 42, targetDurationMin: 45 }],
  ] as const)("T-4.01: a push session rescaled to %s gives %j", (band, expected) => {
    expect(rescaleForBand(push, band)).toEqual(expected);
  });
});

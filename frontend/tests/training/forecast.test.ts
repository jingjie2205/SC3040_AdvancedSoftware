import { describe, expect, it } from "vitest";
import { addDays, startOfWeek } from "@/lib/training/dates";
import {
  acwrOf,
  adherence,
  backtest,
  buildForecast,
  fitHolt,
  fmt,
  forecastPath,
  forecastView,
  trustIn,
  weeklyLoadSeries,
} from "@/lib/training/forecast";
import type { PlannedSession, WorkoutSession } from "@/lib/training/types";

/*
 * Black-box tests of the load forecast that sets how fast a plan builds up (the data-analytics component). Each test
 * gives the athlete's logged training, runs one step and checks what comes out. "Today" is Wednesday 4 November 2026,
 * so the whole weeks counted are those before Monday 2 November.
 */

const ASOF = "2026-11-04";
const THIS_WEEK = startOfWeek(ASOF);

function workout(date: string, volume: number, source: WorkoutSession["source"] = "manual"): WorkoutSession {
  return {
    id: `w-${date}-${volume}-${source}`,
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

/** One workout (on the Wednesday) in each of the last `loads.length` whole weeks, oldest first. */
function weekly(loads: number[]): WorkoutSession[] {
  return loads.map((load, i) => workout(addDays(THIS_WEEK, -7 * (loads.length - i) + 2), load));
}

function planned(id: string, date: string, volume: number): PlannedSession {
  return {
    id,
    planId: "plan-1",
    date,
    activityType: "run",
    targetVolume: volume,
    targetDurationMin: 45,
    intensityBand: "light",
    status: "planned",
  };
}

const completing = (plannedSessionId: string, date: string, volume: number, source: WorkoutSession["source"] = "manual") => ({
  ...workout(date, volume, source),
  plannedSessionId,
});

/* ------------------------------------------------------------------ the weekly series */

describe("DA-1 weekly load series", () => {
  it("DA-1.01: no training gives an empty series", () => {
    expect(weeklyLoadSeries([], ASOF)).toEqual({ weeks: [], loads: [] });
  });

  it("DA-1.01: each whole week's completed load is summed under the Monday it starts on", () => {
    const history = [workout("2026-10-13", 40), workout("2026-10-16", 35.5), workout("2026-10-20", 90), workout("2026-10-30", 100)];
    expect(weeklyLoadSeries(history, ASOF)).toEqual({
      weeks: ["2026-10-12", "2026-10-19", "2026-10-26"],
      loads: [75.5, 90, 100],
    });
  });

  it("DA-1.01: a week with no training in the middle of the history counts as 0", () => {
    const history = [workout("2026-10-13", 80), workout("2026-10-28", 100)];
    expect(weeklyLoadSeries(history, ASOF).loads).toEqual([80, 0, 100]);
  });

  it("DA-1.01: the current week is not counted, because it is not finished", () => {
    const history = [...weekly([80, 90]), workout("2026-11-03", 500)];
    expect(weeklyLoadSeries(history, ASOF).loads).toEqual([80, 90]);
  });

  it("DA-1.01: only the last 12 whole weeks are used", () => {
    const series = weeklyLoadSeries(weekly(Array.from({ length: 13 }, (_, i) => 100 + i)), ASOF);
    expect(series.weeks).toHaveLength(12);
    expect(series.weeks[0]).toBe("2026-08-10");
    expect(series.loads[0]).toBe(101);
  });

  it("HR-1.30: Strava activities never count towards the athlete's load", () => {
    const history = [...weekly([80, 90, 100]), workout("2026-10-15", 400, "strava")];
    expect(weeklyLoadSeries(history, ASOF).loads).toEqual([80, 90, 100]);
  });
});

/* ------------------------------------------------------------------ the fitted trend */

describe("DA-2 trend fitting", () => {
  it("DA-2.01: fewer than three weeks cannot be fitted", () => {
    expect(fitHolt([100, 110])).toBeNull();
  });

  it("DA-2.01: the same weeks always give the same fit", () => {
    const loads = [100, 112, 98, 121, 109, 125, 117];
    expect(fitHolt(loads)).toEqual(fitHolt(loads));
  });

  it("DA-2.02: a flat history is fitted as a level with no trend", () => {
    const fit = fitHolt([100, 100, 100, 100, 100, 100]);
    expect(fit?.level).toBeCloseTo(100, 6);
    expect(fit?.trend).toBeCloseTo(0, 6);
  });

  it("DA-2.02: a rising history is fitted with a positive trend near its steady rise", () => {
    const fit = fitHolt([100, 110, 120, 130, 140, 150]);
    expect(fit?.trend).toBeGreaterThan(5);
    expect(fit?.trend).toBeLessThan(12);
    expect(fit?.level).toBeGreaterThan(140);
  });

  it("DA-2.02: a falling history is fitted with a negative trend", () => {
    expect(fitHolt([150, 140, 130, 120, 110, 100])?.trend).toBeLessThan(-5);
  });

  it("DA-2.03: it gives one fitted value for every week after the first", () => {
    expect(fitHolt([100, 112, 98, 121, 109, 125, 117])?.fitted).toHaveLength(6);
  });
});

describe("DA-3 forecast for the weeks ahead", () => {
  const noisy = fitHolt([100, 112, 98, 121, 109, 125, 117])!;

  it("DA-3.01: four weeks are forecast, starting with the current week", () => {
    expect(forecastPath(noisy, ASOF).map((p) => p.weekStart)).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
    ]);
  });

  it("DA-3.01: the band around the forecast widens the further ahead it looks", () => {
    const widths = forecastPath(noisy, ASOF).map((p) => p.high - p.low);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
  });

  it("DA-3.01: the forecast sits inside its band", () => {
    for (const p of forecastPath(noisy, ASOF)) {
      expect(p.low).toBeLessThanOrEqual(p.value);
      expect(p.value).toBeLessThanOrEqual(p.high);
    }
  });

  it("DA-3.02: a falling history never forecasts a negative load", () => {
    const falling = fitHolt([100, 70, 40, 10, 5, 1])!;
    for (const p of forecastPath(falling, ASOF)) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.low).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------------------------------------------ how far the athlete's own trend is trusted */

describe("DA-4 trust in the athlete's own trend", () => {
  it.each([
    // model error, "same as last week" error, "last four weeks' average" error -> share of its usual say the trend keeps
    [4, 5, 6, 1], // better than the best plain guess
    [5, 5, 6, 1], // as good as the best plain guess
    [5.5, 5, 6, 0.6], // 10% worse than the bar: 60% of its say is kept
    [11.25, 10, 20, 0.5], // halfway between "as good" and "25% worse"
    [12.5, 10, 20, 0], // 25% worse: none of its say
    [20, 10, 20, 0], // far worse
    [0, 0, 0, 1], // a perfect bar can only be matched
    [1, 0, 3, 0], // ... and not beaten
  ])("DA-4.01: model error %s against guesses %s and %s keeps %s of its say", (model, lastWeek, average, expected) => {
    expect(trustIn(model, lastWeek, average)).toBeCloseTo(expected, 6);
  });

  it("DA-4.02: the back-test needs enough weeks to test on", () => {
    expect(backtest([100, 105, 110, 115, 120])).toBeNull(); // 1 prediction
    expect(backtest([100, 105, 110, 115, 120, 125])?.folds).toBe(2);
  });

  it("DA-4.02: it makes one prediction for each week after the first four", () => {
    expect(backtest(Array.from({ length: 10 }, (_, i) => 100 + i * 10))?.folds).toBe(6);
  });

  it("DA-4.02: a steady climb is predicted better than the plain guesses, so the trend is fully trusted", () => {
    const result = backtest(Array.from({ length: 10 }, (_, i) => 100 + i * 10))!;
    expect(result.modelMae).toBeLessThan(result.lastWeekMae);
    expect(result.modelMae).toBeLessThan(result.averageMae);
    expect(result.trust).toBe(1);
  });
});

/* ------------------------------------------------------------------ what the athlete completes, and the recent load */

describe("DA-5 plan completion", () => {
  const due = [planned("s1", "2026-10-14", 100), planned("s2", "2026-10-21", 100)];

  it("DA-5.01: with nothing planned in the last four whole weeks there is nothing to measure", () => {
    expect(adherence([], [], ASOF)).toBeNull();
    expect(adherence([planned("late", "2026-11-03", 100)], [], ASOF)).toBeNull(); // this week is not finished
    expect(adherence([planned("old", "2026-09-30", 100)], [], ASOF)).toBeNull(); // older than four weeks
  });

  it.each([
    [100, 1],
    [50, 0.75],
    [0, 0.5],
  ])("DA-5.01: finishing the second session with %s of 100 points gives a completion of %s", (volume, expected) => {
    const logs = [completing("s1", "2026-10-14", 100), completing("s2", "2026-10-21", volume)];
    expect(adherence(due, logs, ASOF)).toBeCloseTo(expected, 6);
  });

  it("DA-5.01: a workout that is not linked to a planned session completes nothing", () => {
    expect(adherence(due, [workout("2026-10-14", 100)], ASOF)).toBe(0);
  });

  it("HR-1.31: a Strava activity never counts as completing a planned session", () => {
    expect(adherence(due, [completing("s1", "2026-10-14", 100, "strava")], ASOF)).toBe(0);
  });
});

describe("DA-6 acute:chronic load ratio", () => {
  const steady = [workout("2026-10-10", 100), workout("2026-10-17", 100), workout("2026-10-24", 100), workout("2026-10-31", 100)];

  it("DA-6.01: with no logged training there is no ratio", () => {
    expect(acwrOf([], ASOF)).toBeNull();
  });

  it("DA-6.01: with under two weeks of history there is no ratio", () => {
    expect(acwrOf([workout("2026-10-30", 100), workout("2026-11-02", 100)], ASOF)).toBeNull();
  });

  it("DA-6.01: steady training gives a ratio of 1", () => {
    expect(acwrOf(steady, ASOF)).toBe(1);
  });

  it("DA-6.01: a much heavier last week gives a ratio above the usual range", () => {
    const spike = [...steady, workout("2026-11-02", 200), workout("2026-11-03", 200)];
    expect(acwrOf(spike, ASOF)).toBeGreaterThan(1.3);
  });

  it("HR-1.32: Strava activities are left out of the ratio", () => {
    expect(acwrOf([...steady, workout("2026-11-02", 900, "strava")], ASOF)).toBe(1);
  });
});

/* ------------------------------------------------------------------ the decision: the weekly progression rate */

describe("DA-7 the weekly progression the forecast supports", () => {
  it("DA-7.01: with no history the standard 5% a week is used and the plan says why", () => {
    const result = buildForecast([], [], null, ASOF);
    expect(result.method).toBe("default");
    expect(result.ratePct).toBe(5);
    expect(result.steps[0].detail).toBe("No logged training yet, so the standard 5.0% a week is the starting point.");
  });

  it("DA-7.01: with 5 whole weeks (one short of the 6 needed) the standard rate is still used", () => {
    const result = buildForecast(weekly([100, 105, 110, 116, 122]), [], null, ASOF);
    expect(result.method).toBe("default");
    expect(result.ratePct).toBe(5);
    expect(result.fit).toBeNull();
    expect(result.steps[0].detail).toBe(
      "5 whole weeks of logged training. The forecast needs 6, so the standard 5.0% a week is the starting point.",
    );
  });

  it("DA-7.02: with 6 whole weeks the athlete's own trend is fitted and a forecast is made", () => {
    const result = buildForecast(weekly([100, 105, 110, 116, 122, 128]), [], null, ASOF);
    expect(result.method).toBe("holt");
    expect(result.fit).not.toBeNull();
    expect(result.future).toHaveLength(4);
    expect(result.trendPct).toBeGreaterThan(0);
  });

  it("DA-7.02: the explanation lists every step of the decision, in order", () => {
    const result = buildForecast(weekly([100, 105, 110, 116, 122, 128, 134, 141]), [], null, ASOF);
    expect(result.steps.map((s) => s.key)).toEqual([
      "history",
      "trend",
      "record",
      "blend",
      "adherence",
      "load",
      "limits",
      "rate",
    ]);
  });

  it("DA-7.02: a steady 5% climb gives a rate close to 5%", () => {
    const rate = buildForecast(weekly([100, 105, 110, 116, 122, 128, 134, 141]), [], null, ASOF).ratePct;
    expect(rate).toBeGreaterThan(3.5);
    expect(rate).toBeLessThan(6.5);
  });

  it.each([
    ["a very steep climb", [50, 100, 200, 400, 800, 1600]],
    ["a steep fall", [200, 170, 140, 110, 80, 50]],
    ["a flat history", [100, 100, 100, 100, 100, 100]],
    ["an erratic history", [100, 20, 180, 40, 160, 90, 10, 200]],
  ])("DA-7.03: %s never gives a rate outside 0% to 8%", (_name, loads) => {
    const rate = buildForecast(weekly(loads), [], null, ASOF).ratePct;
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(8);
  });

  it("DA-7.03: a steep fall holds progression at 0%", () => {
    expect(buildForecast(weekly([200, 170, 140, 110, 80, 50]), [], null, ASOF).ratePct).toBe(0);
  });

  describe("scaled by how much of the plan was completed", () => {
    const due = [planned("s1", "2026-10-14", 100), planned("s2", "2026-10-21", 100)];
    const rateWith = (secondSession: number) =>
      buildForecast(
        [completing("s1", "2026-10-14", 100), completing("s2", "2026-10-21", secondSession)],
        due,
        null,
        ASOF,
      ).ratePct;

    it.each([
      [100, 5], // 100% completed: unchanged
      [80, 5], // 90% completed: unchanged (boundary)
      [50, 2.5], // 75% completed: half
      [20, 0], // 60% completed: none (boundary)
      [0, 0], // 50% completed: none
    ])("DA-7.04: finishing %s of the second session's 100 points gives %s percent a week", (secondSession, expected) => {
      expect(rateWith(secondSession)).toBeCloseTo(expected, 6);
    });
  });

  describe("held back while the recent load is above the athlete's usual range", () => {
    it.each([
      [null, 5],
      [0.79, 5],
      [1, 5],
      [1.3, 5], // exactly the top of the range is still allowed (boundary)
      [1.31, 0],
      [2, 0],
    ])("DA-7.05: an acute:chronic ratio of %s gives %s percent a week", (acwr, expected) => {
      expect(buildForecast([], [], acwr, ASOF).ratePct).toBe(expected);
    });

    it("DA-7.05: the athlete is told why progression is held", () => {
      const detail = buildForecast([], [], 1.45, ASOF).steps.find((s) => s.key === "load")?.detail;
      expect(detail).toBe(
        "Your acute:chronic load ratio is 1.45, above 1.3, so progression is held at 0% until it settles.",
      );
    });
  });

  it("HR-1.33: Strava activities cannot change the forecast at all", () => {
    const own = weekly([100, 105, 110, 116, 122, 128]);
    const withStrava = [...own, ...weekly([900, 900, 900, 900, 900, 900]).map((w) => ({ ...w, source: "strava" as const, id: `s-${w.id}` }))];
    expect(buildForecast(withStrava, [], null, ASOF)).toEqual(buildForecast(own, [], null, ASOF));
  });
});

describe("DA-8 what the Plan tab is shown", () => {
  it("DA-8.01: the view carries the history, the model's numbers and the rate the plan was built with", () => {
    const forecast = buildForecast(weekly([100, 105, 110, 116, 122, 128]), [], null, ASOF);
    const view = forecastView(forecast, 4.5);
    expect(view.method).toBe("holt");
    expect(view.weeksOfHistory).toBe(6);
    expect(view.weeksNeeded).toBe(6);
    expect(view.history.map((h) => h.load)).toEqual([100, 105, 110, 116, 122, 128]);
    expect(view.fitted).toHaveLength(5);
    expect(view.ahead).toHaveLength(4);
    expect(view.standardPct).toBe(5);
    expect(view.capPct).toBe(8);
    expect(view.planProgressionPct).toBe(4.5);
    expect(view.progressionPct).toBe(forecast.ratePct);
  });

  it("DA-8.01: without enough history the view is the standard rate with no model numbers", () => {
    const view = forecastView(buildForecast([], [], null, ASOF), null);
    expect(view).toMatchObject({
      method: "default",
      weeksOfHistory: 0,
      level: null,
      trendPct: null,
      backtest: null,
      progressionPct: 5,
      planProgressionPct: null,
    });
    expect(view.ahead).toEqual([]);
  });

  it.each([
    [2.5, 0, "3"],
    [7, 1, "7.0"],
    [0.05, 1, "0.1"],
    [0.125, 2, "0.13"],
  ])("DA-8.02: %s to %s decimal places is written as %s (halves round up)", (value, places, expected) => {
    expect(fmt(value, places)).toBe(expected);
  });
});

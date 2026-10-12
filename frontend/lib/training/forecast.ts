/**
 * The load forecast behind a plan's weekly progression, for the in-memory fixtures. A line-for-line copy of the
 * backend's `forecast.py`, which is the source of truth: the same history gives the same numbers and the same wording,
 * and a check compares the two on random inputs.
 *
 * In short: the athlete's own weekly completed load is fitted with Holt's damped-trend exponential smoothing (the
 * smoothing parameters picked per athlete by how well they forecast that athlete's own earlier weeks), a walk-forward
 * test scores that forecast on those weeks against two plain guesses, and the fitted trend is blended with the standard
 * progression in proportion to how much history there is and how well it did, scaled by how much of the plan they
 * completed, held at zero while their recent load is above their usual range, and capped. With too little history the
 * standard progression stands. Strava logs never count.
 */
import { FORECAST_RULES as F, TRAINING_RULES as R } from "./config";
import { addDays, startOfWeek } from "./dates";
import type {
  ForecastAhead,
  ForecastBacktest,
  ForecastStep,
  ForecastView,
  ForecastWeek,
  PlannedSession,
  WorkoutSession,
} from "./types";

export interface WeeklySeries {
  weeks: string[];
  loads: number[];
}

export interface HoltFit {
  alpha: number;
  beta: number;
  level: number;
  trend: number;
  sse: number;
  sd: number;
  fitted: number[];
}

export interface LoadForecast {
  method: "holt" | "default";
  series: WeeklySeries;
  fit: HoltFit | null;
  trendPct: number | null;
  adherence: number | null;
  acwr: number | null;
  ratePct: number;
  future: ForecastAhead[];
  backtest: ForecastBacktest | null;
  steps: ForecastStep[];
}

const roundHalfUp = (x: number) => Math.floor(x + 0.5);
const round2 = (x: number) => roundHalfUp(x * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** `value` to `places` decimals, halves rounded up, the same way as the backend. */
export function fmt(value: number, places = 1): string {
  const scale = 10 ** places;
  return (Math.floor(value * scale + 0.5) / scale).toFixed(places);
}

/* ------------------------------------------------------------------ the weekly series */

/** The load completed in each whole week before the week containing `asOf`, from the first week of training on. */
export function weeklyLoadSeries(workouts: WorkoutSession[], asOf: string): WeeklySeries {
  const thisWeek = startOfWeek(asOf);
  const earliest = addDays(thisWeek, -7 * F.windowWeeks);
  const totals = new Map<string, number>();
  for (const w of workouts) {
    if (w.source === "strava") continue; // Hard Rule 1
    if (w.date >= earliest && w.date < thisWeek) {
      const monday = startOfWeek(w.date);
      totals.set(monday, (totals.get(monday) ?? 0) + w.actualVolume);
    }
  }
  if (totals.size === 0) return { weeks: [], loads: [] };
  const weeks: string[] = [];
  for (let cursor = [...totals.keys()].sort()[0]; cursor < thisWeek; cursor = addDays(cursor, 7)) weeks.push(cursor);
  return { weeks, loads: weeks.map((m) => round2(totals.get(m) ?? 0)) };
}

/* ------------------------------------------------------------------ Holt's damped-trend smoothing */

function holtPass(loads: number[], alpha: number, beta: number, phi: number) {
  const n = loads.length;
  const reach = Math.min(3, n - 1);
  let level = loads[0];
  let trend = (loads[reach] - loads[0]) / reach;
  let sse = 0;
  const predictions: number[] = [];
  for (let t = 1; t < n; t++) {
    const predicted = level + phi * trend;
    predictions.push(predicted);
    const error = loads[t] - predicted;
    sse += error * error;
    const newLevel = alpha * loads[t] + (1 - alpha) * predicted;
    trend = beta * (newLevel - level) + (1 - beta) * phi * trend;
    level = newLevel;
  }
  return { level, trend, sse, predictions };
}

/** Of every pair in the grids, the one whose one-week-ahead forecasts of this very series were closest (first of ties). */
export function fitHolt(loads: number[]): HoltFit | null {
  const n = loads.length;
  if (n < 3) return null;
  let best: (ReturnType<typeof holtPass> & { alpha: number; beta: number }) | null = null;
  for (const alpha of F.alphaGrid) {
    for (const beta of F.betaGrid) {
      const run = holtPass(loads, alpha, beta, F.damping);
      if (best === null || run.sse < best.sse) best = { ...run, alpha, beta };
    }
  }
  if (best === null) return null;
  const sd = Math.sqrt(best.sse / Math.max(n - 3, 1));
  return {
    alpha: best.alpha,
    beta: best.beta,
    level: best.level,
    trend: best.trend,
    sse: best.sse,
    sd,
    fitted: best.predictions,
  };
}

/** The weeks ahead from the week containing `asOf`: the damped trend carried forward, with a band that widens. */
export function forecastPath(fit: HoltFit, asOf: string): ForecastAhead[] {
  const thisWeek = startOfWeek(asOf);
  const points: ForecastAhead[] = [];
  let faded = 0;
  let power = 1;
  for (let h = 1; h <= F.horizonWeeks; h++) {
    power *= F.damping;
    faded += power;
    const value = Math.max(fit.level + fit.trend * faded, 0);
    const spread = F.intervalZ * fit.sd * Math.sqrt(h);
    points.push({
      weekStart: addDays(thisWeek, 7 * (h - 1)),
      value,
      low: Math.max(value - spread, 0),
      high: value + spread,
    });
  }
  return points;
}

/**
 * How much of its usual say the athlete's own trend keeps, from how its forecasts did on their own earlier weeks. The bar
 * is the better of the two plain guesses: the trend keeps all of its say while its average miss is within
 * `trustFullRatio` times the bar's, none of it once the miss is `trustNoneRatio` times the bar's or more, and a
 * proportional share in between. A bar with no misses at all can only be matched, never beaten.
 */
export function trustIn(modelMae: number, lastWeekMae: number, averageMae: number): number {
  const bar = Math.min(lastWeekMae, averageMae);
  if (modelMae <= bar * F.trustFullRatio) return 1;
  if (bar <= 0) return 0;
  return clamp((F.trustNoneRatio - modelMae / bar) / (F.trustNoneRatio - F.trustFullRatio), 0, 1);
}

/** Walk forward through the athlete's own weeks: fit on those so far, predict the next, score it against two plain alternatives. */
export function backtest(loads: number[]): ForecastBacktest | null {
  const model: number[] = [];
  const last: number[] = [];
  const average: number[] = [];
  for (let t = F.backtestMinTrain; t < loads.length; t++) {
    const fit = fitHolt(loads.slice(0, t));
    if (fit === null) continue;
    model.push(Math.abs(loads[t] - (fit.level + F.damping * fit.trend)));
    last.push(Math.abs(loads[t] - loads[t - 1]));
    const recent = loads.slice(Math.max(0, t - 4), t);
    average.push(Math.abs(loads[t] - recent.reduce((a, b) => a + b, 0) / recent.length));
  }
  if (model.length < F.backtestMinFolds) return null;
  const n = model.length;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / n;
  const [modelMae, lastWeekMae, averageMae] = [mean(model), mean(last), mean(average)];
  return { folds: n, modelMae, lastWeekMae, averageMae, trust: trustIn(modelMae, lastWeekMae, averageMae) };
}

/* ------------------------------------------------------------------ what the athlete actually completes */

/** The share of planned load done in the last few whole weeks, or null when nothing came due. */
export function adherence(sessions: PlannedSession[], workouts: WorkoutSession[], asOf: string): number | null {
  const thisWeek = startOfWeek(asOf);
  const earliest = addDays(thisWeek, -7 * F.adherenceWindowWeeks);
  const due = sessions.filter((s) => s.date >= earliest && s.date < thisWeek);
  const planned = due.reduce((sum, s) => sum + s.targetVolume, 0);
  if (planned <= 0) return null;
  const ids = new Set(due.map((s) => s.id));
  let done = 0;
  for (const w of workouts) {
    if (w.source !== "strava" && w.plannedSessionId !== null && ids.has(w.plannedSessionId)) done += w.actualVolume;
  }
  return done / planned;
}

/**
 * The athlete's acute:chronic load ratio on `asOf` (last 7 days against the 28-day weekly average), or null with under
 * two weeks of history. The same definition as the readiness score's.
 */
export function acwrOf(workouts: WorkoutSession[], asOf: string): number | null {
  const usable = workouts.filter((w) => w.source !== "strava");
  const acuteStart = addDays(asOf, -7);
  const chronicStart = addDays(asOf, -28);
  const acute = usable.filter((w) => w.date >= acuteStart && w.date < asOf);
  const chronic = usable.filter((w) => w.date >= chronicStart && w.date < asOf);
  if (chronic.length === 0) return null;
  const oldest = chronic.reduce((min, w) => (w.date < min ? w.date : min), chronic[0].date);
  if (oldest > addDays(asOf, -14)) return null;
  const chronicWeekly = chronic.reduce((sum, w) => sum + w.actualVolume, 0) / 4;
  if (chronicWeekly <= 0) return null;
  return Number((acute.reduce((sum, w) => sum + w.actualVolume, 0) / chronicWeekly).toFixed(3));
}

/* ------------------------------------------------------------------ the decision */

/**
 * The load ratio to two decimals, or to three when two would read as the very bound it is on the other side of: a ratio
 * of 0.797 is under 0.8 even though 0.80 is what two decimals make of it.
 */
function ratioText(value: number, bound: number): string {
  const two = fmt(value, 2);
  return two === fmt(bound, 2) ? fmt(value, 3) : two;
}

/** What the backtest found, and what it means for the say the athlete's own trend gets. */
export function recordStep(result: ForecastBacktest | null): ForecastStep {
  if (result === null) {
    return {
      key: "record",
      label: "Track record",
      detail: "Too few weeks to test the forecast on your own earlier weeks, so your trend gets no say yet.",
    };
  }
  const bar = Math.min(result.lastWeekMae, result.averageMae);
  const evidence =
    `Predicting your own earlier weeks one at a time (${result.folds} predictions), the forecast missed by ` +
    `${fmt(result.modelMae)} pts a week on average, against ${fmt(result.lastWeekMae)} for "same as last week" ` +
    `and ${fmt(result.averageMae)} for "the last four weeks' average".`;
  let verdict: string;
  if (result.trust >= 1) {
    const gain = bar > 0 ? (100 * (bar - result.modelMae)) / bar : 0;
    verdict =
      gain >= 0.5
        ? `It did ${fmt(gain, 0)}% better than the best of them, so your trend keeps its full say.`
        : "It did about as well as the best of them, so your trend keeps its full say.";
  } else if (result.trust > 0) {
    const kept = clamp(roundHalfUp(100 * result.trust), 1, 99);
    verdict = `It didn't beat the best of them, so your trend keeps ${kept}% of its say.`;
  } else {
    verdict = "It didn't beat the best of them, so your trend gets no say and the standard rate carries the plan.";
  }
  return { key: "record", label: "Track record", detail: `${evidence} ${verdict}` };
}

export function buildForecast(
  workouts: WorkoutSession[],
  sessions: PlannedSession[],
  acwr: number | null,
  asOf: string,
): LoadForecast {
  const series = weeklyLoadSeries(workouts, asOf);
  const n = series.loads.length;
  const standard = R.weeklyProgressionPct;
  const steps: ForecastStep[] = [];

  const fit = n >= F.minWeeks ? fitHolt(series.loads) : null;
  let trendPct: number | null = null;
  let future: ForecastAhead[] = [];
  let result: ForecastBacktest | null = null;
  let rate: number;

  if (fit === null) {
    const weeks = `${n} whole week${n === 1 ? "" : "s"}`;
    steps.push({
      key: "history",
      label: "Your history",
      detail:
        n === 0
          ? `No logged training yet, so the standard ${fmt(standard)}% a week is the starting point.`
          : `${weeks} of logged training. The forecast needs ${F.minWeeks}, so the standard ${fmt(standard)}% a week is the starting point.`,
    });
    rate = standard;
  } else {
    trendPct = fit.level > 0 ? (100 * fit.trend) / fit.level : 0;
    result = backtest(series.loads);
    const trust = result !== null ? result.trust : 0;
    const weight = n / (n + F.priorWeeks);
    const say = weight * trust; // more weeks of data, and a better record, give the athlete's own trend more of the say
    rate = say * trendPct + (1 - say) * standard;
    future = forecastPath(fit, asOf);
    steps.push({
      key: "history",
      label: "Your history",
      detail: `${n} whole weeks of logged training, from ${fmt(Math.min(...series.loads), 0)} to ${fmt(Math.max(...series.loads), 0)} pts a week.`,
    });
    const movement =
      Math.abs(trendPct) < 0.05
        ? "holding steady"
        : trendPct > 0
          ? `rising about ${fmt(trendPct)}% a week`
          : `falling about ${fmt(-trendPct)}% a week`;
    steps.push({
      key: "trend",
      label: "Your trend",
      detail: `Smoothing fitted to your own weeks (alpha ${fmt(fit.alpha, 2)}, beta ${fmt(fit.beta, 2)}) puts your weekly load at ${fmt(fit.level, 0)} pts, ${movement}.`,
    });
    steps.push(recordStep(result));
    steps.push({
      key: "blend",
      label: "Blended with the standard",
      detail: `With ${n} weeks of data${trust >= 1 ? "" : " and that record"} your own trend gets ${fmt(100 * say, 0)}% of the say and the standard ${fmt(standard)}% the rest: ${fmt(rate)}% a week.`,
    });
  }

  const completed = adherence(sessions, workouts, asOf);
  if (completed === null) {
    steps.push({
      key: "adherence",
      label: "Plan completion",
      detail: "No finished plan weeks to measure yet, so this doesn't change the rate.",
    });
  } else {
    const factor = clamp((completed - F.adherenceLow) / (F.adherenceHigh - F.adherenceLow), 0, 1);
    rate = rate * factor;
    const done = `You completed ${fmt(100 * completed, 0)}% of the last ${F.adherenceWindowWeeks} weeks' planned load`;
    steps.push({
      key: "adherence",
      label: "Plan completion",
      detail:
        factor >= 1
          ? `${done}, so progression is unchanged.`
          : `${done}, so progression is scaled to ${fmt(100 * factor, 0)}%: ${fmt(rate)}% a week.`,
    });
  }

  if (acwr === null) {
    steps.push({
      key: "load",
      label: "Recent load",
      detail: "Not enough recent days logged to compare this week with your usual, so no hold applies.",
    });
  } else if (acwr > R.acwrHigh) {
    rate = 0;
    steps.push({
      key: "load",
      label: "Recent load",
      detail: `Your acute:chronic load ratio is ${ratioText(acwr, R.acwrHigh)}, above ${fmt(R.acwrHigh, 1)}, so progression is held at 0% until it settles.`,
    });
  } else if (acwr < R.acwrLow) {
    steps.push({
      key: "load",
      label: "Recent load",
      detail: `Your acute:chronic load ratio is ${ratioText(acwr, R.acwrLow)}, lighter than your usual (under ${fmt(R.acwrLow, 1)}), so there is no hold.`,
    });
  } else {
    steps.push({
      key: "load",
      label: "Recent load",
      detail: `Your acute:chronic load ratio is ${fmt(acwr, 2)}, within the usual range (up to ${fmt(R.acwrHigh, 1)}), so there is no hold.`,
    });
  }

  rate = round2(clamp(rate, F.rateMinPct, F.rateMaxPct));
  steps.push({
    key: "limits",
    label: "Safety limits",
    detail: `The rate is kept between ${fmt(F.rateMinPct)}% and ${fmt(F.rateMaxPct)}% a week, and a plan is rejected above ${fmt(R.maxWeeklyIncreasePct)}% between loading weeks.`,
  });
  steps.push({ key: "rate", label: "Weekly progression", detail: `${fmt(rate, 2)}% a week.` });

  return {
    method: fit !== null ? "holt" : "default",
    series,
    fit,
    trendPct,
    adherence: completed,
    acwr,
    ratePct: rate,
    future,
    backtest: result,
    steps,
  };
}

/** The forecast as the API returns it, with the numbers rounded to what is worth showing. */
export function forecastView(forecast: LoadForecast, planProgressionPct: number | null): ForecastView {
  const { series, fit, backtest: bt } = forecast;
  const week = (weekStart: string, load: number): ForecastWeek => ({ weekStart, load: round2(load) });
  return {
    method: forecast.method,
    weeksOfHistory: series.loads.length,
    weeksNeeded: F.minWeeks,
    history: series.weeks.map((w, i) => week(w, series.loads[i])),
    fitted: (fit ? fit.fitted : []).map((v, i) => week(series.weeks[i + 1], v)),
    ahead: forecast.future.map((p) => ({
      weekStart: p.weekStart,
      value: round2(p.value),
      low: round2(p.low),
      high: round2(p.high),
    })),
    level: fit ? round2(fit.level) : null,
    trendPct: forecast.trendPct !== null ? round2(forecast.trendPct) : null,
    alpha: fit ? fit.alpha : null,
    beta: fit ? fit.beta : null,
    adherence: forecast.adherence !== null ? round2(forecast.adherence) : null,
    acwr: forecast.acwr,
    standardPct: R.weeklyProgressionPct,
    progressionPct: forecast.ratePct,
    capPct: F.rateMaxPct,
    planProgressionPct,
    backtest: bt
      ? {
          folds: bt.folds,
          modelMae: round2(bt.modelMae),
          lastWeekMae: round2(bt.lastWeekMae),
          averageMae: round2(bt.averageMae),
          trust: round2(bt.trust),
        }
      : null,
    steps: forecast.steps,
  };
}

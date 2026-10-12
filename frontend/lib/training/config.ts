/**
 * Business rules for the training routine page. Kept in one place so QA can vary them.
 * Volume is expressed in "load points" (roughly minutes weighted by intensity).
 */
export const TRAINING_RULES = {
  daysPerWeek: { min: 1, max: 7 },
  sessionDurationMin: { min: 15, max: 180 },
  planWeeks: { min: 2, max: 16, default: 8 },
  deloadEveryNWeeks: 4,
  deloadVolumeFactor: 0.7,
  weeklyProgressionPct: 5,
  maxWeeklyIncreasePct: 10,
  examDates: { max: 10, horizonDays: 730 },
  sleepHours: { min: 0, max: 16 },
  baselineWindowWeeks: 4,
  minHistoryWeeksForBaseline: 2,
  defaultBaselineVolume: 100,
  partialCompletionRatio: 0.8,
  /** The acute:chronic load ratio's usual range, as the readiness score has it: a plan stops progressing above the top. */
  acwrLow: 0.8,
  acwrHigh: 1.3,
  highIntensityBand: "push",
  /** What a session counts for when a week's load is shared out, per minute (intensity), and how long it is, by band. */
  bandWeight: { push: 1, light: 0.7, deload: 0.6 },
  bandDurationFactor: { push: 1, light: 0.75, deload: 0.6 },
  missedSessionsTrigger: 3,
  lowReadinessDaysTrigger: 3,
  workout: {
    durationMin: { min: 1, max: 600 },
    volume: { max: 1000 },
    rpe: { min: 1, max: 10 },
    avgHr: { min: 30, max: 230 },
    calories: { min: 0, max: 20000 },
    distanceKm: { max: 500 },
  },
} as const;

/**
 * The load forecast that sets how fast a plan progresses (forecast.ts). Mirrors `ForecastRules` in the backend's
 * config.py, which is the source of truth; a backend test fails if the two disagree.
 */
export const FORECAST_RULES = {
  minWeeks: 6,
  windowWeeks: 12,
  damping: 0.95,
  alphaGrid: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  betaGrid: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
  priorWeeks: 6,
  rateMinPct: 0,
  rateMaxPct: 8,
  adherenceWindowWeeks: 4,
  adherenceLow: 0.6,
  adherenceHigh: 0.9,
  backtestMinTrain: 4,
  backtestMinFolds: 2,
  trustFullRatio: 1,
  trustNoneRatio: 1.25,
  horizonWeeks: 4,
  intervalZ: 1.28,
} as const;

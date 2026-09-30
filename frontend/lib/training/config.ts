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
  baselineWindowWeeks: 4,
  minHistoryWeeksForBaseline: 2,
  defaultBaselineVolume: 100,
  partialCompletionRatio: 0.8,
  highIntensityBand: "push",
  missedSessionsTrigger: 3,
  lowReadinessDaysTrigger: 3,
  workout: {
    durationMin: { min: 1, max: 600 },
    volume: { max: 1000 },
    rpe: { min: 1, max: 10 },
    avgHr: { min: 30, max: 230 },
  },
} as const;

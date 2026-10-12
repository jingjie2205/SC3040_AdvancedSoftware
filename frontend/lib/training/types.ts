export const ACTIVITY_TYPES = ["run", "gym", "cycling", "bodyweight"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** The profile goal a plan was built for. Settings stores it as DEFICIT, MAINTAIN or SURPLUS. */
export type Goal = "lose_weight" | "maintain" | "build_muscle";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const INTENSITY_BANDS = ["deload", "light", "push"] as const;
export type IntensityBand = (typeof INTENSITY_BANDS)[number];

export type SessionStatus =
  | "planned"
  | "accepted"
  | "completed"
  | "partial"
  | "missed"
  | "moved";

export interface TrainingPreferences {
  daysPerWeek: number;
  sessionDurationMin: number;
  activityTypes: ActivityType[];
  restDays: Weekday[];
  /** Upcoming exams as "YYYY-MM-DD", earliest first. Readiness dips in the week before one. */
  examDates: string[];
  updatedAt: string;
}

export interface PlanAdaptation {
  trigger: "missed_sessions" | "low_readiness" | "manual";
  reason: string;
  adaptedAt: string;
  /** The user's local date when it happened, as "YYYY-MM-DD". */
  adaptedOn: string;
  acknowledged: boolean;
}

export interface TrainingPlan {
  id: string;
  startDate: string;
  endDate: string;
  weeks: number;
  status: "active" | "superseded";
  baselineVolume: number;
  createdAt: string;
  notice: string;
  /** The profile goal when the plan was generated or last adapted, or null if the profile had none. */
  goal: Goal | null;
  lastAdaptation: PlanAdaptation | null;
  /**
   * The weekly load increase, in percent, this plan was built with: learned from the athlete's own history (see
   * ForecastView). Null for a plan made before that existed or on a database that can't keep it: the standard rate then.
   */
  progressionPct: number | null;
}

export interface PlannedSession {
  id: string;
  planId: string;
  date: string;
  activityType: ActivityType;
  targetVolume: number;
  targetDurationMin: number;
  intensityBand: IntensityBand;
  status: SessionStatus;
}

export interface WorkoutSession {
  id: string;
  plannedSessionId: string | null;
  date: string;
  activityType: ActivityType;
  actualVolume: number;
  actualDurationMin: number;
  rpe: number | null;
  avgHr: number | null;
  calories: number | null;
  /** Metres, for a run or ride saved from Strava or logged with a distance; null otherwise. */
  distanceM: number | null;
  /** "strava" logs were saved from the Strava tab; they show on the schedule and count towards nothing else. */
  source: "manual" | "import" | "strava";
  /** Strava's id for the activity when `source` is "strava" (what "View on Strava" opens), otherwise null. */
  externalId: string | null;
  createdAt: string;
}

export interface ReadinessFactor {
  key: string;
  label: string;
  impact: "positive" | "negative" | "neutral";
  detail: string;
}

export interface ReadinessScore {
  date: string;
  score: number;
  classification: IntensityBand;
  factors: ReadinessFactor[];
  explanation: string;
  computedAt: string;
}

/** Which scorer is producing readiness scores. Mirrors GET /api/v1/readiness/model. */
export interface ModelInfo {
  kind: "model" | "rules";
  version: string;
  description: string;
  trainedOn: string | null;
  metrics: Record<string, number>;
  /** Set when the trained model couldn't be used and the rules are scoring instead. */
  fallbackReason: string | null;
}

export interface SessionRecommendation {
  activityType: ActivityType;
  intensityBand: IntensityBand;
  targetVolume: number;
  targetDurationMin: number;
  downgraded: boolean;
  explanation: string;
}

export interface TodayView {
  date: string;
  readiness: ReadinessScore;
  planned: PlannedSession | null;
  recommendation: SessionRecommendation | null;
  logged: WorkoutSession | null;
  /** Last night's sleep as entered today, or null if none has been. */
  sleepHours: number | null;
}

export interface SleepEntry {
  date: string;
  hours: number;
}

export interface Schedule {
  sessions: PlannedSession[];
  workouts: WorkoutSession[];
}

export type TodayState = "no_plan" | "rest_day" | "to_do" | "done" | "missed";

export interface TodaySummary {
  state: TodayState;
  /** Today's planned session, when there is one. */
  session: PlannedSession | null;
  /** What readiness makes of it. Only set while the session is still to do. */
  recommendation: SessionRecommendation | null;
  logged: WorkoutSession | null;
}

export interface WeekProgress {
  /** Monday and Sunday of the user's current week, as "YYYY-MM-DD". */
  start: string;
  end: string;
  plannedSessions: number;
  completedSessions: number;
  missedSessions: number;
  /** Minutes logged this week. Strava rows are left out. */
  loggedMinutes: number;
}

export interface NextSession {
  date: string;
  activityType: ActivityType;
  intensityBand: IntensityBand;
  targetDurationMin: number;
}

/** Everything a Home card needs, from GET /api/v1/training/summary. Only the signed-in user's own. */
export interface TrainingSummary {
  date: string;
  hasPlan: boolean;
  goal: Goal | null;
  readiness: ReadinessScore;
  today: TodaySummary;
  week: WeekProgress;
  nextSession: NextSession | null;
}

/**
 * A short note about today's training, from POST /api/v1/training/coach. `source` says whether Gemini
 * or the built-in text wrote it. Gemini is never given readiness, check-in answers or Strava data.
 */
export interface CoachMessage {
  date: string;
  message: string;
  source: "gemini" | "fallback";
  model: string | null;
  /** True when this is an earlier answer to the same question, served from memory. */
  cached: boolean;
  /** The not-medical-advice notice to show with it. */
  notice: string;
}

/** One week of the athlete's completed load (pts), the Monday it starts on. */
export interface ForecastWeek {
  weekStart: string;
  load: number;
}

/** A week ahead: the forecast and the 80% band around it. */
export interface ForecastAhead {
  weekStart: string;
  value: number;
  low: number;
  high: number;
}

/** One line of the plain-language account of how the weekly progression was set. */
export interface ForecastStep {
  key: string;
  label: string;
  detail: string;
}

/** How the forecast did on the athlete's own earlier weeks, against two plain alternatives (mean absolute error, pts). */
export interface ForecastBacktest {
  folds: number;
  modelMae: number;
  lastWeekMae: number;
  averageMae: number;
  /** How much of its usual say the athlete's own trend keeps in the progression because of this record, 0 to 1. */
  trust: number;
}

/**
 * The athlete's weekly load, the forecast fitted to it and the weekly progression it supports, from
 * GET /api/v1/training/plan/forecast. Their own completed training only: Strava logs never count and no readiness
 * data is involved.
 */
export interface ForecastView {
  /** "holt" once there is enough history to fit the athlete's own trend, otherwise "default" (the standard rate). */
  method: "holt" | "default";
  weeksOfHistory: number;
  weeksNeeded: number;
  history: ForecastWeek[];
  /** The model's one-week-ahead prediction for each week after the first. */
  fitted: ForecastWeek[];
  ahead: ForecastAhead[];
  level: number | null;
  trendPct: number | null;
  alpha: number | null;
  beta: number | null;
  adherence: number | null;
  acwr: number | null;
  standardPct: number;
  /** What the forecast supports as of today. */
  progressionPct: number;
  capPct: number;
  /** What the active plan was built with, if it recorded one. */
  planProgressionPct: number | null;
  backtest: ForecastBacktest | null;
  steps: ForecastStep[];
}

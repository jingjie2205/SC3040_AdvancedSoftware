export const ACTIVITY_TYPES = ["run", "gym", "cycling", "bodyweight"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

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
  lastAdaptation: PlanAdaptation | null;
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
  source: "manual" | "import";
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
}

export interface Schedule {
  sessions: PlannedSession[];
  workouts: WorkoutSession[];
}

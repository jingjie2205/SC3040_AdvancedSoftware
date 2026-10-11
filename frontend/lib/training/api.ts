/**
 * The training page talks to this interface only. Two implementations sit behind it:
 * the FastAPI service (http-api.ts) and in-memory fixtures (mock-api.ts).
 *
 * Set NEXT_PUBLIC_TRAINING_API=http to use the backend. Anything else uses the fixtures, so the
 * page still works without a backend or a signed-in user.
 *
 * Reads throw on failure; writes return an ApiResult so the UI can show the reason.
 */
import { httpTrainingApi } from "./http-api";
import { mockTrainingApi } from "./mock-api";
import type { MoveRefusalCode } from "./rules";
import type {
  AddSessionInput,
  LogWorkoutInput,
  SessionChange,
  TrainingPreferencesInput,
} from "./schemas";
import type {
  ActivityType,
  CoachMessage,
  ModelInfo,
  PlannedSession,
  Schedule,
  SleepEntry,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
  TrainingSummary,
  WorkoutSession,
} from "./types";

export type ApiErrorCode =
  | "VALIDATION"
  | "NO_PREFERENCES"
  | "NO_PLAN"
  | "PLAN_EXISTS"
  | "PLAN_UNSAFE"
  | "PLAN_ENDED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "NOT_CONNECTED"
  | "WEEK_FULL"
  | "NETWORK"
  | "SERVER_ERROR"
  | MoveRefusalCode;

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
  /** Set when a reschedule is refused and another day would work. */
  suggestedDate?: string | null;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface GeneratePlanRequest {
  weeks: number;
  /** Must be true to replace an existing active plan. */
  confirmReplace: boolean;
}

export type SessionResponse =
  | { action: "accept" }
  | { action: "swap"; activityType: ActivityType }
  | { action: "skip" };

export interface LogResult {
  workout: WorkoutSession;
  session: PlannedSession | null;
}

export interface RemoveResult {
  redistributedCount: number;
}

export interface AddSessionResult {
  session: PlannedSession;
  /** How many of that week's other sessions had their points changed to make room for it. */
  adjustedCount: number;
}

export interface TrainingApi {
  getPreferences(): Promise<TrainingPreferences | null>;
  savePreferences(input: TrainingPreferencesInput): Promise<ApiResult<TrainingPreferences>>;

  getPlan(): Promise<TrainingPlan | null>;
  generatePlan(request: GeneratePlanRequest): Promise<ApiResult<TrainingPlan>>;
  recalculatePlan(): Promise<ApiResult<TrainingPlan>>;
  acknowledgeAdaptation(): Promise<void>;

  getSchedule(from: string, to: string): Promise<Schedule>;
  rescheduleSession(id: string, newDate: string): Promise<ApiResult<PlannedSession>>;
  removeSession(id: string): Promise<ApiResult<RemoveResult>>;
  /**
   * Plan a session by hand on a free day of the active plan. The week's load stays the plan's own: the new session
   * takes its share and the week's other sessions give up a little to make room.
   */
  addSession(input: AddSessionInput): Promise<ApiResult<AddSessionResult>>;
  /** Change a planned session's activity, intensity or length where it stands (moving it is `rescheduleSession`). */
  updateSession(id: string, change: SessionChange): Promise<ApiResult<PlannedSession>>;

  getToday(): Promise<TodayView>;
  /** One read for the Home page: readiness, today's session, the week so far and what is next. */
  getSummary(): Promise<TrainingSummary>;
  /** A short note about today from Gemini (or the built-in text). Can be refused for asking too fast. */
  getCoachMessage(): Promise<ApiResult<CoachMessage>>;
  getReadinessModel(): Promise<ModelInfo>;
  /** Last night's sleep, filed under today. Entering it again replaces it. */
  logSleep(hours: number): Promise<ApiResult<SleepEntry>>;
  clearSleep(): Promise<ApiResult<void>>;
  respondToSession(id: string, response: SessionResponse): Promise<ApiResult<PlannedSession>>;
  logSession(id: string, input: LogWorkoutInput): Promise<ApiResult<LogResult>>;
  logAdHocSession(input: LogWorkoutInput): Promise<ApiResult<LogResult>>;
}

export const trainingApi: TrainingApi =
  process.env.NEXT_PUBLIC_TRAINING_API === "http" ? httpTrainingApi : mockTrainingApi;

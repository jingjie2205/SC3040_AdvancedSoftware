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
import type { LogWorkoutInput, TrainingPreferencesInput } from "./schemas";
import type {
  ActivityType,
  ModelInfo,
  PlannedSession,
  Schedule,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
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

  getToday(): Promise<TodayView>;
  getReadinessModel(): Promise<ModelInfo>;
  respondToSession(id: string, response: SessionResponse): Promise<ApiResult<PlannedSession>>;
  logSession(id: string, input: LogWorkoutInput): Promise<ApiResult<LogResult>>;
  logAdHocSession(input: LogWorkoutInput): Promise<ApiResult<LogResult>>;
}

export const trainingApi: TrainingApi =
  process.env.NEXT_PUBLIC_TRAINING_API === "http" ? httpTrainingApi : mockTrainingApi;

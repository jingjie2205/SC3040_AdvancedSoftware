/**
 * The gamification page talks to this interface only. Two implementations sit behind it:
 * the FastAPI service (http-api.ts) and in-memory fixtures (mock-api.ts).
 *
 * Set NEXT_PUBLIC_GAMIFICATION_API=http to use the backend. Anything else uses the fixtures, so the
 * page still works without a backend or a signed-in user.
 *
 * Reads throw on failure; writes return an ApiResult so the UI can show the reason.
 */
import { httpGamificationApi } from "./http-api";
import { mockGamificationApi } from "./mock-api";
import type { ChallengeInput, CheckInInput } from "./schemas";
import type {
  Challenge,
  CheckInResult,
  GamificationStats,
  Leaderboard,
  LeaderboardMetric,
  PendingXp,
  PendingXpResync,
  XpEvent,
} from "./types";

export type ApiErrorCode =
  | "VALIDATION"
  /** Clashes with current state, e.g. already checked in today or already answered an invite. */
  | "CONFLICT"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "NETWORK"
  | "SERVER_ERROR";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface GamificationApi {
  getStats(): Promise<GamificationStats>;
  getXpHistory(): Promise<XpEvent[]>;
  getPendingXp(): Promise<PendingXp>;
  resyncPendingXp(): Promise<ApiResult<PendingXpResync>>;
  checkIn(input: CheckInInput): Promise<ApiResult<CheckInResult>>;
  getLeaderboard(metric: LeaderboardMetric): Promise<Leaderboard>;
  getChallenges(): Promise<Challenge[]>;
  createChallenge(input: ChallengeInput): Promise<ApiResult<Challenge>>;
  respondToChallenge(challengeId: string, accept: boolean): Promise<ApiResult<Challenge>>;
}

export const gamificationApi: GamificationApi =
  process.env.NEXT_PUBLIC_GAMIFICATION_API === "http" ? httpGamificationApi : mockGamificationApi;

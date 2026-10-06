/**
 * GamificationApi backed by the FastAPI service (backend/app/controllers/gamification.py).
 *
 * Every request carries the signed-in user's Supabase access token. The server decides which day
 * "today" is, so no client date is sent. Reads throw with a readable message; writes return an
 * ApiResult so the UI can react to the specific error.
 */
import { GAMIFICATION_RULES as R } from "./config";
import type { ApiError, ApiResult, GamificationApi } from "./api";
import type { Challenge, CheckInResult, GamificationStats, Leaderboard } from "./types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const BASE_URL = `${BACKEND_URL}/gamification`;

async function readError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;

  switch (response.status) {
    case 409:
      return {
        code: "CONFLICT",
        message: typeof detail === "string" ? detail : "That has already been done.",
      };
    case 404:
      return { code: "NOT_FOUND", message: "That challenge no longer exists." };
    case 401:
    case 403:
      // FastAPI's bearer check answers 403 when the header is missing and 401 when it is invalid.
      return { code: "UNAUTHORIZED", message: "Your session has expired. Sign in again." };
    case 422:
      // Business-rule failures carry a sentence; schema failures carry a list of field errors.
      return {
        code: "VALIDATION",
        message:
          typeof detail === "string" ? detail : "Some values were out of range. Check them and try again.",
      };
    default:
      return {
        code: "SERVER_ERROR",
        message:
          typeof detail === "string" ? detail : `The server returned an error (${response.status}).`,
      };
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    // Loaded on demand so the page doesn't carry the Supabase client when it runs on fixtures.
    const { createClient } = await import("@/lib/supabase/client");
    const { data } = await createClient().auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  } catch {
    // No readable session: the request goes out unauthenticated and the server rejects it.
  }
  return headers;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: await buildHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "NETWORK",
        message: "Couldn't reach the server. Check your connection and try again.",
      },
    };
  }

  if (!response.ok) return { ok: false, error: await readError(response) };
  return { ok: true, data: (await response.json()) as T };
}

async function read<T>(path: string): Promise<T> {
  const result = await request<T>("GET", path);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export const httpGamificationApi: GamificationApi = {
  getStats: () => read<GamificationStats>("/me"),
  checkIn: (input) => request<CheckInResult>("POST", "/checkins", input),
  getLeaderboard: (metric) =>
    read<Leaderboard>(`/leaderboard?metric=${metric}&limit=${R.leaderboardLimit}`),
  getChallenges: async () => (await read<{ challenges: Challenge[] }>("/challenges")).challenges,
  createChallenge: (input) => request<Challenge>("POST", "/challenges", input),
  respondToChallenge: (challengeId, accept) =>
    request<Challenge>("POST", `/challenges/${encodeURIComponent(challengeId)}/respond`, { accept }),
};

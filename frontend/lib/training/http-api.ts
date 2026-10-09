/**
 * TrainingApi backed by the FastAPI service (backend/app/training).
 *
 * Every request carries the signed-in user's Supabase access token, and the user's local date in
 * X-Client-Date so the server's idea of "today" matches theirs. Reads throw with the server's
 * message; writes return an ApiResult so the UI can show the reason and any suggested fix.
 */
import { todayISO } from "./dates";
import type {
  ApiError,
  ApiErrorCode,
  ApiResult,
  LogResult,
  RemoveResult,
  TrainingApi,
} from "./api";
import type {
  CoachMessage,
  ModelInfo,
  PlannedSession,
  Schedule,
  SleepEntry,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
  TrainingSummary,
} from "./types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const BASE_URL = `${BACKEND_URL}/api/v1/training`;
const READINESS_URL = `${BACKEND_URL}/api/v1/readiness`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function toFieldErrors(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * What FastAPI's bearer check says when the request has no token. Newer releases answer 401, older
 * ones 403, and the backend doesn't pin the version, so both mean "not signed in".
 */
const NOT_AUTHENTICATED = "Not authenticated";

const isSignedOut = (response: Response, detail: unknown) =>
  response.status === 401 || (response.status === 403 && detail === NOT_AUTHENTICATED);

async function readError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const detail = isRecord(body) ? body.detail : undefined;

  if (isRecord(detail) && typeof detail.code === "string" && typeof detail.message === "string") {
    return {
      code: detail.code as ApiErrorCode,
      message: detail.message,
      fieldErrors: toFieldErrors(detail.fieldErrors),
      suggestedDate: typeof detail.suggestedDate === "string" ? detail.suggestedDate : null,
    };
  }
  if (isSignedOut(response, detail)) {
    // The shared auth dependency answers with a plain-string body, which isn't something to show.
    return { code: "UNAUTHORIZED", message: "Your session has expired. Sign in again." };
  }
  return {
    code: "SERVER_ERROR",
    message:
      typeof detail === "string" ? detail : `The server returned an error (${response.status}).`,
  };
}

/** Nothing on this page works without a session, so being signed out means going back to sign in. */
function sendToSignIn() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Client-Date": todayISO(),
  };
  try {
    // Loaded on demand so the page doesn't carry the Supabase client when it runs on fixtures.
    const { createClient } = await import("@/lib/supabase/client");
    const { data } = await createClient().auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  } catch {
    // No readable session: the request goes out unauthenticated and the server answers 401.
  }
  return headers;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  base: string = BASE_URL,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
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

  if (!response.ok) {
    const error = await readError(response);
    if (error.code === "UNAUTHORIZED") sendToSignIn();
    return { ok: false, error };
  }
  const data = response.status === 204 ? undefined : await response.json();
  return { ok: true, data: data as T };
}

async function read<T>(path: string, base: string = BASE_URL): Promise<T> {
  const result = await request<T>("GET", path, undefined, base);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;

export const httpTrainingApi: TrainingApi = {
  getPreferences: () => read<TrainingPreferences | null>("/preferences"),
  savePreferences: (input) => request<TrainingPreferences>("PUT", "/preferences", input),

  getPlan: () => read<TrainingPlan | null>("/plan"),
  generatePlan: (req) => request<TrainingPlan>("POST", "/plan", req),
  recalculatePlan: () => request<TrainingPlan>("POST", "/plan/recalculate"),
  async acknowledgeAdaptation() {
    const result = await request<void>("POST", "/plan/adaptation/acknowledge");
    if (!result.ok) throw new Error(result.error.message);
  },

  getSchedule: (from, to) => read<Schedule>(`/schedule?from=${from}&to=${to}`),
  rescheduleSession: (id, newDate) =>
    request<PlannedSession>("PATCH", sessionPath(id), { date: newDate }),
  removeSession: (id) => request<RemoveResult>("DELETE", sessionPath(id)),

  getToday: () => read<TodayView>("/today"),
  getSummary: () => read<TrainingSummary>("/summary"),
  getCoachMessage: () => request<CoachMessage>("POST", "/coach"),
  getReadinessModel: () => read<ModelInfo>("/model", READINESS_URL),
  logSleep: (hours) => request<SleepEntry>("PUT", "/sleep", { hours }),
  clearSleep: () => request<void>("DELETE", "/sleep"),
  respondToSession: (id, response) =>
    request<PlannedSession>("POST", `${sessionPath(id)}/respond`, response),
  logSession: (id, input) => request<LogResult>("POST", `${sessionPath(id)}/log`, input),
  logAdHocSession: (input) => request<LogResult>("POST", "/sessions", input),
};

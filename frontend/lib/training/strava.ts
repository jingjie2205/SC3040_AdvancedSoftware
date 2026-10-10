/**
 * The Strava tab's connection to the backend: whether Strava is connected, pulling the latest activities as cards,
 * saving chosen ones to the schedule (the server asks Strava again, so what is saved is what Strava said, never what
 * the browser sends), taking them off again, and the link that connects a Strava account.
 *
 * Hard Rule 1: Strava data never reaches an AI feature. This module is deliberately separate from `trainingApi` (which
 * feeds Home, the readiness score, the plan and the coach); it shares only the request helper.
 * `test_training_strava_isolation.py` pins that the two never import each other.
 */
import type { ApiResult } from "./api";
import { request } from "./http-api";
import {
  parseDeleted,
  parsePull,
  parseSaveResult,
  parseStatus,
  type SaveSummary,
  type StravaCard,
  type StravaStatus,
} from "./strava-format";

/** Like the rest of the page's live data, the Strava tab needs the real backend and a signed-in user. */
export const stravaAvailable = process.env.NEXT_PUBLIC_TRAINING_API === "http";

const unexpected = (): ApiResult<never> => ({
  ok: false,
  error: { code: "SERVER_ERROR", message: "The server sent something unexpected. Try again." },
});

async function call<T>(
  method: string,
  path: string,
  parse: (raw: unknown) => T | null,
  body?: unknown,
): Promise<ApiResult<T>> {
  const result = await request<unknown>(method, path, body);
  if (!result.ok) return result;
  const parsed = parse(result.data);
  return parsed === null ? unexpected() : { ok: true, data: parsed };
}

/** Whether Strava is connected and how many activities from it are on the schedule. No call to Strava is made. */
export function loadStatus(): Promise<ApiResult<StravaStatus>> {
  return call("GET", "/strava/status", parseStatus);
}

/** Ask Strava for the latest activities, as cards, newest first. Nothing is saved. */
export function pullActivities(): Promise<ApiResult<StravaCard[]>> {
  return call("POST", "/strava/pull", parsePull);
}

/** Save the chosen activities to the schedule. Saving one that is already there does nothing. */
export function saveToSchedule(stravaIds: number[]): Promise<ApiResult<SaveSummary>> {
  return call("POST", "/strava/save", parseSaveResult, { stravaIds });
}

/** Take every activity that came from Strava off the schedule. The athlete's own logs stay. */
export function removeFromSchedule(): Promise<ApiResult<number>> {
  return call("DELETE", "/strava/logs", parseDeleted);
}

/**
 * Where "Connect Strava" goes: Strava's consent page, which sends the athlete back to the callback route
 * with `state=training` so they land on this tab. Null when the server has no Strava app configured.
 */
export function stravaConnectUrl(): string | null {
  const clientId = process.env.NEXT_PUBLIC_STRAVA_CLIENT_ID;
  const redirectUri = process.env.NEXT_PUBLIC_STRAVA_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    approval_prompt: "force",
    scope: "activity:read_all,profile:read_all",
    state: "training",
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

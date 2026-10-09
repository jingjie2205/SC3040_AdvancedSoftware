/**
 * The Strava tab's connection to the backend: the athlete's latest activities, fetched live from Strava
 * through the existing `GET /strava/activities` route, and the link that connects a Strava account.
 *
 * Hard Rule 1: Strava data is for display only. This module is deliberately separate from `trainingApi`
 * (which feeds Home, the readiness score, the plan and the coach), and nothing it returns is saved or sent
 * anywhere. `test_training_strava_isolation.py` pins that the two never import each other.
 */
import { buildHeaders } from "./http-api";
import { parseStravaActivities, type StravaActivity } from "./strava-format";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

/** Like the rest of the page's live data, the Strava tab needs the real backend and a signed-in user. */
export const stravaAvailable = process.env.NEXT_PUBLIC_TRAINING_API === "http";

export type StravaResult =
  | { status: "ok"; activities: StravaActivity[] }
  | { status: "not_connected" }
  | { status: "error"; message: string };

const error = (message: string): StravaResult => ({ status: "error", message });

/** The athlete's latest activities, newest first. Never throws: every failure is a result the tab can show. */
export async function loadStravaActivities(limit = 10): Promise<StravaResult> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/strava/activities?per_page=${limit}`, {
      headers: await buildHeaders(),
      cache: "no-store",
    });
  } catch {
    return error("Couldn't reach the server. Check your connection and try again.");
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (response.ok) {
    return Array.isArray(body)
      ? { status: "ok", activities: parseStravaActivities(body) }
      : error("Strava sent something unexpected. Try again in a minute.");
  }

  const detail = typeof body === "object" && body !== null ? (body as { detail?: unknown }).detail : undefined;
  if (response.status === 400 && typeof detail === "string" && /not connected/i.test(detail)) {
    return { status: "not_connected" };
  }
  if (response.status === 401 || response.status === 403) {
    return error("Your session has expired. Sign in again.");
  }
  // The backend answers 500 when Strava itself refuses (rate limit, revoked access, outage).
  return error("Strava didn't respond. Try again in a minute, or reconnect Strava in Settings.");
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

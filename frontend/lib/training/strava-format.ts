/**
 * Strava activities as the training page's Strava tab shows them. Plain functions with no imports, so they
 * can be checked on their own.
 *
 * Hard Rule 1: this data is for display only. Nothing here, and nothing in the Strava tab, is passed to the
 * training API, the readiness score, the plan or the coach. `test_training_strava_isolation.py` pins that.
 */

export interface StravaActivity {
  id: number;
  name: string;
  /** Strava's own sport type: "Run", "Ride", "WeightTraining"... */
  type: string;
  /** The day it happened where the athlete was, as "YYYY-MM-DD". */
  day: string;
  /** "HH:MM" start time where the athlete was, or null when Strava didn't send one. */
  time: string | null;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number;
  averageHeartrate: number | null;
}

export type IconKind = "foot" | "bike" | "gym" | "swim" | "other";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Reads the list the backend returns. Anything that isn't a well-formed activity is left out rather than
 * shown half-empty, and the rest comes back newest first.
 */
export function parseStravaActivities(raw: unknown): StravaActivity[] {
  if (!Array.isArray(raw)) return [];
  const activities: StravaActivity[] = [];

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = finite(item.id);
    // Strava's "local" start time is the athlete's wall clock (its trailing Z is not a real UTC marker).
    const started =
      typeof item.start_date_local === "string"
        ? item.start_date_local
        : typeof item.start_date === "string"
          ? item.start_date
          : "";
    const when = started.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    if (id === null || !when || typeof item.name !== "string" || typeof item.type !== "string") continue;

    activities.push({
      id,
      name: item.name.trim() || "Untitled activity",
      type: item.type,
      day: when[1],
      time: when[2] ?? null,
      distanceM: Math.max(0, finite(item.distance) ?? 0),
      movingTimeS: Math.max(0, finite(item.moving_time) ?? finite(item.elapsed_time) ?? 0),
      elevationGainM: Math.max(0, finite(item.total_elevation_gain) ?? 0),
      averageHeartrate: finite(item.average_heartrate),
    });
  }

  const key = (a: StravaActivity) => `${a.day}T${a.time ?? "00:00"}`;
  return activities.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

/** "5.2 km", "42.2 km", "150 km", or whole metres under a kilometre. */
export function formatDistance(meters: number): string {
  const wholeMeters = Math.round(meters);
  if (wholeMeters < 1000) return `${wholeMeters} m`;
  const km = meters / 1000;
  return `${km < 100 ? km.toFixed(1) : Math.round(km)} km`;
}

/** "42 min", or "1 h 05 min" from an hour up. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const PACE_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);

/** Minutes per kilometre for activities where that is how people think of speed; null for the rest. */
export function formatPace(type: string, distanceM: number, movingTimeS: number): string | null {
  if (!PACE_TYPES.has(type) || distanceM < 500 || movingTimeS <= 0) return null;
  const secondsPerKm = movingTimeS / (distanceM / 1000);
  let minutes = Math.floor(secondsPerKm / 60);
  let seconds = Math.round(secondsPerKm - minutes * 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")} /km`;
}

/** "WeightTraining" becomes "Weight training". */
export function typeLabel(type: string): string {
  const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function iconKind(type: string): IconKind {
  if (PACE_TYPES.has(type)) return "foot";
  if (/ride|cycle|bike/i.test(type)) return "bike";
  if (/swim/i.test(type)) return "swim";
  if (/weight|workout|crossfit|yoga|pilates|strength/i.test(type)) return "gym";
  return "other";
}

/**
 * The Strava tab's cards: reading what the server sends and wording it. Plain functions with no imports, so they
 * can be checked on their own.
 *
 * Hard Rule 1: Strava data is for display. Cards are shown here, and an activity the athlete chooses is saved to the
 * schedule as a log flagged "strava", which the plan, the readiness score and the coach never count. Nothing here is
 * passed to the training API. `test_training_strava_isolation.py` pins that.
 */

/** The four kinds of training the schedule holds, which is all a Strava activity can be saved as. */
export type SavedAs = "run" | "cycling" | "gym" | "bodyweight";

export interface StravaCard {
  /** Strava's own id for the activity, which is also what "View on Strava" links to. */
  stravaId: number;
  name: string;
  /** Strava's own sport type: "Run", "Ride", "Swim"... */
  type: string;
  /** The day it happened where the athlete was, as "YYYY-MM-DD". */
  day: string;
  /** "HH:MM" start time where the athlete was, or null when there isn't one. */
  time: string | null;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number;
  averageHeartrate: number | null;
  /** What it would be saved to the schedule as, or null when the schedule has no place for it (a swim, a walk...). */
  savedAs: SavedAs | null;
  /** The minutes and the points it would be saved with; null exactly when `savedAs` is. */
  durationMin: number | null;
  points: number | null;
  /** Already on the schedule. */
  saved: boolean;
}

export interface StravaStatus {
  /** Whether a Strava account is connected right now. */
  connected: boolean;
  /** How many activities from Strava are on the schedule. They stay when Strava is disconnected. */
  savedCount: number;
}

export interface SaveSummary {
  /** The activities saved just now. */
  savedIds: number[];
  /** Asked for, but on the schedule already. */
  alreadySaved: number;
  /** Asked for, but no longer among Strava's latest or with nowhere on the schedule to go. */
  skipped: number;
}

export type IconKind = "foot" | "bike" | "gym" | "swim" | "other";

const SAVED_AS: readonly SavedAs[] = ["run", "cycling", "gym", "bodyweight"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const count = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};

const sortKey = (card: StravaCard) => `${card.day}T${card.time ?? "00:00"}`;

/**
 * Reads what `POST /strava/pull` returns. Anything that isn't a well-formed activity is left out rather than shown
 * half-empty; an answer that isn't the expected shape at all comes back as null. Newest first.
 */
export function parsePull(raw: unknown): StravaCard[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.activities)) return null;

  const cards: StravaCard[] = [];
  for (const item of raw.activities) {
    if (!isRecord(item)) continue;
    const stravaId = finite(item.stravaId);
    const when =
      typeof item.startedLocal === "string"
        ? item.startedLocal.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/)
        : null;
    if (
      stravaId === null ||
      !Number.isInteger(stravaId) ||
      !when ||
      typeof item.name !== "string" ||
      typeof item.sportType !== "string"
    ) {
      continue;
    }

    const savedAs = SAVED_AS.find((kind) => kind === item.activityType) ?? null;
    const durationMin = finite(item.durationMin);
    const points = finite(item.volume);
    const placed = savedAs !== null && durationMin !== null && points !== null;

    cards.push({
      stravaId,
      name: item.name.trim() || "Untitled activity",
      type: item.sportType,
      day: when[1],
      time: when[2] ?? null,
      distanceM: Math.max(0, finite(item.distanceM) ?? 0),
      movingTimeS: Math.max(0, finite(item.movingTimeS) ?? 0),
      elevationGainM: Math.max(0, finite(item.elevationGainM) ?? 0),
      averageHeartrate: finite(item.averageHeartrate),
      savedAs: placed ? savedAs : null,
      durationMin: placed ? durationMin : null,
      points: placed ? points : null,
      saved: item.saved === true,
    });
  }

  cards.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  return cards;
}

/** Reads what `GET /strava/status` returns. */
export function parseStatus(raw: unknown): StravaStatus | null {
  if (!isRecord(raw) || typeof raw.connected !== "boolean") return null;
  const savedCount = count(raw.savedCount);
  return savedCount === null ? null : { connected: raw.connected, savedCount };
}

/** Reads what `POST /strava/save` returns. */
export function parseSaveResult(raw: unknown): SaveSummary | null {
  if (!isRecord(raw) || !Array.isArray(raw.savedIds)) return null;
  const alreadySaved = count(raw.alreadySaved);
  const skipped = count(raw.skipped);
  const savedIds = raw.savedIds.map(finite);
  if (alreadySaved === null || skipped === null || savedIds.some((id) => id === null)) return null;
  return { savedIds: savedIds as number[], alreadySaved, skipped };
}

/** Reads what `DELETE /strava/logs` returns: how many were taken off the schedule. */
export function parseDeleted(raw: unknown): number | null {
  return isRecord(raw) ? count(raw.deleted) : null;
}

/** Can this card be saved to the schedule now: it has a place there, and isn't there already. */
export function canSave(card: StravaCard): boolean {
  return card.savedAs !== null && !card.saved;
}

export interface PullSummary {
  total: number;
  /** Can be saved now. */
  toSave: number;
  /** Already on the schedule. */
  onSchedule: number;
  /** The schedule has no place for them. */
  unsupported: number;
}

export function summarisePull(cards: readonly StravaCard[]): PullSummary {
  return {
    total: cards.length,
    toSave: cards.filter(canSave).length,
    onSchedule: cards.filter((card) => card.saved).length,
    unsupported: cards.filter((card) => card.savedAs === null && !card.saved).length,
  };
}

/** What the athlete is told after a save. */
export function describeSave({ savedIds, alreadySaved, skipped }: SaveSummary): string {
  const sentences: string[] = [];
  if (savedIds.length > 0) {
    sentences.push(`Saved ${plural(savedIds.length, "activity", "activities")} to your schedule.`);
  }
  if (alreadySaved > 0) {
    sentences.push(
      `${plural(alreadySaved, "activity", "activities")} ${alreadySaved === 1 ? "was" : "were"} already on your schedule.`,
    );
  }
  if (skipped > 0) {
    sentences.push(
      `${plural(skipped, "activity", "activities")} couldn't be saved because ${skipped === 1 ? "it is" : "they are"} no longer among your latest on Strava. Upload again to refresh the list.`,
    );
  }
  return sentences.join(" ") || "Nothing was saved.";
}

/** "error" when nothing was saved and something was refused; otherwise the save went as asked. */
export function saveTone({ savedIds, skipped }: SaveSummary): "ok" | "error" {
  return savedIds.length === 0 && skipped > 0 ? "error" : "ok";
}

/** Where "View on Strava" goes. */
export function activityUrl(stravaId: number): string {
  return `https://www.strava.com/activities/${stravaId}`;
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

const TYPE_LABELS: Record<string, string> = {
  EBikeRide: "E-bike ride",
  EMountainBikeRide: "E-mountain bike ride",
  Crossfit: "CrossFit",
  HighIntensityIntervalTraining: "HIIT",
};

/** "TrailRun" becomes "Trail run". */
export function typeLabel(type: string): string {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function iconKind(type: string): IconKind {
  if (PACE_TYPES.has(type)) return "foot";
  if (/ride|cycle|bike/i.test(type)) return "bike";
  if (/swim/i.test(type)) return "swim";
  if (/weight|workout|crossfit|yoga|pilates|strength|interval/i.test(type)) return "gym";
  return "other";
}

/** "1 run", "3 runs"; pass the plural for the odd ones: plural(2, "activity", "activities"). */
export function plural(n: number, noun: string, pluralNoun: string = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : pluralNoun}`;
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bike,
  Dumbbell,
  ExternalLink,
  Footprints,
  HeartPulse,
  Info,
  Mountain,
  RefreshCw,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { formatDay } from "@/lib/training/dates";
import {
  loadStravaActivities,
  stravaAvailable,
  stravaConnectUrl,
  type StravaResult,
} from "@/lib/training/strava";
import {
  formatDistance,
  formatDuration,
  formatPace,
  iconKind,
  typeLabel,
  type IconKind,
  type StravaActivity,
} from "@/lib/training/strava-format";
import { ErrorBox, Loading, btnSecondary, cardClass } from "./ui";

/*
 * Hard Rule 1: Strava data is for display only. This panel keeps what it loads to itself. It doesn't use
 * `trainingApi`, and nothing it shows reaches the plan, the readiness score or the coach.
 */

const ICONS: Record<IconKind, LucideIcon> = {
  foot: Footprints,
  bike: Bike,
  gym: Dumbbell,
  swim: Waves,
  other: Activity,
};

const LIMIT = 10;

/** "Fri 14 Aug", with the year added for anything not from this year, since the list can reach back years. */
function dayLabel(day: string): string {
  const year = day.slice(0, 4);
  return year === String(new Date().getFullYear()) ? formatDay(day) : `${formatDay(day)} ${year}`;
}

function ActivityRow({ activity }: { activity: StravaActivity }) {
  const Icon = ICONS[iconKind(activity.type)];
  const pace = formatPace(activity.type, activity.distanceM, activity.movingTimeS);

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="truncate text-sm font-semibold text-white">{activity.name}</p>
          <a
            href={`https://www.strava.com/activities/${activity.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-[#FC4C02] hover:underline"
          >
            View on Strava
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
        <p className="text-xs text-slate-400">
          {typeLabel(activity.type)} · {dayLabel(activity.day)}
          {activity.time ? ` · ${activity.time}` : ""}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
          {activity.distanceM > 0 && <span>{formatDistance(activity.distanceM)}</span>}
          <span>{formatDuration(activity.movingTimeS)}</span>
          {pace && <span>{pace}</span>}
          {activity.averageHeartrate !== null && (
            <span className="inline-flex items-center gap-1">
              <HeartPulse className="h-3 w-3 text-rose-300" aria-hidden="true" />
              {Math.round(activity.averageHeartrate)} bpm avg
            </span>
          )}
          {activity.elevationGainM >= 1 && (
            <span className="inline-flex items-center gap-1">
              <Mountain className="h-3 w-3 text-slate-400" aria-hidden="true" />
              {Math.round(activity.elevationGainM)} m climb
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

export function StravaPanel() {
  const [result, setResult] = useState<StravaResult | null>(null);
  const [loading, setLoading] = useState(stravaAvailable);
  const [refreshKey, setRefreshKey] = useState(0);

  // Opening the tab is what asks Strava: nothing is fetched while another tab is showing.
  useEffect(() => {
    if (!stravaAvailable) return;
    let cancelled = false;
    setLoading(true);
    loadStravaActivities(LIMIT)
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const reload = () => setRefreshKey((key) => key + 1);
  const connectUrl = stravaConnectUrl();

  return (
    <section aria-labelledby="strava-heading" className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#FC4C02]/20 bg-[#FC4C02]/10 text-[#FC4C02]">
            <Activity className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="strava-heading" className="text-base font-bold text-white">
              Strava activities
            </h2>
            <p className="text-xs text-slate-400">Your latest activities, loaded from Strava.</p>
          </div>
        </div>
        {result?.status === "ok" && (
          <button type="button" onClick={reload} disabled={loading} className={btnSecondary}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
        Shown for reference only. Strava data is never used for your plan, readiness score or coach.
      </p>

      <div className="mt-5">
        {!stravaAvailable ? (
          <p className="text-sm text-slate-400">
            Strava activities need the backend. Start it, set <code>NEXT_PUBLIC_TRAINING_API=http</code>{" "}
            and sign in.
          </p>
        ) : result === null ? (
          loading ? <Loading label="Loading your Strava activities…" /> : null
        ) : result.status === "not_connected" ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-md text-sm text-slate-300">
              Connect Strava to see your recent activities here.
            </p>
            {connectUrl ? (
              <a
                href={connectUrl}
                className="flex items-center gap-2 rounded-lg bg-[#FC4C02] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#E34402]"
              >
                Connect Strava
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p className="text-xs text-slate-400">Strava isn&apos;t set up on this server yet.</p>
            )}
          </div>
        ) : result.status === "error" ? (
          <ErrorBox message={result.message} onRetry={reload} />
        ) : result.activities.length === 0 ? (
          <p className="text-sm text-slate-400">There are no activities on your Strava account yet.</p>
        ) : (
          <>
            <ul aria-label="Your latest Strava activities" className="divide-y divide-slate-800/80">
              {result.activities.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </ul>
            {loading && <Loading label="Refreshing…" />}
          </>
        )}
      </div>

      {stravaAvailable && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-4 text-[11px] text-slate-500">
          <span>Powered by Strava</span>
          <Link
            href="/dashboard/settings?tab=integrations"
            className="font-semibold text-slate-400 hover:text-white hover:underline"
          >
            Manage the connection in Settings
          </Link>
        </div>
      )}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gamificationApi } from "@/lib/gamification/api";
import type { CheckInResult, GamificationStats } from "@/lib/gamification/types";
import { ChallengesPanel } from "./_components/challenges-panel";
import { CheckInPanel } from "./_components/checkin-panel";
import { LeaderboardPanel } from "./_components/leaderboard-panel";
import { StatsPanel } from "./_components/stats-panel";
import { ErrorBox, Loading } from "./_components/ui";

export default function LeaderboardPage() {
  const [stats, setStats] = useState<GamificationStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    gamificationApi
      .getStats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your progress");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleCheckedIn = useCallback(
    (result: CheckInResult | null) => {
      if (result) {
        clearTimeout(noticeTimer.current);
        setNotice(`+${result.xpAwarded} XP · ${result.currentStreak}-day streak`);
        noticeTimer.current = setTimeout(() => setNotice(null), 4500);
      }
      refresh();
    },
    [refresh],
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            Leaderboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Check in daily, earn XP, climb the ranks and take on challenges.
          </p>
        </div>
        {notice && (
          <span
            role="status"
            className="text-xs font-medium text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20 w-fit"
          >
            {notice}
          </span>
        )}
      </div>

      {loadError ? (
        <ErrorBox message={loadError} onRetry={refresh} />
      ) : !stats ? (
        <Loading label="Loading your progress…" />
      ) : (
        <>
          <StatsPanel stats={stats} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <CheckInPanel stats={stats} onCheckedIn={handleCheckedIn} />
            <div className="lg:col-span-2">
              <LeaderboardPanel refreshKey={refreshKey} />
            </div>
          </div>
          <ChallengesPanel refreshKey={refreshKey} />
        </>
      )}
    </div>
  );
}

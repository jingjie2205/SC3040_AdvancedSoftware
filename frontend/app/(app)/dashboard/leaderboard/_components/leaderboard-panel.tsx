"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Flame, Medal, Sparkles, Trophy, UserPlus, Users } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import type { Leaderboard, LeaderboardMetric } from "@/lib/gamification/types";
import { CardHeader, ErrorBox, FRIENDS_PATH, Loading, Segmented, btnPrimary, cardClass, displayName } from "./ui";

const METRICS = [
  { value: "xp", label: "XP", icon: Sparkles },
  { value: "streak", label: "Streak", icon: Flame },
] as const;

const PODIUM_CLASSES = ["text-amber-300", "text-slate-300", "text-orange-400"];

function Position({ position }: { position: number }) {
  if (position > PODIUM_CLASSES.length) {
    return <span className="w-6 text-center text-xs font-semibold text-slate-500">{position}</span>;
  }
  const Icon = position === 1 ? Trophy : Medal;
  return (
    <span className="flex w-6 justify-center" aria-label={`Position ${position}`}>
      <Icon className={`h-4 w-4 ${PODIUM_CLASSES[position - 1]}`} aria-hidden="true" />
    </span>
  );
}

function NoFriends() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-700 px-6 py-10 text-center">
      <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
        <Users className="h-8 w-8 text-emerald-400" aria-hidden="true" />
        <Trophy className="absolute -right-1 -top-1 h-5 w-5 text-amber-300" aria-hidden="true" />
      </div>
      <p className="text-sm font-semibold text-white">No friends on your leaderboard yet</p>
      <p className="mt-1 max-w-xs text-xs text-slate-400">
        The leaderboard ranks you against your friends. Add some to see who comes out on top.
      </p>
      <Link href={FRIENDS_PATH} className={`${btnPrimary} mt-5`}>
        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
        Add friends
      </Link>
    </div>
  );
}

export function LeaderboardPanel({ refreshKey }: { refreshKey: number }) {
  const [metric, setMetric] = useState<LeaderboardMetric>("xp");
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    setError(null);
    gamificationApi
      .getLeaderboard(metric)
      .then((data) => {
        if (!cancelled) setBoard(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the leaderboard");
      });
    return () => {
      cancelled = true;
    };
  }, [metric, refreshKey, retryKey]);

  return (
    <div className={cardClass}>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader title="Leaderboard" subtitle="You and your friends" />
        <Segmented label="Rank by" value={metric} options={[...METRICS]} onChange={setMetric} />
      </div>

      {error ? (
        <ErrorBox message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !board ? (
        <Loading label="Loading leaderboard…" />
      ) : board.friendCount === 0 ? (
        <NoFriends />
      ) : board.entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-xs text-slate-400">
          {metric === "streak"
            ? "No active streaks among you and your friends. Check in to start one."
            : "No one has earned XP yet. Check in to get on the board."}
        </p>
      ) : (
        <ol className="space-y-2">
          {board.entries.map((entry) => (
            <li
              key={entry.userId}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                entry.isCurrentUser
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-slate-800 bg-slate-950/60"
              }`}
            >
              <Position position={entry.position} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-sm font-semibold ${entry.isCurrentUser ? "text-emerald-300" : "text-white"}`}>
                  {displayName(entry)}
                </p>
                <p className="text-[11px] text-slate-400">{entry.rank}</p>
              </div>
              <p className="text-sm font-bold text-white">
                {metric === "xp" ? entry.totalXp.toLocaleString() : entry.currentStreak}
                <span className="ml-1 text-[10px] font-semibold text-slate-400">
                  {metric === "xp" ? "XP" : entry.currentStreak === 1 ? "day" : "days"}
                </span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

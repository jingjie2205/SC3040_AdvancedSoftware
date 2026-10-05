"use client";

import { Award, Flame, Sparkles } from "lucide-react";
import type { GamificationStats } from "@/lib/gamification/types";
import { cardClass, tileClass } from "./ui";

export function StatsPanel({ stats }: { stats: GamificationStats }) {
  const nextThreshold = stats.xpToNextRank === null ? null : stats.totalXp + stats.xpToNextRank;
  const progressPct = nextThreshold ? Math.round((stats.totalXp / nextThreshold) * 100) : 100;

  return (
    <div className={cardClass}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Rank */}
        <div className={tileClass}>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Award className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" /> Rank
          </span>
          <p className="mt-2 text-2xl font-extrabold text-white">{stats.rank}</p>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800"
            role="progressbar"
            aria-label={stats.nextRank ? `Progress to ${stats.nextRank}` : "Top rank reached"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            {stats.nextRank
              ? `${stats.xpToNextRank} XP to ${stats.nextRank}`
              : "Top rank reached"}
          </p>
        </div>

        {/* XP */}
        <div className={tileClass}>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> Total XP
          </span>
          <p className="mt-2 text-2xl font-extrabold text-white">
            {stats.totalXp.toLocaleString()}
            <span className="ml-1 text-xs font-semibold text-slate-400">XP</span>
          </p>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Earn XP from check-ins, workouts and meal logs
          </p>
        </div>

        {/* Streak */}
        <div className={tileClass}>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Flame className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" /> Check-in streak
          </span>
          <p className="mt-2 text-2xl font-extrabold text-white">
            {stats.currentStreak}
            <span className="ml-1 text-xs font-semibold text-slate-400">
              {stats.currentStreak === 1 ? "day" : "days"}
            </span>
          </p>
          <p className="mt-1.5 text-[11px] text-slate-400">Best: {stats.longestStreak} days</p>
        </div>
      </div>
    </div>
  );
}

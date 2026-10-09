"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, Dumbbell, Trophy, Utensils, type LucideIcon } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import type { XpEvent, XpSource } from "@/lib/gamification/types";
import { CardHeader, ErrorBox, Loading, cardClass } from "./ui";

const SOURCE_INFO: Record<XpSource, { label: string; icon: LucideIcon; className: string }> = {
  checkin: { label: "Daily check-in", icon: CalendarCheck, className: "text-emerald-400" },
  workout: { label: "Workout logged", icon: Dumbbell, className: "text-sky-400" },
  meal: { label: "Meal logged", icon: Utensils, className: "text-orange-400" },
  challenge: { label: "Challenge completed", icon: Trophy, className: "text-amber-300" },
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function XpHistoryPanel({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<XpEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    gamificationApi
      .getXpHistory()
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your XP history");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryKey]);

  return (
    <div className={cardClass}>
      <CardHeader title="Recent XP" subtitle="Where your XP came from" />
      {error ? (
        <ErrorBox message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !events ? (
        <Loading label="Loading XP history…" />
      ) : events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-xs text-slate-400">
          No XP yet. Check in, log a workout or log a meal to start earning.
        </p>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => {
            const info = SOURCE_INFO[event.source];
            const Icon = info.icon;
            return (
              <li key={event.id} className="flex items-center gap-3 text-xs">
                <Icon className={`h-4 w-4 shrink-0 ${info.className}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-200">{info.label}</p>
                  <p className="text-[10px] text-slate-500">{formatWhen(event.createdAt)}</p>
                </div>
                <span className="font-bold text-emerald-300">+{event.amount} XP</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

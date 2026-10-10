"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Dumbbell, Loader2, RefreshCw, Utensils } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import type { PendingXp, PendingXpResync } from "@/lib/gamification/types";
import { btnSecondary } from "./ui";

function resyncSummary(result: PendingXpResync): string {
  const parts = [];
  if (result.awardedXp > 0) parts.push(`+${result.awardedXp} XP added`);
  if (result.removed > 0) parts.push(`${result.removed} deleted ${result.removed === 1 ? "activity" : "activities"} cleared`);
  if (result.stillPending > 0) parts.push(`${result.stillPending} still on hold`);
  return parts.length ? parts.join(" · ") : "Nothing changed yet.";
}

/** G-2: XP held because a workout or meal failed a check, with a way to re-sync it. */
export function PendingXpAlert({ refreshKey, onResynced }: { refreshKey: number; onResynced: () => void }) {
  const [pending, setPending] = useState<PendingXp | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gamificationApi
      .getPendingXp()
      .then((data) => {
        if (!cancelled) setPending(data);
      })
      .catch(() => {
        // Held XP is secondary to the page; if it can't load, the page still works without the alert.
        if (!cancelled) setPending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function resync() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await gamificationApi.resyncPendingXp();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setPending(result.data);
    setMessage(resyncSummary(result.data));
    if (result.data.awardedXp > 0) onResynced();
  }

  if (message && pending && pending.items.length === 0) {
    return (
      <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">
        Re-synced: {message}
      </p>
    );
  }
  if (!pending || pending.items.length === 0) return null;

  return (
    <div role="alert" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-amber-200">{pending.totalXp} XP on hold</p>
            <p className="mt-0.5 text-xs text-amber-100/80">
              {pending.items.length === 1 ? "An activity" : `${pending.items.length} activities`} couldn&apos;t be
              verified. Fix the details below, then re-sync to collect the XP.
            </p>
          </div>
        </div>
        <button type="button" onClick={resync} disabled={busy} className={`${btnSecondary} w-fit shrink-0`}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Re-sync
        </button>
      </div>

      <ul className="mt-4 space-y-2">
        {pending.items.map((item) => {
          const Icon = item.source === "workout" ? Dumbbell : Utensils;
          return (
            <li key={item.id} className="flex items-start gap-3 rounded-lg bg-slate-950/40 px-3 py-2 text-xs">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-200">
                  {item.source === "workout" ? "Workout" : "Meal"} ·{" "}
                  {new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                </p>
                <p className="text-slate-400">{item.reason}</p>
              </div>
              <span className="shrink-0 font-semibold text-amber-200">+{item.amount} XP</span>
            </li>
          );
        })}
      </ul>

      {message && <p role="status" className="mt-3 text-xs text-amber-100">Re-synced: {message}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

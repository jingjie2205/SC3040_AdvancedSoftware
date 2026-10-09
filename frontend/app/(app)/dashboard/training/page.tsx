"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CalendarDays, ClipboardList, Info, Sparkles, SlidersHorizontal } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import { formatDay } from "@/lib/training/dates";
import type { PlanAdaptation, TrainingPlan, TrainingPreferences } from "@/lib/training/types";
import { PlanPanel } from "./_components/plan-panel";
import { PreferencesForm } from "./_components/preferences-form";
import { SchedulePanel } from "./_components/schedule-panel";
import { StravaPanel } from "./_components/strava-panel";
import { TodayPanel } from "./_components/today-panel";
import { ErrorBox, Loading, Segmented, btnSecondary } from "./_components/ui";

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

type Tab = "today" | "schedule" | "plan" | "preferences" | "strava";

const TABS = [
  { value: "today", label: "Today", icon: Sparkles },
  { value: "schedule", label: "Schedule", icon: CalendarDays },
  { value: "plan", label: "Plan", icon: ClipboardList },
  { value: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { value: "strava", label: "Strava", icon: Activity },
] as const;

const TRIGGER_LABEL: Record<PlanAdaptation["trigger"], string> = {
  missed_sessions: "Too many missed sessions",
  low_readiness: "Readiness stayed low",
  manual: "You asked for it",
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TrainingPage() {
  const [tab, setTab] = useState<Tab>("today");
  const [preferences, setPreferences] = useState<TrainingPreferences | null>(null);
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([trainingApi.getPreferences(), trainingApi.getPlan()])
      .then(([prefs, activePlan]) => {
        if (cancelled) return;
        setPreferences(prefs);
        setPlan(activePlan);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your training data");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const showNotice = useCallback((message: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), 4500);
  }, []);

  // Strava's consent page sends the athlete back here (through /api/auth/callback) with the outcome in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("strava");
    if (!outcome) return;
    setTab("strava");
    showNotice(
      outcome === "connected"
        ? "Strava connected"
        : params.get("reason") === "access_denied"
          ? "Strava access wasn't granted"
          : "Couldn't connect Strava. Try again.",
    );
    window.history.replaceState(null, "", window.location.pathname);
  }, [showNotice]);

  async function acknowledgeAdaptation() {
    try {
      await trainingApi.acknowledgeAdaptation();
      refresh();
    } catch (e: unknown) {
      showNotice(e instanceof Error ? e.message : "Couldn't dismiss that message");
    }
  }

  const adaptation = plan?.lastAdaptation && !plan.lastAdaptation.acknowledged ? plan.lastAdaptation : null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            Training
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Your plan, today&apos;s workout and readiness in one place.
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

      <Segmented label="Training sections" value={tab} onChange={setTab} options={[...TABS]} fill />

      {adaptation && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="flex gap-3 text-sm text-sky-100">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
            <div>
              <p className="font-semibold">
                Your plan was adapted on {formatDay(adaptation.adaptedOn)}
                <span className="font-normal text-sky-200"> · {TRIGGER_LABEL[adaptation.trigger]}</span>
              </p>
              <p className="mt-1 text-xs text-sky-200">{adaptation.reason}</p>
            </div>
          </div>
          <button type="button" onClick={acknowledgeAdaptation} className={btnSecondary}>
            Got it
          </button>
        </div>
      )}

      {loadError ? (
        <ErrorBox message={loadError} onRetry={refresh} />
      ) : !loaded ? (
        <Loading label="Loading your training data…" />
      ) : (
        <>
          {tab === "today" && (
            <TodayPanel
              preferences={preferences}
              plan={plan}
              refreshKey={refreshKey}
              onChanged={refresh}
              onNotice={showNotice}
              onGoTo={setTab}
            />
          )}
          {tab === "schedule" && (
            <SchedulePanel
              plan={plan}
              refreshKey={refreshKey}
              onChanged={refresh}
              onNotice={showNotice}
            />
          )}
          {tab === "plan" && (
            <PlanPanel
              preferences={preferences}
              plan={plan}
              refreshKey={refreshKey}
              onChanged={refresh}
              onNotice={showNotice}
              onGoToPreferences={() => setTab("preferences")}
            />
          )}
          {tab === "preferences" && (
            <PreferencesForm
              key={preferences?.updatedAt ?? "new"}
              preferences={preferences}
              hasPlan={plan !== null}
              onSaved={(message) => {
                showNotice(message);
                refresh();
              }}
            />
          )}
          {tab === "strava" && <StravaPanel />}
        </>
      )}
    </div>
  );
}

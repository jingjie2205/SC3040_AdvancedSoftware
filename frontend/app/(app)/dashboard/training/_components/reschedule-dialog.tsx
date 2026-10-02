"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import { formatDay, todayISO } from "@/lib/training/dates";
import { checkMove } from "@/lib/training/rules";
import type { PlannedSession, TrainingPlan } from "@/lib/training/types";
import {
  ACTIVITY_LABEL,
  BandBadge,
  Modal,
  btnPrimary,
  btnSecondary,
  inputClass,
} from "./ui";

export function RescheduleDialog({
  session,
  plan,
  onClose,
  onMoved,
}: {
  session: PlannedSession;
  plan: TrainingPlan;
  onClose: () => void;
  onMoved: (message: string) => void;
}) {
  const today = todayISO();
  const [target, setTarget] = useState(session.date);
  const [planSessions, setPlanSessions] = useState<PlannedSession[] | null>(null);
  const [planLoadFailed, setPlanLoadFailed] = useState(false);
  const [planVersion, setPlanVersion] = useState(0);
  const [serverRefusal, setServerRefusal] = useState<{
    message: string;
    suggestedDate: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // The whole plan is loaded so the early warning also sees neighbours in adjacent weeks.
  // If it can't load, the server still checks the move. A server refusal means our copy is
  // out of date, so it is loaded again.
  useEffect(() => {
    let cancelled = false;
    trainingApi
      .getSchedule(plan.startDate, plan.endDate)
      .then((data) => {
        if (!cancelled) setPlanSessions(data.sessions);
      })
      .catch(() => {
        if (!cancelled) setPlanLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.startDate, plan.endDate, planVersion]);

  const check = useMemo(
    () =>
      planSessions
        ? checkMove(session, target, {
            sessions: planSessions.filter((s) => s.planId === plan.id),
            planStart: plan.startDate,
            planEnd: plan.endDate,
            today,
          })
        : null,
    [session, planSessions, plan, target, today],
  );

  const refusal =
    serverRefusal ??
    (check && !check.ok && check.code !== "NO_CHANGE"
      ? { message: check.reason, suggestedDate: check.suggestedDate }
      : null);
  const checking = planSessions === null && !planLoadFailed;
  const blocked = checking || (check !== null && !check.ok);

  function pick(date: string) {
    setTarget(date);
    setServerRefusal(null);
  }

  async function handleMove() {
    setSaving(true);
    const result = await trainingApi.rescheduleSession(session.id, target);
    setSaving(false);
    if (!result.ok) {
      setServerRefusal({
        message: result.error.message,
        suggestedDate: result.error.suggestedDate ?? null,
      });
      setPlanVersion((v) => v + 1);
      return;
    }
    onMoved(`Session moved to ${formatDay(target)}`);
    onClose();
  }

  return (
    <Modal title="Move session" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
          <span className="font-semibold text-white">{ACTIVITY_LABEL[session.activityType]}</span>
          <BandBadge band={session.intensityBand} />
          <span className="text-slate-400">currently on {formatDay(session.date)}</span>
        </div>

        <label className="block">
          <span className="text-xs text-slate-400">Move to</span>
          <input
            type="date"
            min={plan.startDate > today ? plan.startDate : today}
            max={plan.endDate}
            value={target}
            onChange={(e) => pick(e.target.value)}
            data-autofocus
            className={inputClass}
          />
        </label>

        {refusal && (
          <div
            role="alert"
            className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <div className="space-y-2">
              <p>{refusal.message}</p>
              {refusal.suggestedDate && (
                <button
                  type="button"
                  onClick={() => pick(refusal.suggestedDate as string)}
                  className={btnSecondary}
                >
                  Use nearest valid day: {formatDay(refusal.suggestedDate)}
                </button>
              )}
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400">
          Moving a session within the same week keeps that week&apos;s volume unchanged.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={saving} className={btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleMove}
            disabled={saving || blocked}
            className={btnPrimary}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Move session
          </button>
        </div>
      </div>
    </Modal>
  );
}

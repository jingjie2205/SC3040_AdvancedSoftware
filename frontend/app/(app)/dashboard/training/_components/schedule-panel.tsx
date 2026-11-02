"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import {
  addDays,
  addMonths,
  formatDay,
  formatMonthYear,
  formatShortDate,
  parseISODate,
  startOfMonth,
  startOfWeek,
  todayISO,
} from "@/lib/training/dates";
import { LOGGABLE_STATUSES, MOVABLE_STATUSES } from "@/lib/training/rules";
import type {
  PlannedSession,
  Schedule,
  TrainingPlan,
  TrainingPreferences,
  WorkoutSession,
} from "@/lib/training/types";
import { LogWorkoutDialog, type LogTarget } from "./log-workout-dialog";
import { RescheduleDialog } from "./reschedule-dialog";
import { SessionDialog, type SessionDialogTarget } from "./session-dialog";
import {
  ACTIVITY_LABEL,
  ActivityIcon,
  BandBadge,
  ConfirmDialog,
  ErrorBox,
  Loading,
  STATUS_META,
  Segmented,
  StatusBadge,
  btnDanger,
  btnPrimary,
  btnSecondary,
  cardClass,
} from "./ui";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type View = "week" | "month";

interface DayEntry {
  key: string;
  session: PlannedSession | null;
  workout: WorkoutSession | null;
}

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function groupByDay(schedule: Schedule): Map<string, DayEntry[]> {
  const days = new Map<string, DayEntry[]>();
  const add = (date: string, entry: DayEntry) => days.set(date, [...(days.get(date) ?? []), entry]);

  const linked = new Set<string>();
  for (const session of schedule.sessions) {
    const workout = schedule.workouts.find((w) => w.plannedSessionId === session.id) ?? null;
    if (workout) linked.add(workout.id);
    add(session.date, { key: session.id, session, workout });
  }
  for (const workout of schedule.workouts) {
    if (!linked.has(workout.id)) add(workout.date, { key: workout.id, session: null, workout });
  }
  return days;
}

/** A log saved from the Strava tab. It is shown here and counts towards nothing else (Hard Rule 1). */
function isFromStrava(workout: WorkoutSession | null): boolean {
  return workout?.source === "strava";
}

/** Strava's activity page for a log, or null when the log has no usable Strava id. */
function stravaLink(workout: WorkoutSession | null): string | null {
  const id = workout?.externalId;
  return id && /^\d+$/.test(id) ? `https://www.strava.com/activities/${id}` : null;
}

function entryLabel(date: string, entry: DayEntry): string {
  if (!entry.session) {
    const type = entry.workout ? ACTIVITY_LABEL[entry.workout.activityType] : "Workout";
    return `${formatDay(date)}: ${type}, ${isFromStrava(entry.workout) ? "from Strava" : "ad hoc"}, completed`;
  }
  const { session } = entry;
  return `${formatDay(date)}: ${ACTIVITY_LABEL[session.activityType]}, ${session.intensityBand}, ${STATUS_META[session.status].label.toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SchedulePanel({
  plan,
  preferences,
  refreshKey,
  onChanged,
  onNotice,
}: {
  plan: TrainingPlan | null;
  preferences: TrainingPreferences | null;
  refreshKey: number;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<PlannedSession | null>(null);
  const [sessionTarget, setSessionTarget] = useState<SessionDialogTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PlannedSession | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Dates are set after mount so server and client markup can't disagree about "today".
  useEffect(() => {
    const today = todayISO();
    setAnchor(today);
    setSelected(today);
  }, []);

  const range = useMemo(() => {
    if (!anchor) return null;
    if (view === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    const from = startOfWeek(startOfMonth(anchor));
    return { from, to: addDays(from, 41) };
  }, [anchor, view]);

  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    setLoadError(null);
    trainingApi
      .getSchedule(range.from, range.to)
      .then((data) => {
        if (!cancelled) setSchedule(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your schedule");
      });
    return () => {
      cancelled = true;
    };
  }, [range, refreshKey, retry]);

  const days = useMemo(() => (schedule ? groupByDay(schedule) : new Map<string, DayEntry[]>()), [schedule]);

  if (!anchor || !range || !selected) return <Loading label="Loading schedule…" />;

  const today = todayISO();
  const cellCount = view === "week" ? 7 : 42;
  const cells = Array.from({ length: cellCount }, (_, i) => addDays(range.from, i));
  // Keep the selected day inside whatever range is showing, so the detail panel is never for a day that isn't loaded.
  const step = (direction: 1 | -1) => {
    const next = view === "week" ? addDays(anchor, 7 * direction) : addMonths(anchor, direction);
    setAnchor(next);
    setSelected(next);
  };
  const goToday = () => {
    setAnchor(today);
    setSelected(today);
  };
  const changeView = (next: View) => {
    setView(next);
    setAnchor(selected);
  };
  const title =
    view === "week"
      ? `${formatShortDate(range.from)} – ${formatShortDate(range.to)}`
      : formatMonthYear(anchor);

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    setRemoveError(null);
    const result = await trainingApi.removeSession(removeTarget.id);
    setRemoving(false);
    if (!result.ok) {
      setRemoveError(result.error.message);
      return;
    }
    const n = result.data.redistributedCount;
    onNotice(
      n > 0
        ? `Session removed. Its volume was spread across ${n} other session${n === 1 ? "" : "s"} this week.`
        : "Session removed.",
    );
    setRemoveTarget(null);
    onChanged();
  }

  const selectedEntries = days.get(selected) ?? [];
  // A session can be planned by hand on any day from today to the end of the plan, whatever is already on it.
  const canPlanHere =
    plan !== null &&
    selected >= (plan.startDate > today ? plan.startDate : today) &&
    selected <= plan.endDate;

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-bold text-white">Training schedule</h3>
            <p className="text-xs text-slate-400">
              {plan
                ? "Planned and completed sessions"
                : "No active plan, so only logged workouts show here. Generate one on the Plan tab to plan sessions yourself."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Calendar view"
              value={view}
              onChange={changeView}
              options={[
                { value: "week", label: "Week" },
                { value: "month", label: "Month" },
              ]}
            />
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => step(-1)} aria-label="Previous" className={btnSecondary}>
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={goToday} className={btnSecondary}>
                Today
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next" className={btnSecondary}>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <p className="mb-3 text-sm font-semibold text-white" aria-live="polite">
          {title}
        </p>

        {loadError && <ErrorBox message={loadError} onRetry={() => setRetry((n) => n + 1)} />}

        {view === "month" && (
          <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-slate-400">
            {WEEKDAY_HEADERS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        )}

        <div className={`grid gap-1 ${view === "week" ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7" : "grid-cols-7"}`}>
          {cells.map((date) => (
            <DayCell
              key={date}
              date={date}
              view={view}
              entries={days.get(date) ?? []}
              isToday={date === today}
              isSelected={date === selected}
              isOutsideMonth={view === "month" && date.slice(0, 7) !== anchor.slice(0, 7)}
              onSelect={() => setSelected(date)}
            />
          ))}
        </div>

        <Legend />
      </div>

      <div className={cardClass}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-bold text-white">{formatDay(selected)}</h3>
          <div className="flex flex-wrap items-center gap-2">
            {canPlanHere && (
              <button
                type="button"
                onClick={() => setSessionTarget({ kind: "add", date: selected })}
                className={btnPrimary}
              >
                <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
                Add session
              </button>
            )}
            {selected <= today && (
              <button
                type="button"
                onClick={() => setLogTarget({ session: null, date: selected })}
                className={btnSecondary}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Log ad hoc session
              </button>
            )}
          </div>
        </div>

        {selectedEntries.length === 0 ? (
          <p className="text-sm text-slate-400">
            {canPlanHere
              ? "Nothing scheduled on this day. You can plan a session yourself."
              : "Nothing scheduled or logged on this day."}
          </p>
        ) : (
          <ul className="space-y-3">
            {selectedEntries.map((entry) => (
              <DetailRow
                key={entry.key}
                entry={entry}
                today={today}
                isCurrentPlan={entry.session !== null && entry.session.planId === plan?.id}
                onLog={(session) => setLogTarget({ session, date: session.date })}
                onMove={setMoveTarget}
                onEdit={(session) => setSessionTarget({ kind: "edit", session })}
                onRemove={(session) => {
                  setRemoveError(null);
                  setRemoveTarget(session);
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {logTarget && (
        <LogWorkoutDialog
          target={logTarget}
          onClose={() => setLogTarget(null)}
          onLogged={(message) => {
            onNotice(message);
            onChanged();
          }}
        />
      )}

      {sessionTarget && plan && (
        <SessionDialog
          target={sessionTarget}
          plan={plan}
          preferences={preferences}
          onClose={() => setSessionTarget(null)}
          onSaved={(message) => {
            onNotice(message);
            onChanged();
          }}
        />
      )}

      {moveTarget && plan && (
        <RescheduleDialog
          session={moveTarget}
          plan={plan}
          onClose={() => setMoveTarget(null)}
          onMoved={(message) => {
            onNotice(message);
            onChanged();
          }}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove this session?"
          confirmLabel="Remove session"
          tone="danger"
          busy={removing}
          onConfirm={confirmRemove}
          onCancel={() => setRemoveTarget(null)}
        >
          <p>
            {ACTIVITY_LABEL[removeTarget.activityType]} on {formatDay(removeTarget.date)} will be
            removed. The rest of that week is adjusted so its volume is kept.
          </p>
          {removeError && (
            <p role="alert" className="text-xs text-rose-400">
              {removeError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calendar cells                                                      */
/* ------------------------------------------------------------------ */

function DayCell({
  date,
  view,
  entries,
  isToday,
  isSelected,
  isOutsideMonth,
  onSelect,
}: {
  date: string;
  view: View;
  entries: DayEntry[];
  isToday: boolean;
  isSelected: boolean;
  isOutsideMonth: boolean;
  onSelect: () => void;
}) {
  const day = parseISODate(date);
  const compact = view === "month";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      aria-label={`${formatDay(date)}, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
      className={`flex flex-col gap-1.5 rounded-xl border p-2 text-left transition ${
        compact ? "min-h-[76px]" : "min-h-[120px]"
      } ${isSelected ? "border-emerald-500 bg-emerald-500/5" : "border-slate-800 bg-slate-950/60 hover:border-slate-600"} ${
        isOutsideMonth ? "opacity-40" : ""
      }`}
    >
      <span className="flex items-center justify-between gap-1">
        <span className={`text-[11px] font-semibold ${isToday ? "text-emerald-400" : "text-slate-300"}`}>
          {compact ? day.getDate() : formatDay(date)}
        </span>
        {isToday && (
          <span className="rounded-full bg-emerald-500 px-1.5 py-px text-[9px] font-bold text-black">
            Today
          </span>
        )}
      </span>

      {entries.map((entry) => (
        <EntryChip key={entry.key} date={date} entry={entry} compact={compact} />
      ))}
    </button>
  );
}

function EntryChip({ date, entry, compact }: { date: string; entry: DayEntry; compact: boolean }) {
  const status = entry.session ? entry.session.status : "completed";
  const meta = STATUS_META[status];
  const StatusIcon = meta.icon;
  const type = entry.session?.activityType ?? entry.workout?.activityType ?? "run";
  const label = entryLabel(date, entry);

  if (compact) {
    return (
      <span
        title={label}
        className={`flex items-center gap-1 rounded border px-1 py-0.5 text-[10px] ${meta.classes}`}
      >
        <StatusIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <ActivityIcon type={type} className="h-3 w-3 shrink-0" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <span className={`flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${meta.classes}`}>
      <StatusIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="flex items-center gap-1 font-semibold">
          <ActivityIcon type={type} className="h-3 w-3 shrink-0" />
          <span className="truncate">{ACTIVITY_LABEL[type]}</span>
        </span>
        <span className="block truncate text-[10px] opacity-90">
          {entry.session
            ? `${meta.label} · ${entry.session.targetDurationMin} min`
            : isFromStrava(entry.workout)
              ? "Strava · logged"
              : "Ad hoc · logged"}
        </span>
      </span>
    </span>
  );
}

function Legend() {
  return (
    <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-slate-300" aria-label="Status legend">
      {(Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map((status) => {
        const meta = STATUS_META[status];
        const Icon = meta.icon;
        return (
          <li key={status} className="flex items-center gap-1.5">
            <span className={`flex h-5 w-5 items-center justify-center rounded border ${meta.classes}`}>
              <Icon className="h-3 w-3" aria-hidden="true" />
            </span>
            {meta.label}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Selected day                                                        */
/* ------------------------------------------------------------------ */

function DetailRow({
  entry,
  today,
  isCurrentPlan,
  onLog,
  onMove,
  onEdit,
  onRemove,
}: {
  entry: DayEntry;
  today: string;
  isCurrentPlan: boolean;
  onLog: (session: PlannedSession) => void;
  onMove: (session: PlannedSession) => void;
  onEdit: (session: PlannedSession) => void;
  onRemove: (session: PlannedSession) => void;
}) {
  const { session, workout } = entry;

  if (!session) {
    const fromStrava = isFromStrava(workout);
    const link = stravaLink(workout);
    return (
      <li className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-white">
          <StatusBadge status="completed" />
          <span className="flex items-center gap-1.5 font-bold">
            <ActivityIcon type={workout?.activityType ?? "run"} className="h-4 w-4 text-emerald-400" />
            {workout ? ACTIVITY_LABEL[workout.activityType] : "Workout"}
          </span>
          {fromStrava ? (
            <span className="rounded-full border border-[#FC4C02]/30 bg-[#FC4C02]/10 px-2 py-0.5 text-[10px] font-bold text-[#FC4C02]">
              From Strava
            </span>
          ) : (
            <span className="text-xs text-slate-400">Ad hoc session</span>
          )}
        </div>
        {workout && <WorkoutSummary workout={workout} />}
        {fromStrava && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>Shown for reference. It doesn&apos;t complete a planned session or change your plan or readiness.</span>
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#FC4C02] hover:underline"
              >
                View on Strava
              </a>
            )}
          </p>
        )}
      </li>
    );
  }

  const canLog = LOGGABLE_STATUSES.includes(session.status) && session.date <= today;
  const canMove = isCurrentPlan && MOVABLE_STATUSES.includes(session.status);
  const lockedByStatus = ["completed", "partial", "missed"].includes(session.status);

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-white">
        <StatusBadge status={session.status} />
        <span className="flex items-center gap-1.5 font-bold">
          <ActivityIcon type={session.activityType} className="h-4 w-4 text-emerald-400" />
          {ACTIVITY_LABEL[session.activityType]}
        </span>
        <BandBadge band={session.intensityBand} />
        <span className="text-xs text-slate-400">
          Target {session.targetDurationMin} min · {session.targetVolume} pts
        </span>
      </div>

      {workout && <WorkoutSummary workout={workout} />}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canLog && (
          <button type="button" onClick={() => onLog(session)} className={btnSecondary}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Log workout
          </button>
        )}
        {canMove && (
          <>
            <button type="button" onClick={() => onMove(session)} className={btnSecondary}>
              Move
            </button>
            <button type="button" onClick={() => onEdit(session)} className={btnSecondary}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </button>
            <button type="button" onClick={() => onRemove(session)} className={btnDanger}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Remove
            </button>
          </>
        )}
        {lockedByStatus && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {session.status === "missed"
              ? "Missed sessions can't be moved."
              : "Completed sessions can't be moved."}
          </span>
        )}
        {!isCurrentPlan && !lockedByStatus && (
          <span className="text-[11px] text-slate-400">From a replaced plan, so it can&apos;t be changed.</span>
        )}
      </div>
    </li>
  );
}

function WorkoutSummary({ workout }: { workout: WorkoutSession }) {
  return (
    <p className="mt-2 text-xs text-slate-300">
      Logged: {workout.actualDurationMin} min · {workout.actualVolume} pts
      {workout.rpe !== null && ` · RPE ${workout.rpe}`}
      {workout.avgHr !== null && ` · ${workout.avgHr} bpm avg`}
      {workout.calories !== null && ` · ${workout.calories} kcal`}
    </p>
  );
}

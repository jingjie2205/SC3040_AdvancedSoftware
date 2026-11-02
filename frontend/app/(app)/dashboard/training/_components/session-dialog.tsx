"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, Save, ShieldAlert, TriangleAlert } from "lucide-react";
import { trainingApi, type ApiError } from "@/lib/training/api";
import { TRAINING_RULES as R } from "@/lib/training/config";
import { addDays, formatDay, isValidISODate, startOfWeek, todayISO } from "@/lib/training/dates";
import { bandsForWeek, checkPlacement, defaultDurationMin } from "@/lib/training/rules";
import {
  addSessionSchema,
  fieldErrorsFrom,
  numberFromInput,
  sessionChangeSchema,
  type SessionChange,
} from "@/lib/training/schemas";
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type IntensityBand,
  type PlannedSession,
  type TrainingPlan,
  type TrainingPreferences,
} from "@/lib/training/types";
import {
  ACTIVITY_LABEL,
  BAND_META,
  FieldError,
  Modal,
  Segmented,
  btnPrimary,
  btnSecondary,
  inputClass,
} from "./ui";

/** Plan a new session on a day, or change the activity, intensity or length of one that is already planned. */
export type SessionDialogTarget =
  | { kind: "add"; date: string }
  | { kind: "edit"; session: PlannedSession };

const FIELDS = ["date", "activityType", "intensityBand", "targetDurationMin"];

/** The refusals that are about the day, which come with the nearest day that would work. */
const DAY_CODES = new Set(["IN_PAST", "OUT_OF_PLAN", "CONSECUTIVE_HIGH_INTENSITY"]);

const BAND_NOTE: Record<IntensityBand, string> = {
  push: "A hard session. It can't be the day before or after another push.",
  light: "An easier session.",
  deload: "An easy session for recovery.",
};

/** Light is the gentler default, so a session planned by hand doesn't start out as a hard one by accident. */
const startingBand = (bands: IntensityBand[]): IntensityBand =>
  bands.includes("light") ? "light" : bands[0];

export function SessionDialog({
  target,
  plan,
  preferences,
  onClose,
  onSaved,
}: {
  target: SessionDialogTarget;
  plan: TrainingPlan;
  preferences: TrainingPreferences | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target.kind === "edit" ? target.session : null;
  const today = todayISO();
  const preferredMin = preferences?.sessionDurationMin ?? 45;
  const ownActivities: readonly ActivityType[] = preferences?.activityTypes.length
    ? preferences.activityTypes
    : ACTIVITY_TYPES;
  // A session keeps an activity the athlete has since dropped from their list, so it has to stay selectable.
  const activities =
    editing && !ownActivities.includes(editing.activityType)
      ? [editing.activityType, ...ownActivities]
      : ownActivities;

  const [date, setDate] = useState(target.kind === "edit" ? target.session.date : target.date);
  const [activityType, setActivityType] = useState<ActivityType>(editing?.activityType ?? activities[0]);
  const [chosenBand, setChosenBand] = useState<IntensityBand | null>(editing?.intensityBand ?? null);
  // null until the athlete types a length of their own: until then it follows the intensity.
  const [typedLength, setTypedLength] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverRefusal, setServerRefusal] = useState<{ message: string; suggestedDate: string | null } | null>(null);
  const [saving, setSaving] = useState(false);

  // The whole plan, and a day either side, so the early warning also sees neighbours in adjacent weeks and
  // anything an older plan left on a day. If it can't load, the server still checks everything.
  const [around, setAround] = useState<PlannedSession[] | null>(null);
  const [aroundFailed, setAroundFailed] = useState(false);
  const [aroundVersion, setAroundVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    trainingApi
      .getSchedule(addDays(plan.startDate, -1), addDays(plan.endDate, 1))
      .then((data) => {
        if (!cancelled) setAround(data.sessions);
      })
      .catch(() => {
        if (!cancelled) setAroundFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.startDate, plan.endDate, aroundVersion]);

  const bands = bandsForWeek(plan, startOfWeek(date));
  const band = chosenBand !== null && bands.includes(chosenBand) ? chosenBand : startingBand(bands);
  const followsBand = !editing || band !== editing.intensityBand;
  const length =
    typedLength ??
    String(followsBand ? defaultDurationMin(preferredMin, band) : (editing?.targetDurationMin ?? preferredMin));

  const earlyCheck = useMemo(() => {
    // No day yet (the field is being retyped): the form says "Choose a date" when it is submitted.
    if (!around || !isValidISODate(date)) return null;
    const context = { sessions: around, planStart: plan.startDate, planEnd: plan.endDate, today };
    if (!editing) {
      const draft: PlannedSession = {
        id: "new",
        planId: plan.id,
        date,
        activityType,
        targetVolume: 0,
        targetDurationMin: R.sessionDurationMin.min,
        intensityBand: band,
        status: "planned",
      };
      return checkPlacement(draft, date, context);
    }
    // Where it stands, only a push can run into a rule: a push beside a push.
    return band !== editing.intensityBand
      ? checkPlacement({ ...editing, intensityBand: band }, editing.date, context)
      : null;
  }, [around, plan, today, editing, date, activityType, band]);

  const refusal =
    serverRefusal ??
    (earlyCheck && !earlyCheck.ok ? { message: earlyCheck.reason, suggestedDate: earlyCheck.suggestedDate } : null);
  const checking = around === null && !aroundFailed;
  const blocked = checking || (earlyCheck !== null && !earlyCheck.ok);

  function touch() {
    setServerRefusal(null);
    setErrors({});
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    touch(); // every attempt starts clean, so an old answer never sits beside the new one
    const minutes = numberFromInput(length);
    let failure: ApiError | null = null;
    let done = "";

    if (editing) {
      const change: SessionChange = {};
      if (activityType !== editing.activityType) change.activityType = activityType;
      if (band !== editing.intensityBand) change.intensityBand = band;
      if (minutes !== editing.targetDurationMin) change.targetDurationMin = minutes;
      const parsed = sessionChangeSchema.safeParse(change);
      if (!parsed.success) {
        setErrors(
          Object.keys(change).length === 0
            ? { form: "Nothing has changed yet." }
            : fieldErrorsFrom(parsed.error),
        );
        return;
      }
      setSaving(true);
      const result = await trainingApi.updateSession(editing.id, parsed.data);
      if (!result.ok) failure = result.error;
      done =
        parsed.data.intensityBand !== undefined || parsed.data.targetDurationMin !== undefined
          ? "Session updated. The rest of that week was adjusted so its load stays the same."
          : "Session updated.";
    } else {
      const parsed = addSessionSchema.safeParse({
        date,
        activityType,
        intensityBand: band,
        targetDurationMin: minutes,
      });
      if (!parsed.success) {
        setErrors(fieldErrorsFrom(parsed.error));
        return;
      }
      setSaving(true);
      const result = await trainingApi.addSession(parsed.data);
      if (!result.ok) failure = result.error;
      else {
        const { adjustedCount } = result.data;
        done =
          adjustedCount > 0
            ? `Session added on ${formatDay(date)}. ${adjustedCount} other session${adjustedCount === 1 ? " was" : "s were"} adjusted to make room.`
            : `Session added on ${formatDay(date)}.`;
      }
    }
    setSaving(false);

    if (failure) {
      const { code, message, fieldErrors, suggestedDate } = failure;
      if (DAY_CODES.has(code)) {
        setServerRefusal({ message, suggestedDate: suggestedDate ?? null });
        setAroundVersion((v) => v + 1); // our copy of the plan is out of date
      } else {
        // A problem with a field this dialog doesn't show (there is no day field when editing) still has to be seen.
        const shown = FIELDS.some((field) => fieldErrors?.[field] && !(editing && field === "date"));
        const unplaced = fieldErrors?.form ?? Object.values(fieldErrors ?? {})[0] ?? message;
        setErrors({ ...fieldErrors, ...(shown ? {} : { form: unplaced }) });
      }
      return;
    }
    onSaved(done);
    onClose();
  }

  const lengthHint = `${BAND_META[band].label} sessions are ${defaultDurationMin(preferredMin, band)} min with your preferred length. Type your own to change it.`;

  return (
    <Modal title={editing ? "Edit session" : "Add a session"} onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <p className="text-xs text-slate-400">
          {editing
            ? `Planned for ${formatDay(editing.date)}. To change the day, use Move.`
            : "Plan a session yourself. Pick the day, what you'll do and how hard."}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!editing && (
            <label className="block sm:col-span-2">
              <span className="text-xs text-slate-400">Day</span>
              <input
                type="date"
                min={plan.startDate > today ? plan.startDate : today}
                max={plan.endDate}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  touch();
                }}
                aria-invalid={Boolean(errors.date)}
                data-autofocus
                className={inputClass}
              />
              <FieldError message={errors.date} />
            </label>
          )}

          <label className="block">
            <span className="text-xs text-slate-400">Activity</span>
            <select
              value={activityType}
              onChange={(e) => {
                setActivityType(e.target.value as ActivityType);
                touch();
              }}
              aria-invalid={Boolean(errors.activityType)}
              data-autofocus={editing ? true : undefined}
              className={inputClass}
            >
              {activities.map((type) => (
                <option key={type} value={type}>
                  {ACTIVITY_LABEL[type]}
                </option>
              ))}
            </select>
            <FieldError message={errors.activityType} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">
              Length, min ({R.sessionDurationMin.min}–{R.sessionDurationMin.max})
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={R.sessionDurationMin.min}
              max={R.sessionDurationMin.max}
              step={5}
              value={length}
              onChange={(e) => {
                setTypedLength(e.target.value);
                touch();
              }}
              aria-invalid={Boolean(errors.targetDurationMin)}
              className={inputClass}
            />
            <FieldError message={errors.targetDurationMin} />
          </label>

          <div className="sm:col-span-2">
            <span className="text-xs text-slate-400">Intensity</span>
            <div className="mt-1">
              <Segmented
                label="Intensity"
                value={band}
                onChange={(next) => {
                  setChosenBand(next);
                  touch();
                }}
                options={bands.map((value) => ({ value, label: BAND_META[value].label }))}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {bands.length === 1
                ? "This is a deload week, so its sessions stay at Deload intensity: easy, for recovery."
                : BAND_NOTE[band]}
            </p>
            <FieldError message={errors.intensityBand} />
          </div>
        </div>

        <p className="text-[11px] text-slate-400">{lengthHint}</p>

        {refusal && (
          <div
            role="alert"
            className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <div className="space-y-2">
              <p>{refusal.message}</p>
              {!editing && refusal.suggestedDate && (
                <button
                  type="button"
                  onClick={() => {
                    setDate(refusal.suggestedDate as string);
                    touch();
                  }}
                  className={btnSecondary}
                >
                  Use nearest valid day: {formatDay(refusal.suggestedDate)}
                </button>
              )}
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400">
          {editing
            ? "Changing the intensity or length changes this session's share of the week. Your other sessions adjust so the week's load stays the same."
            : "Your plan decides how much training a week carries. The new session takes its share of that, and your other sessions that week adjust to make room."}
        </p>

        <FieldError message={errors.form} />

        <div className="flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-200">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p>{plan.notice}</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={saving} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={saving || blocked} className={btnPrimary}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {editing ? "Save changes" : "Add session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

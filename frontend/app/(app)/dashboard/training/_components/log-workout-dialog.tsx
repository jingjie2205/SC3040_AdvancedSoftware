"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Save } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import { TRAINING_RULES as R } from "@/lib/training/config";
import { todayISO } from "@/lib/training/dates";
import {
  fieldErrorsFrom,
  logWorkoutSchema,
  nullableNumberFromInput,
  numberFromInput,
} from "@/lib/training/schemas";
import { ACTIVITY_TYPES, type ActivityType, type PlannedSession } from "@/lib/training/types";
import { ACTIVITY_LABEL, FieldError, Modal, btnPrimary, btnSecondary, inputClass } from "./ui";

export interface LogTarget {
  /** The planned session to pre-fill from, or null for an ad hoc session. */
  session: PlannedSession | null;
  date: string;
}

/** Load per minute used to keep "load" in step with duration until the user edits it. */
const AD_HOC_LOAD_PER_MIN = 0.8;

export function LogWorkoutDialog({
  target,
  onClose,
  onLogged,
}: {
  target: LogTarget;
  onClose: () => void;
  onLogged: (message: string) => void;
}) {
  const { session } = target;
  const loadPerMin = session ? session.targetVolume / session.targetDurationMin : AD_HOC_LOAD_PER_MIN;

  const [date, setDate] = useState(target.date);
  const [activityType, setActivityType] = useState<ActivityType>(session?.activityType ?? "run");
  const [duration, setDuration] = useState(session ? String(session.targetDurationMin) : "");
  const [volume, setVolume] = useState(session ? String(session.targetVolume) : "");
  const [volumeEdited, setVolumeEdited] = useState(false);
  const [rpe, setRpe] = useState("");
  const [avgHr, setAvgHr] = useState("");
  const [calories, setCalories] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function handleDuration(value: string) {
    setDuration(value);
    if (volumeEdited) return;
    const minutes = numberFromInput(value);
    setVolume(Number.isFinite(minutes) ? String(Math.round(minutes * loadPerMin)) : "");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = logWorkoutSchema.safeParse({
      date,
      activityType,
      actualDurationMin: numberFromInput(duration),
      actualVolume: numberFromInput(volume),
      rpe: nullableNumberFromInput(rpe),
      avgHr: nullableNumberFromInput(avgHr),
      calories: nullableNumberFromInput(calories),
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }

    setErrors({});
    setSaving(true);
    const result = session
      ? await trainingApi.logSession(session.id, parsed.data)
      : await trainingApi.logAdHocSession(parsed.data);
    setSaving(false);
    if (!result.ok) {
      setErrors({ ...result.error.fieldErrors, form: result.error.message });
      return;
    }
    onLogged("Workout logged. Tomorrow's readiness score will be recalculated.");
    onClose();
  }

  return (
    <Modal title={session ? "Log completed workout" : "Log an ad hoc session"} onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <p className="text-xs text-slate-400">
          {session
            ? "Pre-filled from your plan. Change anything that differs from what you actually did."
            : "This session isn't linked to a planned session."}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-slate-400">Date</span>
            <input
              type="date"
              max={todayISO()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={Boolean(errors.date)}
              className={inputClass}
            />
            <FieldError message={errors.date} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Activity</span>
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value as ActivityType)}
              className={inputClass}
            >
              {ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACTIVITY_LABEL[type]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Duration (min)</span>
            <input
              type="number"
              inputMode="numeric"
              min={R.workout.durationMin.min}
              max={R.workout.durationMin.max}
              value={duration}
              onChange={(e) => handleDuration(e.target.value)}
              aria-invalid={Boolean(errors.actualDurationMin)}
              data-autofocus
              className={inputClass}
            />
            <FieldError message={errors.actualDurationMin} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Load (pts)</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={R.workout.volume.max}
              value={volume}
              onChange={(e) => {
                setVolume(e.target.value);
                setVolumeEdited(true);
              }}
              aria-invalid={Boolean(errors.actualVolume)}
              className={inputClass}
            />
            <FieldError message={errors.actualVolume} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">
              RPE, {R.workout.rpe.min}–{R.workout.rpe.max} (optional)
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={R.workout.rpe.min}
              max={R.workout.rpe.max}
              value={rpe}
              onChange={(e) => setRpe(e.target.value)}
              aria-invalid={Boolean(errors.rpe)}
              className={inputClass}
            />
            <FieldError message={errors.rpe} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Average heart rate, bpm (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={R.workout.avgHr.min}
              max={R.workout.avgHr.max}
              value={avgHr}
              onChange={(e) => setAvgHr(e.target.value)}
              aria-invalid={Boolean(errors.avgHr)}
              className={inputClass}
            />
            <FieldError message={errors.avgHr} />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Calories burned, kcal (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={R.workout.calories.min}
              max={R.workout.calories.max}
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
              aria-invalid={Boolean(errors.calories)}
              className={inputClass}
            />
            <FieldError message={errors.calories} />
          </label>
        </div>

        <FieldError message={errors.form} />

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={saving} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className={btnPrimary}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Log workout
          </button>
        </div>
      </form>
    </Modal>
  );
}

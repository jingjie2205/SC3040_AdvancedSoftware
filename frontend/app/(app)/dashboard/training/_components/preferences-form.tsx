"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Save } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import { TRAINING_RULES as R } from "@/lib/training/config";
import {
  fieldErrorsFrom,
  numberFromInput,
  trainingPreferencesSchema,
} from "@/lib/training/schemas";
import {
  ACTIVITY_TYPES,
  WEEKDAYS,
  type ActivityType,
  type TrainingPreferences,
  type Weekday,
} from "@/lib/training/types";
import {
  ACTIVITY_LABEL,
  ActivityIcon,
  FieldError,
  ToggleChip,
  WEEKDAY_LABEL,
  btnPrimary,
  cardClass,
  inputClass,
} from "./ui";

const toggle = <T,>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

export function PreferencesForm({
  preferences,
  hasPlan,
  onSaved,
}: {
  preferences: TrainingPreferences | null;
  hasPlan: boolean;
  onSaved: (message: string) => void;
}) {
  const [days, setDays] = useState(String(preferences?.daysPerWeek ?? 3));
  const [duration, setDuration] = useState(String(preferences?.sessionDurationMin ?? 45));
  const [types, setTypes] = useState<ActivityType[]>(preferences?.activityTypes ?? []);
  const [restDays, setRestDays] = useState<Weekday[]>(preferences?.restDays ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = trainingPreferencesSchema.safeParse({
      daysPerWeek: numberFromInput(days),
      sessionDurationMin: numberFromInput(duration),
      activityTypes: types,
      restDays,
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }

    setErrors({});
    setSaving(true);
    const result = await trainingApi.savePreferences(parsed.data);
    setSaving(false);
    if (!result.ok) {
      setErrors({ ...result.error.fieldErrors, form: result.error.message });
      return;
    }
    onSaved("Training preferences saved");
  }

  return (
    <form onSubmit={handleSubmit} noValidate className={`${cardClass} max-w-3xl space-y-6`}>
      <div>
        <h3 className="text-base font-bold text-white">Training preferences</h3>
        <p className="text-xs text-slate-400">
          Used the next time you generate a plan. You need these before a plan can be generated.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-slate-400">
            Training days per week ({R.daysPerWeek.min}–{R.daysPerWeek.max})
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={R.daysPerWeek.min}
            max={R.daysPerWeek.max}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-invalid={Boolean(errors.daysPerWeek)}
            className={inputClass}
          />
          <FieldError message={errors.daysPerWeek} />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">
            Preferred session duration in minutes ({R.sessionDurationMin.min}–
            {R.sessionDurationMin.max})
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={R.sessionDurationMin.min}
            max={R.sessionDurationMin.max}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            aria-invalid={Boolean(errors.sessionDurationMin)}
            className={inputClass}
          />
          <FieldError message={errors.sessionDurationMin} />
        </label>
      </div>

      <fieldset>
        <legend className="text-xs text-slate-400">Preferred activity types (pick at least one)</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {ACTIVITY_TYPES.map((type) => (
            <ToggleChip
              key={type}
              pressed={types.includes(type)}
              onClick={() => setTypes((current) => toggle(current, type))}
            >
              <ActivityIcon type={type} />
              {ACTIVITY_LABEL[type]}
            </ToggleChip>
          ))}
        </div>
        <FieldError message={errors.activityTypes} />
      </fieldset>

      <fieldset>
        <legend className="text-xs text-slate-400">Preferred rest days (optional)</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {WEEKDAYS.map((day) => (
            <ToggleChip
              key={day}
              pressed={restDays.includes(day)}
              onClick={() => setRestDays((current) => toggle(current, day))}
            >
              {WEEKDAY_LABEL[day]}
            </ToggleChip>
          ))}
        </div>
        <FieldError message={errors.restDays} />
      </fieldset>

      {hasPlan && (
        <p className="text-xs text-slate-400">
          Changing these won&apos;t alter your current plan. They apply the next time you generate
          or adapt one.
        </p>
      )}

      <FieldError message={errors.form} />

      <button type="submit" disabled={saving} className={btnPrimary}>
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Save preferences
      </button>
    </form>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Save, X } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import { TRAINING_RULES as R } from "@/lib/training/config";
import { addDays, formatDay, isValidISODate, todayISO } from "@/lib/training/dates";
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
  btnSecondary,
  cardClass,
  inputClass,
  inputInlineClass,
} from "./ui";

const toggle = <T,>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/** "Wed, 7 Oct", with the year added when it isn't this one. */
const examLabel = (day: string, today: string) =>
  day.slice(0, 4) === today.slice(0, 4) ? formatDay(day) : `${formatDay(day)} ${day.slice(0, 4)}`;

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
  const today = todayISO();
  const latestExam = addDays(today, R.examDates.horizonDays);
  // An exam that has passed no longer matters, so it isn't shown or sent back.
  const [examDates, setExamDates] = useState<string[]>(
    (preferences?.examDates ?? []).filter((day) => day >= today),
  );
  const [examDraft, setExamDraft] = useState("");
  const [examError, setExamError] = useState<string | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function addExamDate() {
    const problem = !examDraft
      ? "Pick a date first"
      : !isValidISODate(examDraft)
        ? "Enter a valid date"
        : examDraft < today
          ? "That date has passed. Pick today or later"
          : examDraft > latestExam
            ? `Pick a date within the next ${R.examDates.horizonDays} days`
            : examDates.includes(examDraft)
              ? "That date is already in the list"
              : examDates.length >= R.examDates.max
                ? `You can add up to ${R.examDates.max} exam dates`
                : undefined;
    setExamError(problem);
    if (problem) return;
    setExamDates((current) => [...current, examDraft].sort());
    setExamDraft("");
  }

  const serverExamError = Object.entries(errors).find(([key]) => key.startsWith("examDates"))?.[1];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = trainingPreferencesSchema.safeParse({
      daysPerWeek: numberFromInput(days),
      sessionDurationMin: numberFromInput(duration),
      activityTypes: types,
      restDays,
      examDates,
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

      <fieldset>
        <legend className="text-xs text-slate-400">Upcoming exams (optional)</legend>
        <p className="mt-1 text-xs text-slate-500">
          In the week before an exam your readiness score dips a little, because study stress and
          short nights slow recovery. Only you can see these dates.
        </p>
        {examDates.length > 0 && (
          <ul aria-label="Your exam dates" className="mt-2 flex flex-wrap gap-2">
            {examDates.map((day) => (
              <li
                key={day}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 py-1.5 pl-3 pr-2 text-xs font-semibold text-slate-200"
              >
                {examLabel(day, today)}
                <button
                  type="button"
                  onClick={() => setExamDates((current) => current.filter((d) => d !== day))}
                  aria-label={`Remove exam on ${examLabel(day, today)}`}
                  className="rounded p-0.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="date"
            aria-label="Exam date"
            min={today}
            max={latestExam}
            value={examDraft}
            onChange={(e) => {
              setExamDraft(e.target.value);
              setExamError(undefined);
            }}
            onKeyDown={(e) => {
              // Enter adds the date; it shouldn't save the whole form.
              if (e.key === "Enter") {
                e.preventDefault();
                addExamDate();
              }
            }}
            aria-invalid={Boolean(examError ?? serverExamError)}
            className={inputInlineClass}
          />
          <button type="button" onClick={addExamDate} className={btnSecondary}>
            Add date
          </button>
        </div>
        <FieldError message={examError ?? errors.examDates ?? serverExamError} />
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

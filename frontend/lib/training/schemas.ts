import { z } from "zod";
import { TRAINING_RULES as R } from "./config";
import { addDays, isValidISODate, todayISO } from "./dates";
import { ACTIVITY_TYPES, WEEKDAYS } from "./types";

/**
 * Shared by the forms and by the API layer, so client and server reject the same input.
 */

function wholeNumber(label: string, min: number, max: number) {
  return z
    .number({ invalid_type_error: `${label} must be a number`, required_error: `${label} is required` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);
}

export const trainingPreferencesSchema = z
  .object({
    daysPerWeek: wholeNumber("Training days", R.daysPerWeek.min, R.daysPerWeek.max),
    sessionDurationMin: wholeNumber(
      "Session duration",
      R.sessionDurationMin.min,
      R.sessionDurationMin.max,
    ),
    activityTypes: z.array(z.enum(ACTIVITY_TYPES)).min(1, "Select at least one activity type"),
    restDays: z.array(z.enum(WEEKDAYS)),
    examDates: z
      .array(z.string().refine(isValidISODate, "Enter a valid date"))
      .max(R.examDates.max, `Add at most ${R.examDates.max} exam dates`)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const freeDays = 7 - value.restDays.length;
    if (freeDays < value.daysPerWeek) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restDays"],
        message: `Only ${freeDays} day${freeDays === 1 ? " is" : "s are"} free, but you want ${value.daysPerWeek} training days`,
      });
    }
    const latest = addDays(todayISO(), R.examDates.horizonDays);
    if (value.examDates.some((day) => day > latest)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["examDates"],
        message: `Exam dates can be at most ${R.examDates.horizonDays} days ahead`,
      });
    }
  });

export type TrainingPreferencesInput = z.infer<typeof trainingPreferencesSchema>;

export const generatePlanSchema = z.object({
  weeks: wholeNumber("Plan length", R.planWeeks.min, R.planWeeks.max),
});

export const sleepSchema = z.object({
  hours: z
    .number({ invalid_type_error: "Sleep must be a number", required_error: "Enter your hours of sleep" })
    .min(R.sleepHours.min, `Sleep must be between ${R.sleepHours.min} and ${R.sleepHours.max} hours`)
    .max(R.sleepHours.max, `Sleep must be between ${R.sleepHours.min} and ${R.sleepHours.max} hours`),
});

export const logWorkoutSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
    .refine((d) => d <= todayISO(), "Date can't be in the future"),
  activityType: z.enum(ACTIVITY_TYPES),
  actualDurationMin: wholeNumber(
    "Duration",
    R.workout.durationMin.min,
    R.workout.durationMin.max,
  ),
  actualVolume: z
    .number({ invalid_type_error: "Load must be a number", required_error: "Load is required" })
    .positive("Load must be greater than 0")
    .max(R.workout.volume.max, `Load must be at most ${R.workout.volume.max}`),
  rpe: wholeNumber("RPE", R.workout.rpe.min, R.workout.rpe.max).nullable(),
  avgHr: wholeNumber("Average heart rate", R.workout.avgHr.min, R.workout.avgHr.max).nullable(),
  calories: wholeNumber("Calories", R.workout.calories.min, R.workout.calories.max).nullable(),
});

export type LogWorkoutInput = z.infer<typeof logWorkoutSchema>;

/** Form inputs arrive as strings; blank becomes NaN so the schema reports "must be a number". */
export function numberFromInput(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/** For optional numeric fields: blank means "not provided". */
export function nullableNumberFromInput(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/** First message per field, keyed by the field name. */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

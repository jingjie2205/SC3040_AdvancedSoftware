import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SafeParseReturnType } from "zod";
import { addDays } from "@/lib/training/dates";
import {
  addSessionSchema,
  fieldErrorsFrom,
  generatePlanSchema,
  logWorkoutSchema,
  nullableNumberFromInput,
  numberFromInput,
  sessionChangeSchema,
  sleepSchema,
  trainingPreferencesSchema,
} from "@/lib/training/schemas";
import { TODAY, restoreClock, useFixedClock } from "./helpers";

/*
 * Black-box tests of the input rules the Training forms and the API client share (equivalence classes and boundary
 * values). Test titles start with the test-case ID used in the Test Cases document: T-<requirement>.<number>.
 * "Today" is pinned to Wednesday 4 November 2026 because two rules (exam horizon, no future workouts) depend on it.
 */

beforeEach(() => useFixedClock());
afterEach(() => restoreClock());

function messagesOf<I, O>(result: SafeParseReturnType<I, O>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

/* ------------------------------------------------------------------ T-1 Set training preferences */

const prefs = {
  daysPerWeek: 3,
  sessionDurationMin: 45,
  activityTypes: ["run", "gym"],
  restDays: ["sat", "sun"],
  examDates: [] as string[],
};
const withPrefs = (change: Record<string, unknown>) => trainingPreferencesSchema.safeParse({ ...prefs, ...change });

describe("T-1 preferences", () => {
  it("T-1.01: a typical set of preferences is accepted and exam dates default to none", () => {
    const { examDates: _omitted, ...withoutExams } = prefs;
    const result = trainingPreferencesSchema.safeParse(withoutExams);
    expect(result.success).toBe(true);
    expect(result.success && result.data.examDates).toEqual([]);
  });

  it.each([
    [0, "Training days must be at least 1"],
    [8, "Training days must be at most 7"],
    [3.5, "Training days must be a whole number"],
    [Number.NaN, "Training days must be a number"],
    ["3", "Training days must be a number"],
  ])("T-1.02: training days %s is refused with '%s'", (daysPerWeek, message) => {
    expect(messagesOf(withPrefs({ daysPerWeek, restDays: [] }))).toContain(message);
  });

  it.each([1, 2, 6, 7])("T-1.02: training days %s (inside 1 to 7) is accepted", (daysPerWeek) => {
    expect(withPrefs({ daysPerWeek, restDays: [] }).success).toBe(true);
  });

  it.each([
    [14, "Session duration must be at least 15"],
    [181, "Session duration must be at most 180"],
    [45.5, "Session duration must be a whole number"],
  ])("T-1.03: session duration %s is refused with '%s'", (sessionDurationMin, message) => {
    expect(messagesOf(withPrefs({ sessionDurationMin }))).toContain(message);
  });

  it.each([15, 16, 90, 179, 180])("T-1.03: session duration %s minutes (inside 15 to 180) is accepted", (sessionDurationMin) => {
    expect(withPrefs({ sessionDurationMin }).success).toBe(true);
  });

  it("T-1.04: choosing no activity type is refused", () => {
    expect(messagesOf(withPrefs({ activityTypes: [] }))).toContain("Select at least one activity type");
  });

  it.each(["run", "gym", "cycling", "bodyweight"])("T-1.04: choosing only %s is accepted", (activity) => {
    expect(withPrefs({ activityTypes: [activity] }).success).toBe(true);
  });

  it("T-1.04: an activity outside the four on offer is refused", () => {
    expect(withPrefs({ activityTypes: ["swimming"] }).success).toBe(false);
  });

  it("T-1.05: more training days than free days is refused and says how many days are free", () => {
    const restDays = ["mon", "tue", "wed", "thu", "fri"];
    expect(messagesOf(withPrefs({ daysPerWeek: 3, restDays }))).toContain(
      "Only 2 days are free, but you want 3 training days",
    );
  });

  it("T-1.05: the wording is singular when only one day is free", () => {
    const restDays = ["mon", "tue", "wed", "thu", "fri", "sat"];
    expect(messagesOf(withPrefs({ daysPerWeek: 2, restDays }))).toContain(
      "Only 1 day is free, but you want 2 training days",
    );
  });

  it("T-1.05: exactly as many free days as training days is accepted (boundary)", () => {
    const restDays = ["mon", "tue", "wed", "thu"];
    expect(withPrefs({ daysPerWeek: 3, restDays }).success).toBe(true);
  });

  it("T-1.06: valid exam dates are accepted, up to ten of them", () => {
    const ten = Array.from({ length: 10 }, (_, i) => addDays(TODAY, 10 + i));
    expect(withPrefs({ examDates: ten }).success).toBe(true);
  });

  it("T-1.06: an eleventh exam date is refused", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => addDays(TODAY, 10 + i));
    expect(messagesOf(withPrefs({ examDates: eleven }))).toContain("Add at most 10 exam dates");
  });

  it.each(["2026-13-45", "2026-02-30", "soon", "04/11/2026", ""])("T-1.06: '%s' is not a date", (examDate) => {
    expect(messagesOf(withPrefs({ examDates: [examDate] }))).toContain("Enter a valid date");
  });

  it("T-1.06: an exam 730 days ahead is accepted and one 731 days ahead is refused (boundary)", () => {
    expect(withPrefs({ examDates: [addDays(TODAY, 730)] }).success).toBe(true);
    expect(messagesOf(withPrefs({ examDates: [addDays(TODAY, 731)] }))).toContain(
      "Exam dates can be at most 730 days ahead",
    );
  });
});

/* ------------------------------------------------------------------ T-2 Generate plan: plan length */

describe("T-2 plan length", () => {
  it.each([
    [1, "Plan length must be at least 2"],
    [17, "Plan length must be at most 16"],
    [8.5, "Plan length must be a whole number"],
    [Number.NaN, "Plan length must be a number"],
  ])("T-2.01: a plan of %s weeks is refused with '%s'", (weeks, message) => {
    expect(messagesOf(generatePlanSchema.safeParse({ weeks }))).toContain(message);
  });

  it.each([2, 3, 8, 15, 16])("T-2.01: a plan of %s weeks (inside 2 to 16) is accepted", (weeks) => {
    expect(generatePlanSchema.safeParse({ weeks }).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ T-3 Readiness input: sleep */

describe("T-3 sleep entry", () => {
  it.each([-0.1, 16.1, 24])("T-3.01: %s hours of sleep is refused", (hours) => {
    expect(messagesOf(sleepSchema.safeParse({ hours }))).toContain("Sleep must be between 0 and 16 hours");
  });

  it.each([0, 0.5, 7.5, 8, 16])("T-3.01: %s hours of sleep (inside 0 to 16) is accepted", (hours) => {
    expect(sleepSchema.safeParse({ hours }).success).toBe(true);
  });

  it("T-3.01: a blank or non-numeric entry is refused as not a number", () => {
    expect(messagesOf(sleepSchema.safeParse({ hours: numberFromInput("") }))).toContain("Sleep must be a number");
    expect(messagesOf(sleepSchema.safeParse({ hours: numberFromInput("abc") }))).toContain("Sleep must be a number");
  });
});

/* ------------------------------------------------------------------ T-5 Log a workout */

const workout = {
  date: TODAY,
  activityType: "run",
  actualDurationMin: 45,
  actualVolume: 40,
  rpe: 6,
  avgHr: 150,
  calories: 420,
  distanceKm: 7.5,
};
const withWorkout = (change: Record<string, unknown>) => logWorkoutSchema.safeParse({ ...workout, ...change });

describe("T-5 workout log", () => {
  it("T-5.01: a complete log is accepted", () => {
    expect(withWorkout({}).success).toBe(true);
  });

  it("T-5.01: a log with every optional field left blank is accepted", () => {
    expect(withWorkout({ rpe: null, avgHr: null, calories: null, distanceKm: null }).success).toBe(true);
  });

  it.each([
    [0, "Duration must be at least 1"],
    [601, "Duration must be at most 600"],
    [45.5, "Duration must be a whole number"],
    [Number.NaN, "Duration must be a number"],
  ])("T-5.02: a duration of %s minutes is refused with '%s'", (actualDurationMin, message) => {
    expect(messagesOf(withWorkout({ actualDurationMin }))).toContain(message);
  });

  it.each([1, 2, 599, 600])("T-5.02: a duration of %s minutes is accepted", (actualDurationMin) => {
    expect(withWorkout({ actualDurationMin }).success).toBe(true);
  });

  it.each([
    [0, "Load must be greater than 0"],
    [-5, "Load must be greater than 0"],
    [1000.5, "Load must be at most 1000"],
    [Number.NaN, "Load must be a number"],
  ])("T-5.03: a load of %s points is refused with '%s'", (actualVolume, message) => {
    expect(messagesOf(withWorkout({ actualVolume }))).toContain(message);
  });

  it.each([0.5, 1, 999, 1000])("T-5.03: a load of %s points is accepted", (actualVolume) => {
    expect(withWorkout({ actualVolume }).success).toBe(true);
  });

  it.each([
    [0, "RPE must be at least 1"],
    [11, "RPE must be at most 10"],
    [5.5, "RPE must be a whole number"],
  ])("T-5.04: an RPE of %s is refused with '%s'", (rpe, message) => {
    expect(messagesOf(withWorkout({ rpe }))).toContain(message);
  });

  it.each([1, 2, 9, 10])("T-5.04: an RPE of %s is accepted", (rpe) => {
    expect(withWorkout({ rpe }).success).toBe(true);
  });

  it.each([
    [29, "Average heart rate must be at least 30"],
    [231, "Average heart rate must be at most 230"],
  ])("T-5.05: an average heart rate of %s bpm is refused with '%s'", (avgHr, message) => {
    expect(messagesOf(withWorkout({ avgHr }))).toContain(message);
  });

  it.each([30, 31, 229, 230])("T-5.05: an average heart rate of %s bpm is accepted", (avgHr) => {
    expect(withWorkout({ avgHr }).success).toBe(true);
  });

  it.each([
    [-1, "Calories must be at least 0"],
    [20001, "Calories must be at most 20000"],
  ])("T-5.06: %s calories is refused with '%s'", (calories, message) => {
    expect(messagesOf(withWorkout({ calories }))).toContain(message);
  });

  it.each([0, 1, 19999, 20000])("T-5.06: %s calories is accepted", (calories) => {
    expect(withWorkout({ calories }).success).toBe(true);
  });

  it.each([
    [0, "Distance must be greater than 0"],
    [500.5, "Distance must be at most 500 km"],
  ])("T-5.07: a distance of %s km is refused with '%s'", (distanceKm, message) => {
    expect(messagesOf(withWorkout({ distanceKm }))).toContain(message);
  });

  it.each([0.1, 42.2, 500])("T-5.07: a run of %s km is accepted", (distanceKm) => {
    expect(withWorkout({ distanceKm }).success).toBe(true);
  });

  it("T-5.07: a distance is accepted for a ride", () => {
    expect(withWorkout({ activityType: "cycling", distanceKm: 30 }).success).toBe(true);
  });

  it.each(["gym", "bodyweight"])("T-5.07: a distance is refused for %s", (activityType) => {
    expect(messagesOf(withWorkout({ activityType, distanceKm: 5 }))).toContain(
      "Distance can only be given for a run or a ride",
    );
  });

  it("T-5.07: a gym session with no distance is accepted", () => {
    expect(withWorkout({ activityType: "gym", distanceKm: null }).success).toBe(true);
  });

  it("T-5.08: a workout dated tomorrow is refused", () => {
    expect(messagesOf(withWorkout({ date: addDays(TODAY, 1) }))).toContain("Date can't be in the future");
  });

  it.each([TODAY, addDays(TODAY, -1), addDays(TODAY, -365)])("T-5.08: a workout dated %s is accepted", (date) => {
    expect(withWorkout({ date }).success).toBe(true);
  });

  it.each(["04/11/2026", "2026-11-4", "yesterday", ""])("T-5.08: '%s' is not a date", (date) => {
    expect(messagesOf(withWorkout({ date }))).toContain("Enter a valid date");
  });

  it("T-5.09: every invalid field gets its own message, the first one per field", () => {
    const result = withWorkout({ actualDurationMin: 0, actualVolume: 0, rpe: 11 });
    expect(result.success).toBe(false);
    expect(!result.success && fieldErrorsFrom(result.error)).toEqual({
      actualDurationMin: "Duration must be at least 1",
      actualVolume: "Load must be greater than 0",
      rpe: "RPE must be at most 10",
    });
  });

  it("T-5.09: blank form fields become 'not a number' for required inputs and 'not given' for optional ones", () => {
    expect(numberFromInput("")).toBeNaN();
    expect(numberFromInput("   ")).toBeNaN();
    expect(numberFromInput(" 12 ")).toBe(12);
    expect(nullableNumberFromInput("")).toBeNull();
    expect(nullableNumberFromInput(" ")).toBeNull();
    expect(nullableNumberFromInput("7")).toBe(7);
  });
});

/* ------------------------------------------------------------------ T-7 Hand-planned sessions */

const session = { date: "2026-11-10", activityType: "run", intensityBand: "light", targetDurationMin: 30 };

describe("T-7 planning a session by hand", () => {
  it("T-7.01: a complete session is accepted, and a blank length means the preferred length", () => {
    expect(addSessionSchema.safeParse(session).success).toBe(true);
    expect(addSessionSchema.safeParse({ ...session, targetDurationMin: null }).success).toBe(true);
  });

  it.each([
    [14, "Length must be at least 15"],
    [181, "Length must be at most 180"],
    [20.5, "Length must be a whole number"],
  ])("T-7.01: a session of %s minutes is refused with '%s'", (targetDurationMin, message) => {
    expect(messagesOf(addSessionSchema.safeParse({ ...session, targetDurationMin }))).toContain(message);
  });

  it.each([15, 16, 179, 180])("T-7.01: a session of %s minutes is accepted", (targetDurationMin) => {
    expect(addSessionSchema.safeParse({ ...session, targetDurationMin }).success).toBe(true);
  });

  it.each(["", "10-11-2026", "2026-02-30"])("T-7.01: '%s' is not a day to choose", (date) => {
    expect(messagesOf(addSessionSchema.safeParse({ ...session, date }))).toContain("Choose a date");
  });

  it("T-7.01: an unknown activity or intensity is refused", () => {
    expect(addSessionSchema.safeParse({ ...session, activityType: "swimming" }).success).toBe(false);
    expect(addSessionSchema.safeParse({ ...session, intensityBand: "extreme" }).success).toBe(false);
  });

  it("T-7.02: an edit that changes nothing is refused", () => {
    expect(messagesOf(sessionChangeSchema.safeParse({}))).toContain("Say what to change");
  });

  it("T-7.02: an edit may change just one thing, or several", () => {
    expect(sessionChangeSchema.safeParse({ activityType: "gym" }).success).toBe(true);
    expect(sessionChangeSchema.safeParse({ intensityBand: "push", targetDurationMin: 60 }).success).toBe(true);
  });

  it("T-7.02: an edit applies the same length limits", () => {
    expect(messagesOf(sessionChangeSchema.safeParse({ targetDurationMin: 14 }))).toContain("Length must be at least 15");
    expect(messagesOf(sessionChangeSchema.safeParse({ targetDurationMin: 181 }))).toContain("Length must be at most 180");
  });
});

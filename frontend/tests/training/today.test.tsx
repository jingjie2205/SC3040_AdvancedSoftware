import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import TrainingPage from "@/app/(app)/dashboard/training/page";
import type { TrainingApi } from "@/lib/training/api";
import { addDays } from "@/lib/training/dates";
import {
  DAY,
  TODAY,
  fixtureApi,
  installBrowserShims,
  openDialog,
  openTab,
  renderTrainingPage,
  restoreClock,
  setField,
  useFixedClock,
} from "./helpers";

vi.mock("@/lib/training/api", async () => (await import("./helpers")).apiModule);

/*
 * T-3 daily readiness, T-4 today's recommended workout and T-5 logging a workout, driven through the real Training
 * page on the in-memory fixtures. Today is Wed 4 November 2026 unless a test says otherwise. On that day the plan holds
 * a Light 35 minute run (22 pts) and the readiness fixture says 79 out of 100 ("push"); Tuesday 3 November is a rest
 * day, Saturday 7 November holds a Push session and Monday 9 November a Deload session.
 */

beforeEach(() => {
  installBrowserShims();
  useFixedClock();
});
afterEach(() => {
  restoreClock();
  vi.unstubAllGlobals();
});

async function onToday(options: Parameters<typeof renderTrainingPage>[1] = {}) {
  await renderTrainingPage(TrainingPage, options);
  await screen.findByRole("img", { name: /Readiness score \d+ out of 100/ });
  await act(async () => {}); // let the card's effects (the sleep field follows the saved value) run before anything is typed
}

const gauge = (score: number) => screen.getByRole("img", { name: `Readiness score ${score} out of 100` });
const plannedBox = () => screen.getByText("Planned", { selector: "p" }).closest("div") as HTMLElement;
const recommendedBox = () => screen.getByText("Recommended today").closest("div.rounded-xl") as HTMLElement;
const sleepField = () => screen.getByLabelText("Last night's sleep") as HTMLInputElement;
const loggedWorkouts = async () => (await fixtureApi().getSchedule("2026-01-01", "2026-12-31")).workouts;

const withExam = (day: string) => async (api: TrainingApi) => {
  const current = await api.getPreferences();
  const { updatedAt: _updatedAt, ...preferences } = current!;
  await api.savePreferences({ ...preferences, examDates: [day] });
};

/* ------------------------------------------------------------------ T-3 readiness */

describe("T-3 daily readiness score", () => {
  it("T-3.20: today's score is shown out of 100 with its class, a one-line reason and what is driving it", async () => {
    await onToday();
    expect(gauge(79)).toBeInTheDocument();
    expect(screen.getByText("Ready for hard training")).toBeInTheDocument();
    expect(screen.getByText("Well recovered. Nothing is holding your score back today.")).toBeInTheDocument();
    expect(screen.getByText("What's driving this score")).toBeInTheDocument();
    expect(screen.getByText("Acute:chronic ratio 1.05, right in the productive range")).toBeInTheDocument();
    expect(screen.getByText("1 bpm below your 14-day baseline")).toBeInTheDocument();
    expect(screen.getByText("Muscle soreness 4 out of 5")).toBeInTheDocument();
  });

  it("T-3.21: each driving factor says whether it is helping, hurting or neutral in words, not colour alone", async () => {
    await onToday();
    const factors = screen.getByText("What's driving this score").nextElementSibling as HTMLElement;
    const rows = within(factors).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      "Training loadHelpingAcute:chronic ratio 1.05, right in the productive range",
      "Resting heart rateHelping1 bpm below your 14-day baseline",
      "Daily check-inNeutralMuscle soreness 4 out of 5",
    ]);
  });

  it("T-3.22: which scorer produced the score is stated", async () => {
    await onToday();
    expect(await screen.findByText("Scored by trained model mlp-v1")).toBeInTheDocument();
  });

  it("T-3.23: the score is marked as only visible to the user", async () => {
    await onToday();
    expect(screen.getByText("Only visible to you")).toBeInTheDocument();
  });
});

describe("T-3 sleep entry", () => {
  const save = () => fireEvent.click(screen.getByRole("button", { name: /^(Save|Update)$/ }));

  it("T-3.24: with no sleep entered the Save button is disabled and the user is invited to add it", async () => {
    await onToday();
    expect(screen.getByText("Optional. Add it to sharpen today's score.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("T-3.25: short sleep is saved, confirmed and lowers today's score, with Sleep named as a factor hurting it", async () => {
    await onToday();
    setField(sleepField(), "5");
    save();

    expect(await screen.findByText("Sleep saved. Your readiness score has been updated.")).toBeInTheDocument();
    await waitFor(() => expect(gauge(64)).toBeInTheDocument());
    expect(screen.getByText("5.0 h last night")).toBeInTheDocument();
    expect(screen.getByText("Sleep is holding your score back, so keep it easier today.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(sleepField().value).toBe("5");
  });

  it.each([
    ["7.5", 79], // 7 to under 8 hours: no change
    ["8", 82], // 8 hours or more: a small boost
    ["16", 82],
    ["0", 64], // under 7 hours costs 7.5 points an hour, at most 15
    ["4", 64],
    ["6", 72],
  ])("T-3.26: %s hours of sleep gives a score of %s", async (hours, score) => {
    await onToday();
    setField(sleepField(), hours);
    save();
    await waitFor(() => expect(gauge(score)).toBeInTheDocument());
  });

  it.each([
    ["16.1", "Sleep must be between 0 and 16 hours"],
    ["-1", "Sleep must be between 0 and 16 hours"],
    ["25", "Sleep must be between 0 and 16 hours"],
  ])("T-3.27: %s hours of sleep is refused with '%s' and the score does not change", async (hours, message) => {
    await onToday();
    setField(sleepField(), hours);
    save();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(sleepField()).toHaveAttribute("aria-invalid", "true");
    expect(gauge(79)).toBeInTheDocument();
    expect(screen.queryByText("Sleep saved. Your readiness score has been updated.")).not.toBeInTheDocument();
  });

  it("T-3.28: saving again replaces the entry, and Clear takes it out so the score goes back", async () => {
    await onToday({ before: async (api) => void (await api.logSleep(5)) });
    expect(gauge(64)).toBeInTheDocument();
    expect(sleepField().value).toBe("5");

    setField(sleepField(), "9");
    save();
    await waitFor(() => expect(gauge(82)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Sleep entry removed.")).toBeInTheDocument();
    await waitFor(() => expect(gauge(79)).toBeInTheDocument());
    await waitFor(() => expect(sleepField().value).toBe(""));
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });
});

describe("T-3 exam dates", () => {
  it.each([
    [0, 69, "Exam today", "Hurting"],
    [3, 73, "Exam in 3 days", "Hurting"],
    [7, 79, "Exam in 7 days", "Neutral"],
  ])("T-3.29: an exam %s day(s) away gives a score of %s and the 'Academic load' factor '%s' (%s)", async (days, score, detail, impact) => {
    await onToday({ before: withExam(addDays(TODAY, days)) });
    expect(gauge(score)).toBeInTheDocument();
    const row = screen.getByText("Academic load").closest("li") as HTMLElement;
    expect(within(row).getByText(detail)).toBeInTheDocument();
    expect(within(row).getByText(impact)).toBeInTheDocument();
  });

  it("T-3.29: an exam 8 days away (outside the week before) changes nothing", async () => {
    await onToday({ before: withExam(addDays(TODAY, 8)) });
    expect(gauge(79)).toBeInTheDocument();
    expect(screen.queryByText("Academic load")).not.toBeInTheDocument();
  });

  it("T-3.29: an exam that has passed changes nothing", async () => {
    await onToday({ before: withExam(addDays(TODAY, -1)) });
    expect(gauge(79)).toBeInTheDocument();
    expect(screen.queryByText("Academic load")).not.toBeInTheDocument();
  });

  it("T-3.30: exam today and no sleep drops the class from push to light", async () => {
    await onToday({ before: withExam(TODAY) });
    expect(screen.queryByText("Ready for hard training")).not.toBeInTheDocument();
    expect(screen.getByText("Keep it easy today")).toBeInTheDocument();
    expect(screen.getByText("Academic load is holding your score back, so keep it easier today.")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ T-4 recommended workout */

describe("T-4 today's recommended workout", () => {
  it("T-4.20: today's planned session, the recommendation and the four actions are shown", async () => {
    await onToday();
    const planned = within(plannedBox());
    expect(planned.getByText("Run")).toBeInTheDocument();
    expect(planned.getByText("Light")).toBeInTheDocument();
    expect(planned.getByText("35 min")).toBeInTheDocument();
    expect(planned.getByText("22 pts")).toBeInTheDocument();

    const recommended = within(recommendedBox());
    expect(recommended.getByText("Light")).toBeInTheDocument();
    expect(recommended.getByText("35 min")).toBeInTheDocument();
    expect(recommended.getByText("22 pts")).toBeInTheDocument();
    for (const name of ["Accept", "Log workout", "Swap", "Skip"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("T-4.21: Accept confirms the session and it shows as accepted", async () => {
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Session accepted")).toBeInTheDocument();
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Log workout" })).toBeInTheDocument();
  });

  it("T-4.22: Swap offers the user's other activities, never the one already planned", async () => {
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(screen.getByText("Swap today's activity to")).toBeInTheDocument();
    const choices = within(screen.getByText("Swap today's activity to").parentElement as HTMLElement);
    expect(choices.getAllByRole("button").map((button) => button.textContent)).toEqual(["Gym", "Cycling"]);
  });

  it("T-4.22: choosing an activity swaps it, accepts the session and says so", async () => {
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    fireEvent.click(
      within(screen.getByText("Swap today's activity to").parentElement as HTMLElement).getByRole("button", {
        name: "Cycling",
      }),
    );
    expect(await screen.findByText("Swapped to cycling")).toBeInTheDocument();
    await waitFor(() => expect(within(plannedBox()).getByText("Cycling")).toBeInTheDocument());
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });

  it("T-4.23: Skip marks the session as missed, says that it counts, and leaves only Log workout", async () => {
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Session skipped. It counts as a missed session.")).toBeInTheDocument();
    expect(await screen.findByText("Missed")).toBeInTheDocument();
    expect(
      screen.getByText("This session is marked as missed. If you did it after all, you can still log it."),
    ).toBeInTheDocument();
    await waitFor(() => {
      for (const name of ["Accept", "Swap", "Skip"]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
    });
    expect(screen.getByRole("button", { name: "Log workout" })).toBeInTheDocument();
  });

  it("T-4.24: on a day with nothing planned the user is told it is a rest day and can still log a session", async () => {
    vi.setSystemTime(DAY.tue);
    await onToday();
    expect(screen.getByText("Rest day. Nothing is scheduled today, so recovery is the workout.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log ad hoc session" })).toBeInTheDocument();
    for (const name of ["Accept", "Swap", "Skip"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("T-4.25: a new user with no preferences is led through the first steps", async () => {
    await renderTrainingPage(TrainingPage, { scenario: "new" });
    expect(await screen.findByText("Let's build your plan")).toBeInTheDocument();
    expect(screen.getByText(/Tell us how you like to train, then generate a plan/)).toBeInTheDocument();
    const stepList = screen.getByText("Set your training preferences").closest("ol") as HTMLElement;
    const steps = within(stepList).getAllByRole("listitem").map((item) => item.textContent);
    expect(steps).toEqual([
      "1Set your training preferences(to do)",
      "2Generate a plan(to do)",
      "3Follow today's recommended workout(to do)",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Set preferences" }));
    expect(await screen.findByRole("button", { name: "Save preferences" })).toBeInTheDocument();
  });

  it("T-4.25: a new user who has saved preferences is sent on to generate a plan", async () => {
    await renderTrainingPage(TrainingPage, {
      scenario: "new",
      before: async (api) => {
        await api.savePreferences({
          daysPerWeek: 3,
          sessionDurationMin: 45,
          activityTypes: ["run"],
          restDays: [],
          examDates: [],
        });
      },
    });
    expect(await screen.findByText(/Your preferences are saved\. Generate a plan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate my plan" }));
    expect(await screen.findByRole("heading", { name: "Generate a training plan" })).toBeInTheDocument();
  });
});

describe("HR-2 readiness only ever downgrades a session", () => {
  it("HR-2.20: high readiness never upgrades a planned light session, and the user is told why", async () => {
    await onToday();
    expect(screen.getByText("Ready for hard training")).toBeInTheDocument(); // readiness says push
    const recommended = within(recommendedBox());
    expect(recommended.getByText("Light")).toBeInTheDocument();
    expect(recommended.queryByText(/Adjusted down/)).not.toBeInTheDocument();
    expect(
      recommended.getByText(
        "You're ready to push, but today is a planned light day. The plan stays as scheduled to protect your progression.",
      ),
    ).toBeInTheDocument();
  });

  it("HR-2.21: low readiness downgrades a planned push session, shorter and lighter, and the user is told why", async () => {
    vi.setSystemTime(DAY.sat);
    await onToday();
    const planned = within(plannedBox());
    expect(planned.getByText("Push")).toBeInTheDocument();

    const recommended = within(recommendedBox());
    expect(recommended.getByText("Light")).toBeInTheDocument();
    expect(recommended.getByText("Adjusted down from Push")).toBeInTheDocument();
    expect(
      recommended.getByText("Readiness is light today (66/100), so your planned push session is dialled back to light."),
    ).toBeInTheDocument();
    const minutes = (box: ReturnType<typeof within>) => Number(box.getByText(/ min$/).textContent?.replace(" min", ""));
    expect(minutes(recommended)).toBeLessThan(minutes(planned));
  });

  it("HR-2.22: a planned deload session is never raised, even when readiness is higher", async () => {
    // The fixture plan is built around the current week, so a session from next week's deload week is moved onto today.
    await onToday({
      before: async (api) => {
        const { sessions } = await api.getSchedule("2026-11-02", "2026-11-15");
        await api.removeSession(sessions.find((s) => s.date === TODAY)!.id);
        await api.rescheduleSession(sessions.find((s) => s.intensityBand === "deload")!.id, TODAY);
      },
    });
    expect(within(plannedBox()).getByText("Deload")).toBeInTheDocument();
    const recommended = within(recommendedBox());
    expect(recommended.getByText("Deload")).toBeInTheDocument();
    expect(recommended.queryByText(/Adjusted down/)).not.toBeInTheDocument();
    expect(recommended.getByText("Readiness matches today's plan, so go ahead as scheduled.")).toBeInTheDocument();
  });

  it("HR-2.23: the recommendation is a suggestion: the user can still accept the planned session as it stands", async () => {
    vi.setSystemTime(DAY.sat);
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Session accepted")).toBeInTheDocument();
    expect((await fixtureApi().getToday()).planned).toMatchObject({ status: "accepted", intensityBand: "push" });
  });
});

/* ------------------------------------------------------------------ T-5 logging a workout */

const field = (dialog: HTMLElement, label: RegExp) => within(dialog).getByLabelText(label) as HTMLInputElement;
const submitLog = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Log workout" }));

async function openLogDialog() {
  await onToday();
  fireEvent.click(screen.getByRole("button", { name: "Log workout" }));
  return openDialog("Log completed workout");
}

describe("T-5 logging a planned workout", () => {
  it("T-5.20: the form is filled in from the planned session", async () => {
    const dialog = await openLogDialog();
    expect(field(dialog, /^Date/).value).toBe(TODAY);
    expect(field(dialog, /^Activity/).value).toBe("run");
    expect(field(dialog, /^Duration/).value).toBe("35");
    expect(field(dialog, /^Load/).value).toBe("22");
    for (const optional of [/^RPE/, /^Average heart rate/, /^Calories/, /^Distance/]) {
      expect(field(dialog, optional).value).toBe("");
    }
  });

  it("T-5.21: logging it as planned completes the session, shows what was logged and tells the user", async () => {
    const dialog = await openLogDialog();
    submitLog(dialog);

    expect(await screen.findByText("Workout logged. Tomorrow's readiness score will be recalculated.")).toBeInTheDocument();
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    const logged = screen.getByText("Logged", { selector: "p" }).parentElement as HTMLElement;
    expect(within(logged).getByText("35 min · 22 pts")).toBeInTheDocument();

    const [workout] = await loggedWorkouts().then((all) => all.filter((w) => w.date === TODAY));
    expect(workout).toMatchObject({ activityType: "run", actualDurationMin: 35, actualVolume: 22, source: "manual" });
    expect(workout.plannedSessionId).toBe((await fixtureApi().getToday()).planned?.id);
  });

  it("T-5.22: the user's own numbers, RPE and heart rate are kept", async () => {
    const dialog = await openLogDialog();
    setField(field(dialog, /^Duration/), "40");
    setField(field(dialog, /^RPE/), "7");
    setField(field(dialog, /^Average heart rate/), "150");
    setField(field(dialog, /^Calories/), "320");
    setField(field(dialog, /^Distance/), "6.5");
    submitLog(dialog);

    await screen.findByText("Workout logged. Tomorrow's readiness score will be recalculated.");
    const logged = (await screen.findByText("Logged", { selector: "p" })).parentElement as HTMLElement;
    expect(within(logged).getByText("40 min · 25 pts · RPE 7 · 150 bpm avg")).toBeInTheDocument();
    const workout = (await loggedWorkouts()).find((w) => w.date === TODAY && w.plannedSessionId !== null);
    expect(workout).toMatchObject({ actualDurationMin: 40, actualVolume: 25, rpe: 7, avgHr: 150, calories: 320, distanceM: 6500 });
  });

  it("T-5.23: the load follows the duration until the user sets the load themselves", async () => {
    const dialog = await openLogDialog();
    setField(field(dialog, /^Duration/), "70");
    expect(field(dialog, /^Load/).value).toBe("44");
    setField(field(dialog, /^Load/), "50");
    setField(field(dialog, /^Duration/), "35");
    expect(field(dialog, /^Load/).value).toBe("50");
  });

  it.each([
    ["17", "Partial"], // 17 of 22 pts is under 80% (17.6)
    ["18", "Completed"], // 18 of 22 pts is over 80%
    ["30", "Completed"],
  ])("T-5.24: logging %s of the 22 planned points makes the session %s", async (load, status) => {
    const dialog = await openLogDialog();
    setField(field(dialog, /^Load/), load);
    submitLog(dialog);
    expect(await screen.findByText(status)).toBeInTheDocument();
  });

  it.each([
    [/^Duration/, "", "Duration must be a number"],
    [/^Duration/, "0", "Duration must be at least 1"],
    [/^Duration/, "601", "Duration must be at most 600"],
    [/^Duration/, "35.5", "Duration must be a whole number"],
    [/^Load/, "0", "Load must be greater than 0"],
    [/^Load/, "1001", "Load must be at most 1000"],
    [/^Load/, "", "Load must be a number"],
    [/^RPE/, "0", "RPE must be at least 1"],
    [/^RPE/, "11", "RPE must be at most 10"],
    [/^Average heart rate/, "29", "Average heart rate must be at least 30"],
    [/^Average heart rate/, "231", "Average heart rate must be at most 230"],
    [/^Calories/, "-1", "Calories must be at least 0"],
    [/^Calories/, "20001", "Calories must be at most 20000"],
    [/^Distance/, "0", "Distance must be greater than 0"],
    [/^Distance/, "501", "Distance must be at most 500 km"],
  ])("T-5.25: %s = %j is refused with '%s' and nothing is logged", async (label, value, message) => {
    const dialog = await openLogDialog();
    const before = (await loggedWorkouts()).length;
    setField(field(dialog, label), value);
    submitLog(dialog);

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(field(dialog, label)).toHaveAttribute("aria-invalid", "true");
    expect(openDialog("Log completed workout")).toBeInTheDocument();
    expect(screen.queryByText(/Workout logged/)).not.toBeInTheDocument();
    expect((await loggedWorkouts()).length).toBe(before);
  });

  it.each([
    [addDays(TODAY, 1), "Date can't be in the future"],
    ["", "Enter a valid date"],
  ])("T-5.26: the date '%s' is refused with '%s'", async (date, message) => {
    const dialog = await openLogDialog();
    setField(field(dialog, /^Date/), date);
    submitLog(dialog);
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
  });

  it("T-5.27: yesterday is accepted as the date of a workout", async () => {
    const dialog = await openLogDialog();
    setField(field(dialog, /^Date/), addDays(TODAY, -1));
    submitLog(dialog);
    expect(await screen.findByText(/Workout logged/)).toBeInTheDocument();
  });

  it("T-5.28: distance is asked for runs and rides only, and dropped when the activity changes to one without", async () => {
    const dialog = await openLogDialog();
    expect(within(dialog).getByLabelText(/^Distance/)).toBeInTheDocument();
    setField(field(dialog, /^Distance/), "5");

    setField(field(dialog, /^Activity/), "gym");
    expect(within(dialog).queryByLabelText(/^Distance/)).not.toBeInTheDocument();
    setField(field(dialog, /^Activity/), "cycling");
    expect(within(dialog).getByLabelText(/^Distance/)).toBeInTheDocument();
    setField(field(dialog, /^Activity/), "bodyweight");
    expect(within(dialog).queryByLabelText(/^Distance/)).not.toBeInTheDocument();

    submitLog(dialog);
    expect(await screen.findByText(/Workout logged/)).toBeInTheDocument();
    expect((await loggedWorkouts()).find((w) => w.date === TODAY && w.plannedSessionId !== null)?.distanceM).toBeNull();
  });

  it("T-5.29: Cancel closes the form and logs nothing", async () => {
    const dialog = await openLogDialog();
    const before = (await loggedWorkouts()).length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect((await loggedWorkouts()).length).toBe(before);
  });

  it("T-5.30: a session that was skipped can still be logged if the user did it after all", async () => {
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("Missed");
    fireEvent.click(await screen.findByRole("button", { name: "Log workout" }));
    submitLog(openDialog("Log completed workout"));
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Missed")).not.toBeInTheDocument();
  });
});

describe("T-5 logging an ad hoc session", () => {
  async function openAdHoc() {
    vi.setSystemTime(DAY.tue);
    await onToday();
    fireEvent.click(screen.getByRole("button", { name: "Log ad hoc session" }));
    return openDialog("Log an ad hoc session");
  }

  it("T-5.31: the form starts empty on today's date and says it isn't linked to a planned session", async () => {
    const dialog = await openAdHoc();
    expect(within(dialog).getByText("This session isn't linked to a planned session.")).toBeInTheDocument();
    expect(field(dialog, /^Date/).value).toBe("2026-11-03");
    expect(field(dialog, /^Activity/).value).toBe("run");
    expect(field(dialog, /^Duration/).value).toBe("");
    expect(field(dialog, /^Load/).value).toBe("");
  });

  it("T-5.32: the load is worked out from the duration at 0.8 points a minute and the session is logged with no plan entry", async () => {
    const dialog = await openAdHoc();
    setField(field(dialog, /^Activity/), "gym");
    setField(field(dialog, /^Duration/), "30");
    expect(field(dialog, /^Load/).value).toBe("24");
    submitLog(dialog);

    expect(await screen.findByText("Workout logged. Tomorrow's readiness score will be recalculated.")).toBeInTheDocument();
    const workout = (await loggedWorkouts()).find((w) => w.date === "2026-11-03");
    expect(workout).toMatchObject({ activityType: "gym", actualDurationMin: 30, actualVolume: 24, plannedSessionId: null });
  });

  it("T-5.33: an ad hoc session needs a duration and a load like any other", async () => {
    const dialog = await openAdHoc();
    submitLog(dialog);
    expect(await within(dialog).findByText("Duration must be a number")).toBeInTheDocument();
    expect(within(dialog).getByText("Load must be a number")).toBeInTheDocument();
  });

  it("T-5.34: an ad hoc session is also reachable from the Schedule tab", async () => {
    await onToday();
    await openTab("Schedule");
    expect(await screen.findByRole("button", { name: "Log ad hoc session" })).toBeInTheDocument();
  });
});

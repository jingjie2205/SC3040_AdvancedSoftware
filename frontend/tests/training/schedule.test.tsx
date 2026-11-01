import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import TrainingPage from "@/app/(app)/dashboard/training/page";
import type { TrainingApi } from "@/lib/training/api";
import { STATUS_META } from "@/app/(app)/dashboard/training/_components/ui";
import type { WorkoutSession } from "@/lib/training/types";
import {
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
 * T-6 View training schedule and T-7 Reschedule a planned session (move, remove, plan by hand, edit), driven through
 * the real Training page on the in-memory fixtures. Today is Wed 4 November 2026. The plan began on Monday 19 October
 * and runs 8 weeks to Sunday 13 December. This week: Mon 2 Cycling completed (push), Wed 4 Run planned (light),
 * Fri 6 Gym planned (light), Sat 7 planned (push). Last week: Mon 26 October missed. Week before: Sat 24 October partial.
 * Weeks 4 and 8 (from Mon 9 November and Mon 7 December) are deload weeks.
 */

const NOTICE =
  "This plan is a general training guide, not medical advice. Stop and speak to a qualified professional if you feel pain, dizziness or unusual fatigue.";

beforeEach(() => {
  installBrowserShims();
  useFixedClock();
});
afterEach(() => {
  restoreClock();
  vi.unstubAllGlobals();
});

async function onSchedule(options: Parameters<typeof renderTrainingPage>[1] = {}) {
  await renderTrainingPage(TrainingPage, options);
  await openTab("Schedule");
  // The calendar draws its empty cells first and the sessions arrive a moment later: wait for today's planned run.
  await screen.findByRole("button", { name: "Wed 4 Nov, 1 entry" });
}

const dayCell = (label: string) => screen.getByRole("button", { name: label });
const selectDay = (label: string) => fireEvent.click(dayCell(label));
const detail = () =>
  within(
    screen
      .getByRole("heading", { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/ })
      .closest(".rounded-2xl") as HTMLElement,
  );
const period = () => screen.getByText(/^\d{1,2} \w{3} – \d{1,2} \w{3}$|^\w+ \d{4}$/, { selector: "p" }).textContent;
const nav = () => within(screen.getByRole("button", { name: "Previous" }).parentElement as HTMLElement);
const weekSessions = async (from: string, to: string) => (await fixtureApi().getSchedule(from, to)).sessions;
const movableVolume = (sessions: Awaited<ReturnType<typeof weekSessions>>) =>
  sessions.filter((s) => ["planned", "accepted", "moved"].includes(s.status)).reduce((sum, s) => sum + s.targetVolume, 0);

/** The first session on a day, from the fixtures. */
async function sessionOn(date: string) {
  const found = (await weekSessions(date, date))[0];
  expect(found).toBeDefined();
  return found;
}

/* ------------------------------------------------------------------ T-6 viewing the schedule */

describe("T-6 weekly and monthly calendar", () => {
  it("T-6.20: the week view shows this week's seven days, each with its number of entries, and marks today", async () => {
    await onSchedule();
    expect(period()).toBe("2 Nov – 8 Nov");
    const entries = [
      "Mon 2 Nov, 1 entry",
      "Tue 3 Nov, 0 entries",
      "Wed 4 Nov, 1 entry",
      "Thu 5 Nov, 0 entries",
      "Fri 6 Nov, 1 entry",
      "Sat 7 Nov, 1 entry",
      "Sun 8 Nov, 0 entries",
    ];
    for (const label of entries) expect(dayCell(label)).toBeInTheDocument();
    expect(within(dayCell("Wed 4 Nov, 1 entry")).getByText("Today")).toBeInTheDocument();
    expect(dayCell("Wed 4 Nov, 1 entry")).toHaveAttribute("aria-pressed", "true");
  });

  it("T-6.21: Next, Previous and Today move through the weeks and back", async () => {
    await onSchedule();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(period()).toBe("9 Nov – 15 Nov"));
    expect(await screen.findByRole("button", { name: "Mon 9 Nov, 1 entry" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(period()).toBe("26 Oct – 1 Nov"));

    fireEvent.click(nav().getByRole("button", { name: "Today" }));
    await waitFor(() => expect(period()).toBe("2 Nov – 8 Nov"));
  });

  it("T-6.22: the month view shows the whole month, and every entry has a text label", async () => {
    await onSchedule();
    fireEvent.click(within(screen.getByRole("group", { name: "Calendar view" })).getByRole("button", { name: "Month" }));
    await waitFor(() => expect(period()).toBe("November 2026"));
    expect(await screen.findByText("Wed 4 Nov: Run, light, planned")).toBeInTheDocument();
    expect(screen.getByText("Mon 2 Nov: Cycling, push, completed")).toBeInTheDocument();
    // Six weeks of seven days, from Monday 26 October to Sunday 6 December
    const cells = screen.getAllByRole("button", { name: /, \d+ entr(y|ies)$/ });
    expect(cells).toHaveLength(42);
    expect(cells[0]).toHaveAccessibleName(/^Mon 26 Oct,/);
    expect(cells[41]).toHaveAccessibleName(/^Sun 6 Dec,/);
  });

  it("T-6.23: planned, completed, partial and missed sessions are told apart by a text label, not colour", async () => {
    await onSchedule();
    expect(within(dayCell("Mon 2 Nov, 1 entry")).getByText(/^Completed · \d+ min$/)).toBeInTheDocument();
    expect(within(dayCell("Wed 4 Nov, 1 entry")).getByText("Planned · 35 min")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("button", { name: "Mon 26 Oct, 1 entry" })).toBeInTheDocument();
    expect(within(dayCell("Mon 26 Oct, 1 entry")).getByText(/^Missed · \d+ min$/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("button", { name: "Sat 24 Oct, 1 entry" })).toBeInTheDocument();
    expect(within(dayCell("Sat 24 Oct, 1 entry")).getByText(/^Partial · \d+ min$/)).toBeInTheDocument();
  });

  it("T-6.24: a legend lists all six statuses", async () => {
    await onSchedule();
    const legend = screen.getByRole("list", { name: "Status legend" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Planned",
      "Accepted",
      "Completed",
      "Partial",
      "Missed",
      "Moved",
    ]);
  });

  it("T-6.25: every status has its own text label and its own icon", () => {
    const labels = Object.values(STATUS_META).map((meta) => meta.label);
    const icons = Object.values(STATUS_META).map((meta) => meta.icon);
    expect(new Set(labels).size).toBe(6);
    expect(new Set(icons).size).toBe(6);
  });

  it("T-6.26: selecting a completed day shows what was logged, a planned day what is targeted", async () => {
    await onSchedule();
    selectDay("Mon 2 Nov, 1 entry");
    expect(detail().getByText("Completed")).toBeInTheDocument();
    expect(detail().getByText(/^Logged: \d+ min · \d+ pts · RPE 8/)).toBeInTheDocument();

    selectDay("Wed 4 Nov, 1 entry");
    expect(detail().getByText("Planned")).toBeInTheDocument();
    expect(detail().getByText("Target 35 min · 22 pts")).toBeInTheDocument();
  });

  it("T-6.27: an ad hoc session logged from a day appears on that day, labelled as ad hoc", async () => {
    await onSchedule();
    // Tuesday has passed, so nothing can be planned there, but a workout can still be logged for it.
    selectDay("Tue 3 Nov, 0 entries");
    expect(detail().getByText("Nothing scheduled or logged on this day.")).toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    fireEvent.click(detail().getByRole("button", { name: "Log ad hoc session" }));

    const dialog = openDialog("Log an ad hoc session");
    setField(within(dialog).getByLabelText(/^Duration/), "30");
    fireEvent.click(within(dialog).getByRole("button", { name: "Log workout" }));

    expect(await screen.findByText(/Workout logged/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Tue 3 Nov, 1 entry" })).toBeInTheDocument();
    expect(within(dayCell("Tue 3 Nov, 1 entry")).getByText("Ad hoc · logged")).toBeInTheDocument();
    expect(detail().getByText("Ad hoc session")).toBeInTheDocument();
  });

  it("T-6.28: a user with no plan sees only logged workouts and cannot plan sessions", async () => {
    await renderTrainingPage(TrainingPage, { scenario: "new" });
    await openTab("Schedule");
    expect(
      await screen.findByText(
        "No active plan, so only logged workouts show here. Generate one on the Plan tab to plan sessions yourself.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing scheduled or logged on this day.")).toBeInTheDocument();
  });
});

describe("T-6 Strava activities on the schedule", () => {
  const strava: WorkoutSession = {
    id: "w-strava-1",
    plannedSessionId: null,
    date: "2026-11-03",
    activityType: "run",
    actualVolume: 42,
    actualDurationMin: 42,
    rpe: null,
    avgHr: 150,
    calories: null,
    distanceM: 8000,
    source: "strava",
    externalId: "123456789",
    createdAt: "2026-11-03T08:00:00Z",
  };
  const withStrava = (log: WorkoutSession) => async (api: TrainingApi) => {
    const original = api.getSchedule.bind(api);
    api.getSchedule = async (from, to) => {
      const schedule = await original(from, to);
      return { ...schedule, workouts: [...schedule.workouts, ...(log.date >= from && log.date <= to ? [log] : [])] };
    };
  };

  it("HR-1.20: a Strava activity is shown for reference, labelled, and says it changes nothing", async () => {
    await onSchedule({ before: withStrava(strava) });
    expect(within(await screen.findByRole("button", { name: "Tue 3 Nov, 1 entry" })).getByText("Strava · logged")).toBeInTheDocument();

    selectDay("Tue 3 Nov, 1 entry");
    expect(detail().getByText("From Strava")).toBeInTheDocument();
    expect(
      detail().getByText("Shown for reference. It doesn't complete a planned session or change your plan or readiness."),
    ).toBeInTheDocument();
    expect(detail().getByText("Logged: 42 min · 42 pts · 150 bpm avg")).toBeInTheDocument();
    expect(detail().getByRole("link", { name: "View on Strava" })).toHaveAttribute(
      "href",
      "https://www.strava.com/activities/123456789",
    );
  });

  it("HR-1.21: a Strava activity gives no way to log, move or remove anything", async () => {
    await onSchedule({ before: withStrava(strava) });
    await screen.findByRole("button", { name: "Tue 3 Nov, 1 entry" });
    selectDay("Tue 3 Nov, 1 entry");
    for (const name of ["Log workout", "Move", "Edit", "Remove"]) {
      expect(detail().queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("HR-1.22: a Strava activity with no usable id has no link to Strava", async () => {
    await onSchedule({ before: withStrava({ ...strava, externalId: "not-a-number" }) });
    await screen.findByRole("button", { name: "Tue 3 Nov, 1 entry" });
    selectDay("Tue 3 Nov, 1 entry");
    expect(detail().getByText("From Strava")).toBeInTheDocument();
    expect(detail().queryByRole("link", { name: "View on Strava" })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ T-7 moving and removing */

describe("T-7 moving a session", () => {
  async function openMove(label: string) {
    await onSchedule();
    selectDay(label);
    fireEvent.click(detail().getByRole("button", { name: "Move" }));
    return openDialog("Move session");
  }
  const moveTo = async (dialog: HTMLElement, date: string) => {
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move session" })).toBeDisabled());
    setField(within(dialog).getByLabelText("Move to"), date);
  };

  it("T-7.20: a session moves to a free day: the user is told, it shows as moved and the week's volume is unchanged", async () => {
    const dialog = await openMove("Fri 6 Nov, 1 entry");
    const before = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    expect(within(dialog).getByText("currently on Fri 6 Nov")).toBeInTheDocument();
    expect(within(dialog).getByText(/Moving a session within the same week keeps that week's volume unchanged/)).toBeInTheDocument();

    await moveTo(dialog, "2026-11-08");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move session" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Move session" }));

    expect(await screen.findByText("Session moved to Sun 8 Nov")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sun 8 Nov, 1 entry" })).toBeInTheDocument();
    expect(dayCell("Fri 6 Nov, 0 entries")).toBeInTheDocument();
    expect(within(dayCell("Sun 8 Nov, 1 entry")).getByText(/^Moved · /)).toBeInTheDocument();
    expect(movableVolume(await weekSessions("2026-11-02", "2026-11-08"))).toBe(before);
  });

  it("T-7.21: moving a session onto the day it is already on is not offered", async () => {
    const dialog = await openMove("Fri 6 Nov, 1 entry");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move session" })).toBeDisabled());
    expect(within(dialog).getByLabelText("Move to")).toHaveValue("2026-11-06");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("T-7.22: a push moved beside another push is refused with the reason, and the nearest valid day can be taken", async () => {
    // Saturday 7 November is a push; Monday 16 November is the next one, so Sunday 15 November would be beside it.
    const dialog = await openMove("Sat 7 Nov, 1 entry");
    await moveTo(dialog, "2026-11-15");

    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByText("Two high-intensity (push) sessions can't be on the same day or on consecutive days.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move session" })).toBeDisabled();

    fireEvent.click(within(refusal).getByRole("button", { name: "Use nearest valid day: Sat 14 Nov" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(dialog).getByLabelText("Move to")).toHaveValue("2026-11-14");
    fireEvent.click(within(dialog).getByRole("button", { name: "Move session" }));
    expect(await screen.findByText("Session moved to Sat 14 Nov")).toBeInTheDocument();
  });

  it("T-7.23: a day that has passed is refused and today is suggested", async () => {
    const dialog = await openMove("Fri 6 Nov, 1 entry");
    await moveTo(dialog, "2026-11-03");
    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByText("A session can't be on a day that has already passed.")).toBeInTheDocument();
    expect(within(refusal).getByRole("button", { name: "Use nearest valid day: Wed 4 Nov" })).toBeInTheDocument();
  });

  it("T-7.23: a day after the plan ends is refused and the last day of the plan is suggested", async () => {
    const dialog = await openMove("Fri 6 Nov, 1 entry");
    await moveTo(dialog, "2026-12-14");
    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByText("That date is outside your plan.")).toBeInTheDocument();
    expect(within(refusal).getByRole("button", { name: "Use nearest valid day: Sun 13 Dec" })).toBeInTheDocument();
  });

  it("T-7.24: a completed session cannot be moved, edited or removed, and says so", async () => {
    await onSchedule();
    selectDay("Mon 2 Nov, 1 entry");
    expect(detail().getByText("Completed sessions can't be moved.")).toBeInTheDocument();
    for (const name of ["Move", "Edit", "Remove"]) {
      expect(detail().queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("T-7.24: a missed session cannot be moved either, but it can still be logged", async () => {
    await onSchedule();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByRole("button", { name: "Mon 26 Oct, 1 entry" });
    selectDay("Mon 26 Oct, 1 entry");
    expect(detail().getByText("Missed sessions can't be moved.")).toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(detail().getByRole("button", { name: "Log workout" })).toBeInTheDocument();
  });

  it("T-7.24: a partial session cannot be moved", async () => {
    await onSchedule();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByRole("button", { name: "Sat 24 Oct, 1 entry" });
    selectDay("Sat 24 Oct, 1 entry");
    expect(detail().getByText("Partial")).toBeInTheDocument();
    expect(detail().getByText("Completed sessions can't be moved.")).toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
  });

  it("T-7.25: Cancel closes the move form and changes nothing", async () => {
    const dialog = await openMove("Fri 6 Nov, 1 entry");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(dayCell("Fri 6 Nov, 1 entry")).toBeInTheDocument();
  });
});

describe("T-7 removing a session", () => {
  async function openRemove(label: string) {
    await onSchedule();
    selectDay(label);
    fireEvent.click(detail().getByRole("button", { name: "Remove" }));
    return openDialog("Remove this session?");
  }

  it("T-7.26: the user is asked first, and Cancel keeps the session", async () => {
    const dialog = await openRemove("Fri 6 Nov, 1 entry");
    expect(
      within(dialog).getByText("Gym on Fri 6 Nov will be removed. The rest of that week is adjusted so its volume is kept."),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(dayCell("Fri 6 Nov, 1 entry")).toBeInTheDocument();
  });

  it("T-7.27: removing a session shares its volume among the rest of that week's sessions", async () => {
    const dialog = await openRemove("Fri 6 Nov, 1 entry");
    const before = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove session" }));

    expect(
      await screen.findByText("Session removed. Its volume was spread across 2 other sessions this week."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Fri 6 Nov, 0 entries" })).toBeInTheDocument();
    const after = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1); // shared in whole points, so rounding can differ by one
  });
});

/* ------------------------------------------------------------------ T-7 planning a session by hand */

describe("T-7 planning a session by hand", () => {
  async function openAdd(label: string) {
    await onSchedule();
    selectDay(label);
    fireEvent.click(detail().getByRole("button", { name: "Add session" }));
    const dialog = openDialog("Add a session");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add session" })).toBeEnabled());
    return dialog;
  }
  const intensity = (dialog: HTMLElement) => within(within(dialog).getByRole("group", { name: "Intensity" }));
  const lengthField = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Length/) as HTMLInputElement;
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Add session" }));

  it("T-7.30: a session is added on a free day with the usual defaults: light intensity and the preferred length for it", async () => {
    const dialog = await openAdd("Thu 5 Nov, 0 entries");
    expect(within(dialog).getByLabelText(/^Day/)).toHaveValue("2026-11-05");
    expect(intensity(dialog).getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(intensity(dialog).getByRole("button", { name: "Push" })).toHaveAttribute("aria-pressed", "false");
    expect(lengthField(dialog).value).toBe("35");
    expect(within(dialog).getByText("Light sessions are 35 min with your preferred length. Type your own to change it.")).toBeInTheDocument();
    expect(within(dialog).getByText(NOTICE)).toBeInTheDocument();
  });

  it("T-7.31: adding it puts it on the calendar and tells the user", async () => {
    const dialog = await openAdd("Thu 5 Nov, 0 entries");
    const before = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    submit(dialog);

    expect(await screen.findByText(/^Session added on Thu 5 Nov\./)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Thu 5 Nov, 1 entry" })).toBeInTheDocument();
    // The plan decides what a week carries: the new session takes its share and the others give some up.
    const after = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    expect(Math.abs(after - before)).toBeLessThanOrEqual(3);
  });

  it("T-7.32: changing the intensity changes the suggested length until the user types their own", async () => {
    const dialog = await openAdd("Thu 5 Nov, 0 entries");
    fireEvent.click(intensity(dialog).getByRole("button", { name: "Push" }));
    expect(lengthField(dialog).value).toBe("45");
    setField(lengthField(dialog), "60");
    fireEvent.click(intensity(dialog).getByRole("button", { name: "Light" }));
    expect(lengthField(dialog).value).toBe("60");
  });

  it.each([
    ["14", "Length must be at least 15"],
    ["181", "Length must be at most 180"],
    ["20.5", "Length must be a whole number"],
    ["", "Length must be a number"],
  ])("T-7.33: a session of %j minutes is refused with '%s' and nothing is added", async (value, message) => {
    const dialog = await openAdd("Thu 5 Nov, 0 entries");
    setField(lengthField(dialog), value);
    submit(dialog);
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect((await weekSessions("2026-11-05", "2026-11-05"))).toHaveLength(0);
  });

  it.each(["15", "180"])("T-7.33: a session of %s minutes (a limit itself) is accepted", async (value) => {
    const dialog = await openAdd("Thu 5 Nov, 0 entries");
    setField(lengthField(dialog), value);
    submit(dialog);
    expect(await screen.findByText(/^Session added on Thu 5 Nov\./)).toBeInTheDocument();
    expect((await weekSessions("2026-11-05", "2026-11-05"))[0].targetDurationMin).toBe(Number(value));
  });

  it("T-7.34: a deload week offers only Deload intensity and says why", async () => {
    await onSchedule();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: "Tue 10 Nov, 0 entries" });
    selectDay("Tue 10 Nov, 0 entries");
    fireEvent.click(detail().getByRole("button", { name: "Add session" }));
    const dialog = openDialog("Add a session");

    const buttons = intensity(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Deload"]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(
      within(dialog).getByText("This is a deload week, so its sessions stay at Deload intensity: easy, for recovery."),
    ).toBeInTheDocument();
    expect(lengthField(dialog).value).toBe("25");
  });

  it("T-7.35: a push beside a push is refused straight away, with the nearest valid day to use instead", async () => {
    // Saturday 7 November is a push, so a push on Friday 6 November would be beside it.
    const dialog = await openAdd("Fri 6 Nov, 1 entry");
    fireEvent.click(intensity(dialog).getByRole("button", { name: "Push" }));

    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByText("Two high-intensity (push) sessions can't be on the same day or on consecutive days.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add session" })).toBeDisabled();

    fireEvent.click(within(refusal).getByRole("button", { name: "Use nearest valid day: Thu 5 Nov" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add session" })).toBeEnabled());
    expect(within(dialog).getByLabelText(/^Day/)).toHaveValue("2026-11-05");
  });

  it("T-7.36: a session can be planned for today and for the last day of the plan, but not for a day that has passed or after the plan", async () => {
    await onSchedule();
    selectDay("Tue 3 Nov, 0 entries");
    expect(detail().queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
    selectDay("Wed 4 Nov, 1 entry");
    expect(detail().getByRole("button", { name: "Add session" })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "Calendar view" })).getByRole("button", { name: "Month" }));
    await screen.findByText("November 2026");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("December 2026");
    await screen.findByRole("button", { name: "Sun 13 Dec, 0 entries" });
    selectDay("Sun 13 Dec, 0 entries");
    expect(detail().getByRole("button", { name: "Add session" })).toBeInTheDocument();
    selectDay("Mon 14 Dec, 0 entries");
    expect(detail().queryByRole("button", { name: "Add session" })).not.toBeInTheDocument();
  });
});

describe("T-7 editing a planned session", () => {
  async function openEdit(label: string) {
    await onSchedule();
    selectDay(label);
    fireEvent.click(detail().getByRole("button", { name: "Edit" }));
    const dialog = openDialog("Edit session");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled());
    return dialog;
  }
  const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

  it("T-7.40: the form says which day the session is on and that Move changes the day", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    expect(within(dialog).getByText("Planned for Fri 6 Nov. To change the day, use Move.")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^Day/)).not.toBeInTheDocument();
  });

  it("T-7.41: saving with nothing changed is refused", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    save(dialog);
    expect(await within(dialog).findByText("Nothing has changed yet.")).toBeInTheDocument();
  });

  it("T-7.42: a new length is saved, the rest of the week adjusts and the user is told", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    const before = movableVolume(await weekSessions("2026-11-02", "2026-11-08"));
    setField(within(dialog).getByLabelText(/^Length/), "60");
    save(dialog);

    expect(
      await screen.findByText("Session updated. The rest of that week was adjusted so its load stays the same."),
    ).toBeInTheDocument();
    await waitFor(() => expect(detail().getByText(/^Target 60 min/)).toBeInTheDocument());
    expect(movableVolume(await weekSessions("2026-11-02", "2026-11-08"))).toBe(before);
  });

  it("T-7.43: changing only the activity says just that the session was updated", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    // Friday's session is a gym session, so running instead is a real change
    setField(within(dialog).getByLabelText("Activity"), "run");
    save(dialog);
    expect(await screen.findByText("Session updated.")).toBeInTheDocument();
    await waitFor(() => expect(detail().getByText("Run")).toBeInTheDocument());
  });

  it("T-7.44: making Friday's session a push is refused because Saturday's is already a push", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    fireEvent.click(within(within(dialog).getByRole("group", { name: "Intensity" })).getByRole("button", { name: "Push" }));
    const refusal = await within(dialog).findByRole("alert");
    expect(within(refusal).getByText("Two high-intensity (push) sessions can't be on the same day or on consecutive days.")).toBeInTheDocument();
    expect(within(refusal).queryByRole("button", { name: /Use nearest valid day/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("T-7.45: a length under 15 minutes is refused when editing too", async () => {
    const dialog = await openEdit("Fri 6 Nov, 1 entry");
    setField(within(dialog).getByLabelText(/^Length/), "10");
    save(dialog);
    expect(await within(dialog).findByText("Length must be at least 15")).toBeInTheDocument();
    await act(async () => {});
    expect(detail().getByText(/^Target 35 min/)).toBeInTheDocument();
  });

  it("T-7.46: a completed or missed session offers no Edit", async () => {
    await onSchedule();
    expect((await sessionOn("2026-11-02")).status).toBe("completed");
    selectDay("Mon 2 Nov, 1 entry");
    expect(detail().queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByRole("button", { name: "Mon 26 Oct, 1 entry" });
    expect((await sessionOn("2026-10-26")).status).toBe("missed");
    selectDay("Mon 26 Oct, 1 entry");
    expect(detail().queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});

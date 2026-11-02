import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import TrainingPage from "@/app/(app)/dashboard/training/page";
import { addDays } from "@/lib/training/dates";
import {
  TODAY,
  fixtureApi,
  installBrowserShims,
  openTab,
  renderTrainingPage,
  restoreClock,
  setField,
  useFixedClock,
} from "./helpers";

vi.mock("@/lib/training/api", async () => (await import("./helpers")).apiModule);

/*
 * T-1 Set training preferences, driven through the real Training page on the in-memory fixtures.
 * Each test: the user's situation, what they do on the Preferences tab, and what they should see and what is kept.
 * "New user" has no preferences and no plan; the default user has a plan under way. Today is Wed 4 November 2026.
 */

beforeEach(() => {
  installBrowserShims();
  useFixedClock();
});
afterEach(() => {
  restoreClock();
  vi.unstubAllGlobals();
});

const daysField = () => screen.getByLabelText(/Training days per week/) as HTMLInputElement;
const durationField = () => screen.getByLabelText(/Preferred session duration/) as HTMLInputElement;
const activity = (name: string) =>
  within(screen.getByRole("group", { name: /Preferred activity types/ })).getByRole("button", { name });
const restDay = (name: string) =>
  within(screen.getByRole("group", { name: /Preferred rest days/ })).getByRole("button", { name });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
const addExamDate = (value: string) => {
  setField(screen.getByLabelText("Exam date"), value);
  fireEvent.click(screen.getByRole("button", { name: "Add date" }));
};

async function newUserOnPreferences() {
  await renderTrainingPage(TrainingPage, { scenario: "new" });
  await openTab("Preferences");
}

describe("T-1 saving preferences", () => {
  it("T-1.10: a new user sees the form with 3 days and 45 minutes suggested and nothing chosen", async () => {
    await newUserOnPreferences();
    expect(daysField().value).toBe("3");
    expect(durationField().value).toBe("45");
    for (const name of ["Run", "Gym", "Cycling", "Bodyweight"]) {
      expect(activity(name)).toHaveAttribute("aria-pressed", "false");
    }
    for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(restDay(name)).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("T-1.11: valid preferences are saved, confirmed on screen and kept", async () => {
    await newUserOnPreferences();
    setField(daysField(), "4");
    setField(durationField(), "50");
    fireEvent.click(activity("Run"));
    fireEvent.click(activity("Gym"));
    fireEvent.click(restDay("Sat"));
    fireEvent.click(restDay("Sun"));
    save();

    expect(await screen.findByText("Training preferences saved")).toBeInTheDocument();
    expect(await fixtureApi().getPreferences()).toMatchObject({
      daysPerWeek: 4,
      sessionDurationMin: 50,
      activityTypes: ["run", "gym"],
      restDays: ["sat", "sun"],
      examDates: [],
    });
  });

  it("T-1.11: the saved preferences are shown again when the form is reopened", async () => {
    await newUserOnPreferences();
    setField(daysField(), "5");
    fireEvent.click(activity("Cycling"));
    save();
    await screen.findByText("Training preferences saved");

    await openTab("Today");
    await openTab("Preferences");
    // The page reloads the saved preferences in the background and the form is rebuilt from them when they arrive.
    await waitFor(() => expect(daysField().value).toBe("5"));
    expect(activity("Cycling")).toHaveAttribute("aria-pressed", "true");
    expect(activity("Run")).toHaveAttribute("aria-pressed", "false");
  });

  it("T-1.12: choosing no activity type is refused and nothing is saved", async () => {
    await newUserOnPreferences();
    save();
    expect(await screen.findByText("Select at least one activity type")).toBeInTheDocument();
    expect(screen.queryByText("Training preferences saved")).not.toBeInTheDocument();
    expect(await fixtureApi().getPreferences()).toBeNull();
  });

  it.each([
    ["0", "Training days must be at least 1"],
    ["8", "Training days must be at most 7"],
    ["2.5", "Training days must be a whole number"],
    ["", "Training days must be a number"],
  ])("T-1.13: %j training days is refused with '%s' and nothing is saved", async (value, message) => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    setField(daysField(), value);
    save();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(daysField()).toHaveAttribute("aria-invalid", "true");
    expect(await fixtureApi().getPreferences()).toBeNull();
  });

  it.each([
    ["14", "Session duration must be at least 15"],
    ["181", "Session duration must be at most 180"],
  ])("T-1.14: a session of %s minutes is refused with '%s'", async (value, message) => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    setField(durationField(), value);
    save();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(await fixtureApi().getPreferences()).toBeNull();
  });

  it.each(["15", "180"])("T-1.14: a session of %s minutes (a limit itself) is accepted", async (value) => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    setField(durationField(), value);
    save();
    expect(await screen.findByText("Training preferences saved")).toBeInTheDocument();
  });

  it("T-1.15: more training days than free days is refused with the number of free days", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(restDay(name));
    setField(daysField(), "3");
    save();
    expect(await screen.findByText("Only 2 days are free, but you want 3 training days")).toBeInTheDocument();
    expect(await fixtureApi().getPreferences()).toBeNull();
  });

  it("T-1.15: as many training days as free days is accepted (boundary)", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    for (const name of ["Mon", "Tue", "Wed", "Thu"]) fireEvent.click(restDay(name));
    setField(daysField(), "3");
    save();
    expect(await screen.findByText("Training preferences saved")).toBeInTheDocument();
  });

  it("T-1.16: a toggle can be switched off again", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Gym"));
    expect(activity("Gym")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(activity("Gym"));
    expect(activity("Gym")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("T-1 exam dates", () => {
  it("T-1.17: an exam date can be added, is listed with its day, saved with the preferences and removed again", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    addExamDate("2026-11-20");

    const list = screen.getByRole("list", { name: "Your exam dates" });
    expect(within(list).getByText("Fri 20 Nov")).toBeInTheDocument();
    expect(screen.getByLabelText("Exam date")).toHaveValue("");

    addExamDate("2026-11-12");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Thu 12 Nov", "Fri 20 Nov"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove exam on Thu 12 Nov" }));
    expect(within(list).queryByText("Thu 12 Nov")).not.toBeInTheDocument();

    save();
    await screen.findByText("Training preferences saved");
    expect((await fixtureApi().getPreferences())?.examDates).toEqual(["2026-11-20"]);
  });

  it("T-1.17: an exam today is accepted (boundary)", async () => {
    await newUserOnPreferences();
    addExamDate(TODAY);
    expect(within(screen.getByRole("list", { name: "Your exam dates" })).getByText("Wed 4 Nov")).toBeInTheDocument();
  });

  it.each([
    ["", "Pick a date first"],
    [addDays(TODAY, -1), "That date has passed. Pick today or later"],
    [addDays(TODAY, 731), "Pick a date within the next 730 days"],
  ])("T-1.18: the exam date '%s' is refused with '%s'", async (value, message) => {
    await newUserOnPreferences();
    addExamDate(value);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your exam dates" })).not.toBeInTheDocument();
  });

  it("T-1.18: an exam 730 days ahead is accepted (boundary)", async () => {
    await newUserOnPreferences();
    addExamDate(addDays(TODAY, 730));
    expect(screen.getByRole("list", { name: "Your exam dates" })).toBeInTheDocument();
  });

  it("T-1.18: the same date cannot be added twice", async () => {
    await newUserOnPreferences();
    addExamDate("2026-11-20");
    addExamDate("2026-11-20");
    expect(await screen.findByText("That date is already in the list")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Your exam dates" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("T-1.18: an eleventh exam date is refused", async () => {
    await newUserOnPreferences();
    for (let i = 0; i < 10; i++) addExamDate(addDays(TODAY, 10 + i));
    expect(within(screen.getByRole("list", { name: "Your exam dates" })).getAllByRole("listitem")).toHaveLength(10);
    addExamDate(addDays(TODAY, 40));
    expect(await screen.findByText("You can add up to 10 exam dates")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Your exam dates" })).getAllByRole("listitem")).toHaveLength(10);
  });

  it("T-1.18: pressing Enter in the date field adds the date and does not save the form", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    setField(screen.getByLabelText("Exam date"), "2026-11-20");
    fireEvent.keyDown(screen.getByLabelText("Exam date"), { key: "Enter" });
    expect(within(screen.getByRole("list", { name: "Your exam dates" })).getByText("Fri 20 Nov")).toBeInTheDocument();
    expect(screen.queryByText("Training preferences saved")).not.toBeInTheDocument();
    expect(await fixtureApi().getPreferences()).toBeNull();
  });
});

describe("T-1 preferences and the plan", () => {
  it("T-1.19: until preferences exist, Generate plan is disabled and the user is sent to the form", async () => {
    await renderTrainingPage(TrainingPage, { scenario: "new" });
    await openTab("Plan");
    expect(await screen.findByText("Set your training preferences before generating a plan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate plan" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Set preferences" }));
    expect(await screen.findByRole("button", { name: "Save preferences" })).toBeInTheDocument();
  });

  it("T-1.19: once preferences are saved, Generate plan is enabled", async () => {
    await newUserOnPreferences();
    fireEvent.click(activity("Run"));
    save();
    await screen.findByText("Training preferences saved");

    await openTab("Plan");
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate plan" })).toBeEnabled());
    expect(screen.queryByText("Set your training preferences before generating a plan.")).not.toBeInTheDocument();
  });

  it("T-1.20: the saved preferences of a user with a plan are shown, with a note that the plan won't change", async () => {
    await renderTrainingPage(TrainingPage);
    const stored = await fixtureApi().getPreferences();
    await openTab("Preferences");
    expect(daysField().value).toBe(String(stored?.daysPerWeek));
    expect(durationField().value).toBe(String(stored?.sessionDurationMin));
    expect(screen.getByText(/Changing these won't alter your current plan/)).toBeInTheDocument();
  });

  it("T-1.20: changing preferences leaves the current plan as it is", async () => {
    await renderTrainingPage(TrainingPage);
    const before = await fixtureApi().getPlan();
    await openTab("Preferences");
    setField(daysField(), "2");
    save();
    await screen.findByText("Training preferences saved");
    expect(await fixtureApi().getPlan()).toEqual(before);
  });
});

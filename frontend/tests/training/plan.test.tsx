import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import TrainingPage from "@/app/(app)/dashboard/training/page";
import {
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
 * T-2 Generate plan, T-8 Adapt plan, Hard Rule 5 (not-medical-advice notice) and the load forecast on the Plan tab,
 * driven through the real Training page on the in-memory fixtures.
 * "New user" has no preferences and no plan; the default user has an 8 week plan that started on Monday 19 October.
 * Today is Wed 4 November 2026.
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

const lengthField = () => screen.getByLabelText(/Plan length in weeks/) as HTMLInputElement;
const planButton = (name: "Generate plan" | "Replace plan" | "Adapt plan") => screen.getByRole("button", { name });

/** A new user who has saved preferences (through the Preferences tab) and is looking at the Plan tab. */
async function newUserReadyToGenerate() {
  await renderTrainingPage(TrainingPage, { scenario: "new" });
  await openTab("Preferences");
  const types = within(screen.getByRole("group", { name: /Preferred activity types/ }));
  fireEvent.click(types.getByRole("button", { name: "Run" }));
  fireEvent.click(types.getByRole("button", { name: "Gym" }));
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await screen.findByText("Training preferences saved");
  await openTab("Plan");
  await waitFor(() => expect(planButton("Generate plan")).toBeEnabled());
}

async function userWithPlan(query?: string) {
  await renderTrainingPage(TrainingPage, { query });
  await openTab("Plan");
  await screen.findByText("Week by week");
}

/** The "Week by week" table as [week, dates, type, planned, completed, sessions] text per row. */
function weekRows() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));
}

describe("T-2 generating a plan", () => {
  it("T-2.20: a new user with preferences generates an 8 week plan starting this Monday", async () => {
    await newUserReadyToGenerate();
    expect(screen.getByRole("heading", { name: "Generate a training plan" })).toBeInTheDocument();
    expect(lengthField().value).toBe("8");

    fireEvent.click(planButton("Generate plan"));
    expect(await screen.findByText("New 8-week plan created")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Your training plan" })).toBeInTheDocument();
    expect(screen.getByText(/Mon 2 Nov to Sun 27 Dec · 8 weeks · baseline \d+ pts\/week/)).toBeInTheDocument();
  });

  it("T-2.21: the plan lists every week, with a deload every fourth week", async () => {
    await newUserReadyToGenerate();
    fireEvent.click(planButton("Generate plan"));
    await screen.findByText("Week by week");

    const rows = weekRows();
    expect(rows).toHaveLength(8);
    expect(rows.map((cells) => cells[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(rows.map((cells) => cells[2])).toEqual([
      "Loading",
      "Loading",
      "Loading",
      "Deload",
      "Loading",
      "Loading",
      "Loading",
      "Deload",
    ]);
  });

  it.each([2, 12, 16])("T-2.22: a plan of %s weeks (inside 2 to 16) is created with that many weeks", async (weeks) => {
    await newUserReadyToGenerate();
    setField(lengthField(), String(weeks));
    fireEvent.click(planButton("Generate plan"));
    expect(await screen.findByText(`New ${weeks}-week plan created`)).toBeInTheDocument();
    await screen.findByText("Week by week");
    expect(weekRows()).toHaveLength(weeks);
    expect((await fixtureApi().getPlan())?.weeks).toBe(weeks);
  });

  it.each([
    ["1", "Plan length must be at least 2"],
    ["17", "Plan length must be at most 16"],
    ["8.5", "Plan length must be a whole number"],
    ["", "Plan length must be a number"],
  ])("T-2.23: a plan length of %j is refused with '%s' and no plan is created", async (value, message) => {
    await newUserReadyToGenerate();
    setField(lengthField(), value);
    fireEvent.click(planButton("Generate plan"));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(lengthField()).toHaveAttribute("aria-invalid", "true");
    expect(await fixtureApi().getPlan()).toBeNull();
    expect(screen.queryByText(/plan created/)).not.toBeInTheDocument();
  });

  it("T-2.24: a user who already has a plan is asked before it is replaced, and Cancel changes nothing", async () => {
    await userWithPlan();
    const before = await fixtureApi().getPlan();

    fireEvent.click(planButton("Replace plan"));
    const dialog = openDialog("Replace your current plan?");
    expect(within(dialog).getByText(/Anything you already logged stays in your history/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await fixtureApi().getPlan()).toEqual(before);
    expect(screen.queryByText(/plan created/)).not.toBeInTheDocument();
  });

  it("T-2.24: confirming replaces the plan with a new one that starts this Monday", async () => {
    await userWithPlan();
    const before = await fixtureApi().getPlan();

    fireEvent.click(planButton("Replace plan"));
    fireEvent.click(within(openDialog("Replace your current plan?")).getByRole("button", { name: "Replace plan" }));

    expect(await screen.findByText("New 8-week plan created")).toBeInTheDocument();
    const after = await fixtureApi().getPlan();
    expect(after?.id).not.toBe(before?.id);
    expect(after?.startDate).toBe("2026-11-02");
    expect(after?.status).toBe("active");
  });

  it("T-2.24: a plan length outside 2 to 16 is refused before the user is asked to confirm", async () => {
    await userWithPlan();
    setField(lengthField(), "17");
    fireEvent.click(planButton("Replace plan"));
    expect(await screen.findByText("Plan length must be at most 16")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("T-2.25: the plan shows its dates, length, baseline from the user's history and weekly progression", async () => {
    await userWithPlan();
    const plan = await fixtureApi().getPlan();
    expect(plan).not.toBeNull();
    expect(
      screen.getByText(
        `Mon 19 Oct to Sun 13 Dec · 8 weeks · baseline ${plan!.baselineVolume} pts/week · +${plan!.progressionPct!.toFixed(1)}% a week`,
      ),
    ).toBeInTheDocument();
  });

  it("T-2.26: the week-by-week table puts the deload weeks of the plan in weeks 4 and 8", async () => {
    await userWithPlan();
    const rows = weekRows();
    expect(rows).toHaveLength(8);
    expect(rows.map((cells) => cells[2])).toEqual(["Loading", "Loading", "Loading", "Deload", "Loading", "Loading", "Loading", "Deload"]);
    expect(rows[0][1]).toBe("19 Oct – 25 Oct");
    expect(rows[7][1]).toBe("7 Dec – 13 Dec");
  });

  it.each([
    ["maintain", /Maintenance\. Your chosen activities are mixed evenly\./],
    ["build_muscle", /Muscle gain\. Gym and bodyweight sessions get extra turns in your mix/],
    ["lose_weight", /Weight loss\. Run and cycling sessions get extra turns in your mix/],
  ])("T-2.27: with the profile goal %s the plan says how the goal shaped it", async (goal, text) => {
    await userWithPlan(`goal=${goal}`);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change it in Settings" })).toHaveAttribute("href", "/dashboard/settings");
  });
});

describe("HR-5 not-medical-advice notice", () => {
  it("HR-5.01: the plan a user already has carries the notice", async () => {
    await userWithPlan();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it("HR-5.02: a newly generated plan carries the notice, on screen and in the plan itself", async () => {
    await newUserReadyToGenerate();
    fireEvent.click(planButton("Generate plan"));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect((await fixtureApi().getPlan())?.notice).toBe(NOTICE);
  });

  it("HR-5.03: a replaced plan and an adapted plan still carry the notice", async () => {
    await userWithPlan();
    fireEvent.click(planButton("Replace plan"));
    fireEvent.click(within(openDialog("Replace your current plan?")).getByRole("button", { name: "Replace plan" }));
    await screen.findByText("New 8-week plan created");
    expect((await fixtureApi().getPlan())?.notice).toBe(NOTICE);

    fireEvent.click(planButton("Adapt plan"));
    fireEvent.click(within(openDialog("Adapt your plan?")).getByRole("button", { name: "Adapt plan" }));
    await screen.findByText("Plan adapted. The banner above explains what changed and why.");
    expect((await fixtureApi().getPlan())?.notice).toBe(NOTICE);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });
});

describe("T-8 adapting the plan", () => {
  it("T-8.20: Adapt plan asks first, and Cancel changes nothing", async () => {
    await userWithPlan();
    fireEvent.click(planButton("Adapt plan"));
    const dialog = openDialog("Adapt your plan?");
    expect(within(dialog).getByText(/rebuilt from what you actually completed, not from what was planned/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect((await fixtureApi().getPlan())?.lastAdaptation).toBeNull();
    expect(screen.queryByText(/Your plan was adapted on/)).not.toBeInTheDocument();
  });

  it("T-8.21: adapting is never silent: the user gets a notice, and a banner saying when, why and what changed", async () => {
    await userWithPlan();
    fireEvent.click(planButton("Adapt plan"));
    fireEvent.click(within(openDialog("Adapt your plan?")).getByRole("button", { name: "Adapt plan" }));

    expect(await screen.findByText("Plan adapted. The banner above explains what changed and why.")).toBeInTheDocument();
    expect(await screen.findByText(/Your plan was adapted on Wed 4 Nov/)).toBeInTheDocument();
    expect(screen.getByText(/You asked for it/)).toBeInTheDocument();
    expect(screen.getByText(/Rebaselined from your \d+ completed sessions in the last 4 weeks/)).toBeInTheDocument();
    expect(screen.getByText(/Only the remaining 6 week\(s\) were regenerated/)).toBeInTheDocument();
  });

  it("T-8.22: 'Got it' dismisses the banner for good", async () => {
    await userWithPlan();
    fireEvent.click(planButton("Adapt plan"));
    fireEvent.click(within(openDialog("Adapt your plan?")).getByRole("button", { name: "Adapt plan" }));
    await screen.findByText(/Your plan was adapted on/);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByText(/Your plan was adapted on/)).not.toBeInTheDocument());
    expect((await fixtureApi().getPlan())?.lastAdaptation?.acknowledged).toBe(true);
  });

  it("T-8.23: only the weeks still to come change: sessions already in the past are left exactly as they were", async () => {
    await userWithPlan();
    const pastBefore = (await fixtureApi().getSchedule("2026-10-19", "2026-12-13")).sessions.filter((s) => s.date < TODAY);
    expect(pastBefore.length).toBeGreaterThan(0);

    fireEvent.click(planButton("Adapt plan"));
    fireEvent.click(within(openDialog("Adapt your plan?")).getByRole("button", { name: "Adapt plan" }));
    await screen.findByText(/Your plan was adapted on/);

    const after = (await fixtureApi().getSchedule("2026-10-19", "2026-12-13")).sessions;
    expect(after.filter((s) => s.date < TODAY)).toEqual(pastBefore);
    expect(after.some((s) => s.date >= TODAY)).toBe(true);
    expect((await fixtureApi().getPlan())?.lastAdaptation).toMatchObject({ trigger: "manual", adaptedOn: TODAY });
  });

  it("T-8.24: a user with no plan has nothing to adapt", async () => {
    await newUserReadyToGenerate();
    expect(screen.queryByRole("button", { name: "Adapt plan" })).not.toBeInTheDocument();
  });

  it("T-8.25: the Plan tab tells the user when the plan adapts on its own (3 missed sessions in a row, 3 days of low readiness)", async () => {
    await userWithPlan();
    expect(
      screen.getByText(/adapts on its own after 3 missed sessions in a row, or 3 days in a row of low readiness/),
    ).toBeInTheDocument();
  });
});

describe("DA-9 load forecast card", () => {
  it("DA-9.01: it shows the weekly progression, the trend, the history and the plan completion", async () => {
    await userWithPlan();
    expect(await screen.findByRole("heading", { name: "Load forecast" })).toBeInTheDocument();
    for (const label of ["Weekly progression", "Your trend", "History", "Plan completion"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/^enough to fit your trend \(needs 6\)$/)).toBeInTheDocument();
  });

  it("DA-9.02: it explains, step by step, how the rate was set", async () => {
    await userWithPlan();
    const heading = await screen.findByRole("heading", { name: "How your rate was set" });
    const steps = within(heading.nextElementSibling as HTMLElement).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent?.replace(/^\d+/, "").split(".")[0])).toEqual([
      "Your history",
      "Your trend",
      "Track record",
      "Blended with the standard",
      "Plan completion",
      "Recent load",
      "Safety limits",
      "Weekly progression",
    ]);
  });

  it("DA-9.03: it states that Strava and readiness data are never used", async () => {
    await userWithPlan();
    expect(await screen.findByText(/Strava activities and readiness data are never used/)).toBeInTheDocument();
  });

  it("DA-9.04: when today's forecast differs from the rate the plan was built with, the user is invited to adapt", async () => {
    await userWithPlan();
    expect(await screen.findByText(/Adapt your plan to use it\./)).toBeInTheDocument();
  });

  it("DA-9.05: a user with no plan is told a plan will use this rate", async () => {
    await newUserReadyToGenerate();
    expect(await screen.findByText("Generate a plan and it will use this rate.")).toBeInTheDocument();
  });
});

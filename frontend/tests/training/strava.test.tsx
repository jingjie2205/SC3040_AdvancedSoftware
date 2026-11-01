import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import TrainingPage from "@/app/(app)/dashboard/training/page";
import type { StravaCard } from "@/lib/training/strava-format";
import {
  fixtureApi,
  installBrowserShims,
  openDialog,
  openTab,
  renderTrainingPage,
  restoreClock,
  useFixedClock,
} from "./helpers";

vi.mock("@/lib/training/api", async () => (await import("./helpers")).apiModule);

/*
 * The Strava tab, driven through the real Training page. The server calls (`@/lib/training/strava`) are replaced so each
 * test decides what Strava and the backend answer; the wording, the numbers on the cards and the formatting are the real
 * ones. Today is Wed 4 November 2026. The Strava saving rules themselves (what may be saved, no XP, never counted by the
 * plan or readiness) are the backend's and are tested there; here: what the user sees and is asked, and that the tab
 * never touches the training API (Hard Rule 1).
 */

const strava = vi.hoisted(() => ({
  available: true,
  connectUrl: null as string | null,
  loadStatus: vi.fn(),
  pullActivities: vi.fn(),
  saveToSchedule: vi.fn(),
  removeFromSchedule: vi.fn(),
}));

vi.mock("@/lib/training/strava", () => ({
  get stravaAvailable() {
    return strava.available;
  },
  stravaConnectUrl: () => strava.connectUrl,
  loadStatus: strava.loadStatus,
  pullActivities: strava.pullActivities,
  saveToSchedule: strava.saveToSchedule,
  removeFromSchedule: strava.removeFromSchedule,
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const status = (connected: boolean, savedCount = 0) => ok({ connected, savedCount });
const saved = (savedIds: number[], alreadySaved = 0, skipped = 0) => ok({ savedIds, alreadySaved, skipped });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  installBrowserShims();
  useFixedClock();
  strava.available = true;
  strava.connectUrl = null;
  strava.loadStatus.mockReset().mockResolvedValue(status(true));
  strava.pullActivities.mockReset().mockResolvedValue(ok([]));
  strava.saveToSchedule.mockReset().mockResolvedValue(saved([]));
  strava.removeFromSchedule.mockReset().mockResolvedValue(ok(0));
});
afterEach(() => {
  restoreClock();
  vi.unstubAllGlobals();
});

const card = (over: Partial<StravaCard> = {}): StravaCard => ({
  stravaId: 1001,
  name: "Morning run",
  type: "Run",
  day: "2026-11-03",
  time: "07:15",
  distanceM: 8000,
  movingTimeS: 2400,
  elevationGainM: 42,
  averageHeartrate: 151,
  savedAs: "run",
  durationMin: 40,
  points: 40,
  saved: false,
  ...over,
});
const run = card();
const ride = card({
  stravaId: 1002,
  name: "Lunch ride",
  type: "Ride",
  day: "2026-11-02",
  time: "12:30",
  distanceM: 30000,
  movingTimeS: 3600,
  elevationGainM: 150,
  averageHeartrate: null,
  savedAs: "cycling",
  durationMin: 60,
  points: 48,
});
const swim = card({
  stravaId: 1003,
  name: "Pool swim",
  type: "Swim",
  day: "2026-11-01",
  time: null,
  distanceM: 1500,
  movingTimeS: 1800,
  elevationGainM: 0,
  averageHeartrate: null,
  savedAs: null,
  durationMin: null,
  points: null,
});
const gym = card({
  stravaId: 1004,
  name: "Evening gym",
  type: "WeightTraining",
  day: "2026-10-30",
  time: "18:00",
  distanceM: 0,
  movingTimeS: 3000,
  elevationGainM: 0,
  averageHeartrate: 118,
  savedAs: "gym",
  durationMin: 50,
  points: 40,
  saved: true,
});

async function onStrava(options: Parameters<typeof renderTrainingPage>[1] = {}) {
  await renderTrainingPage(TrainingPage, options);
  await openTab("Strava");
}

const uploadButton = () => screen.findByRole("button", { name: "Upload Strava data" });
const list = () => screen.findByRole("list", { name: "Your latest Strava activities" });
const saveButton = (name: string) => screen.getByRole("button", { name: `Save ${name} to schedule` });
const saveAll = (label: string | RegExp = /^Save all to schedule/) => screen.getByRole("button", { name: label });
const cardOf = async (name: string) => {
  const items = within(await list()).getAllByRole("listitem");
  const found = items.find((item) => within(item).queryByText(name, { selector: "p" }));
  if (!found) throw new Error(`No card for ${name}`);
  return within(found);
};

/** Opens the tab, uploads, and waits for the cards. */
async function uploaded(cards: StravaCard[], savedCount = 0) {
  strava.loadStatus.mockResolvedValue(status(true, savedCount));
  strava.pullActivities.mockResolvedValue(ok(cards));
  await onStrava();
  fireEvent.click(await uploadButton());
  await list();
}

/* ------------------------------------------------------------------ S-4 connection */

describe("S-4 opening the Strava tab", () => {
  it("S-4.20: opening the tab asks the user's own server whether Strava is connected, and does not ask Strava for anything", async () => {
    const pending = deferred<ReturnType<typeof status>>();
    strava.loadStatus.mockReturnValue(pending.promise);
    await onStrava();
    expect(screen.getByText("Checking your Strava connection…")).toBeInTheDocument();
    expect(strava.loadStatus).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(status(true)));
    expect(await uploadButton()).toBeEnabled();
    expect(screen.queryByText("Checking your Strava connection…")).not.toBeInTheDocument();
    expect(strava.pullActivities).not.toHaveBeenCalled();
    expect(strava.saveToSchedule).not.toHaveBeenCalled();
  });

  it("S-4.21: a connected user who has not uploaded yet is told nothing is saved until they say so", async () => {
    await onStrava();
    await uploadButton();
    expect(
      screen.getByText("Press Upload Strava data to see your latest activities here. Nothing is saved until you say so."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your latest Strava activities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save all/ })).not.toBeInTheDocument();
  });

  it("S-4.22: a user who is not connected is offered Connect Strava, which goes to Strava's consent page", async () => {
    strava.connectUrl = "https://www.strava.com/oauth/authorize?client_id=12345&state=training";
    strava.loadStatus.mockResolvedValue(status(false));
    await onStrava();
    const link = await screen.findByRole("link", { name: "Connect Strava" });
    expect(link).toHaveAttribute("href", "https://www.strava.com/oauth/authorize?client_id=12345&state=training");
    expect(screen.getByText("Connect Strava to upload your activities.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload Strava data" })).not.toBeInTheDocument();
  });

  it("S-4.23: when this server has no Strava app set up, the user is told so instead of being sent nowhere", async () => {
    strava.connectUrl = null;
    strava.loadStatus.mockResolvedValue(status(false));
    await onStrava();
    expect(await screen.findByText("Strava isn't set up on this server yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect Strava" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload Strava data" })).not.toBeInTheDocument();
  });

  it("S-4.24: if the connection can't be checked the user sees why and can try again", async () => {
    strava.loadStatus.mockResolvedValueOnce(fail("NETWORK", "Couldn't reach the server. Check your connection and try again."));
    await onStrava();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn't reach the server. Check your connection and try again.")).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await uploadButton()).toBeInTheDocument();
    expect(strava.loadStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("S-4.25: without the backend the tab says what is needed and makes no call", async () => {
    strava.available = false;
    await onStrava();
    expect(
      screen.getByText(
        (_text, element) =>
          element?.tagName === "P" &&
          element.textContent === "Strava needs the backend. Start it, set NEXT_PUBLIC_TRAINING_API=http and sign in.",
      ),
    ).toBeInTheDocument();
    expect(strava.loadStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Upload Strava data" })).not.toBeInTheDocument();
    expect(screen.queryByText("Powered by Strava")).not.toBeInTheDocument();
  });

  it("S-4.26: the tab credits Strava and links to where the connection is managed", async () => {
    await onStrava();
    await uploadButton();
    expect(screen.getByText("Powered by Strava")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage the connection in Settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings?tab=integrations",
    );
  });

  it("S-4.27: after Strava is disconnected, saved activities are still listed and can still be removed", async () => {
    strava.connectUrl = "https://www.strava.com/oauth/authorize?state=training";
    strava.loadStatus.mockResolvedValue(status(false, 2));
    await onStrava();
    expect(
      await screen.findByText(
        "Strava isn't connected, so nothing more can be uploaded. The activities already on your schedule stay until you remove them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("2 Strava activities on your schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove saved activities" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Connect Strava" })).toBeInTheDocument();
  });

  it.each([
    ["strava=connected", "Strava connected"],
    ["strava=denied&reason=access_denied", "Strava access wasn't granted"],
    ["strava=error", "Couldn't connect Strava. Try again."],
    ["strava=error&reason=server_error", "Couldn't connect Strava. Try again."],
  ])("S-4.28: coming back from Strava with ?%s opens the Strava tab and says '%s'", async (query, message) => {
    await renderTrainingPage(TrainingPage, { query });
    expect(await screen.findByText(message)).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Training sections" });
    expect(within(group).getByRole("button", { name: "Strava" })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.search).toBe("");
    expect(await uploadButton()).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ S-1 upload and cards */

describe("S-1 uploading and looking at activities", () => {
  it("S-1.20: Upload asks for the latest activities, is locked while it waits, and saves nothing", async () => {
    const pending = deferred<ReturnType<typeof ok<StravaCard[]>>>();
    strava.pullActivities.mockReturnValue(pending.promise);
    await onStrava();
    fireEvent.click(await uploadButton());

    expect(await screen.findByRole("button", { name: "Uploading…" })).toBeDisabled();
    await act(async () => pending.resolve(ok([run])));
    expect(await list()).toBeInTheDocument();
    expect(strava.pullActivities).toHaveBeenCalledTimes(1);
    expect(strava.saveToSchedule).not.toHaveBeenCalled();
    expect(await uploadButton()).toBeEnabled();
  });

  it("S-1.21: a card shows what the activity was: name, kind, day and time, distance, time, pace, heart rate and climb", async () => {
    await uploaded([run]);
    const item = await cardOf("Morning run");
    expect(item.getByText("Run · Tue 3 Nov · 07:15")).toBeInTheDocument();
    expect(item.getByText("8.0 km")).toBeInTheDocument();
    expect(item.getByText("40 min")).toBeInTheDocument();
    expect(item.getByText("5:00 /km")).toBeInTheDocument();
    expect(item.getByText("151 bpm avg")).toBeInTheDocument();
    expect(item.getByText("42 m climb")).toBeInTheDocument();
    expect(item.getByText("Saves as Run · 40 min · 40 pts")).toBeInTheDocument();
  });

  it("S-1.21: each card links to its activity on Strava, in a new tab, with the activity's name for screen readers", async () => {
    await uploaded([run]);
    const link = (await cardOf("Morning run")).getByRole("link", { name: /View on Strava/ });
    expect(link).toHaveAttribute("href", "https://www.strava.com/activities/1001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Every card says "View on Strava", so the activity's name is added for screen readers only
    expect(link).toHaveTextContent("View on Strava (Morning run)");
    expect(within(link).getByText("(Morning run)")).toHaveClass("sr-only");
  });

  it("S-1.22: an activity from an earlier year shows its year", async () => {
    await uploaded([card({ stravaId: 2001, name: "Old run", day: "2025-08-14" }), run]);
    expect((await cardOf("Old run")).getByText("Run · Thu 14 Aug 2025 · 07:15")).toBeInTheDocument();
    expect((await cardOf("Morning run")).getByText("Run · Tue 3 Nov · 07:15")).toBeInTheDocument();
  });

  it("S-1.23: what Strava didn't record is left out rather than shown as zero", async () => {
    await uploaded([
      card({ distanceM: 0, averageHeartrate: null, elevationGainM: 0.9, time: null, type: "Ride" }),
      card({ stravaId: 1002, name: "Short climb", elevationGainM: 1 }),
    ]);
    const bare = await cardOf("Morning run");
    expect(bare.getByText("Ride · Tue 3 Nov")).toBeInTheDocument();
    expect(bare.getByText("40 min")).toBeInTheDocument();
    expect(bare.queryByText(/^[\d.]+ (km|m)$/)).not.toBeInTheDocument();
    expect(bare.queryByText(/bpm avg/)).not.toBeInTheDocument();
    expect(bare.queryByText(/m climb/)).not.toBeInTheDocument();
    expect(bare.queryByText(/\/km/)).not.toBeInTheDocument();
    expect((await cardOf("Short climb")).getByText("1 m climb")).toBeInTheDocument();
  });

  it("S-1.24: a summary says how many activities came, how many can be saved, are on the schedule and can't be saved", async () => {
    await uploaded([run, ride, gym, swim]);
    expect(screen.getByText("4 activities from Strava")).toBeInTheDocument();
    expect(screen.getByText("· 2 to save · 1 on your schedule · 1 can't be saved")).toBeInTheDocument();
  });

  it("S-1.24: the summary leaves out the parts that are zero, and says '1 activity' for one", async () => {
    await uploaded([run]);
    expect(screen.getByText("1 activity from Strava")).toBeInTheDocument();
    expect(screen.getByText("· 1 to save")).toBeInTheDocument();
  });

  it("S-1.25: an activity the schedule has no place for says so and offers no Save", async () => {
    await uploaded([swim]);
    const item = await cardOf("Pool swim");
    expect(
      item.getByText("The schedule only holds runs, rides, gym and bodyweight sessions, so this one can't be saved."),
    ).toBeInTheDocument();
    expect(item.queryByRole("button")).not.toBeInTheDocument();
    expect(item.queryByText("On schedule")).not.toBeInTheDocument();
  });

  it("S-1.26: an upload with nothing in it says Strava has no activities to show", async () => {
    strava.pullActivities.mockResolvedValue(ok([]));
    await onStrava();
    fireEvent.click(await uploadButton());
    expect(await screen.findByText("Strava has no activities to show yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your latest Strava activities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save all/ })).not.toBeInTheDocument();
  });

  it("S-1.27: if the upload fails the user sees why, and the tab stays as it was", async () => {
    strava.pullActivities.mockResolvedValue(fail("RATE_LIMITED", "Strava is busy. Try again in a few minutes."));
    await onStrava();
    fireEvent.click(await uploadButton());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Strava is busy. Try again in a few minutes.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your latest Strava activities" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload Strava data" })).toBeEnabled();
  });

  it("S-1.28: if Strava turns out not to be connected, the tab asks again and offers Connect instead", async () => {
    strava.connectUrl = "https://www.strava.com/oauth/authorize?state=training";
    strava.loadStatus.mockResolvedValueOnce(status(true)).mockResolvedValue(status(false));
    strava.pullActivities.mockResolvedValue(fail("NOT_CONNECTED", "Strava isn't connected. Connect it first."));
    await onStrava();
    fireEvent.click(await uploadButton());

    expect(await screen.findByRole("link", { name: "Connect Strava" })).toBeInTheDocument();
    expect(screen.getByText("Strava isn't connected. Connect it first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload Strava data" })).not.toBeInTheDocument();
    expect(strava.loadStatus).toHaveBeenCalledTimes(2);
  });

  it("S-1.29: uploading again replaces the cards with the newest list", async () => {
    await uploaded([run]);
    strava.pullActivities.mockResolvedValue(ok([ride]));
    fireEvent.click(await uploadButton());
    expect(await cardOf("Lunch ride")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("Morning run")).not.toBeInTheDocument());
  });
});

/* ------------------------------------------------------------------ S-2 saving */

describe("S-2 saving activities to the schedule", () => {
  it("S-2.20: saving one activity sends just that one, locks the tab while it works, and then marks it as on the schedule", async () => {
    const pending = deferred<ReturnType<typeof saved>>();
    await uploaded([run, ride]);
    strava.saveToSchedule.mockReturnValue(pending.promise);
    strava.loadStatus.mockResolvedValue(status(true, 1));

    fireEvent.click(saveButton("Morning run"));
    expect(await screen.findByRole("button", { name: "Save Morning run to schedule" })).toHaveTextContent("Saving…");
    expect(saveButton("Morning run")).toBeDisabled();
    expect(saveButton("Lunch ride")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload Strava data" })).toBeDisabled();
    expect(saveAll()).toBeDisabled();
    expect(strava.saveToSchedule).toHaveBeenCalledWith([1001]);

    await act(async () => pending.resolve(saved([1001])));
    const item = await cardOf("Morning run");
    expect(await item.findByText("On schedule")).toBeInTheDocument();
    expect(item.getByText("Saved as Run · 40 min · 40 pts")).toBeInTheDocument();
    expect(item.queryByRole("button", { name: /Save Morning run/ })).not.toBeInTheDocument();
    // The other activity is untouched and can be saved again
    expect(saveButton("Lunch ride")).toBeEnabled();
    expect((await cardOf("Lunch ride")).queryByText("On schedule")).not.toBeInTheDocument();
  });

  it("S-2.20: the user is told it was saved, can go and see the schedule, and the count of saved activities is refreshed", async () => {
    await uploaded([run, ride]);
    strava.saveToSchedule.mockResolvedValue(saved([1001]));
    strava.loadStatus.mockResolvedValue(status(true, 1));
    fireEvent.click(saveButton("Morning run"));

    expect(await screen.findByText("Saved 1 activity to your schedule.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View schedule" })).toBeInTheDocument();
    expect(await screen.findByText("1 Strava activity on your schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove saved activities" })).toBeInTheDocument();
    expect(screen.getByText("· 1 to save · 1 on your schedule")).toBeInTheDocument();
  });

  it("S-2.21: Save all sends every activity that can be saved, and none of the others", async () => {
    await uploaded([run, ride, gym, swim]);
    strava.saveToSchedule.mockResolvedValue(saved([1001, 1002]));
    expect(saveAll()).toHaveAccessibleName("Save all to schedule (2)");
    fireEvent.click(saveAll());

    expect(await screen.findByText("Saved 2 activities to your schedule.")).toBeInTheDocument();
    expect(strava.saveToSchedule).toHaveBeenCalledTimes(1);
    expect(strava.saveToSchedule).toHaveBeenCalledWith([1001, 1002]);
    expect((await cardOf("Morning run")).getByText("On schedule")).toBeInTheDocument();
    expect((await cardOf("Lunch ride")).getByText("On schedule")).toBeInTheDocument();
    expect((await cardOf("Pool swim")).queryByText("On schedule")).not.toBeInTheDocument();
    // Nothing is left to save
    await waitFor(() => expect(saveAll("Save all to schedule")).toBeDisabled());
  });

  it("S-2.22: Save all is disabled when everything is saved already or cannot be saved", async () => {
    await uploaded([gym, swim]);
    expect(saveAll("Save all to schedule")).toBeDisabled();
  });

  it("S-2.23: an activity already on the schedule says so and has no Save button", async () => {
    await uploaded([gym]);
    const item = await cardOf("Evening gym");
    expect(item.getByText("On schedule")).toBeInTheDocument();
    expect(item.getByText("Saved as Gym · 50 min · 40 pts")).toBeInTheDocument();
    expect(item.queryByRole("button")).not.toBeInTheDocument();
  });

  it("S-2.24: when some were saved, some were there already and some are gone from Strava's latest, each is accounted for", async () => {
    await uploaded([run, ride]);
    strava.saveToSchedule.mockResolvedValue(saved([1001], 1, 1));
    fireEvent.click(saveAll());
    const message = await screen.findByText(
      "Saved 1 activity to your schedule. 1 activity was already on your schedule. 1 activity couldn't be saved because it is no longer among your latest on Strava. Upload again to refresh the list.",
    );
    // Something was saved, so this is a plain notice and not an error, and the schedule can be opened
    expect(message.closest("[role='status']")).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View schedule" })).toBeInTheDocument();
  });

  it("S-2.25: when nothing could be saved the message is an error and there is nowhere to go", async () => {
    await uploaded([run]);
    strava.saveToSchedule.mockResolvedValue(saved([], 0, 1));
    fireEvent.click(saveButton("Morning run"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 activity couldn't be saved because it is no longer among your latest on Strava.");
    expect(within(alert).queryByRole("button", { name: "View schedule" })).not.toBeInTheDocument();
    expect((await cardOf("Morning run")).queryByText("On schedule")).not.toBeInTheDocument();
  });

  it("S-2.26: if the save fails the user sees why, nothing is marked as saved and they can try again", async () => {
    await uploaded([run]);
    strava.saveToSchedule.mockResolvedValue(fail("SERVER_ERROR", "The server returned an error (500)."));
    fireEvent.click(saveButton("Morning run"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The server returned an error (500).")).toBeInTheDocument();
    expect((await cardOf("Morning run")).queryByText("On schedule")).not.toBeInTheDocument();
    expect(saveButton("Morning run")).toBeEnabled();
  });

  it("S-2.26: if Strava turns out not to be connected while saving, the tab asks again and offers Connect", async () => {
    strava.connectUrl = "https://www.strava.com/oauth/authorize?state=training";
    await uploaded([run]);
    strava.loadStatus.mockResolvedValue(status(false));
    strava.saveToSchedule.mockResolvedValue(fail("NOT_CONNECTED", "Strava isn't connected. Connect it first."));
    fireEvent.click(saveButton("Morning run"));
    expect(await screen.findByRole("link", { name: "Connect Strava" })).toBeInTheDocument();
    expect(screen.getByText("Strava isn't connected. Connect it first.")).toBeInTheDocument();
  });

  it("S-2.27: View schedule takes the user to the Schedule tab", async () => {
    await uploaded([run]);
    strava.saveToSchedule.mockResolvedValue(saved([1001]));
    fireEvent.click(saveButton("Morning run"));
    fireEvent.click(await screen.findByRole("button", { name: "View schedule" }));

    const group = screen.getByRole("group", { name: "Training sections" });
    expect(within(group).getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("group", { name: "Calendar view" })).toBeInTheDocument();
  });

  it("S-2.28: a new notice replaces the old one, and starting an upload clears it", async () => {
    await uploaded([run, ride]);
    strava.saveToSchedule.mockResolvedValue(saved([1001]));
    fireEvent.click(saveButton("Morning run"));
    expect(await screen.findByText("Saved 1 activity to your schedule.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Upload Strava data" }));
    await waitFor(() => expect(screen.queryByText("Saved 1 activity to your schedule.")).not.toBeInTheDocument());
  });
});

/* ------------------------------------------------------------------ S-3 removing */

describe("S-3 removing saved activities", () => {
  it("S-3.20: the Remove button and the count show only when something from Strava is on the schedule", async () => {
    await onStrava();
    await uploadButton();
    expect(screen.queryByRole("button", { name: "Remove saved activities" })).not.toBeInTheDocument();
    expect(screen.queryByText(/on your schedule$/)).not.toBeInTheDocument();
  });

  it.each([
    [1, "1 Strava activity on your schedule"],
    [3, "3 Strava activities on your schedule"],
  ])("S-3.20: with %i saved the tab says '%s' and offers Remove", async (count, text) => {
    strava.loadStatus.mockResolvedValue(status(true, count));
    await onStrava();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove saved activities" })).toBeEnabled();
  });

  it("S-3.21: the user is asked first, told what stays, and Cancel changes nothing", async () => {
    strava.loadStatus.mockResolvedValue(status(true, 3));
    await onStrava();
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved activities" }));

    const dialog = openDialog("Remove saved Strava activities?");
    expect(
      within(dialog).getByText(
        "This takes 3 activities that came from Strava off your schedule. Your own logged sessions stay as they are, nothing changes on Strava, and you can upload and save them again later.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(strava.removeFromSchedule).not.toHaveBeenCalled();
    expect(screen.getByText("3 Strava activities on your schedule")).toBeInTheDocument();
  });

  it("S-3.22: confirming removes them, says how many, and the cards go back to being saveable", async () => {
    await uploaded([gym, run], 3);
    strava.removeFromSchedule.mockResolvedValue(ok(3));
    strava.loadStatus.mockResolvedValue(status(true, 0));
    fireEvent.click(screen.getByRole("button", { name: "Remove saved activities" }));
    fireEvent.click(within(openDialog("Remove saved Strava activities?")).getByRole("button", { name: "Remove from schedule" }));

    expect(await screen.findByText("Removed 3 activities from your schedule.")).toBeInTheDocument();
    expect(strava.removeFromSchedule).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveButton("Evening gym")).toBeEnabled();
    expect((await cardOf("Evening gym")).queryByText("On schedule")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove saved activities" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Strava activit(y|ies) on your schedule$/)).not.toBeInTheDocument();
  });

  it.each([
    [1, "Removed 1 activity from your schedule."],
    [2, "Removed 2 activities from your schedule."],
    [0, "There were no Strava activities on your schedule."],
  ])("S-3.23: when %i were removed the user is told '%s'", async (removed, message) => {
    strava.loadStatus.mockResolvedValue(status(true, 2));
    strava.removeFromSchedule.mockResolvedValue(ok(removed));
    await onStrava();
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved activities" }));
    fireEvent.click(within(openDialog("Remove saved Strava activities?")).getByRole("button", { name: "Remove from schedule" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("S-3.24: if removing fails the user sees why, the dialog closes and the activities are still counted", async () => {
    strava.loadStatus.mockResolvedValue(status(true, 2));
    strava.removeFromSchedule.mockResolvedValue(fail("SERVER_ERROR", "The server returned an error (500)."));
    await onStrava();
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved activities" }));
    fireEvent.click(within(openDialog("Remove saved Strava activities?")).getByRole("button", { name: "Remove from schedule" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The server returned an error (500).")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("2 Strava activities on your schedule")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ Hard Rule 1 on screen */

describe("HR-1 what the Strava tab says and does about Strava data", () => {
  const STATEMENT =
    "Saved Strava activities show on your schedule so you can see them. They don't complete planned sessions, and they are never used for your plan, readiness score or coach.";

  it("HR-1.44: the tab always says saved activities are only shown, never used for the plan, readiness or coach", async () => {
    await onStrava();
    await uploadButton();
    expect(screen.getByText(STATEMENT)).toBeInTheDocument();
  });

  it("HR-1.44: it says so when the user is not connected", async () => {
    strava.loadStatus.mockResolvedValue(status(false));
    await onStrava();
    await screen.findByText("Strava isn't set up on this server yet.");
    expect(screen.getByText(STATEMENT)).toBeInTheDocument();
  });

  it("HR-1.44: it says so when the backend is missing", async () => {
    strava.available = false;
    await onStrava();
    expect(screen.getByText(STATEMENT)).toBeInTheDocument();
  });

  it("HR-1.45: uploading, saving one, saving all and removing never call the training API", async () => {
    await uploaded([run, ride, gym], 1);
    const api = fixtureApi() as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = Object.keys(api)
      .filter((name) => typeof api[name] === "function")
      .map((name) => vi.spyOn(api, name));
    expect(spies.length).toBeGreaterThan(10);

    strava.saveToSchedule.mockResolvedValueOnce(saved([1001])).mockResolvedValueOnce(saved([1002]));
    fireEvent.click(saveButton("Morning run"));
    await screen.findByText("Saved 1 activity to your schedule.");
    fireEvent.click(saveAll());
    await screen.findByText("Saved 1 activity to your schedule.");
    fireEvent.click(screen.getByRole("button", { name: "Upload Strava data" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload Strava data" })).toBeEnabled());
    strava.removeFromSchedule.mockResolvedValue(ok(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove saved activities" }));
    fireEvent.click(within(openDialog("Remove saved Strava activities?")).getByRole("button", { name: "Remove from schedule" }));
    await screen.findByText("Removed 1 activity from your schedule.");

    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it("HR-1.46: what the tab sends to the server is the Strava ids and nothing else about the activities", async () => {
    await uploaded([run, ride]);
    strava.saveToSchedule.mockResolvedValue(saved([1001, 1002]));
    fireEvent.click(saveAll());
    await screen.findByText("Saved 2 activities to your schedule.");
    // The server asks Strava again for the details; the browser sends numbers only, never names, times or heart rates.
    expect(strava.saveToSchedule.mock.calls).toEqual([[[1001, 1002]]]);
  });
});

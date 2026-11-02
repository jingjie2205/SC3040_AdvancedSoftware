import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// api.ts picks the real HTTP client or the fixtures when it is first imported, so this runs before the imports.
vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_GAMIFICATION_API", "http");
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://backend.test");
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  }),
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...props }: { href: string; children?: ReactNode }) =>
      createElement("a", { href, ...props }, children),
  };
});

import LeaderboardPage from "@/app/(app)/dashboard/leaderboard/page";
import { ChallengesPanel } from "@/app/(app)/dashboard/leaderboard/_components/challenges-panel";
import { LeaderboardPanel } from "@/app/(app)/dashboard/leaderboard/_components/leaderboard-panel";
import { PendingXpAlert } from "@/app/(app)/dashboard/leaderboard/_components/pending-xp-alert";
import { XpHistoryPanel } from "@/app/(app)/dashboard/leaderboard/_components/xp-history-panel";
import { addDaysISO, todayISO } from "@/lib/gamification/dates";
import type {
  Challenge,
  ChallengeParticipant,
  GamificationStats,
  Leaderboard,
  LeaderboardEntry,
  PendingXpItem,
  XpEvent,
} from "@/lib/gamification/types";

const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";
const CAROL = "00000000-0000-0000-0000-00000000000c";
const DAVE = "00000000-0000-0000-0000-00000000000d";

function stats(overrides: Partial<GamificationStats> = {}): GamificationStats {
  return {
    userId: ALICE,
    totalXp: 0,
    currentStreak: 0,
    longestStreak: 0,
    lastCheckInDate: null,
    checkedInToday: false,
    rank: "Beginner",
    nextRank: "Bronze",
    xpToNextRank: 100,
    ...overrides,
  };
}

function entry(
  position: number,
  userId: string,
  displayName: string | null,
  totalXp: number,
  rank: string,
  extra: Partial<LeaderboardEntry> = {},
): LeaderboardEntry {
  return {
    position,
    userId,
    displayName,
    totalXp,
    currentStreak: 0,
    mileageKm: 0,
    rank,
    isCurrentUser: userId === ALICE,
    ...extra,
  };
}

const xpBoard: Leaderboard = {
  metric: "xp",
  friendCount: 2,
  entries: [
    entry(1, BOB, "Bob Tan", 100, "Bronze"),
    entry(2, ALICE, "Alice Wong", 50, "Beginner"),
    entry(3, CAROL, "Carol Lim", 0, "Beginner"),
  ],
};

function participant(
  userId: string,
  displayName: string | null,
  status: ChallengeParticipant["status"],
  extra: Partial<ChallengeParticipant> = {},
): ChallengeParticipant {
  return { userId, displayName, status, progress: 0, completed: false, isCurrentUser: false, ...extra };
}

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "c1",
    creatorId: ALICE,
    creatorName: "Alice Wong",
    title: "Week of grind",
    metric: "sessions",
    targetValue: 2,
    startDate: todayISO(),
    endDate: addDaysISO(6),
    status: "active",
    myStatus: "accepted",
    rewardXp: 100,
    participants: [],
    ...overrides,
  };
}

const xpEvent = (id: string, source: XpEvent["source"], amount: number): XpEvent => ({
  id,
  source,
  amount,
  createdAt: "2026-10-05T04:00:00+00:00",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Route = (request: { url: URL; body: unknown }) => Response | Promise<Response>;

/**
 * Stands in for the FastAPI /gamification routes behind the page's real HTTP client.
 * Routes are keyed "METHOD /path" without the /gamification prefix; tests replace the ones they need.
 */
function startServer(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    "GET /me": () => json(stats()),
    "GET /xp-events": () => json({ events: [] }),
    "GET /pending-xp": () => json({ items: [], totalXp: 0 }),
    "GET /leaderboard": () => json(xpBoard),
    "GET /challenges": () => json({ challenges: [] }),
    ...overrides,
  };
  const calls: { key: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname
      .replace(/^\/gamification/, "")
      .replace(/^\/challenges\/[^/]+\/respond$/, "/challenges/:id/respond");
    const key = `${init?.method ?? "GET"} ${path}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    const route = routes[key];
    if (!route) throw new Error(`No fake route for ${key}`);
    return route({ url, body });
  });
  return {
    routes,
    bodies: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
    count: (key: string) => calls.filter((call) => call.key === key).length,
  };
}

const rankingRows = () =>
  within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((row) => row.textContent);

function answerCheckIn() {
  const answers = [
    ["How sore are your muscles?", "3"],
    ["How's your mood?", "4"],
    ["Did you stick to your diet yesterday?", "5"],
  ];
  for (const [question, score] of answers) {
    fireEvent.click(within(screen.getByRole("group", { name: question })).getByRole("button", { name: score }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Check in" }));
}

async function openChallengeForm() {
  fireEvent.click(await screen.findByRole("button", { name: "New challenge" }));
  await screen.findByRole("checkbox", { name: /Bob Tan/ });
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("Leaderboard page (LT-1 to LT-8)", () => {
  it("LT-1: ranks the user and their friends by XP and labels the user's row", async () => {
    startServer();

    render(<LeaderboardPanel refreshKey={0} />);

    await screen.findByText("Bob Tan");
    expect(rankingRows()).toEqual(["Bob TanBronze100XP", "YouBeginner50XP", "Carol LimBeginner0XP"]);
    expect(screen.getByRole("button", { name: "XP" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Position 1")).toBeInTheDocument();
    expect(screen.queryByText("Alice Wong")).not.toBeInTheDocument();
  });

  it("LT-2: completing the daily check-in awards XP and builds the streak", async () => {
    let me = stats();
    let saved = { checkInId: "k1", date: "2026-10-04", xpAwarded: 10, currentStreak: 1, totalXp: 10, rank: "Beginner" };
    const server = startServer({
      "GET /me": () => json(me),
      "POST /checkins": () => {
        me = stats({
          totalXp: saved.totalXp,
          currentStreak: saved.currentStreak,
          checkedInToday: true,
          xpToNextRank: 100 - saved.totalXp,
        });
        return json(saved, 201);
      },
    });

    const first = render(<LeaderboardPage />);
    expect(await screen.findByText("No streak yet")).toBeInTheDocument();
    expect(screen.getByText("+10 XP")).toBeInTheDocument();
    expect(screen.getByText("100 XP to Bronze")).toBeInTheDocument();

    answerCheckIn();

    expect(await screen.findByText("+10 XP · 1-day streak")).toBeInTheDocument();
    expect(await screen.findByText("Checked in for today")).toBeInTheDocument();
    expect(screen.getByText("90 XP to Bronze")).toBeInTheDocument();
    expect(server.bodies("POST /checkins")).toEqual([{ muscleFatigue: 3, mood: 4, dietAdherence: 5 }]);
    first.unmount();

    // The next day, yesterday's check-in keeps the streak alive
    me = stats({ totalXp: 10, currentStreak: 1, xpToNextRank: 90 });
    saved = { checkInId: "k2", date: "2026-10-05", xpAwarded: 12, currentStreak: 2, totalXp: 22, rank: "Beginner" };
    render(<LeaderboardPage />);
    expect(await screen.findByText("1-day streak")).toBeInTheDocument();
    expect(screen.getByText("Check in today to make it 2 days")).toBeInTheDocument();
    expect(screen.getByText("+12 XP")).toBeInTheDocument();

    answerCheckIn();

    expect(await screen.findByText("+12 XP · 2-day streak")).toBeInTheDocument();
    expect(await screen.findByText("78 XP to Bronze")).toBeInTheDocument();
  });

  it("LT-3: a second check-in on the same day is refused without extra XP", async () => {
    const checkedIn = stats({ totalXp: 10, currentStreak: 1, checkedInToday: true, xpToNextRank: 90 });
    const server = startServer({ "GET /me": () => json(checkedIn) });

    const first = render(<LeaderboardPage />);
    expect(await screen.findByText("Checked in for today")).toBeInTheDocument();
    expect(screen.getByText("1-day streak. Come back tomorrow to extend it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
    first.unmount();

    // A tab opened before the check-in still shows the questions
    let me = stats();
    server.routes["GET /me"] = () => json(me);
    server.routes["POST /checkins"] = () => {
      me = checkedIn;
      return json({ detail: "You have already checked in today" }, 409);
    };
    render(<LeaderboardPage />);
    await screen.findByText("No streak yet");

    answerCheckIn();

    expect(await screen.findByText("Checked in for today")).toBeInTheDocument();
    expect(screen.getByText("90 XP to Bronze")).toBeInTheDocument();
    expect(screen.queryByText(/XP · /)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("LT-4: XP on hold is listed and paid after the meal is fixed and re-synced", async () => {
    const held: PendingXpItem = {
      id: "h1",
      source: "meal",
      sourceId: "m1",
      amount: 10,
      reason: "no calorie estimate",
      createdAt: "2026-10-05T04:00:00+00:00",
    };
    let me = stats();
    let pending = { items: [held], totalXp: 10 };
    const resyncs = [
      { items: [held], totalXp: 10, awardedXp: 0, released: 0, stillPending: 1, removed: 0 },
      { items: [], totalXp: 0, awardedXp: 10, released: 1, stillPending: 0, removed: 0 },
    ];
    const server = startServer({
      "GET /me": () => json(me),
      "GET /pending-xp": () => json(pending),
      "POST /pending-xp/resync": () => json(resyncs.shift()),
    });

    render(<LeaderboardPage />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("10 XP on hold")).toBeInTheDocument();
    expect(within(alert).getByText("no calorie estimate")).toBeInTheDocument();
    expect(within(alert).getByText("+10 XP")).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Re-sync" }));
    expect(await screen.findByText("Re-synced: 1 still on hold")).toBeInTheDocument();
    expect(screen.getByText("10 XP on hold")).toBeInTheDocument();

    // The user adds the meal's calories on the Meal page
    pending = { items: [], totalXp: 0 };
    me = stats({ totalXp: 10, xpToNextRank: 90 });
    fireEvent.click(screen.getByRole("button", { name: "Re-sync" }));

    expect(await screen.findByText("Re-synced: +10 XP added")).toBeInTheDocument();
    expect(screen.queryByText("10 XP on hold")).not.toBeInTheDocument();
    expect(await screen.findByText("90 XP to Bronze")).toBeInTheDocument();
    expect(server.count("POST /pending-xp/resync")).toBe(2);
  });

  it("LT-5: accepting an invitation tracks progress and shows the reward once", async () => {
    const invite = challenge({
      myStatus: "invited",
      participants: [
        participant(ALICE, "Alice Wong", "accepted"),
        participant(BOB, "Bob Tan", "invited", { isCurrentUser: true }),
        participant(CAROL, "Carol Lim", "invited"),
      ],
    });
    const accepted = challenge({
      participants: [
        participant(ALICE, "Alice Wong", "accepted"),
        participant(BOB, "Bob Tan", "accepted", { isCurrentUser: true }),
        participant(CAROL, "Carol Lim", "invited"),
      ],
    });
    const server = startServer({
      "GET /me": () => json(stats({ userId: BOB })),
      "GET /challenges": () => json({ challenges: [invite] }),
      "POST /challenges/:id/respond": () => json(accepted),
    });

    const first = render(<LeaderboardPage />);
    expect(await screen.findByText("Alice Wong invited you")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(screen.queryByText("Alice Wong invited you")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(server.bodies("POST /challenges/:id/respond")).toEqual([{ accept: true }]);
    first.unmount();

    // Two workouts later
    server.routes["GET /me"] = () =>
      json(stats({ userId: BOB, totalXp: 200, rank: "Bronze", nextRank: "Silver", xpToNextRank: 300 }));
    server.routes["GET /xp-events"] = () =>
      json({ events: [xpEvent("e3", "challenge", 100), xpEvent("e2", "workout", 50), xpEvent("e1", "workout", 50)] });
    server.routes["GET /challenges"] = () =>
      json({
        challenges: [
          challenge({
            participants: [
              participant(BOB, "Bob Tan", "accepted", { isCurrentUser: true, progress: 2, completed: true }),
              participant(ALICE, "Alice Wong", "accepted"),
              participant(CAROL, "Carol Lim", "invited"),
            ],
          }),
        ],
      });
    const second = render(<LeaderboardPage />);
    expect(await screen.findByText("Target reached: +100 XP earned")).toBeInTheDocument();
    expect(screen.getByLabelText("Target reached")).toBeInTheDocument();
    expect(screen.getByText("300 XP to Silver")).toBeInTheDocument();
    expect(await screen.findAllByText("Challenge completed")).toHaveLength(1);
    second.unmount();

    // A tab opened before accepting still shows the invitation
    let list = [invite];
    server.routes["GET /challenges"] = () => json({ challenges: list });
    server.routes["POST /challenges/:id/respond"] = () => {
      list = [accepted];
      return json({ detail: "You have already responded to this challenge" }, 409);
    };
    render(<LeaderboardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(await screen.findByText("You have already responded to this challenge")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument());
  });

  it("LT-6: switching to Streak and Mileage re-ranks the same people", async () => {
    const boards: Record<string, Leaderboard> = {
      xp: xpBoard,
      streak: {
        metric: "streak",
        friendCount: 2,
        entries: [
          entry(1, ALICE, "Alice Wong", 50, "Beginner", { currentStreak: 2 }),
          entry(2, BOB, "Bob Tan", 100, "Bronze", { currentStreak: 1 }),
        ],
      },
      mileage: {
        metric: "mileage",
        friendCount: 2,
        entries: [
          entry(1, BOB, "Bob Tan", 100, "Bronze", { mileageKm: 15.3 }),
          entry(2, ALICE, "Alice Wong", 50, "Beginner", { mileageKm: 8 }),
          entry(3, CAROL, "Carol Lim", 0, "Beginner"),
        ],
      },
    };
    const server = startServer({
      "GET /leaderboard": ({ url }) => json(boards[url.searchParams.get("metric") ?? "xp"]),
    });

    render(<LeaderboardPanel refreshKey={0} />);
    await screen.findByText("Bob Tan");
    const rankBy = screen.getByRole("group", { name: "Rank by" });

    fireEvent.click(within(rankBy).getByRole("button", { name: "Streak" }));
    await waitFor(() => expect(rankingRows()).toEqual(["YouBeginner2days", "Bob TanBronze1day"]));

    fireEvent.click(within(rankBy).getByRole("button", { name: "Mileage" }));
    await waitFor(() =>
      expect(rankingRows()).toEqual(["Bob TanBronze15.3km", "YouBeginner8.0km", "Carol LimBeginner0.0km"]),
    );
    expect(screen.getByText(/Runs saved from Strava in the last 30 days/)).toBeInTheDocument();
    expect(server.count("GET /leaderboard")).toBe(3);
  });

  it("LT-7: creating a challenge invites friends and shows each person's status", async () => {
    const created = challenge({
      participants: [
        participant(ALICE, "Alice Wong", "accepted", { isCurrentUser: true }),
        participant(BOB, "Bob Tan", "invited"),
        participant(CAROL, "Carol Lim", "invited"),
      ],
    });
    const nextWeek = challenge({
      id: "c2",
      title: "Next week",
      metric: "xp",
      targetValue: 500,
      startDate: addDaysISO(7),
      endDate: addDaysISO(13),
      status: "upcoming",
      participants: [participant(ALICE, "Alice Wong", "accepted", { isCurrentUser: true })],
    });
    const replies = [created, nextWeek];
    const server = startServer({ "POST /challenges": () => json(replies.shift(), 201) });

    const first = render(<ChallengesPanel refreshKey={0} />);
    expect(await screen.findByText("No challenges yet. Start one and invite other athletes.")).toBeInTheDocument();
    await openChallengeForm();
    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual([
      "Bob TanBronze",
      "Carol LimBeginner",
    ]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Week of grind  " } });
    fireEvent.click(within(screen.getByRole("group", { name: "Compete on" })).getByRole("button", { name: "Workouts" }));
    fireEvent.change(screen.getByLabelText("Target (workouts)"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob Tan/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Carol Lim/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));

    expect(await screen.findByText("Week of grind")).toBeInTheDocument();
    expect(server.bodies("POST /challenges")).toEqual([
      {
        title: "Week of grind",
        metric: "sessions",
        targetValue: 2,
        startDate: todayISO(),
        endDate: addDaysISO(6),
        inviteeIds: [BOB, CAROL],
      },
    ]);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getAllByText("invited")).toHaveLength(2);
    expect(screen.getByText("Reach the target to earn +100 XP")).toBeInTheDocument();
    first.unmount();

    // Reloading keeps it listed, and a challenge that starts next week is upcoming
    server.routes["GET /challenges"] = () => json({ challenges: [created] });
    render(<ChallengesPanel refreshKey={0} />);
    expect(await screen.findByText("Week of grind")).toBeInTheDocument();

    await openChallengeForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Next week" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: addDaysISO(7) } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: addDaysISO(13) } });
    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));

    expect(await screen.findByText("Upcoming")).toBeInTheDocument();
    expect(server.bodies("POST /challenges")[1]).toMatchObject({
      title: "Next week",
      startDate: addDaysISO(7),
      endDate: addDaysISO(13),
      inviteeIds: [],
    });
  });

  it("LT-8: a challenge that invites someone who is not a friend is blocked", async () => {
    const replies = [
      json({ detail: "You can only invite your friends" }, 422),
      json({ detail: "One or more invited athletes don't exist" }, 422),
    ];
    const server = startServer({ "POST /challenges": () => replies.shift() ?? json({}, 500) });

    render(<ChallengesPanel refreshKey={0} />);
    await openChallengeForm();
    expect(screen.queryByRole("checkbox", { name: /Dave Ng/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sneaky" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob Tan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));
    expect(await screen.findByText("You can only invite your friends")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));
    expect(await screen.findByText("One or more invited athletes don't exist")).toBeInTheDocument();
    expect(screen.getByText("No challenges yet. Start one and invite other athletes.")).toBeInTheDocument();
    expect(server.count("POST /challenges")).toBe(2);
  });
});

describe("Leaderboard page: other states (not in the report)", () => {
  it("shows an error with Try again when the user's progress can't load", async () => {
    let fail = true;
    startServer({
      "GET /me": () => (fail ? new Response("Internal Server Error", { status: 500 }) : json(stats())),
    });

    render(<LeaderboardPage />);
    expect(await screen.findByText("The server returned an error (500).")).toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No streak yet")).toBeInTheDocument();
  });

  it("keeps the newest progress when an older request finishes late", async () => {
    const held: PendingXpItem = {
      id: "h1",
      source: "meal",
      sourceId: "m1",
      amount: 10,
      reason: "no calorie estimate",
      createdAt: "2026-10-05T04:00:00+00:00",
    };
    let releaseStale: () => void = () => {};
    const progress = [
      () => json(stats()),
      // Asked for after the check-in, but only answers after the re-sync below
      () =>
        new Promise<Response>((resolve) => {
          releaseStale = () => resolve(json(stats({ totalXp: 10, checkedInToday: true, xpToNextRank: 90 })));
        }),
      () => json(stats({ totalXp: 20, checkedInToday: true, xpToNextRank: 80 })),
    ];
    const server = startServer({
      "GET /me": () => (progress.shift() ?? progress[0])(),
      "POST /checkins": () =>
        json({ checkInId: "k1", date: "2026-10-05", xpAwarded: 10, currentStreak: 1, totalXp: 10, rank: "Beginner" }, 201),
      "GET /pending-xp": () => json({ items: [held], totalXp: 10 }),
      "POST /pending-xp/resync": () =>
        json({ items: [], totalXp: 0, awardedXp: 10, released: 1, stillPending: 0, removed: 0 }),
    });

    render(<LeaderboardPage />);
    await screen.findByText("No streak yet");
    answerCheckIn();
    await screen.findByText("+10 XP · 1-day streak");
    await waitFor(() => expect(server.count("GET /me")).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Re-sync" }));
    expect(await screen.findByText("80 XP to Bronze")).toBeInTheDocument();

    releaseStale();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("80 XP to Bronze")).toBeInTheDocument();
    expect(screen.queryByText("90 XP to Bronze")).not.toBeInTheDocument();
  });

  it("shows top rank and the best streak", async () => {
    startServer({
      "GET /me": () =>
        json(
          stats({
            totalXp: 4200,
            rank: "Platinum",
            nextRank: null,
            xpToNextRank: null,
            currentStreak: 1,
            longestStreak: 9,
            checkedInToday: true,
          }),
        ),
    });

    render(<LeaderboardPage />);
    expect(await screen.findByText("Top rank reached")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Top rank reached" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("Best: 9 days")).toBeInTheDocument();
  });

  it("asks for every check-in answer and shows server errors", async () => {
    const server = startServer({ "POST /checkins": () => json({ detail: "Database unavailable" }, 503) });

    render(<LeaderboardPage />);
    await screen.findByText("No streak yet");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));

    expect(await screen.findByText("Rate your muscle fatigue")).toBeInTheDocument();
    expect(server.count("POST /checkins")).toBe(0);

    answerCheckIn();
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check in" })).toBeEnabled();
  });

  it("points a user without friends to the Friends page", async () => {
    startServer({
      "GET /leaderboard": () =>
        json({ metric: "xp", friendCount: 0, entries: [entry(1, ALICE, "Alice Wong", 0, "Beginner")] }),
    });

    render(<LeaderboardPanel refreshKey={0} />);
    expect(await screen.findByText("No friends on your leaderboard yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add friends" })).toHaveAttribute("href", "/dashboard/friends");
  });

  it("numbers places past 3rd, names unnamed athletes and explains empty boards", async () => {
    const boards: Record<string, Leaderboard> = {
      xp: { ...xpBoard, friendCount: 3, entries: [...xpBoard.entries, entry(4, DAVE, null, 0, "Beginner")] },
      streak: { metric: "streak", friendCount: 3, entries: [] },
      mileage: { metric: "mileage", friendCount: 3, entries: [] },
    };
    startServer({ "GET /leaderboard": ({ url }) => json(boards[url.searchParams.get("metric") ?? "xp"]) });

    render(<LeaderboardPanel refreshKey={0} />);
    await screen.findByText("Bob Tan");
    expect(rankingRows()[3]).toBe("4Athlete 000DBeginner0XP");

    const rankBy = screen.getByRole("group", { name: "Rank by" });
    fireEvent.click(within(rankBy).getByRole("button", { name: "Streak" }));
    expect(
      await screen.findByText("No active streaks among you and your friends. Check in to start one."),
    ).toBeInTheDocument();

    fireEvent.click(within(rankBy).getByRole("button", { name: "Mileage" }));
    expect(await screen.findByText("No one has earned XP yet. Check in to get on the board.")).toBeInTheDocument();
  });

  it("shows a leaderboard load error with Try again", async () => {
    let fail = true;
    startServer({
      "GET /leaderboard": () => (fail ? json({ detail: "Service unavailable" }, 503) : json(xpBoard)),
    });

    render(<LeaderboardPanel refreshKey={0} />);
    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Bob Tan")).toBeInTheDocument();
  });

  it("labels each Recent XP source and recovers from a load error", async () => {
    let fail = true;
    startServer({
      "GET /xp-events": () =>
        fail
          ? json({ detail: "Service unavailable" }, 503)
          : json({
              events: [
                xpEvent("e4", "challenge", 100),
                xpEvent("e3", "workout", 50),
                xpEvent("e2", "meal", 10),
                xpEvent("e1", "checkin", 12),
              ],
            }),
    });

    render(<XpHistoryPanel refreshKey={0} />);
    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Challenge completed")).toBeInTheDocument();
    expect(screen.getByText("Workout logged")).toBeInTheDocument();
    expect(screen.getByText("Meal logged")).toBeInTheDocument();
    expect(screen.getByText("Daily check-in")).toBeInTheDocument();
    expect(screen.getByText("+12 XP")).toBeInTheDocument();
  });

  it("re-syncing several held items handles errors, no change and deleted activities", async () => {
    const items: PendingXpItem[] = [
      { id: "h1", source: "meal", sourceId: "m1", amount: 10, reason: "no calorie estimate", createdAt: "2026-10-05T04:00:00+00:00" },
      { id: "h2", source: "workout", sourceId: "w1", amount: 50, reason: "dated in the future", createdAt: "2026-10-05T05:00:00+00:00" },
    ];
    const replies = [
      new Response("Internal Server Error", { status: 500 }),
      json({ items, totalXp: 60, awardedXp: 0, released: 0, stillPending: 0, removed: 0 }),
      json({ items: [], totalXp: 0, awardedXp: 0, released: 0, stillPending: 0, removed: 2 }),
    ];
    startServer({
      "GET /pending-xp": () => json({ items, totalXp: 60 }),
      "POST /pending-xp/resync": () => replies.shift() ?? json({}, 500),
    });
    const onResynced = vi.fn();

    render(<PendingXpAlert refreshKey={0} onResynced={onResynced} />);
    expect(await screen.findByText("60 XP on hold")).toBeInTheDocument();
    expect(screen.getByText(/2 activities couldn't be verified/)).toBeInTheDocument();
    expect(screen.getByText("dated in the future")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Re-sync" }));
    expect(await screen.findByText("The server returned an error (500).")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Re-sync" }));
    expect(await screen.findByText("Re-synced: Nothing changed yet.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Re-sync" }));
    expect(await screen.findByText("Re-synced: 2 deleted activities cleared")).toBeInTheDocument();
    expect(onResynced).not.toHaveBeenCalled();
  });

  it("leaves the page usable when held XP can't load", async () => {
    const server = startServer({ "GET /pending-xp": () => json({ detail: "Service unavailable" }, 503) });

    const { container } = render(<PendingXpAlert refreshKey={0} onResynced={vi.fn()} />);
    await waitFor(() => expect(server.count("GET /pending-xp")).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("puts invitations first, hides the reward note on ended challenges and names unnamed creators", async () => {
    const me = participant(ALICE, "Alice Wong", "accepted", { isCurrentUser: true });
    startServer({
      "GET /challenges": () =>
        json({
          challenges: [
            challenge({ id: "e", title: "Ended one", status: "ended", participants: [me] }),
            challenge({ id: "a", title: "Active one", participants: [me] }),
            challenge({
              id: "i",
              title: "Invite",
              creatorId: DAVE,
              creatorName: null,
              myStatus: "invited",
              participants: [
                participant(DAVE, null, "accepted"),
                participant(ALICE, "Alice Wong", "invited", { isCurrentUser: true }),
              ],
            }),
          ],
        }),
    });

    render(<ChallengesPanel refreshKey={0} />);
    expect(await screen.findByText("Athlete 000D invited you")).toBeInTheDocument();
    expect(screen.getAllByText(/^(Active one|Ended one|Invite)$/).map((title) => title.textContent)).toEqual([
      "Invite",
      "Active one",
      "Ended one",
    ]);
    expect(screen.getByText("Ended")).toBeInTheDocument();
    expect(screen.getAllByText("Reach the target to earn +100 XP")).toHaveLength(2);
  });

  it("declining removes the invitation, other errors show without reloading, and load errors can be retried", async () => {
    const invite = challenge({
      myStatus: "invited",
      participants: [
        participant(ALICE, "Alice Wong", "accepted"),
        participant(BOB, "Bob Tan", "invited", { isCurrentUser: true }),
      ],
    });
    let fail = true;
    const replies = [
      new Response("Internal Server Error", { status: 500 }),
      json({ ...invite, myStatus: "declined", participants: [participant(ALICE, "Alice Wong", "accepted")] }),
    ];
    const server = startServer({
      "GET /challenges": () => (fail ? json({ detail: "Service unavailable" }, 503) : json({ challenges: [invite] })),
      "POST /challenges/:id/respond": () => replies.shift() ?? json({}, 500),
    });

    render(<ChallengesPanel refreshKey={0} />);
    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(await screen.findByText("The server returned an error (500).")).toBeInTheDocument();
    expect(server.count("GET /challenges")).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("No challenges yet. Start one and invite other athletes.")).toBeInTheDocument();
    expect(server.bodies("POST /challenges/:id/respond")).toEqual([{ accept: false }, { accept: false }]);
  });

  it("checks the challenge form's fields, lets an invite be unticked and can be cancelled", async () => {
    const server = startServer();

    render(<ChallengesPanel refreshKey={0} />);
    await openChallengeForm();
    fireEvent.change(screen.getByLabelText("Target (XP)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));
    expect(await screen.findByText("Give the challenge a name")).toBeInTheDocument();
    expect(screen.getByText("Enter a target")).toBeInTheDocument();

    // The field errors are inside the labels now, so match the start of each label
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Backwards" } });
    fireEvent.change(screen.getByLabelText(/^Target/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: addDaysISO(-1) } });
    fireEvent.click(screen.getByRole("button", { name: "Create challenge" }));
    expect(await screen.findByText("The end date must be on or after the start date")).toBeInTheDocument();
    expect(server.count("POST /challenges")).toBe(0);

    const bob = screen.getByRole("checkbox", { name: /Bob Tan/ });
    fireEvent.click(bob);
    fireEvent.click(bob);
    expect(bob).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Create challenge" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New challenge" })).toBeInTheDocument();
  });

  it("the invite list explains when there are no friends, and when it can't load", async () => {
    const server = startServer({
      "GET /leaderboard": () =>
        json({ metric: "xp", friendCount: 0, entries: [entry(1, ALICE, "Alice Wong", 0, "Beginner")] }),
    });

    render(<ChallengesPanel refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "New challenge" }));
    expect(await screen.findByText(/No friends yet\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add friends" })).toHaveAttribute("href", "/dashboard/friends");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    server.routes["GET /leaderboard"] = () => json({ detail: "Service unavailable" }, 503);
    fireEvent.click(screen.getByRole("button", { name: "New challenge" }));
    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
  });
});

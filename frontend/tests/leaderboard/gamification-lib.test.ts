import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unset, so api.ts falls back to the sample data and http-api.ts to its default backend URL.
vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_GAMIFICATION_API", "");
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
});

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth }),
}));

import { gamificationApi, type GamificationApi } from "@/lib/gamification/api";
import { httpGamificationApi } from "@/lib/gamification/http-api";
import { mockGamificationApi } from "@/lib/gamification/mock-api";
import type { ChallengeInput } from "@/lib/gamification/schemas";

const ANSWERS = { muscleFatigue: 3, mood: 4, dietAdherence: 5 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("api.ts", () => {
  it("uses the sample data unless NEXT_PUBLIC_GAMIFICATION_API is http", () => {
    expect(gamificationApi).toBe(mockGamificationApi);
  });
});

describe("http-api.ts", () => {
  function reply(response: Response | Error) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
  }

  beforeEach(() => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "t-1" } } });
  });

  it.each([
    [409, { detail: [{ msg: "conflict" }] }, "CONFLICT", "That has already been done."],
    [404, { detail: "Not found" }, "NOT_FOUND", "That challenge no longer exists."],
    [401, { detail: "Invalid token" }, "UNAUTHORIZED", "Your session has expired. Sign in again."],
    [403, { detail: "Not authenticated" }, "UNAUTHORIZED", "Your session has expired. Sign in again."],
    [422, { detail: [{ loc: ["body", "mood"], msg: "too big" }] }, "VALIDATION", "Some values were out of range. Check them and try again."],
    [503, { detail: "Database unavailable" }, "SERVER_ERROR", "Database unavailable"],
  ])("turns a %i response into a readable error", async (status, body, code, message) => {
    reply(json(body, status));
    expect(await httpGamificationApi.checkIn(ANSWERS)).toEqual({ ok: false, error: { code, message } });
  });

  it("falls back to the status code when the error body isn't JSON", async () => {
    reply(new Response("Internal Server Error", { status: 500 }));
    expect(await httpGamificationApi.resyncPendingXp()).toEqual({
      ok: false,
      error: { code: "SERVER_ERROR", message: "The server returned an error (500)." },
    });
  });

  it("reports a network failure", async () => {
    reply(new TypeError("Failed to fetch"));
    expect(await httpGamificationApi.respondToChallenge("c1", true)).toEqual({
      ok: false,
      error: { code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." },
    });
  });

  it("makes reads throw the readable message", async () => {
    reply(json({ detail: "Database unavailable" }, 503));
    await expect(httpGamificationApi.getStats()).rejects.toThrow("Database unavailable");
  });

  it("sends the signed-in user's token to the default backend URL", async () => {
    const fetch = reply(json({ events: [] }));
    expect(await httpGamificationApi.getXpHistory()).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/gamification/xp-events",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer t-1" }) }),
    );
  });

  it("still sends the request, without a token, when there is no readable session", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ challenges: [] }));
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    await httpGamificationApi.getChallenges();
    auth.getSession.mockRejectedValueOnce(new Error("storage blocked"));
    await httpGamificationApi.getChallenges();

    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("encodes the challenge id in the respond URL", async () => {
    const fetch = reply(json({}));
    await httpGamificationApi.respondToChallenge("a/b c", false);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/gamification/challenges/a%2Fb%20c/respond",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ accept: false }) }),
    );
  });
});

describe("mock-api.ts (sample data when the backend isn't used)", () => {
  let api: GamificationApi;

  /** Every sample call waits 150 ms to feel like a network request. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(200);
    return promise;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 12));
    // The sample data lives in module state, so each test starts from a fresh copy.
    vi.resetModules();
    api = (await import("@/lib/gamification/mock-api")).mockGamificationApi;
  });

  it("starts the sample user part-way through Bronze with a live streak", async () => {
    expect(await settle(api.getStats())).toMatchObject({
      totalXp: 340,
      currentStreak: 4,
      checkedInToday: false,
      rank: "Bronze",
      nextRank: "Silver",
      xpToNextRank: 160,
    });
  });

  it("ranks the sample athletes by XP, live streak and mileage", async () => {
    const xp = await settle(api.getLeaderboard("xp"));
    expect(xp.friendCount).toBe(4);
    expect(xp.entries.map((e) => [e.position, e.displayName, e.totalXp, e.mileageKm, e.isCurrentUser])).toEqual([
      [1, "Wei Ling", 1620, 0, false],
      [2, "Arjun", 910, 0, false],
      [3, null, 455, 0, false],
      [4, null, 340, 0, true],
      [5, "Siti", 120, 0, false],
    ]);

    const streak = await settle(api.getLeaderboard("streak"));
    expect(streak.entries.map((e) => [e.displayName, e.currentStreak])).toEqual([
      ["Wei Ling", 12],
      ["Arjun", 6],
      [null, 4],
      [null, 2],
    ]);

    const mileage = await settle(api.getLeaderboard("mileage"));
    expect(mileage.entries.map((e) => [e.displayName, e.mileageKm])).toEqual([
      ["Wei Ling", 42.7],
      ["Siti", 25.1],
      [null, 18.4],
      ["Arjun", 9.2],
      [null, 0],
    ]);
  });

  it("checks in once a day, extends or restarts the streak, and feeds active XP challenges", async () => {
    expect(await settle(api.checkIn({ ...ANSWERS, mood: 0 }))).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Answer all three questions." },
    });
    expect(await settle(api.checkIn(ANSWERS))).toMatchObject({
      ok: true,
      data: { date: "2026-10-05", xpAwarded: 18, currentStreak: 5, totalXp: 358, rank: "Bronze" },
    });
    expect(await settle(api.checkIn(ANSWERS))).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const challenges = await settle(api.getChallenges());
    const myProgress = (id: string) =>
      challenges.find((c) => c.id === id)?.participants.find((p) => p.isCurrentUser)?.progress;
    expect(myProgress("challenge-xp-sprint")).toBe(158);
    expect(myProgress("challenge-streak")).toBe(0);
    expect((await settle(api.getStats())).checkedInToday).toBe(true);

    vi.setSystemTime(new Date(2026, 9, 8, 12));
    expect(await settle(api.checkIn(ANSWERS))).toMatchObject({ ok: true, data: { xpAwarded: 10, currentStreak: 1 } });
  });

  it("lists sample XP newest first and pays held XP on re-sync", async () => {
    expect((await settle(api.getXpHistory())).map((e) => e.id)).toEqual(["xp-2", "xp-1", "xp-3", "xp-4"]);
    expect(await settle(api.getPendingXp())).toMatchObject({ totalXp: 10, items: [{ source: "meal", amount: 10 }] });

    expect(await settle(api.resyncPendingXp())).toEqual({
      ok: true,
      data: { items: [], totalXp: 0, awardedXp: 10, released: 1, stillPending: 0, removed: 0 },
    });
    expect(await settle(api.getPendingXp())).toEqual({ items: [], totalXp: 0 });
    expect((await settle(api.getStats())).totalXp).toBe(350);
    expect((await settle(api.getXpHistory()))[0]).toMatchObject({ source: "meal", amount: 10 });
  });

  it("lists the user's challenges with status, names and progress", async () => {
    const list = await settle(api.getChallenges());

    expect(list.map((c) => [c.id, c.status, c.myStatus, c.creatorName])).toEqual([
      ["challenge-streak", "active", "invited", "Arjun"],
      ["challenge-xp-sprint", "active", "accepted", "Wei Ling"],
      ["challenge-workouts", "ended", "accepted", null],
    ]);
    expect(list[1].participants.map((p) => [p.displayName, p.progress])).toEqual([
      ["Wei Ling", 320],
      ["Arjun", 210],
      [null, 140],
    ]);
    expect(list[0].participants.map((p) => [p.status, p.progress])).toEqual([
      ["accepted", 3],
      ["invited", 0],
      ["invited", 0],
    ]);
    expect(list[2].participants[0]).toMatchObject({ isCurrentUser: true, completed: true });
    // The finished sample challenge was already paid before the session started
    expect((await settle(api.getStats())).totalXp).toBe(340);
  });

  it("creates challenges, checks invitees and pays a completed challenge once", async () => {
    const base: ChallengeInput = {
      title: "Quick XP",
      metric: "xp",
      targetValue: 10,
      startDate: "2026-10-05",
      endDate: "2026-10-11",
      inviteeIds: ["mock-b7c2", "mock-b7c2", "mock-you"],
    };
    expect(await settle(api.createChallenge({ ...base, title: " " }))).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Give the challenge a name" },
    });
    expect(await settle(api.createChallenge({ ...base, inviteeIds: ["nobody"] }))).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "One or more invited athletes don't exist" },
    });

    const created = await settle(api.createChallenge(base));
    expect(created).toMatchObject({ ok: true, data: { status: "active", myStatus: "accepted", creatorName: null, rewardXp: 100 } });
    expect(created.ok && created.data.participants.map((p) => [p.userId, p.status])).toEqual([
      ["mock-you", "accepted"],
      ["mock-b7c2", "invited"],
    ]);
    const later = await settle(api.createChallenge({ ...base, title: "Later", startDate: "2026-10-07", endDate: "2026-10-09", inviteeIds: [] }));
    expect(later).toMatchObject({ ok: true, data: { status: "upcoming" } });

    await settle(api.checkIn(ANSWERS)); // 18 XP finishes the 10 XP challenge
    await settle(api.getChallenges());
    await settle(api.getChallenges());

    expect((await settle(api.getStats())).totalXp).toBe(340 + 18 + 100);
    expect((await settle(api.getXpHistory())).filter((e) => e.source === "challenge")).toHaveLength(2);
  });

  it("accepting an invite counts later check-ins, and other answers follow the rules", async () => {
    expect(await settle(api.respondToChallenge("missing", true))).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "That challenge no longer exists." },
    });
    expect(await settle(api.respondToChallenge("challenge-xp-sprint", true))).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "You have already responded to this challenge" },
    });

    expect(await settle(api.respondToChallenge("challenge-streak", true))).toMatchObject({
      ok: true,
      data: { myStatus: "accepted" },
    });
    await settle(api.checkIn(ANSWERS));
    const streak = (await settle(api.getChallenges())).find((c) => c.id === "challenge-streak");
    expect(streak?.participants.find((p) => p.isCurrentUser)?.progress).toBe(1);
  });

  it("declined invitations disappear from the list", async () => {
    expect(await settle(api.respondToChallenge("challenge-streak", false))).toMatchObject({
      ok: true,
      data: { myStatus: "declined" },
    });
    expect((await settle(api.getChallenges())).map((c) => c.id)).not.toContain("challenge-streak");
  });

  it("an invitation can't be answered once the challenge has ended", async () => {
    await settle(api.getChallenges()); // seeds the sample dates relative to 5 Oct
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    expect(await settle(api.respondToChallenge("challenge-streak", true))).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "This challenge has ended" },
    });
  });
});

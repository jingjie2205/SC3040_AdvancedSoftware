/**
 * In-memory fixtures behind GamificationApi. State lives for the browser session and resets on reload.
 *
 * Everything here is a stand-in: the real server owns XP, streaks, ranks and challenge progress.
 */
import { GAMIFICATION_RULES as R, checkInXpFor } from "./config";
import { addDaysISO, todayISO } from "./dates";
import { challengeSchema, checkInSchema } from "./schemas";
import type { ApiResult, GamificationApi } from "./api";
import type {
  Challenge,
  ChallengeMetric,
  ChallengeParticipant,
  CheckInResult,
  GamificationStats,
  LeaderboardEntry,
  LeaderboardMetric,
  ParticipantStatus,
  PendingXpItem,
  XpEvent,
  XpSource,
} from "./types";

const CURRENT_USER = "mock-you";

interface MockUser {
  userId: string;
  name: string | null;
  totalXp: number;
  currentStreak: number;
  longestStreak: number;
  lastCheckInDate: string | null;
}

/** Progress is stored directly here; the server derives it from check-ins and XP events. */
interface MockChallenge {
  id: string;
  creatorId: string;
  title: string;
  metric: ChallengeMetric;
  targetValue: number;
  startDate: string;
  endDate: string;
  participants: { userId: string; status: ParticipantStatus; progress: number }[];
}

let users: MockUser[] | null = null;
let challenges: MockChallenge[] | null = null;
let history: XpEvent[] | null = null;
let pending: PendingXpItem[] | null = null;
/** Challenges whose reward the current user has already been paid. */
const rewarded = new Set<string>(["challenge-workouts"]);
let counter = 0;

const delay = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function seedUsers(): MockUser[] {
  return [
    { userId: CURRENT_USER, name: null, totalXp: 340, currentStreak: 4, longestStreak: 9, lastCheckInDate: addDaysISO(-1) },
    { userId: "mock-a1f3", name: "Wei Ling", totalXp: 1620, currentStreak: 12, longestStreak: 21, lastCheckInDate: todayISO() },
    { userId: "mock-b7c2", name: "Arjun", totalXp: 910, currentStreak: 6, longestStreak: 6, lastCheckInDate: addDaysISO(-1) },
    { userId: "mock-c0d9", name: null, totalXp: 455, currentStreak: 2, longestStreak: 14, lastCheckInDate: todayISO() },
    { userId: "mock-d4e8", name: "Siti", totalXp: 120, currentStreak: 3, longestStreak: 3, lastCheckInDate: addDaysISO(-3) },
  ];
}

function seedChallenges(): MockChallenge[] {
  return [
    {
      id: "challenge-xp-sprint",
      creatorId: "mock-a1f3",
      title: "Two-week XP sprint",
      metric: "xp",
      targetValue: 500,
      startDate: addDaysISO(-4),
      endDate: addDaysISO(10),
      participants: [
        { userId: "mock-a1f3", status: "accepted", progress: 320 },
        { userId: CURRENT_USER, status: "accepted", progress: 140 },
        { userId: "mock-b7c2", status: "accepted", progress: 210 },
      ],
    },
    {
      id: "challenge-streak",
      creatorId: "mock-b7c2",
      title: "7-day check-in streak",
      metric: "checkin_streak",
      targetValue: 7,
      startDate: addDaysISO(-2),
      endDate: addDaysISO(8),
      participants: [
        { userId: "mock-b7c2", status: "accepted", progress: 3 },
        { userId: CURRENT_USER, status: "invited", progress: 0 },
        { userId: "mock-c0d9", status: "invited", progress: 0 },
      ],
    },
    {
      id: "challenge-workouts",
      creatorId: CURRENT_USER,
      title: "Ten workouts",
      metric: "sessions",
      targetValue: 10,
      startDate: addDaysISO(-20),
      endDate: addDaysISO(-6),
      participants: [
        { userId: CURRENT_USER, status: "accepted", progress: 10 },
        { userId: "mock-c0d9", status: "accepted", progress: 7 },
      ],
    },
  ];
}

function daysAgoAt(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function seedHistory(): XpEvent[] {
  return [
    { id: "xp-1", source: "checkin", amount: 16, createdAt: daysAgoAt(1, 8) },
    { id: "xp-2", source: "meal", amount: R.mealXp, createdAt: daysAgoAt(1, 13) },
    { id: "xp-3", source: "workout", amount: R.workoutXp, createdAt: daysAgoAt(2, 18) },
    { id: "xp-4", source: "challenge", amount: R.challengeRewardXp, createdAt: daysAgoAt(6, 20) },
  ];
}

function pendingStore(): PendingXpItem[] {
  pending ??= [
    {
      id: "pending-1",
      source: "meal",
      sourceId: "meal-without-calories",
      amount: R.mealXp,
      reason: "This meal has no calorie estimate. Add its ingredients and re-sync.",
      createdAt: daysAgoAt(0, 9),
    },
  ];
  return pending;
}

function historyStore(): XpEvent[] {
  history ??= seedHistory();
  return history;
}

function earn(source: XpSource, amount: number) {
  me().totalXp += amount;
  historyStore().push({ id: `xp-${++counter}`, source, amount, createdAt: new Date().toISOString() });
}

function nameOf(userId: string): string | null {
  return userStore().find((u) => u.userId === userId)?.name ?? null;
}

function userStore(): MockUser[] {
  users ??= seedUsers();
  return users;
}

function challengeStore(): MockChallenge[] {
  challenges ??= seedChallenges();
  return challenges;
}

function rankFor(totalXp: number): { rank: string; nextRank: string | null; xpToNextRank: number | null } {
  let rank: string = R.ranks[0][1];
  for (const [threshold, name] of R.ranks) {
    if (totalXp < threshold) return { rank, nextRank: name, xpToNextRank: threshold - totalXp };
    rank = name;
  }
  return { rank, nextRank: null, xpToNextRank: null };
}

/** A streak whose last check-in is older than yesterday is already broken. */
function liveStreak(user: MockUser): number {
  return user.lastCheckInDate && user.lastCheckInDate >= addDaysISO(-1) ? user.currentStreak : 0;
}

function toStats(user: MockUser): GamificationStats {
  return {
    userId: user.userId,
    totalXp: user.totalXp,
    currentStreak: liveStreak(user),
    longestStreak: user.longestStreak,
    lastCheckInDate: user.lastCheckInDate,
    checkedInToday: user.lastCheckInDate === todayISO(),
    ...rankFor(user.totalXp),
  };
}

function me(): MockUser {
  return userStore().find((u) => u.userId === CURRENT_USER)!;
}

function challengeStatus(c: MockChallenge): Challenge["status"] {
  const today = todayISO();
  if (today < c.startDate) return "upcoming";
  if (today > c.endDate) return "ended";
  return "active";
}

function toChallenge(c: MockChallenge): Challenge {
  const participants: ChallengeParticipant[] = c.participants
    .filter((p) => p.status !== "declined")
    .map((p) => {
      const progress = p.status === "accepted" ? p.progress : 0;
      return {
        userId: p.userId,
        displayName: nameOf(p.userId),
        status: p.status,
        progress,
        completed: progress >= c.targetValue,
        isCurrentUser: p.userId === CURRENT_USER,
      };
    })
    .sort((a, b) => Number(a.status !== "accepted") - Number(b.status !== "accepted") || b.progress - a.progress);

  const { participants: _, ...rest } = c;
  return {
    ...rest,
    creatorName: nameOf(c.creatorId),
    rewardXp: R.challengeRewardXp,
    status: challengeStatus(c),
    myStatus: c.participants.find((p) => p.userId === CURRENT_USER)!.status,
    participants,
  };
}

/** Rough stand-in for the server deriving progress from the new check-in. */
function applyCheckInToChallenges(xpAwarded: number) {
  for (const c of challengeStore()) {
    const mine = c.participants.find((p) => p.userId === CURRENT_USER);
    if (challengeStatus(c) !== "active" || mine?.status !== "accepted") continue;
    if (c.metric === "xp") mine.progress += xpAwarded;
    if (c.metric === "checkin_streak") mine.progress += 1;
  }
}

export const mockGamificationApi: GamificationApi = {
  async getStats() {
    await delay();
    return toStats(me());
  },

  async checkIn(input): Promise<ApiResult<CheckInResult>> {
    await delay();
    if (!checkInSchema.safeParse(input).success) {
      return { ok: false, error: { code: "VALIDATION", message: "Answer all three questions." } };
    }
    const user = me();
    const today = todayISO();
    if (user.lastCheckInDate === today) {
      return { ok: false, error: { code: "CONFLICT", message: "You have already checked in today" } };
    }

    user.currentStreak = user.lastCheckInDate === addDaysISO(-1) ? user.currentStreak + 1 : 1;
    user.longestStreak = Math.max(user.longestStreak, user.currentStreak);
    user.lastCheckInDate = today;
    const xpAwarded = checkInXpFor(user.currentStreak);
    earn("checkin", xpAwarded);
    applyCheckInToChallenges(xpAwarded);

    return {
      ok: true,
      data: {
        checkInId: `checkin-${++counter}`,
        date: today,
        xpAwarded,
        currentStreak: user.currentStreak,
        totalXp: user.totalXp,
        rank: rankFor(user.totalXp).rank,
      },
    };
  },

  async getLeaderboard(metric: LeaderboardMetric) {
    await delay();
    const candidates =
      metric === "streak"
        ? userStore().filter((u) => liveStreak(u) > 0).sort((a, b) => b.currentStreak - a.currentStreak)
        : [...userStore()].sort((a, b) => b.totalXp - a.totalXp);

    const entries: LeaderboardEntry[] = candidates.slice(0, R.leaderboardLimit).map((u, i) => ({
      position: i + 1,
      userId: u.userId,
      displayName: u.name,
      totalXp: u.totalXp,
      currentStreak: liveStreak(u),
      rank: rankFor(u.totalXp).rank,
      isCurrentUser: u.userId === CURRENT_USER,
    }));
    return { metric, friendCount: userStore().length - 1, entries };
  },

  async getXpHistory() {
    await delay();
    return [...historyStore()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  },

  async getPendingXp() {
    await delay();
    const items = [...pendingStore()];
    return { items, totalXp: items.reduce((sum, item) => sum + item.amount, 0) };
  },

  // The fixtures treat every held item as fixed by the time the user re-syncs.
  async resyncPendingXp() {
    await delay();
    const released = pendingStore().splice(0);
    for (const item of released) earn(item.source, item.amount);
    return {
      ok: true,
      data: {
        items: [],
        totalXp: 0,
        awardedXp: released.reduce((sum, item) => sum + item.amount, 0),
        released: released.length,
        stillPending: 0,
        removed: 0,
      },
    };
  },

  async getChallenges() {
    await delay();
    const list = challengeStore()
      .filter((c) => c.participants.some((p) => p.userId === CURRENT_USER && p.status !== "declined"))
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
      .map(toChallenge);
    for (const c of list) {
      const mine = c.participants.find((p) => p.isCurrentUser);
      if (mine?.status === "accepted" && mine.completed && !rewarded.has(c.id)) {
        rewarded.add(c.id);
        earn("challenge", R.challengeRewardXp);
      }
    }
    return list;
  },

  async createChallenge(input): Promise<ApiResult<Challenge>> {
    await delay();
    const parsed = challengeSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "VALIDATION", message: parsed.error.issues[0].message } };
    }
    const invitees = [...new Set(parsed.data.inviteeIds)].filter((id) => id !== CURRENT_USER);
    if (invitees.some((id) => !userStore().some((u) => u.userId === id))) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "One or more invited athletes don't exist" },
      };
    }

    const { inviteeIds: _, ...fields } = parsed.data;
    const challenge: MockChallenge = {
      ...fields,
      id: `challenge-${++counter}`,
      creatorId: CURRENT_USER,
      participants: [
        { userId: CURRENT_USER, status: "accepted", progress: 0 },
        ...invitees.map((userId) => ({ userId, status: "invited" as const, progress: 0 })),
      ],
    };
    challengeStore().push(challenge);
    return { ok: true, data: toChallenge(challenge) };
  },

  async respondToChallenge(challengeId, accept): Promise<ApiResult<Challenge>> {
    await delay();
    const challenge = challengeStore().find((c) => c.id === challengeId);
    const mine = challenge?.participants.find((p) => p.userId === CURRENT_USER);
    if (!challenge || !mine) {
      return { ok: false, error: { code: "NOT_FOUND", message: "That challenge no longer exists." } };
    }
    if (mine.status !== "invited") {
      return {
        ok: false,
        error: { code: "CONFLICT", message: "You have already responded to this challenge" },
      };
    }
    if (challengeStatus(challenge) === "ended") {
      return { ok: false, error: { code: "CONFLICT", message: "This challenge has ended" } };
    }
    mine.status = accept ? "accepted" : "declined";
    return { ok: true, data: toChallenge(challenge) };
  },
};

/** Shapes mirror the Pydantic models in backend/app/models/gamification.py. */

export const LEADERBOARD_METRICS = ["xp", "streak"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export interface GamificationStats {
  userId: string;
  totalXp: number;
  /** 0 once a day has been missed, even before the next check-in resets it. */
  currentStreak: number;
  longestStreak: number;
  /** The user's last check-in as "YYYY-MM-DD", or null if they have never checked in. */
  lastCheckInDate: string | null;
  checkedInToday: boolean;
  rank: string;
  /** null at the top rank. */
  nextRank: string | null;
  xpToNextRank: number | null;
}

export interface CheckInResult {
  checkInId: string;
  date: string;
  xpAwarded: number;
  currentStreak: number;
  totalXp: number;
  rank: string;
}

export interface LeaderboardEntry {
  position: number;
  userId: string;
  /** Profile name, or null if the user hasn't set one. */
  displayName: string | null;
  totalXp: number;
  currentStreak: number;
  rank: string;
  isCurrentUser: boolean;
}

export type XpSource = "checkin" | "workout" | "meal" | "challenge";

export interface XpEvent {
  id: string;
  source: XpSource;
  amount: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** XP held back because its workout or meal failed a check; re-syncing checks it again. */
export interface PendingXpItem {
  id: string;
  source: "workout" | "meal";
  sourceId: string;
  amount: number;
  reason: string;
  createdAt: string;
}

export interface PendingXp {
  items: PendingXpItem[];
  totalXp: number;
}

export interface PendingXpResync extends PendingXp {
  /** XP paid by this re-sync. */
  awardedXp: number;
  released: number;
  stillPending: number;
  /** Held items dropped because their workout or meal was deleted. */
  removed: number;
}

export interface Leaderboard {
  metric: LeaderboardMetric;
  /** Accepted friends; 0 means the board can only ever show the user. */
  friendCount: number;
  entries: LeaderboardEntry[];
}

export const CHALLENGE_METRICS = ["xp", "checkin_streak", "sessions"] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export type ChallengeStatus = "upcoming" | "active" | "ended";
export type ParticipantStatus = "invited" | "accepted" | "declined";

export interface ChallengeParticipant {
  userId: string;
  displayName: string | null;
  status: ParticipantStatus;
  /** Only accepted participants accumulate progress; invitees stay at 0. */
  progress: number;
  completed: boolean;
  isCurrentUser: boolean;
}

export interface Challenge {
  id: string;
  creatorId: string;
  creatorName: string | null;
  title: string;
  metric: ChallengeMetric;
  targetValue: number;
  /** "YYYY-MM-DD", inclusive. */
  startDate: string;
  endDate: string;
  status: ChallengeStatus;
  myStatus: ParticipantStatus;
  /** XP each participant earns once for reaching the target. */
  rewardXp: number;
  /** Accepted first by progress, then pending invitees; declined invitees are left out. */
  participants: ChallengeParticipant[];
}

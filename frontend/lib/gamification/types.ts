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
  totalXp: number;
  currentStreak: number;
  rank: string;
  isCurrentUser: boolean;
}

export interface Leaderboard {
  metric: LeaderboardMetric;
  entries: LeaderboardEntry[];
}

export const CHALLENGE_METRICS = ["xp", "checkin_streak", "sessions"] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export type ChallengeStatus = "upcoming" | "active" | "ended";
export type ParticipantStatus = "invited" | "accepted" | "declined";

export interface ChallengeParticipant {
  userId: string;
  status: ParticipantStatus;
  /** Only accepted participants accumulate progress; invitees stay at 0. */
  progress: number;
  completed: boolean;
  isCurrentUser: boolean;
}

export interface Challenge {
  id: string;
  creatorId: string;
  title: string;
  metric: ChallengeMetric;
  targetValue: number;
  /** "YYYY-MM-DD", inclusive. */
  startDate: string;
  endDate: string;
  status: ChallengeStatus;
  myStatus: ParticipantStatus;
  /** Accepted first by progress, then pending invitees; declined invitees are left out. */
  participants: ChallengeParticipant[];
}

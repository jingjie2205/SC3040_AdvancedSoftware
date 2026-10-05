/**
 * Rules for the gamification page. The server is the source of truth for XP and ranks;
 * these copies drive the form limits and the mock API, and must match
 * backend/app/services/gamification.py.
 */
export const GAMIFICATION_RULES = {
  checkInScale: { min: 1, max: 5 },
  leaderboardLimit: 10,
  checkInXp: 10,
  streakBonusPerDay: 2,
  streakBonusCapDays: 7,
  challengeTitleMax: 100,
  challengeTargetMax: 100000,
  challengeMaxInvitees: 20,
  /** [minimum total XP, rank], ascending. */
  ranks: [
    [0, "Beginner"],
    [100, "Bronze"],
    [500, "Silver"],
    [1500, "Gold"],
    [4000, "Platinum"],
  ],
} as const;

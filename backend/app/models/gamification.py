from enum import Enum
from typing import List, Optional
from datetime import date
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator

# --- Gamification Stats ---
class GamificationStatsResponse(BaseModel):
    userId: str
    totalXp: int = 0
    currentStreak: int = 0
    longestStreak: int = 0
    lastCheckInDate: Optional[date] = None
    checkedInToday: bool = False
    rank: str
    nextRank: Optional[str] = None
    xpToNextRank: Optional[int] = None

# --- Daily Check-ins ---
class DailyCheckInCreate(BaseModel):
    """Subjective metrics on a 1 (low) to 5 (high) scale."""
    muscleFatigue: int = Field(ge=1, le=5)
    mood: int = Field(ge=1, le=5)
    dietAdherence: int = Field(ge=1, le=5)

class DailyCheckInResponse(BaseModel):
    checkInId: str
    date: date
    xpAwarded: int
    currentStreak: int
    totalXp: int
    rank: str

# --- Leaderboard ---
class LeaderboardMetric(str, Enum):
    XP = "xp"
    STREAK = "streak"

class LeaderboardEntry(BaseModel):
    position: int
    userId: str
    totalXp: int
    currentStreak: int
    rank: str
    isCurrentUser: bool

class LeaderboardResponse(BaseModel):
    metric: LeaderboardMetric
    entries: List[LeaderboardEntry]

# --- Challenges ---
class ChallengeMetric(str, Enum):
    """sessions: workouts logged; checkin_streak: longest run of consecutive check-in days;
    xp: XP earned. All are counted only between startDate and endDate inclusive."""
    SESSIONS = "sessions"
    CHECKIN_STREAK = "checkin_streak"
    XP = "xp"

class ChallengeCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=100)
    metric: ChallengeMetric
    targetValue: int = Field(ge=1, le=100000)
    startDate: date
    endDate: date
    inviteeIds: List[UUID] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check_dates(self) -> "ChallengeCreate":
        if self.endDate < self.startDate:
            raise ValueError("endDate must be on or after startDate")
        return self

class ChallengeResponseCreate(BaseModel):
    accept: bool

class ChallengeParticipant(BaseModel):
    userId: str
    status: str
    progress: int
    completed: bool
    isCurrentUser: bool

class Challenge(BaseModel):
    id: str
    creatorId: str
    title: str
    metric: ChallengeMetric
    targetValue: int
    startDate: date
    endDate: date
    status: str
    myStatus: str
    participants: List[ChallengeParticipant]

class ChallengeListResponse(BaseModel):
    challenges: List[Challenge]

from typing import Optional
from datetime import date, datetime
from pydantic import BaseModel

# --- Gamification Stats ---
class GamificationStatsBase(BaseModel):
    currentXP: int = 0
    loginStreak: int = 0
    currentRank: str = "Beginner"

class GamificationStatsResponse(GamificationStatsBase):
    userId: str
    updatedAt: datetime

    class Config:
        from_attributes = True

# --- Daily Check-ins ---
class DailyCheckInResponse(BaseModel):
    checkInId: str
    userId: str
    date: date
    createdAt: datetime

    class Config:
        from_attributes = True
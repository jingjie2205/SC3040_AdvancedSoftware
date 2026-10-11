from enum import Enum
from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel

class IntensityLevel(str, Enum):
    LIGHT = "LIGHT"
    MODERATE = "MODERATE"
    HARD = "HARD"
    INTENSE = "INTENSE"
    MAXIMUM = "MAXIMUM"

class SessionStatus(str, Enum):
    SCHEDULED = "SCHEDULED"
    COMPLETED = "COMPLETED"
    SKIPPED = "SKIPPED"
    SWAPPED = "SWAPPED"

# --- Exercises ---
class ExerciseBase(BaseModel):
    exerciseName: str
    repetitions: Optional[int] = None
    sets: Optional[int] = None
    intensity: Optional[IntensityLevel] = None
    duration: Optional[int] = None 

class ExerciseResponse(ExerciseBase):
    exerciseId: str
    sessionId: str
    createdAt: datetime

    class Config:
        from_attributes = True

# --- Workout Sessions ---
class WorkoutSessionBase(BaseModel):
    scheduledDate: datetime
    intensity: Optional[IntensityLevel] = None
    status: SessionStatus = SessionStatus.SCHEDULED

class WorkoutSessionResponse(WorkoutSessionBase):
    sessionId: str
    planId: str
    createdAt: datetime
    exercises: List[ExerciseResponse] = []

    class Config:
        from_attributes = True

# --- Training Plans ---
class TrainingPlanBase(BaseModel):
    startDate: datetime
    endDate: datetime
    targetFrequency: Optional[int] = None
    preferredDuration: Optional[int] = None

class TrainingPlanResponse(TrainingPlanBase):
    planId: str
    userId: str
    createdAt: datetime
    schedules: List[WorkoutSessionResponse] = []

    class Config:
        from_attributes = True

class PlannedSessionInput(BaseModel):
    date: date
    activity_type: ActivityType
    target_duration_min: int = Field(ge=5, le=360)
    intensity_band: IntensityBand = "light"
    target_volume: Optional[int] = None
    notes: Optional[str] = None
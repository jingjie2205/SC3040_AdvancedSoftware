"""
API and domain models. Field names are snake_case in Python and camelCase on the wire
(matching frontend/lib/training/types.ts). Models never carry a user id: the repository
attaches it on write and drops it on read, so a row can't leak another user's id or be
built for the wrong user by accident.
"""
from datetime import date, datetime
from typing import Dict, List, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .config import RULES

ActivityType = Literal["run", "gym", "cycling", "bodyweight"]
Goal = Literal["lose_weight", "maintain", "build_muscle"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
IntensityBand = Literal["deload", "light", "push"]
SessionStatus = Literal["planned", "accepted", "completed", "partial", "missed", "moved"]
WorkoutSource = Literal["manual", "import", "strava"]

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# --------------------------------------------------------------------------- preferences


class TrainingPreferencesInput(ApiModel):
    days_per_week: int = Field(ge=RULES.days_per_week_min, le=RULES.days_per_week_max)
    session_duration_min: int = Field(
        ge=RULES.session_duration_min, le=RULES.session_duration_max
    )
    activity_types: List[ActivityType] = Field(min_length=1)
    rest_days: List[Weekday] = Field(default_factory=list)
    # Upcoming exams, which weigh on readiness in the days before one. Optional, and private to the user.
    exam_dates: List[date] = Field(default_factory=list, max_length=RULES.exam_dates_max)

    @field_validator("exam_dates")
    @classmethod
    def _sorted_unique_exam_dates(cls, value: list) -> list:
        return sorted(set(value))

    @field_validator("activity_types")
    @classmethod
    def _dedupe_activity_types(cls, value: list) -> list:
        return list(dict.fromkeys(value))

    @field_validator("rest_days")
    @classmethod
    def _enough_free_days(cls, value: list, info: ValidationInfo) -> list:
        rest_days = list(dict.fromkeys(value))
        days_per_week = info.data.get("days_per_week")
        free_days = 7 - len(rest_days)
        if days_per_week is not None and free_days < days_per_week:
            raise ValueError(
                f"Only {free_days} day(s) are free, but you want {days_per_week} training days"
            )
        return rest_days


class TrainingPreferences(TrainingPreferencesInput):
    updated_at: datetime


# --------------------------------------------------------------------------- plan


class PlanAdaptation(ApiModel):
    trigger: Literal["missed_sessions", "low_readiness", "manual"]
    reason: str
    adapted_at: datetime
    # The user's local date when it happened. Sessions live in the user's calendar, so "since the
    # last adaptation" is measured in that, not in the server's UTC date.
    adapted_on: date
    acknowledged: bool = False


class TrainingPlan(ApiModel):
    id: str
    start_date: date
    end_date: date
    weeks: int
    status: Literal["active", "superseded"]
    baseline_volume: float
    created_at: datetime
    notice: str
    # The profile goal this plan was built for, as it stood when it was generated or last adapted.
    goal: Optional[Goal] = None
    last_adaptation: Optional[PlanAdaptation] = None


class PlannedSession(ApiModel):
    id: str
    plan_id: str
    date: date
    activity_type: ActivityType
    target_volume: int
    target_duration_min: int
    intensity_band: IntensityBand
    status: SessionStatus


class WorkoutSession(ApiModel):
    id: str
    planned_session_id: Optional[str] = None
    date: date
    activity_type: ActivityType
    actual_volume: float
    actual_duration_min: int
    rpe: Optional[int] = None
    avg_hr: Optional[int] = None
    source: WorkoutSource = "manual"
    created_at: datetime


# --------------------------------------------------------------------------- readiness


class ReadinessFactor(ApiModel):
    key: str
    label: str
    impact: Literal["positive", "negative", "neutral"]
    detail: str


class ScoreResult(ApiModel):
    score: int = Field(ge=0, le=100)
    classification: IntensityBand
    factors: List[ReadinessFactor]
    explanation: str


class ModelInfo(ApiModel):
    """Which scorer is producing readiness scores, and how much to trust it. Holds no user data."""

    kind: Literal["model", "rules"]
    version: str
    description: str
    trained_on: Optional[str] = None
    metrics: Dict[str, float] = Field(default_factory=dict)
    fallback_reason: Optional[str] = None


class ReadinessScore(ScoreResult):
    date: date
    computed_at: datetime


class SessionRecommendation(ApiModel):
    activity_type: ActivityType
    intensity_band: IntensityBand
    target_volume: int
    target_duration_min: int
    downgraded: bool
    explanation: str


# --------------------------------------------------------------------------- responses


class TodayView(ApiModel):
    date: date
    readiness: ReadinessScore
    planned: Optional[PlannedSession] = None
    recommendation: Optional[SessionRecommendation] = None
    logged: Optional[WorkoutSession] = None
    # Last night's sleep as the user entered it today, so the readiness card can show it.
    sleep_hours: Optional[float] = None


class Schedule(ApiModel):
    sessions: List[PlannedSession]
    workouts: List[WorkoutSession]


class RemoveResult(ApiModel):
    redistributed_count: int


class LogResult(ApiModel):
    workout: WorkoutSession
    session: Optional[PlannedSession] = None


class SleepEntry(ApiModel):
    date: date
    hours: float


# --------------------------------------------------------------------------- requests


class GeneratePlanRequest(ApiModel):
    weeks: int = Field(ge=RULES.plan_weeks_min, le=RULES.plan_weeks_max)
    confirm_replace: bool = False


class RescheduleRequest(ApiModel):
    date: date


class SessionResponseRequest(ApiModel):
    action: Literal["accept", "swap", "skip"]
    activity_type: Optional[ActivityType] = None

    @model_validator(mode="after")
    def _swap_needs_activity(self) -> "SessionResponseRequest":
        if self.action == "swap" and self.activity_type is None:
            raise ValueError("Choose an activity type to swap to")
        return self


class SleepInput(ApiModel):
    hours: float = Field(ge=0, le=RULES.sleep_hours_max)


class LogWorkoutInput(ApiModel):
    date: date
    activity_type: ActivityType
    actual_duration_min: int = Field(ge=1, le=RULES.workout_duration_max)
    actual_volume: float = Field(gt=0, le=RULES.workout_volume_max)
    rpe: Optional[int] = Field(default=None, ge=RULES.workout_rpe_min, le=RULES.workout_rpe_max)
    avg_hr: Optional[int] = Field(default=None, ge=RULES.workout_hr_min, le=RULES.workout_hr_max)

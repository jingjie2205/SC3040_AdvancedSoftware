"""In-memory stand-ins for the database, faithful to what the real one enforces."""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from app.training.models import (
    PlannedSession,
    ReadinessScore,
    TrainingPlan,
    TrainingPreferences,
    TrainingPreferencesInput,
    WorkoutSession,
    WorkoutSource,
)
from app.training.planner import AthleteProfile
from app.training.readiness import Checkin
from app.training.repository import ChangeSet

# A Wednesday, so the current week has days before and after "today".
TODAY = date(2026, 9, 30)
USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"

STANDARD_PREFS = TrainingPreferencesInput(
    days_per_week=4,
    session_duration_min=45,
    activity_types=["run", "gym", "cycling"],
    rest_days=["tue", "thu", "sun"],
)


class ConstraintViolation(Exception):
    pass


class FakeTrainingRepository:
    """
    Every read and write is scoped to a user, like the real repository. `apply` is all-or-nothing and
    enforces the same constraints as the SQL function: one session per user per day, one active plan
    per user, and no writing over another user's rows.
    """

    def __init__(self) -> None:
        self.preferences: Dict[str, TrainingPreferences] = {}
        self.plans: Dict[str, Tuple[str, TrainingPlan]] = {}
        self.sessions: Dict[str, Tuple[str, PlannedSession]] = {}
        self.workouts: Dict[str, Tuple[str, WorkoutSession]] = {}
        self.readiness: Dict[Tuple[str, date], Tuple[ReadinessScore, str]] = {}
        self.checkins: Dict[str, Checkin] = {}
        self.profiles: Dict[str, AthleteProfile] = {}
        self.apply_calls = 0

    # ---------------------------------------------------------------- reads

    def get_preferences(self, user_id: str) -> Optional[TrainingPreferences]:
        return deepcopy(self.preferences.get(user_id))

    def save_preferences(self, user_id: str, preferences: TrainingPreferences) -> None:
        self.preferences[user_id] = deepcopy(preferences)

    def get_active_plan(self, user_id: str) -> Optional[TrainingPlan]:
        for owner, plan in self.plans.values():
            if owner == user_id and plan.status == "active":
                return deepcopy(plan)
        return None

    def list_sessions(self, user_id: str, start: date, end: date) -> List[PlannedSession]:
        found = [s for o, s in self.sessions.values() if o == user_id and start <= s.date <= end]
        return deepcopy(sorted(found, key=lambda s: s.date))

    def get_session(self, user_id: str, session_id: str) -> Optional[PlannedSession]:
        entry = self.sessions.get(session_id)
        return deepcopy(entry[1]) if entry and entry[0] == user_id else None

    def list_workouts(self, user_id: str, start: date, end: date) -> List[WorkoutSession]:
        found = [w for o, w in self.workouts.values() if o == user_id and start <= w.date <= end]
        return deepcopy(sorted(found, key=lambda w: w.date))

    def get_workout_for_session(self, user_id: str, session_id: str) -> Optional[WorkoutSession]:
        for owner, workout in self.workouts.values():
            if owner == user_id and workout.planned_session_id == session_id:
                return deepcopy(workout)
        return None

    def get_profile(self, user_id: str) -> Optional[AthleteProfile]:
        return self.profiles.get(user_id)

    def get_latest_checkin(self, user_id: str, on_or_before: date) -> Optional[Checkin]:
        return self.checkins.get(user_id)

    def get_cached_readiness(
        self, user_id: str, day: date
    ) -> Optional[Tuple[ReadinessScore, str]]:
        return deepcopy(self.readiness.get((user_id, day)))

    def save_readiness(self, user_id: str, score: ReadinessScore, feature_hash: str) -> None:
        self.readiness[(user_id, score.date)] = (deepcopy(score), feature_hash)

    def list_readiness(self, user_id: str, start: date, end: date) -> List[ReadinessScore]:
        return [
            deepcopy(s) for (owner, day), (s, _) in self.readiness.items()
            if owner == user_id and start <= day <= end
        ]

    # ---------------------------------------------------------------- writes

    def apply(self, user_id: str, changes: ChangeSet) -> None:
        self.apply_calls += 1
        snapshot = (deepcopy(self.plans), deepcopy(self.sessions), deepcopy(self.workouts))
        try:
            self._apply(user_id, changes)
        except Exception:
            self.plans, self.sessions, self.workouts = snapshot
            raise

    def _apply(self, user_id: str, changes: ChangeSet) -> None:
        if changes.supersede_active_plan:
            for pid, (owner, plan) in list(self.plans.items()):
                if owner == user_id and plan.status == "active":
                    self.plans[pid] = (owner, plan.model_copy(update={"status": "superseded"}))

        for sid in changes.delete_session_ids:
            if sid in self.sessions and self.sessions[sid][0] == user_id:
                del self.sessions[sid]

        for plan in changes.upsert_plans:
            existing = self.plans.get(plan.id)
            if existing and existing[0] != user_id:
                continue
            self.plans[plan.id] = (user_id, deepcopy(plan))
        active = [p for o, p in self.plans.values() if o == user_id and p.status == "active"]
        if len(active) > 1:
            raise ConstraintViolation("one active plan per user")

        for session in changes.upsert_sessions:
            existing = self.sessions.get(session.id)
            if existing and existing[0] != user_id:
                continue
            self.sessions[session.id] = (user_id, deepcopy(session))
        days = [s.date for o, s in self.sessions.values() if o == user_id]
        if len(days) != len(set(days)):
            raise ConstraintViolation("one planned session per user per day")

        for workout in changes.insert_workouts:
            if workout.planned_session_id and workout.planned_session_id not in self.sessions:
                raise ConstraintViolation("workout references an unknown session")
            self.workouts[workout.id] = (user_id, deepcopy(workout))


def workout(day: date, volume: float = 30, avg_hr: Optional[int] = None,
            source: WorkoutSource = "manual", planned_session_id: Optional[str] = None,
            wid: Optional[str] = None) -> WorkoutSession:
    return WorkoutSession(
        id=wid or f"w-{day.isoformat()}-{source}-{volume}",
        planned_session_id=planned_session_id,
        date=day,
        activity_type="run",
        actual_volume=volume,
        actual_duration_min=int(volume),
        avg_hr=avg_hr,
        source=source,
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def seed_history(repo: FakeTrainingRepository, user_id: str, weeks_before: date, weeks: int = 4,
                 volume_per_session: float = 33) -> None:
    """Three logged sessions a week for `weeks` weeks ending just before `weeks_before` (a Monday)."""
    for week in range(1, weeks + 1):
        monday = weeks_before - timedelta(days=7 * week)
        for offset in (0, 2, 5):
            w = workout(monday + timedelta(days=offset), volume_per_session)
            repo.workouts[w.id] = (user_id, w)

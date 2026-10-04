"""
Data access for the training routine.

The backend talks to Supabase with the service-role key, which bypasses row-level security. So the
scoping is done here: every query names the user explicitly, and nothing accepts a user id from a
request body. All writes that touch more than one row go through one `ChangeSet`, applied by a
single Postgres function in one transaction, so a failure never leaves a partial write.
"""
import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional, Protocol, Tuple

from postgrest.exceptions import APIError
from supabase import Client

from ..commons.auth.deps import get_supabase_admin
from .models import (
    PlannedSession,
    ReadinessScore,
    TrainingPlan,
    TrainingPreferences,
    WorkoutSession,
)
from .planner import AthleteProfile
from .readiness import Checkin


logger = logging.getLogger(__name__)

# Postgres and PostgREST codes for "that table or column doesn't exist (yet)".
_SCHEMA_NOT_READY = {"42P01", "42703", "PGRST204", "PGRST205"}


@dataclass
class ChangeSet:
    """Everything one operation wants to write. Applied atomically or not at all."""

    supersede_active_plan: bool = False
    delete_session_ids: List[str] = field(default_factory=list)
    upsert_plans: List[TrainingPlan] = field(default_factory=list)
    upsert_sessions: List[PlannedSession] = field(default_factory=list)
    insert_workouts: List[WorkoutSession] = field(default_factory=list)


class TrainingRepository(Protocol):
    def get_preferences(self, user_id: str) -> Optional[TrainingPreferences]: ...

    def save_preferences(self, user_id: str, preferences: TrainingPreferences) -> None: ...

    def get_active_plan(self, user_id: str) -> Optional[TrainingPlan]: ...

    def list_sessions(self, user_id: str, start: date, end: date) -> List[PlannedSession]: ...

    def get_session(self, user_id: str, session_id: str) -> Optional[PlannedSession]: ...

    def list_workouts(self, user_id: str, start: date, end: date) -> List[WorkoutSession]: ...

    def get_workout_for_session(
        self, user_id: str, session_id: str
    ) -> Optional[WorkoutSession]: ...

    def get_profile(self, user_id: str) -> Optional[AthleteProfile]: ...

    def get_latest_checkin(self, user_id: str, on_or_before: date) -> Optional[Checkin]: ...

    def get_cached_readiness(
        self, user_id: str, day: date
    ) -> Optional[Tuple[ReadinessScore, str]]: ...

    def save_readiness(self, user_id: str, score: ReadinessScore, feature_hash: str) -> None: ...

    def list_readiness(self, user_id: str, start: date, end: date) -> List[ReadinessScore]: ...

    def apply(self, user_id: str, changes: ChangeSet) -> None: ...


def changes_payload(changes: ChangeSet) -> Dict[str, Any]:
    """JSON for the `training_apply_changes` function. Rows carry no user id; the function adds it."""
    return {
        "supersede_active_plan": changes.supersede_active_plan,
        "delete_session_ids": changes.delete_session_ids,
        "upsert_plans": [p.model_dump(mode="json") for p in changes.upsert_plans],
        "upsert_sessions": [s.model_dump(mode="json") for s in changes.upsert_sessions],
        "insert_workouts": [w.model_dump(mode="json") for w in changes.insert_workouts],
    }


class SupabaseTrainingRepository:
    def __init__(self, client: Client) -> None:
        self.db = client

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _rows(query: Any) -> List[Dict[str, Any]]:
        return query.execute().data or []

    def _first(self, query: Any) -> Optional[Dict[str, Any]]:
        rows = self._rows(query.limit(1))
        return rows[0] if rows else None

    @staticmethod
    def _range(query: Any, start: date, end: date) -> Any:
        return query.gte("date", start.isoformat()).lte("date", end.isoformat()).order("date")

    # ------------------------------------------------------------------ preferences

    def get_preferences(self, user_id: str) -> Optional[TrainingPreferences]:
        row = self._first(self.db.table("training_preferences").select("*").eq("user_id", user_id))
        return TrainingPreferences.model_validate(row) if row else None

    def save_preferences(self, user_id: str, preferences: TrainingPreferences) -> None:
        row = {"user_id": user_id, **preferences.model_dump(mode="json")}
        self.db.table("training_preferences").upsert(row, on_conflict="user_id").execute()

    # ------------------------------------------------------------------ plan and sessions

    def get_active_plan(self, user_id: str) -> Optional[TrainingPlan]:
        row = self._first(
            self.db.table("training_plans").select("*").eq("user_id", user_id).eq("status", "active")
        )
        return TrainingPlan.model_validate(row) if row else None

    def list_sessions(self, user_id: str, start: date, end: date) -> List[PlannedSession]:
        query = self.db.table("planned_sessions").select("*").eq("user_id", user_id)
        return [PlannedSession.model_validate(r) for r in self._rows(self._range(query, start, end))]

    def get_session(self, user_id: str, session_id: str) -> Optional[PlannedSession]:
        row = self._first(
            self.db.table("planned_sessions").select("*").eq("user_id", user_id).eq("id", session_id)
        )
        return PlannedSession.model_validate(row) if row else None

    def list_workouts(self, user_id: str, start: date, end: date) -> List[WorkoutSession]:
        query = self.db.table("workout_sessions").select("*").eq("user_id", user_id)
        return [WorkoutSession.model_validate(r) for r in self._rows(self._range(query, start, end))]

    def get_workout_for_session(self, user_id: str, session_id: str) -> Optional[WorkoutSession]:
        row = self._first(
            self.db.table("workout_sessions")
            .select("*")
            .eq("user_id", user_id)
            .eq("planned_session_id", session_id)
        )
        return WorkoutSession.model_validate(row) if row else None

    # ------------------------------------------------------------------ profile

    def get_profile(self, user_id: str) -> Optional[AthleteProfile]:
        # The profile is the Settings page's `users` table, which also holds the Strava tokens, so
        # ask for the one column this feature uses and nothing else.
        try:
            row = self._first(self.db.table("users").select("activity_level").eq("user_id", user_id))
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            # The table or column isn't there (yet). Plans fall back to the default baseline.
            logger.warning("Profile not readable (%s); using the default baseline", error.code)
            return None
        return AthleteProfile(activity_level=row.get("activity_level")) if row else None

    # ------------------------------------------------------------------ readiness

    def get_latest_checkin(self, user_id: str, on_or_before: date) -> Optional[Checkin]:
        # `daily_checkins` is owned by the Home page and doesn't exist yet. Until it does there is
        # no check-in to read, and the scorer simply leaves those signals out.
        return None

    def get_cached_readiness(
        self, user_id: str, day: date
    ) -> Optional[Tuple[ReadinessScore, str]]:
        row = self._first(
            self.db.table("readiness_scores")
            .select("*")
            .eq("user_id", user_id)
            .eq("date", day.isoformat())
        )
        if not row:
            return None
        return ReadinessScore.model_validate(row), row["feature_hash"]

    def save_readiness(self, user_id: str, score: ReadinessScore, feature_hash: str) -> None:
        row = {"user_id": user_id, "feature_hash": feature_hash, **score.model_dump(mode="json")}
        self.db.table("readiness_scores").upsert(row, on_conflict="user_id,date").execute()

    def list_readiness(self, user_id: str, start: date, end: date) -> List[ReadinessScore]:
        query = self.db.table("readiness_scores").select("*").eq("user_id", user_id)
        return [ReadinessScore.model_validate(r) for r in self._rows(self._range(query, start, end))]

    # ------------------------------------------------------------------ writes

    def apply(self, user_id: str, changes: ChangeSet) -> None:
        self.db.rpc(
            "training_apply_changes",
            {"p_user_id": user_id, "p_changes": changes_payload(changes)},
        ).execute()


def create_repository() -> SupabaseTrainingRepository:
    return SupabaseTrainingRepository(get_supabase_admin())

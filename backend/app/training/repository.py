"""
Data access for the training routine.

The backend talks to Supabase with the service-role key, which bypasses row-level security. So the
scoping is done here: every query names the user explicitly, and nothing accepts a user id from a
request body. All writes that touch more than one row go through one `ChangeSet`, applied by a
single Postgres function in one transaction, so a failure never leaves a partial write.
"""
import logging
import threading
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional, Protocol, Set, Tuple

from postgrest.exceptions import APIError
from supabase import Client

from ..commons.auth.deps import get_supabase_admin
from .errors import TrainingError
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

# The check-in questionnaire dates a check-in with a fixed UTC+8 day, while "today" here is the
# user's own local date. For someone west of Singapore a check-in made this evening can be dated
# tomorrow, so look one day ahead.
_CHECKIN_DATE_SKEW_DAYS = 1

_warned: Set[str] = set()


def _warn_once(key: str, message: str, *args: Any) -> None:
    """Readiness and plans are read on every page load, so say a missing table once, not every time."""
    if key not in _warned:
        _warned.add(key)
        logger.warning(message, *args)


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

    def get_sleep(self, user_id: str, day: date) -> Optional[float]: ...

    def save_sleep(self, user_id: str, day: date, hours: float) -> None: ...

    def delete_sleep(self, user_id: str, day: date) -> None: ...

    def get_cached_readiness(
        self, user_id: str, day: date
    ) -> Optional[Tuple[ReadinessScore, str]]: ...

    def award_workout_xp(self, user_id: str, workout_id: str) -> None: ...

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
        try:
            self.db.table("training_preferences").upsert(row, on_conflict="user_id").execute()
        except APIError as error:
            # A database that hasn't had the exam-dates migration yet must still be able to save the
            # rest of the form, which is the first thing a new user does. But dates the user typed are
            # never dropped quietly (the form would say "saved" and they would vanish): those are refused.
            if error.code not in _SCHEMA_NOT_READY or "exam_dates" not in str(error.message):
                raise
            if preferences.exam_dates:
                raise TrainingError(
                    "UNAVAILABLE",
                    "Exam dates aren't set up on this database yet. Apply the latest training migration, "
                    "or save without exam dates.",
                ) from error
            _warn_once("exam-dates", "training_preferences has no exam_dates column; saving without exam dates")
            row.pop("exam_dates", None)
            self.db.table("training_preferences").upsert(row, on_conflict="user_id").execute()

    # ------------------------------------------------------------------ plan and sessions

    def get_active_plan(self, user_id: str) -> Optional[TrainingPlan]:
        row = self._first(
            self.db.table("training_routine_plans").select("*").eq("user_id", user_id).eq("status", "active")
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
        query = self.db.table("training_workout_logs").select("*").eq("user_id", user_id)
        return [WorkoutSession.model_validate(r) for r in self._rows(self._range(query, start, end))]

    def get_workout_for_session(self, user_id: str, session_id: str) -> Optional[WorkoutSession]:
        row = self._first(
            self.db.table("training_workout_logs")
            .select("*")
            .eq("user_id", user_id)
            .eq("planned_session_id", session_id)
        )
        return WorkoutSession.model_validate(row) if row else None

    # ------------------------------------------------------------------ profile

    def get_profile(self, user_id: str) -> Optional[AthleteProfile]:
        # The profile is the Settings page's `users` table, which also holds the Strava tokens and a
        # password hash, so ask for the two columns this feature uses and nothing else.
        try:
            row = self._first(
                self.db.table("users").select("activity_level,fitness_goal").eq("user_id", user_id)
            )
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            # The table or a column isn't there (yet). Plans fall back to the default baseline and an even mix.
            _warn_once(f"profile:{error.code}", "Profile not readable (%s); using plan defaults", error.code)
            return None
        if not row:
            return None
        return AthleteProfile(activity_level=row.get("activity_level"), fitness_goal=row.get("fitness_goal"))

    # ------------------------------------------------------------------ readiness

    def get_latest_checkin(self, user_id: str, on_or_before: date) -> Optional[Checkin]:
        # `daily_checkins` is the gamification questionnaire. Only the muscle soreness answer is read,
        # never mood or diet, and only for this user. Whether it is recent enough to count is decided
        # when the features are built, not here. There is no sleep answer, so sleep stays unknown.
        newest = on_or_before + timedelta(days=_CHECKIN_DATE_SKEW_DAYS)
        try:
            row = self._first(
                self.db.table("daily_checkins")
                .select("date,muscle_fatigue")
                .eq("user_id", user_id)
                .lte("date", newest.isoformat())
                .order("date", desc=True)
            )
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            # The table isn't there (yet), so there is no check-in and the signal is left out.
            _warn_once(f"checkin:{error.code}", "Check-ins not readable (%s); scoring without them", error.code)
            return None
        if not row:
            return None
        rating = row.get("muscle_fatigue")
        if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 5:
            _warn_once("checkin:bad-rating", "Ignoring a check-in whose muscle_fatigue is %r", rating)
            return None
        return Checkin(load_rating=rating, sleep_hours=None, day=date.fromisoformat(str(row["date"])[:10]))

    # Last night's sleep, entered on the Today card. Private to the user like the score it feeds.

    def get_sleep(self, user_id: str, day: date) -> Optional[float]:
        try:
            row = self._first(
                self.db.table("training_sleep_logs")
                .select("hours")
                .eq("user_id", user_id)
                .eq("date", day.isoformat())
            )
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            _warn_once(f"sleep:{error.code}", "Sleep log not readable (%s); scoring without it", error.code)
            return None
        return float(row["hours"]) if row and row.get("hours") is not None else None

    def save_sleep(self, user_id: str, day: date, hours: float) -> None:
        row = {"user_id": user_id, "date": day.isoformat(), "hours": hours}
        self._sleep_write(lambda: self.db.table("training_sleep_logs").upsert(row, on_conflict="user_id,date").execute())

    def delete_sleep(self, user_id: str, day: date) -> None:
        self._sleep_write(
            lambda: self.db.table("training_sleep_logs")
            .delete()
            .eq("user_id", user_id)
            .eq("date", day.isoformat())
            .execute()
        )

    @staticmethod
    def _sleep_write(write: Any) -> None:
        try:
            write()
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            raise TrainingError(
                "UNAVAILABLE",
                "Sleep tracking isn't set up on this database yet. Apply the latest training migration first.",
            ) from error

    # ------------------------------------------------------------------ leaderboard XP

    def award_workout_xp(self, user_id: str, workout_id: str) -> None:
        """
        A logged workout earns XP on the leaderboard, through the helper the gamification feature
        provides for other features. It ignores the same workout twice, so a retry is harmless. The
        leaderboard's tables may not be on the database yet, in which case there is nothing to award
        and one warning is logged.
        """
        from ..services.gamification import XP_REWARDS, award_xp  # not at import time: keeps this package standalone

        try:
            award_xp(self.db, user_id, "workout", XP_REWARDS["workout"], workout_id)
        except APIError as error:
            if error.code not in _SCHEMA_NOT_READY:
                raise
            _warn_once(f"xp:{error.code}", "Leaderboard tables not ready (%s); workout XP not awarded", error.code)

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


class ThreadLocalClient:
    """
    A Supabase client for each worker thread, behind the one name the repository uses.

    Requests run on a thread pool, and the client's HTTP/2 connection can't be shared between threads: each
    thread's reads and writes change the one socket's timeout under the others. Against the live project about
    one call in six then failed with `ReadError` (WinError 10035 on Windows), and the training page, which
    loads two or three endpoints at once, hit it on its first load. A client per thread keeps the connection
    reuse and removes the sharing.
    """

    def __init__(self, factory: Callable[[], Client]) -> None:
        self._factory = factory
        self._local = threading.local()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):  # never build a client for a private or special lookup
            raise AttributeError(name)
        client = getattr(self._local, "client", None)
        if client is None:
            client = self._local.client = self._factory()
        return getattr(client, name)


def create_repository() -> SupabaseTrainingRepository:
    return SupabaseTrainingRepository(ThreadLocalClient(get_supabase_admin))

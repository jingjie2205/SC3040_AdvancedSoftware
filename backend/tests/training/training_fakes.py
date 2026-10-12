"""In-memory stand-ins for the database, faithful to what the real one enforces."""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Callable, Dict, List, Optional, Tuple

from postgrest.exceptions import APIError

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
        self.sleep: Dict[Tuple[str, date], float] = {}
        self.xp_awards: List[Tuple[str, str]] = []  # what the leaderboard ends up with: a repeat counts once
        self.xp_calls: List[Tuple[str, str]] = []  # every call made, so a double call can't hide behind that
        self.xp_error: Optional[Exception] = None
        self.apply_calls = 0
        self.progression_supported = True  # False behaves like a database the progression migration hasn't reached

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

    def get_sleep(self, user_id: str, day: date) -> Optional[float]:
        return self.sleep.get((user_id, day))

    def save_sleep(self, user_id: str, day: date, hours: float) -> None:
        self.sleep[(user_id, day)] = hours

    def delete_sleep(self, user_id: str, day: date) -> None:
        self.sleep.pop((user_id, day), None)

    def award_workout_xp(self, user_id: str, workout_id: str) -> None:
        self.xp_calls.append((user_id, workout_id))
        if self.xp_error:
            raise self.xp_error
        if (user_id, workout_id) not in self.xp_awards:  # the real helper ignores a repeat
            self.xp_awards.append((user_id, workout_id))

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

    def supports_plan_progression(self) -> bool:
        return self.progression_supported

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


class FilteringQuery:
    """
    Applies what PostgREST would: filters, ordering, limit and column projection for reads, and
    upserts (merged on the conflict columns) and deletes (limited by the filters) for writes.
    """

    def __init__(self, client, table):
        self.client, self.table = client, table
        self.columns, self.filters, self.order_by, self.max_rows = "*", [], None, None
        self.operation, self.payload, self.on_conflict = "select", None, None

    def select(self, columns="*"):
        self.columns = columns
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def gte(self, column, value):
        self.filters.append(("gte", column, value))
        return self

    def lte(self, column, value):
        self.filters.append(("lte", column, value))
        return self

    def order(self, column, desc=False):
        self.order_by = (column, desc)
        return self

    def limit(self, count):
        self.max_rows = count
        return self

    def upsert(self, row, on_conflict=None, ignore_duplicates=False):
        # PostgREST takes one row or a list of them; "ignore duplicates" leaves a clashing row exactly as it was
        payload = [dict(r) for r in row] if isinstance(row, list) else dict(row)
        self.operation, self.payload, self.on_conflict = "upsert", payload, on_conflict
        self.ignore_duplicates = ignore_duplicates
        return self

    def insert(self, row):
        self.operation, self.payload = "insert", dict(row)
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def _matching(self, rows):
        for op, column, value in self.filters:
            rows = [
                r for r in rows
                if (op == "eq" and r[column] == value)
                or (op == "gte" and r[column] >= value)
                or (op == "lte" and r[column] <= value)
            ]
        return rows

    def execute(self):
        self.client.requests.append(self)
        failure = self.client.error or (self.client.error_when(self) if self.client.error_when else None)
        if failure:
            raise failure
        stored = self.client.tables.setdefault(self.table, [])
        if self.operation == "insert":
            keys = self.client.unique.get(self.table, ())
            if keys and any(all(row.get(k) == self.payload.get(k) for k in keys) for row in stored):
                raise APIError({"message": "duplicate key value violates unique constraint", "code": "23505",
                                "hint": None, "details": None})
            stored.append(dict(self.payload))
            return SimpleNamespace(data=[dict(self.payload)])
        if self.operation == "upsert":
            keys = [c.strip() for c in (self.on_conflict or "").split(",") if c.strip()]
            incoming = self.payload if isinstance(self.payload, list) else [self.payload]
            for row in incoming:
                for existing in stored:
                    if keys and all(existing.get(k) == row.get(k) for k in keys):
                        if not getattr(self, "ignore_duplicates", False):
                            existing.update(row)
                        break
                else:
                    stored.append(dict(row))
            return SimpleNamespace(data=[dict(row) for row in incoming])
        if self.operation == "delete":
            doomed = self._matching([dict(r) for r in stored])
            stored[:] = [r for r in stored if r not in doomed]
            return SimpleNamespace(data=doomed)

        rows = self._matching([dict(row) for row in stored])
        if self.order_by:
            column, desc = self.order_by
            rows.sort(key=lambda r: r[column], reverse=desc)
        if self.max_rows is not None:
            rows = rows[: self.max_rows]
        if self.columns != "*":
            wanted = [c.strip() for c in self.columns.split(",")]
            rows = [{c: r[c] for c in wanted} for r in rows]
        return SimpleNamespace(data=rows)


class TableClient:
    """
    A stand-in Supabase client over in-memory tables. `error` fails every request; `error_when` is called
    with each request and may return an error to raise for just that one.
    """

    def __init__(self, tables=None, error=None, error_when: Optional[Callable] = None, unique=None):
        self.tables, self.error, self.error_when, self.requests = tables or {}, error, error_when, []
        self.unique = unique or {}  # table -> the columns that must be unique, like the real schema

    def table(self, name):
        return FilteringQuery(self, name)

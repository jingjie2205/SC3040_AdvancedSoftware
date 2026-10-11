from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from postgrest.exceptions import APIError

from app.training import repository
from app.training.errors import TrainingError
from app.training.models import (
    PlannedSession,
    ReadinessFactor,
    ReadinessScore,
    TrainingPlan,
    TrainingPreferences,
    WorkoutSession,
)
from app.training.planner import AthleteProfile
from app.training.repository import ChangeSet, SupabaseTrainingRepository, changes_payload
from training_fakes import USER_A

DAY = date(2026, 10, 1)
NOW = datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc)


class RecordedQuery:
    def __init__(self, recorder, table):
        self.recorder, self.table_name = recorder, table
        self.filters, self.operation, self.payload, self.kwargs = [], "select", None, {}
        self.selected = ()

    def select(self, *columns):
        self.selected = columns
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

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_):
        return self

    def upsert(self, row, **kwargs):
        self.operation, self.payload, self.kwargs = "upsert", row, kwargs
        return self

    def execute(self):
        self.recorder.queries.append(self)
        if self.recorder.error:
            raise self.recorder.error
        return SimpleNamespace(data=self.recorder.rows.get(self.table_name, []))


class RecordingClient:
    """Stands in for the supabase client and remembers exactly what was asked of it."""

    def __init__(self, rows=None):
        self.rows, self.queries, self.rpcs, self.error = rows or {}, [], [], None
        self.features = {"calories": True}  # what training_schema_features() answers on a migrated database

    def table(self, name):
        return RecordedQuery(self, name)

    def rpc(self, name, params):
        self.rpcs.append((name, params))
        if name == "training_schema_features":
            def ask():
                if self.error:
                    raise self.error
                return SimpleNamespace(data=self.features)
            return SimpleNamespace(execute=ask)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=None))


def repo_with(rows=None):
    client = RecordingClient(rows)
    return SupabaseTrainingRepository(client), client


# A row as Postgres returns it: snake_case, with a user_id the models don't know about.
SESSION_ROW = {"id": "s1", "user_id": USER_A, "plan_id": "p1", "date": "2026-10-01", "activity_type": "run",
               "target_volume": 32.0, "target_duration_min": 45, "intensity_band": "push", "status": "planned"}
WORKOUT_ROW = {"id": "w1", "user_id": USER_A, "planned_session_id": "s1", "date": "2026-10-01", "activity_type": "gym",
               "actual_volume": 25.5, "actual_duration_min": 40, "rpe": 6, "avg_hr": None, "source": "manual",
               "created_at": "2026-10-01T09:00:00+00:00"}
PLAN_ROW = {"id": "p1", "user_id": USER_A, "start_date": "2026-09-28", "end_date": "2026-11-22", "weeks": 8,
            "status": "active", "baseline_volume": 99.0, "notice": "n", "created_at": "2026-09-28T00:00:00+00:00",
            "last_adaptation": {"trigger": "manual", "reason": "r", "adapted_at": "2026-09-30T10:00:00+00:00",
                                "adapted_on": "2026-09-30", "acknowledged": False}}
PREFS_ROW = {"user_id": USER_A, "days_per_week": 4, "session_duration_min": 45, "activity_types": ["run"],
             "rest_days": ["sun"], "updated_at": "2026-09-30T10:00:00+00:00"}
READINESS_ROW = {"user_id": USER_A, "date": "2026-10-01", "score": 58, "classification": "light",
                 "factors": [{"key": "load", "label": "Training load", "impact": "negative", "detail": "d"}],
                 "explanation": "e", "feature_hash": "abc123", "computed_at": "2026-10-01T06:00:00+00:00"}


def scoped_to_user(query) -> bool:
    return ("eq", "user_id", USER_A) in query.filters


# ------------------------------------------------------------------ every read names the user


@pytest.mark.parametrize("call,table", [
    (lambda r: r.get_preferences(USER_A), "training_preferences"),
    (lambda r: r.get_active_plan(USER_A), "training_routine_plans"),
    (lambda r: r.list_sessions(USER_A, DAY, DAY), "planned_sessions"),
    (lambda r: r.get_session(USER_A, "s1"), "planned_sessions"),
    (lambda r: r.list_workouts(USER_A, DAY, DAY), "training_workout_logs"),
    (lambda r: r.get_workout_for_session(USER_A, "s1"), "training_workout_logs"),
    (lambda r: r.get_cached_readiness(USER_A, DAY), "readiness_scores"),
    (lambda r: r.list_readiness(USER_A, DAY, DAY), "readiness_scores"),
])
def test_every_read_is_scoped_to_the_user(call, table):
    repo, client = repo_with()
    call(repo)
    assert len(client.queries) == 1
    query = client.queries[0]
    assert query.table_name == table and scoped_to_user(query)


def test_lookups_by_id_also_filter_on_the_user():
    """An id alone must never be enough to read a row."""
    repo, client = repo_with()
    repo.get_session(USER_A, "someone-elses-id")
    repo.get_workout_for_session(USER_A, "someone-elses-id")
    for query in client.queries:
        assert scoped_to_user(query)
        assert any(f[1] in ("id", "planned_session_id") for f in query.filters)


def test_single_row_writes_carry_the_users_id():
    repo, client = repo_with()
    repo.save_preferences(USER_A, TrainingPreferences(
        days_per_week=3, session_duration_min=40, activity_types=["run"], rest_days=[], updated_at=NOW))
    repo.save_readiness(USER_A, ReadinessScore(
        score=70, classification="push", factors=[ReadinessFactor(key="k", label="l", impact="neutral", detail="d")],
        explanation="e", date=DAY, computed_at=NOW), "hash")
    for query in client.queries:
        assert query.operation == "upsert" and query.payload["user_id"] == USER_A
    assert client.queries[0].kwargs == {"on_conflict": "user_id"}
    assert client.queries[1].kwargs == {"on_conflict": "user_id,date"}
    assert client.queries[1].payload["feature_hash"] == "hash"


# ------------------------------------------------------------------ rows become models


def test_rows_as_postgres_returns_them_become_models():
    repo, _ = repo_with({
        "planned_sessions": [SESSION_ROW], "training_workout_logs": [WORKOUT_ROW],
        "training_routine_plans": [PLAN_ROW], "training_preferences": [PREFS_ROW], "readiness_scores": [READINESS_ROW],
    })
    session = repo.list_sessions(USER_A, DAY, DAY)[0]
    assert (session.id, session.target_volume, session.intensity_band) == ("s1", 32, "push")
    assert repo.list_workouts(USER_A, DAY, DAY)[0].actual_volume == 25.5
    plan = repo.get_active_plan(USER_A)
    assert plan.last_adaptation.adapted_on == date(2026, 9, 30) and plan.last_adaptation.acknowledged is False
    assert repo.get_preferences(USER_A).rest_days == ["sun"]
    score, digest = repo.get_cached_readiness(USER_A, DAY)
    assert (score.score, digest) == (58, "abc123") and score.factors[0].key == "load"


def test_missing_rows_come_back_as_none_or_empty():
    repo, _ = repo_with()
    assert repo.get_preferences(USER_A) is None and repo.get_active_plan(USER_A) is None
    assert repo.get_session(USER_A, "x") is None and repo.get_cached_readiness(USER_A, DAY) is None
    assert repo.list_sessions(USER_A, DAY, DAY) == []


# ------------------------------------------------------------------ one transaction, no user id in the rows


def _changes() -> ChangeSet:
    session = PlannedSession.model_validate(SESSION_ROW)
    plan = TrainingPlan.model_validate(PLAN_ROW)
    workout = WorkoutSession.model_validate(WORKOUT_ROW)
    return ChangeSet(supersede_active_plan=True, delete_session_ids=["old"], upsert_plans=[plan],
                     upsert_sessions=[session], insert_workouts=[workout])


def test_all_writes_go_through_a_single_rpc_for_the_named_user():
    repo, client = repo_with()
    repo.apply(USER_A, _changes())
    assert len(client.rpcs) == 1 and client.queries == []
    name, params = client.rpcs[0]
    assert name == "training_apply_changes" and params["p_user_id"] == USER_A


def test_payload_rows_carry_no_user_id_so_a_payload_cannot_write_for_someone_else():
    payload = changes_payload(_changes())
    assert set(payload) == {"supersede_active_plan", "delete_session_ids", "upsert_plans", "upsert_sessions", "insert_workouts"}
    for key in ("upsert_plans", "upsert_sessions", "insert_workouts"):
        for row in payload[key]:
            assert "user_id" not in row
    assert payload["upsert_sessions"][0]["date"] == "2026-10-01"  # JSON-safe
    assert payload["upsert_plans"][0]["last_adaptation"]["adapted_on"] == "2026-09-30"


def _with_calories(value):
    changes = _changes()
    changes.insert_workouts = [changes.insert_workouts[0].model_copy(update={"calories": value})]
    return changes


def _calls(client):
    return [name for name, _ in client.rpcs]


def test_calories_travel_in_the_payload_once_the_database_says_it_can_keep_them():
    repo, client = repo_with()
    repo.apply(USER_A, _with_calories(310))
    assert _calls(client) == ["training_schema_features", "training_apply_changes"]
    assert client.rpcs[1][1]["p_changes"]["insert_workouts"][0]["calories"] == 310
    assert client.queries == []

    plain_repo, plain_client = repo_with()
    plain_repo.apply(USER_A, _with_calories(None))
    assert _calls(plain_client) == ["training_apply_changes"], "a log without calories asks nothing extra"


def test_the_database_is_asked_about_calories_until_it_has_said_yes_and_then_not_again():
    repo, client = repo_with()
    repo.apply(USER_A, _with_calories(100))
    repo.apply(USER_A, _with_calories(200))
    assert _calls(client).count("training_schema_features") == 1 and _calls(client).count("training_apply_changes") == 2


@pytest.mark.parametrize("code", ["PGRST202", "42883", "42703", "PGRST204", "PGRST205", "42P01"])
def test_calories_are_refused_not_dropped_on_a_database_that_cant_keep_them(code):
    repo, client = repo_with()
    client.error = APIError({"message": "could not find the function training_schema_features", "code": code,
                             "hint": None, "details": None})
    with pytest.raises(TrainingError) as refused:
        repo.apply(USER_A, _with_calories(310))
    assert refused.value.code == "UNAVAILABLE" and "migration" in refused.value.message
    assert _calls(client) == ["training_schema_features"], "nothing was written"
    client.error = None  # the migration is applied later: the next log goes through
    repo.apply(USER_A, _with_calories(310))
    assert _calls(client)[-1] == "training_apply_changes"


@pytest.mark.parametrize("answer", [None, {}, {"calories": False}, {"calories": "yes"}, ["calories"], "ok"])
def test_calories_are_refused_when_the_database_doesnt_say_it_keeps_them(answer):
    """Someone adding the column by hand isn't enough: only the migration's own function answers yes."""
    repo, client = repo_with()
    client.features = answer
    with pytest.raises(TrainingError) as refused:
        repo.apply(USER_A, _with_calories(310))
    assert refused.value.code == "UNAVAILABLE"
    assert _calls(client) == ["training_schema_features"]


def test_any_other_database_error_asking_about_calories_is_not_papered_over():
    repo, client = repo_with()
    client.error = APIError({"message": "boom", "code": "XX000", "hint": None, "details": None})
    with pytest.raises(APIError):
        repo.apply(USER_A, _with_calories(310))
    assert _calls(client) == ["training_schema_features"]


def test_an_empty_change_set_has_the_expected_empty_shape():
    payload = changes_payload(ChangeSet())
    assert payload == {"supersede_active_plan": False, "delete_session_ids": [], "upsert_plans": [],
                       "upsert_sessions": [], "insert_workouts": []}


# ------------------------------------------------------------------ configuration


def test_the_repository_is_built_on_the_apps_supabase_admin_client(monkeypatch):
    class Client:
        marker = "the admin client"

    client = Client()
    monkeypatch.setattr(repository, "get_supabase_admin", lambda: client)
    # Each worker thread gets its own copy of that client (test_training_client.py), but it is that client.
    assert repository.create_repository().db.marker == "the admin client"


# ------------------------------------------------------------------ profile


def test_the_profile_read_asks_for_the_two_columns_it_uses_scoped_to_the_user():
    repo, client = repo_with({"users": [{"activity_level": "VERY_ACTIVE", "fitness_goal": "SURPLUS"}]})
    assert repo.get_profile(USER_A) == AthleteProfile(activity_level="VERY_ACTIVE", fitness_goal="SURPLUS")
    query = client.queries[-1]
    assert query.table_name == "users"
    # The same table holds Strava tokens and a password hash, so this must never become select("*").
    assert query.selected == ("activity_level,fitness_goal",)
    assert ("eq", "user_id", USER_A) in query.filters


def test_no_profile_row_means_no_profile():
    repo, _ = repo_with({"users": []})
    assert repo.get_profile(USER_A) is None


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST204", "PGRST205"])
def test_a_profile_table_or_column_that_isnt_there_yet_falls_back_and_is_logged(code, caplog):
    repo, client = repo_with()
    client.error = APIError({"message": "missing", "code": code, "hint": None, "details": None})
    with caplog.at_level("WARNING"):
        assert repo.get_profile(USER_A) is None
    assert code in caplog.text


def test_any_other_database_error_reading_the_profile_is_not_swallowed():
    repo, client = repo_with()
    client.error = APIError({"message": "permission denied", "code": "42501", "hint": None, "details": None})
    with pytest.raises(APIError):
        repo.get_profile(USER_A)


def _with_distance(metres, calories=None):
    changes = _changes()
    changes.insert_workouts = [
        changes.insert_workouts[0].model_copy(update={"distance_m": metres, "calories": calories})
    ]
    return changes


def test_a_distance_travels_in_the_payload_once_the_database_says_it_can_keep_it():
    repo, client = repo_with()
    client.features = {"calories": True, "distance": True}
    repo.apply(USER_A, _with_distance(5230.0))
    assert _calls(client) == ["training_schema_features", "training_apply_changes"]
    assert client.rpcs[1][1]["p_changes"]["insert_workouts"][0]["distance_m"] == 5230.0


def test_a_distance_is_refused_not_dropped_on_a_database_that_only_keeps_calories():
    repo, client = repo_with()  # answers {"calories": True}: the calories migration ran, the distance one didn't
    repo.apply(USER_A, _with_calories(300))
    with pytest.raises(TrainingError) as refused:
        repo.apply(USER_A, _with_distance(5230.0))
    assert refused.value.code == "UNAVAILABLE" and "Distance" in refused.value.message
    assert _calls(client).count("training_apply_changes") == 1, "the log with a distance wasn't written"

"""
Strava activities pulled as cards and saved to the schedule as training logs: the card, what a save writes, that
saving twice does nothing, what each failure means for the athlete, and the routes.

Hard Rule 1 is pinned separately, in test_training_strava_isolation.py.
"""
import asyncio
import itertools
from datetime import date, datetime, timezone
from types import SimpleNamespace
from typing import Dict, Iterator

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError
from pydantic import BaseModel, ValidationError

from app.commons.auth import deps
from app.commons.auth.deps import get_current_user_id
from app.services.strava import StravaActivity
from app.training.config import RULES, TrainingRules
from app.training.errors import TrainingError
from app.training.router import install as install_core
from app.training.strava_router import get_sync_service, router as strava_router
from app.training.strava_sync import (
    ACTIVITY_FOR_TYPE,
    FETCH_LIMIT,
    TABLE,
    StravaAccount,
    StravaLogRepository,
    StravaSyncService,
    log_figures,
    strava_failure,
    to_card,
)
from training_fakes import USER_A, USER_B, TableClient

NOW = datetime(2026, 10, 10, 9, 0, tzinfo=timezone.utc)

# the columns training_workout_logs has: nothing else may be written to it
COLUMNS = {"id", "user_id", "planned_session_id", "date", "activity_type", "actual_volume", "actual_duration_min",
           "rpe", "avg_hr", "source", "external_id", "distance_m", "created_at"}


def activity(**over):
    """What the team's Strava service hands back for one activity."""
    fields = dict(
        id=1001, name="Morning Run", type="Run", start_date="2026-08-14T11:42:02Z",
        start_date_local="2026-08-14T19:42:02Z", elapsed_time=3000, moving_time=2900, distance=8123.44,
        total_elevation_gain=55.26, average_heartrate=151.34,
    )
    fields.update(over)
    return SimpleNamespace(**fields)


class FakeStrava:
    """Stands in for Strava and for the athlete's connection to it."""

    def __init__(self, activities=(), connected=True, error=None):
        self.activities, self.connected, self.error, self.asked = list(activities), connected, error, []

    def is_connected(self, user_id):
        return self.connected

    async def latest_activities(self, user_id, limit):
        self.asked.append((user_id, limit))
        if self.error:
            raise self.error
        return list(self.activities)


def build(strava=None, client=None, rules=RULES):
    client = client if client is not None else TableClient({TABLE: []})
    strava = strava if strava is not None else FakeStrava()
    counter = itertools.count(1)
    service = StravaSyncService(StravaLogRepository(client), strava, rules=rules, clock=lambda: NOW,
                                new_id=lambda: f"log-{next(counter)}")
    return service, strava, client


def pull(service, user=USER_A):
    return asyncio.run(service.pull(user))


def save(service, ids, user=USER_A):
    return asyncio.run(service.save(user, ids))


def rows(client, source=None):
    return [r for r in client.tables.get(TABLE, []) if source is None or r.get("source") == source]


def api_error(code, message="boom"):
    return APIError({"message": message, "code": code, "hint": None, "details": None})


def status_error(status):
    request = httpx.Request("GET", "https://www.strava.com/api/v3/athlete/activities")
    return httpx.HTTPStatusError(f"{status}", request=request, response=httpx.Response(status, request=request))


# ------------------------------------------------------------------ the card


def test_a_card_shows_what_strava_said_and_how_it_would_be_saved():
    card = to_card(activity())
    assert (card.strava_id, card.name, card.sport_type) == (1001, "Morning Run", "Run")
    assert (card.distance_m, card.moving_time_s, card.elevation_gain_m, card.average_heartrate) == (8123.4, 2900, 55.3, 151.3)
    assert (card.activity_type, card.duration_min, card.volume, card.saved) == ("run", 48, 48, False)


def test_the_start_is_the_athletes_wall_clock_and_is_not_shifted_by_the_z_on_the_end():
    card = to_card(activity(start_date="2026-08-14T11:42:02Z", start_date_local="2026-08-14T19:42:02Z"))
    assert card.started_local == datetime(2026, 8, 14, 19, 42, 2) and card.started_local.tzinfo is None


def test_it_falls_back_to_the_utc_start_and_reads_an_offset():
    assert to_card(activity(start_date_local=None, start_date="2026-01-02T08:00:00Z")).started_local == datetime(2026, 1, 2, 8)
    assert to_card(activity(start_date_local="2026-01-02T08:30:00+08:00")).started_local == datetime(2026, 1, 2, 8, 30)
    assert to_card(activity(start_date_local="not a date", start_date="2026-01-02T08:00:00Z")).started_local == datetime(2026, 1, 2, 8)


@pytest.mark.parametrize("kind,expected", [
    ("Run", "run"), ("TrailRun", "run"), ("VirtualRun", "run"),
    ("Ride", "cycling"), ("VirtualRide", "cycling"), ("EBikeRide", "cycling"), ("MountainBikeRide", "cycling"),
    ("EMountainBikeRide", "cycling"), ("GravelRide", "cycling"),
    ("WeightTraining", "gym"),
    ("Workout", "bodyweight"), ("Crossfit", "bodyweight"), ("HighIntensityIntervalTraining", "bodyweight"),
])
def test_each_kind_of_activity_the_schedule_has_a_place_for_is_saved_as_that_kind(kind, expected):
    assert to_card(activity(type=kind)).activity_type == expected


@pytest.mark.parametrize("kind", ["Walk", "Hike", "Swim", "Yoga", "Kayaking", "Golf", "Snowboard", ""])
def test_an_activity_the_schedule_has_no_place_for_still_gets_a_card_that_cant_be_saved(kind):
    card = to_card(activity(type=kind))
    assert card is not None and card.sport_type == kind
    assert (card.activity_type, card.duration_min, card.volume) == (None, None, None)


def test_the_mapping_only_ever_names_the_four_kinds_of_training_the_schedule_has():
    assert set(ACTIVITY_FOR_TYPE.values()) == {"run", "cycling", "gym", "bodyweight"}


def test_a_supported_activity_that_took_no_time_cant_be_saved():
    card = to_card(activity(moving_time=0))
    assert (card.activity_type, card.duration_min, card.volume) == (None, None, None)


@pytest.mark.parametrize("over", [{"start_date_local": None, "start_date": None}, {"start_date_local": "yesterday", "start_date": "later"}])
def test_an_activity_with_no_usable_start_gets_no_card(over):
    assert to_card(activity(**over)) is None


def test_the_name_is_trimmed_given_a_fallback_and_cut_to_a_sensible_length():
    assert to_card(activity(name="  Lunch run  ")).name == "Lunch run"
    assert to_card(activity(name="   ")).name == "Untitled activity"
    assert to_card(activity(name=None)).name == "Untitled activity"
    assert len(to_card(activity(name="n" * 300)).name) == 200


@pytest.mark.parametrize("heart", [None, 0, -4])
def test_a_missing_or_impossible_heart_rate_is_none(heart):
    assert to_card(activity(average_heartrate=heart)).average_heartrate is None


def test_a_card_is_marked_saved_when_it_is():
    assert to_card(activity(), saved=True).saved is True


@pytest.mark.parametrize("seconds,minutes", [(0, None), (29, 1), (30, 1), (89, 1), (90, 2), (2700, 45), (100_000, RULES.workout_duration_max)])
def test_the_duration_is_the_moving_time_in_whole_minutes_rounded_half_up_and_capped(seconds, minutes):
    figures = log_figures(seconds, None)
    assert (figures[0] if figures else None) == minutes


def test_the_pts_are_a_plain_rule_of_so_many_a_minute():
    assert log_figures(1800, None)[1] == 30
    assert log_figures(1800, None, TrainingRules(strava_points_per_minute=2.0))[1] == 60
    assert log_figures(100_000, None, TrainingRules(strava_points_per_minute=5.0))[1] == int(RULES.workout_volume_max)
    assert log_figures(1, None)[1] == 1, "never less than a point"


@pytest.mark.parametrize("heart,saved", [(150.4, 150), (150.5, 151), (RULES.workout_hr_min, RULES.workout_hr_min),
                                         (RULES.workout_hr_min - 1, None), (RULES.workout_hr_max + 1, None), (None, None)])
def test_the_heart_rate_is_saved_only_if_it_is_one_the_log_accepts(heart, saved):
    assert log_figures(1800, heart)[2] == saved


def test_it_reads_the_team_strava_activity_model_as_it_is():
    real = StravaActivity(
        id=7, name="Intervals", type="Run", start_date="2026-08-14T11:42:02Z", start_date_local="2026-08-14T19:42:02Z",
        elapsed_time=520, moving_time=480, distance=1500.4, total_elevation_gain=21.3, average_heartrate=179.2,
    )
    card = to_card(real)
    assert (card.strava_id, card.distance_m, card.average_heartrate, card.duration_min) == (7, 1500.4, 179.2, 8)


# ------------------------------------------------------------------ pulling


def test_pulling_returns_every_activity_newest_first_and_saves_nothing():
    service, strava, client = build(FakeStrava([
        activity(id=1, start_date_local="2026-01-01T08:00:00Z"),
        activity(id=2, start_date_local="2026-03-01T08:00:00Z", type="Swim"),
        activity(id=3, start_date_local="2026-02-01T08:00:00Z", type="Ride"),
    ]))
    result = pull(service)
    assert [c.strava_id for c in result.activities] == [2, 3, 1]
    assert rows(client) == [] and not [q for q in client.requests if q.operation != "select"]
    assert strava.asked == [(USER_A, FETCH_LIMIT)]


def test_a_card_says_when_that_activity_is_already_on_the_schedule():
    service, _, _ = build(FakeStrava([activity(id=1), activity(id=2)]))
    save(service, [1])
    assert {c.strava_id: c.saved for c in pull(service).activities} == {1: True, 2: False}


def test_cards_are_per_athlete():
    service, _, _ = build(FakeStrava([activity(id=1)]))
    save(service, [1], USER_A)
    assert pull(service, USER_B).activities[0].saved is False


def test_an_activity_with_no_usable_start_is_left_out_of_the_cards():
    service, _, _ = build(FakeStrava([activity(id=1), activity(id=2, start_date_local=None, start_date=None)]))
    assert [c.strava_id for c in pull(service).activities] == [1]


# ------------------------------------------------------------------ saving


def test_saving_writes_one_training_log_per_chosen_activity_and_nothing_else():
    service, _, client = build(FakeStrava([activity(id=1), activity(id=2, type="Ride"), activity(id=3)]))
    result = save(service, [1, 2])
    assert (result.saved_ids, result.already_saved, result.skipped) == ([1, 2], 0, 0)
    assert sorted(r["external_id"] for r in rows(client)) == ["1", "2"]


def test_a_saved_log_is_exactly_what_the_card_said_it_would_be():
    service, _, client = build(FakeStrava([activity()]))
    card = pull(service).activities[0]
    save(service, [1001])
    row, = rows(client)
    assert set(row) == COLUMNS, "only columns the table has: no calories, no name"
    assert (row["user_id"], row["source"], row["external_id"]) == (USER_A, "strava", "1001")
    assert (row["activity_type"], row["actual_duration_min"], row["actual_volume"]) == (card.activity_type, card.duration_min, card.volume)
    assert (row["date"], row["avg_hr"], row["rpe"]) == ("2026-08-14", 151, None)
    assert row["distance_m"] == card.distance_m == 8123.4  # kept for the leaderboard's mileage view
    assert row["created_at"] == NOW.isoformat() and row["id"] == "log-1"


def test_a_strava_log_is_never_tied_to_a_planned_session():
    service, _, client = build(FakeStrava([activity(id=1), activity(id=2, type="WeightTraining")]))
    save(service, [1, 2])
    assert [r["planned_session_id"] for r in rows(client)] == [None, None]


def test_saving_again_changes_nothing_and_leaves_the_first_log_exactly_as_it_was():
    service, strava, client = build(FakeStrava([activity(id=1, name="Before", average_heartrate=140)]))
    save(service, [1])
    first = [dict(r) for r in rows(client)]
    strava.activities = [activity(id=1, name="After", average_heartrate=190, moving_time=9999)]
    again = save(service, [1])
    assert (again.saved_ids, again.already_saved, again.skipped) == ([], 1, 0)
    assert rows(client) == first


def test_two_saves_at_once_cannot_overwrite_the_first_log_even_if_both_thought_it_was_new():
    """Looking for what is already saved and writing are two steps, so the database itself must refuse to overwrite."""
    service, strava, client = build(FakeStrava([activity(id=1, moving_time=1800)]))
    save(service, [1])
    first = [dict(r) for r in rows(client)]
    strava.activities = [activity(id=1, moving_time=9999, average_heartrate=190)]
    service.repo.saved_ids = lambda user_id: set()  # the other request had not written yet when this one looked
    assert save(service, [1]).saved_ids == [1]  # this request believed the activity was new
    assert rows(client) == first, "the first log survived untouched"


def test_a_log_is_dated_by_the_day_it_happened_where_the_athlete_was_not_by_the_utc_day():
    # 07:30 on the 15th in Singapore is 23:30 on the 14th in UTC
    service, _, client = build(FakeStrava([activity(id=1, start_date="2026-08-14T23:30:00Z", start_date_local="2026-08-15T07:30:00Z")]))
    save(service, [1])
    assert rows(client)[0]["date"] == "2026-08-15"


def test_saving_all_twice_in_a_row_saves_each_activity_once():
    service, _, client = build(FakeStrava([activity(id=i) for i in range(1, 6)]))
    ids = list(range(1, 6))
    assert save(service, ids).saved_ids == ids
    assert save(service, ids).saved_ids == []
    assert len(rows(client)) == 5


def test_a_run_that_strava_no_longer_lists_still_counts_as_already_saved():
    service, strava, _ = build(FakeStrava([activity(id=1)]))
    save(service, [1])
    strava.activities = []
    assert save(service, [1]).already_saved == 1


def test_what_cant_be_saved_is_skipped_and_counted():
    service, _, client = build(FakeStrava([activity(id=1), activity(id=2, type="Swim"), activity(id=3, moving_time=0)]))
    result = save(service, [1, 2, 3, 404])
    assert (result.saved_ids, result.already_saved, result.skipped) == ([1], 0, 3)
    assert [r["external_id"] for r in rows(client)] == ["1"]


def test_an_id_listed_twice_in_the_request_is_saved_once():
    service, _, client = build(FakeStrava([activity(id=1)]))
    assert save(service, [1, 1, 1]).saved_ids == [1]
    assert len(rows(client)) == 1


def test_only_what_was_asked_for_is_saved():
    service, _, client = build(FakeStrava([activity(id=1), activity(id=2), activity(id=3)]))
    save(service, [2])
    assert [r["external_id"] for r in rows(client)] == ["2"]


def test_the_browser_decides_which_activities_not_what_they_contain():
    """Everything saved comes from a fresh answer from Strava: the request carries ids only."""
    service, strava, client = build(FakeStrava([activity(id=1, moving_time=1800)]))
    save(service, [1])
    assert strava.asked == [(USER_A, FETCH_LIMIT)]
    assert rows(client)[0]["actual_duration_min"] == 30


def test_two_athletes_can_each_save_the_same_strava_activity():
    service, _, client = build(FakeStrava([activity(id=1)]))
    save(service, [1], USER_A)
    save(service, [1], USER_B)
    assert sorted(r["user_id"] for r in rows(client)) == [USER_A, USER_B]


def test_saving_leaves_the_athletes_own_logs_alone():
    manual = {"id": "mine", "user_id": USER_A, "source": "manual", "external_id": None, "actual_volume": 40}
    service, _, client = build(FakeStrava([activity(id=1)]), TableClient({TABLE: [manual]}))
    save(service, [1])
    assert rows(client, "manual") == [manual]


def test_every_query_names_the_athlete_and_the_source():
    service, _, client = build(FakeStrava([activity(id=1)]))
    pull(service)
    save(service, [1])
    service.status(USER_A)
    service.delete(USER_A)
    scoped = [q for q in client.requests if q.table == TABLE and q.operation != "upsert"]
    assert scoped and all(("eq", "user_id", USER_A) in q.filters and ("eq", "source", "strava") in q.filters for q in scoped)


# ------------------------------------------------------------------ status and removing


def test_status_says_whether_strava_is_connected_and_how_many_are_on_the_schedule():
    service, strava, _ = build(FakeStrava([activity(id=1), activity(id=2)]))
    assert (service.status(USER_A).connected, service.status(USER_A).saved_count) == (True, 0)
    save(service, [1, 2])
    strava.connected = False
    status = service.status(USER_A)
    assert (status.connected, status.saved_count) == (False, 2), "disconnecting doesn't take them off the schedule"


def test_the_count_is_the_athletes_stravas_and_not_their_own_logs_or_anyone_elses():
    manual = {"id": "mine", "user_id": USER_A, "source": "manual", "external_id": None}
    service, _, _ = build(FakeStrava([activity(id=1)]), TableClient({TABLE: [manual]}))
    save(service, [1], USER_B)
    assert service.status(USER_A).saved_count == 0
    assert service.status(USER_B).saved_count == 1


def test_removing_takes_off_the_athletes_strava_logs_and_only_those():
    manual = {"id": "mine", "user_id": USER_A, "source": "manual", "external_id": None}
    service, _, client = build(FakeStrava([activity(id=1), activity(id=2)]), TableClient({TABLE: [manual]}))
    save(service, [1, 2], USER_A)
    save(service, [1], USER_B)
    assert service.delete(USER_A).deleted == 2
    assert service.delete(USER_A).deleted == 0
    assert sorted((r["user_id"], r["source"]) for r in rows(client)) == [(USER_A, "manual"), (USER_B, "strava")]


# ------------------------------------------------------------------ the real connection


def test_connected_is_read_from_the_expiry_alone_and_never_the_tokens():
    client = TableClient({"users": [
        {"user_id": USER_A, "strava_expires_at": 1_800_000_000},
        {"user_id": USER_B, "strava_expires_at": None},
    ]})
    account = StravaAccount(client)
    assert account.is_connected(USER_A) is True
    assert account.is_connected(USER_B) is False
    assert account.is_connected("someone-without-a-row") is False
    assert {q.columns for q in client.requests} == {"strava_expires_at"}


def test_the_real_account_asks_the_team_service_for_a_valid_token_then_one_page(monkeypatch):
    from app.training import strava_sync

    calls = []

    async def token(user_id):
        calls.append(("token", user_id))
        return "a-token"

    async def fetch(access_token, page, per_page):
        calls.append(("fetch", access_token, page, per_page))
        return [activity()]

    monkeypatch.setattr(strava_sync.strava_service, "check_valid_strava_token", token)
    monkeypatch.setattr(strava_sync.strava_service, "fetch_strava_activities", fetch)
    assert len(asyncio.run(StravaAccount(TableClient()).latest_activities(USER_A, 42))) == 1
    assert calls == [("token", USER_A), ("fetch", "a-token", 1, 42)]


# ------------------------------------------------------------------ failures


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST204", "PGRST205"])
@pytest.mark.parametrize("use", [
    lambda s: s.status(USER_A),
    lambda s: s.delete(USER_A),
    lambda s: pull(s),
    lambda s: save(s, [1]),
])
def test_a_database_without_the_migration_says_what_to_do(use, code):
    service, _, _ = build(FakeStrava([activity(id=1)]), TableClient(error=api_error(code)))
    with pytest.raises(TrainingError) as refused:
        use(service)
    assert refused.value.code == "UNAVAILABLE" and refused.value.status_code == 503
    assert "migration" in refused.value.message


def test_any_other_database_error_is_not_papered_over():
    service, _, _ = build(FakeStrava([activity()]), TableClient(error=api_error("42501")))
    with pytest.raises(APIError):
        service.status(USER_A)


@pytest.mark.parametrize("use", [lambda s: pull(s), lambda s: save(s, [1])])
def test_without_a_connection_nothing_is_asked_of_strava_and_nothing_is_saved(use):
    service, strava, client = build(FakeStrava([activity(id=1)], connected=False))
    with pytest.raises(TrainingError) as refused:
        use(service)
    assert refused.value.code == "NOT_CONNECTED" and refused.value.status_code == 409
    assert strava.asked == [] and rows(client) == []


class _Strict(BaseModel):
    required: int


def _validation_error():
    try:
        _Strict()
    except ValidationError as error:
        return error


@pytest.mark.parametrize("failure,code,status", [
    (HTTPException(status_code=400, detail="Strava account not connected"), "NOT_CONNECTED", 409),
    (status_error(429), "RATE_LIMITED", 429),
    (status_error(401), "NOT_CONNECTED", 409),
    (status_error(403), "NOT_CONNECTED", 409),
    (status_error(400), "NOT_CONNECTED", 409),  # Strava refusing to renew a revoked connection
    (status_error(500), "UNAVAILABLE", 503),
    (status_error(503), "UNAVAILABLE", 503),
    (httpx.ConnectError("no route"), "UNAVAILABLE", 503),
    (httpx.ReadTimeout("slow"), "UNAVAILABLE", 503),
    (_validation_error(), "UNAVAILABLE", 503),
    (RuntimeError("anything else"), "UNAVAILABLE", 503),
])
@pytest.mark.parametrize("use", [lambda s: pull(s), lambda s: save(s, [1])])
def test_each_way_strava_can_fail_becomes_a_plain_reason_and_saves_nothing(use, failure, code, status):
    service, _, client = build(FakeStrava([activity(id=1)], error=failure))
    with pytest.raises(TrainingError) as refused:
        use(service)
    assert (refused.value.code, refused.value.status_code) == (code, status)
    assert rows(client) == []


def test_a_revoked_connection_tells_the_athlete_what_to_do():
    assert "Settings" in strava_failure(status_error(401)).message


def test_a_training_error_passes_through_unchanged():
    original = TrainingError("RATE_LIMITED", "slow down")
    assert strava_failure(original) is original


# ------------------------------------------------------------------ the routes


class FakeSupabaseAuth:
    def __init__(self, sessions: Dict[str, str]):
        self.sessions = sessions

    def get_user(self, token):
        if token not in self.sessions:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=self.sessions[token]))


def headers(user=USER_A):
    return {"Authorization": f"Bearer token-for-{user}"}


BASE = "/api/v1/training/strava"


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(deps, "get_supabase_admin", lambda: SimpleNamespace(
        auth=FakeSupabaseAuth({f"token-for-{USER_A}": USER_A, f"token-for-{USER_B}": USER_B})))
    service, strava, client = build(FakeStrava([activity(id=1), activity(id=2, type="Ride"), activity(id=3, type="Swim")]))
    app = FastAPI()
    install_core(app)  # for the shared validation-error handler
    app.include_router(strava_router)
    app.dependency_overrides[get_sync_service] = lambda: service
    return SimpleNamespace(http=TestClient(app), service=service, strava=strava, client=client)


def _dependency_calls(dependant) -> Iterator:
    for sub in dependant.dependencies:
        yield sub.call
        yield from _dependency_calls(sub)


def test_every_strava_route_sits_behind_the_shared_auth_dependency():
    routes = [r for r in strava_router.routes if isinstance(r, APIRoute)]
    assert len(routes) == 4, "the route filter matched the wrong thing"
    assert [r.path for r in routes if get_current_user_id not in _dependency_calls(r.dependant)] == []


@pytest.mark.parametrize("method,path", [("get", "/status"), ("post", "/pull"), ("post", "/save"), ("delete", "/logs")])
def test_every_route_needs_a_token(world, method, path):
    assert getattr(world.http, method)(f"{BASE}{path}").status_code in (401, 403)


def test_pulling_over_http_returns_cards_with_what_would_be_saved(world):
    response = world.http.post(f"{BASE}/pull", headers=headers())
    assert response.status_code == 200
    cards = response.json()["activities"]
    assert sorted(c["stravaId"] for c in cards) == [1, 2, 3]
    run = next(c for c in cards if c["stravaId"] == 1)
    assert set(run) == {"stravaId", "name", "sportType", "startedLocal", "distanceM", "movingTimeS", "elevationGainM",
                        "averageHeartrate", "activityType", "durationMin", "volume", "saved"}
    assert (run["activityType"], run["durationMin"], run["volume"], run["saved"]) == ("run", 48, 48, False)
    assert run["startedLocal"] == "2026-08-14T19:42:02"
    swim = next(c for c in cards if c["stravaId"] == 3)
    assert (swim["activityType"], swim["durationMin"], swim["volume"]) == (None, None, None)
    assert "userId" not in run


def test_saving_over_http_then_reading_the_status_and_the_cards(world):
    saved = world.http.post(f"{BASE}/save", json={"stravaIds": [1, 2, 3]}, headers=headers())
    assert saved.status_code == 200
    assert saved.json() == {"savedIds": [1, 2], "alreadySaved": 0, "skipped": 1}
    assert world.http.get(f"{BASE}/status", headers=headers()).json() == {"connected": True, "savedCount": 2}
    cards = {c["stravaId"]: c["saved"] for c in world.http.post(f"{BASE}/pull", headers=headers()).json()["activities"]}
    assert cards == {1: True, 2: True, 3: False}
    again = world.http.post(f"{BASE}/save", json={"stravaIds": [1, 2]}, headers=headers()).json()
    assert again == {"savedIds": [], "alreadySaved": 2, "skipped": 0}


def test_removing_over_http_reports_how_many_and_empties_the_schedule_of_them(world):
    world.http.post(f"{BASE}/save", json={"stravaIds": [1, 2]}, headers=headers())
    assert world.http.delete(f"{BASE}/logs", headers=headers()).json() == {"deleted": 2}
    assert world.http.get(f"{BASE}/status", headers=headers()).json()["savedCount"] == 0


def test_one_athlete_never_sees_or_removes_anothers(world):
    world.http.post(f"{BASE}/save", json={"stravaIds": [1]}, headers=headers(USER_A))
    assert world.http.get(f"{BASE}/status", headers=headers(USER_B)).json()["savedCount"] == 0
    assert world.http.delete(f"{BASE}/logs", headers=headers(USER_B)).json() == {"deleted": 0}
    assert world.http.get(f"{BASE}/status", headers=headers(USER_A)).json()["savedCount"] == 1


@pytest.mark.parametrize("body", [{}, {"stravaIds": []}, {"stravaIds": list(range(FETCH_LIMIT + 1))}, {"stravaIds": ["x"]}, {"stravaIds": "1"}])
def test_a_bad_save_request_is_a_validation_error_in_the_usual_envelope(world, body):
    response = world.http.post(f"{BASE}/save", json=body, headers=headers())
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "VALIDATION"
    assert rows(world.client) == []


@pytest.mark.parametrize("path", ["/pull", "/save"])
@pytest.mark.parametrize("setup,status,code", [
    (lambda w: setattr(w.strava, "connected", False), 409, "NOT_CONNECTED"),
    (lambda w: setattr(w.strava, "error", status_error(429)), 429, "RATE_LIMITED"),
    (lambda w: setattr(w.strava, "error", status_error(500)), 503, "UNAVAILABLE"),
])
def test_failures_use_the_same_envelope_as_the_rest_of_the_training_api(world, path, setup, status, code):
    setup(world)
    response = world.http.post(f"{BASE}{path}", json={"stravaIds": [1]} if path == "/save" else None, headers=headers())
    assert response.status_code == status
    detail = response.json()["detail"]
    assert detail["code"] == code and isinstance(detail["message"], str) and detail["message"]


def test_a_database_without_the_migration_is_a_503_over_http(world):
    world.client.error = api_error("PGRST204")
    response = world.http.get(f"{BASE}/status", headers=headers())
    assert response.status_code == 503 and response.json()["detail"]["code"] == "UNAVAILABLE"


def test_the_package_install_mounts_the_strava_routes_too():
    from app.training import install

    app = FastAPI()
    install(app)
    paths = set(app.openapi()["paths"])  # app.routes nests included routers in this FastAPI
    assert {f"{BASE}/status", f"{BASE}/pull", f"{BASE}/save", f"{BASE}/logs"} <= paths
    assert "/api/v1/training/today" in paths

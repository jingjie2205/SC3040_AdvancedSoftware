import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Iterator, Optional

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.commons.auth import deps
from app.commons.auth.deps import get_current_user_id
from app.training.clock import get_client_date
from app.training.config import RULES
from app.training import router as router_module
from app.training.ml.scorer import ModelScorer, load_scorer
from app.training.planner import AthleteProfile
from app.training.readiness import RuleBasedScorer
from app.training.router import TRAINING_PREFIX, get_service, install, readiness_router, router
from app.training.service import TrainingService
from training_fakes import TODAY, USER_A, USER_B, FakeTrainingRepository, seed_history

PREFS = {
    "daysPerWeek": 4,
    "sessionDurationMin": 45,
    "activityTypes": ["run", "gym", "cycling"],
    "restDays": ["tue", "thu", "sun"],
}


class FakeSupabaseAuth:
    """
    Stands in for Supabase Auth behind the shared `get_current_user_id`, so these tests run the real
    dependency end to end. Like the real client, it raises for a token it doesn't recognise.
    """

    def __init__(self, sessions: Dict[str, Optional[str]]) -> None:
        self.sessions = sessions

    def get_user(self, token: str):
        if token not in self.sessions:
            raise RuntimeError("invalid JWT")
        user_id = self.sessions[token]
        return SimpleNamespace(user=SimpleNamespace(id=user_id) if user_id else None)


def token_for(user: str = USER_A) -> str:
    return f"access-token-for-{user}"


def headers(user: str = USER_A) -> dict:
    return {"Authorization": f"Bearer {token_for(user)}"}


@pytest.fixture
def supabase_auth(monkeypatch) -> FakeSupabaseAuth:
    fake = FakeSupabaseAuth({token_for(USER_A): USER_A, token_for(USER_B): USER_B})
    monkeypatch.setattr(deps, "get_supabase_admin", lambda: SimpleNamespace(auth=fake))
    return fake


@pytest.fixture
def repo() -> FakeTrainingRepository:
    return FakeTrainingRepository()


@pytest.fixture
def app(repo, supabase_auth) -> FastAPI:
    application = FastAPI()
    install(application)
    service = TrainingService(repo, RuleBasedScorer())
    application.dependency_overrides[get_service] = lambda: service
    application.dependency_overrides[get_client_date] = lambda: TODAY
    return application


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


def onboard(client, repo, user: str = USER_A) -> None:
    assert client.put("/api/v1/training/preferences", json=PREFS, headers=headers(user)).status_code == 200
    seed_history(repo, user, TODAY - timedelta(days=TODAY.weekday()))


def generate(client, weeks: int = 8, user: str = USER_A, confirm: bool = False):
    return client.post("/api/v1/training/plan", json={"weeks": weeks, "confirmReplace": confirm}, headers=headers(user))


# ------------------------------------------------------------------ authentication
# Identity comes from the team's shared `get_current_user_id`, where Supabase verifies the token. So
# these tests cover that every route is behind it and that only its answer decides whose data is served.


def _dependency_calls(dependant) -> Iterator:
    for sub in dependant.dependencies:
        yield sub.call
        yield from _dependency_calls(sub)


def test_every_training_and_readiness_route_sits_behind_the_shared_auth_dependency():
    routes = [route for mounted in (router, readiness_router) for route in mounted.routes if isinstance(route, APIRoute)]
    assert len(routes) >= 10, "the route filter matched almost nothing"
    unguarded = [route.path for route in routes if get_current_user_id not in _dependency_calls(route.dependant)]
    assert unguarded == []


@pytest.mark.parametrize("path", ["/preferences", "/plan", "/today", "/schedule?from=2026-09-28&to=2026-10-04"])
def test_every_route_needs_a_token(client, path):
    # FastAPI's HTTPBearer answers 403 on older releases and 401 on newer ones when the header is absent.
    assert client.get(f"{TRAINING_PREFIX}{path}").status_code in (401, 403)


@pytest.mark.parametrize("bad", ["Basic abc", "Bearer", ""])
def test_a_malformed_authorization_header_is_rejected(client, bad):
    response = client.get(f"{TRAINING_PREFIX}/preferences", headers={"Authorization": bad})
    assert response.status_code in (401, 403)


def test_a_token_supabase_does_not_recognise_is_rejected_and_nothing_is_written(client, repo):
    """Forged, expired and wrong-audience tokens all look like this: Supabase refuses to resolve them."""
    response = client.post(
        f"{TRAINING_PREFIX}/plan",
        json={"weeks": 4, "confirmReplace": False},
        headers={"Authorization": "Bearer forged-or-expired"},
    )
    assert response.status_code == 401
    assert repo.plans == {}


def test_a_token_that_resolves_to_no_user_is_rejected(client, supabase_auth):
    supabase_auth.sessions["orphan"] = None
    response = client.get(f"{TRAINING_PREFIX}/preferences", headers={"Authorization": "Bearer orphan"})
    assert response.status_code == 401


def test_the_user_comes_only_from_the_token_never_from_the_request(client, repo):
    onboard(client, repo)
    response = client.post(
        "/api/v1/training/plan?userId=" + USER_B,
        json={"weeks": 4, "confirmReplace": False, "userId": USER_B, "user_id": USER_B},
        headers=headers(USER_A),
    )
    assert response.status_code == 200
    assert {owner for owner, _ in repo.plans.values()} == {USER_A}
    assert client.get("/api/v1/training/plan", headers=headers(USER_B)).json() is None


def test_no_route_takes_a_user_id():
    application = FastAPI()
    install(application)
    schema = application.openapi()
    text = str(schema).lower()
    for name in ("userid", "user_id"):
        assert name not in text


# ------------------------------------------------------------------ client date


def test_client_date_defaults_to_utc_today_and_rejects_dates_far_from_it():
    today = datetime.now(timezone.utc).date()
    assert get_client_date(None) == today
    assert get_client_date((today + timedelta(days=1)).isoformat()) == today + timedelta(days=1)
    for bad in ((today + timedelta(days=3)).isoformat(), "not-a-date"):
        with pytest.raises(Exception) as raised:
            get_client_date(bad)
        assert raised.value.status_code == 400


# ------------------------------------------------------------------ preferences and validation shape


def test_preferences_round_trip_in_camel_case(client):
    assert client.get("/api/v1/training/preferences", headers=headers()).json() is None
    saved = client.put("/api/v1/training/preferences", json=PREFS, headers=headers()).json()
    assert {k: saved[k] for k in PREFS} == PREFS and "updatedAt" in saved
    assert client.get("/api/v1/training/preferences", headers=headers()).json() == saved


def test_validation_errors_use_the_same_shape_as_every_other_error(client):
    response = client.put(
        "/api/v1/training/preferences",
        json={"daysPerWeek": 9, "sessionDurationMin": 5, "activityTypes": [], "restDays": ["mon", "tue", "wed"]},
        headers=headers(),
    )
    detail = response.json()["detail"]
    assert response.status_code == 422 and detail["code"] == "VALIDATION"
    assert {"daysPerWeek", "sessionDurationMin", "activityTypes"} <= set(detail["fieldErrors"])


def test_not_enough_free_days_is_reported_against_rest_days(client):
    body = {**PREFS, "daysPerWeek": 7, "restDays": ["sun"]}
    detail = client.put("/api/v1/training/preferences", json=body, headers=headers()).json()["detail"]
    assert "restDays" in detail["fieldErrors"] and "free" in detail["fieldErrors"]["restDays"]


def test_other_routes_keep_the_default_validation_response(app):
    @app.get("/elsewhere")
    def elsewhere(n: int):
        return n

    body = TestClient(app).get("/elsewhere?n=abc").json()
    assert isinstance(body["detail"], list)


# ------------------------------------------------------------------ plan flow


def test_generating_without_preferences_explains_why(client):
    response = generate(client)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "NO_PREFERENCES"


def test_generate_then_get_then_replace_needs_confirmation(client, repo):
    onboard(client, repo)
    created = generate(client)
    assert created.status_code == 200
    plan = created.json()
    assert plan["weeks"] == 8 and "not medical advice" in plan["notice"] and plan["status"] == "active"
    assert client.get("/api/v1/training/plan", headers=headers()).json()["id"] == plan["id"]

    refused = generate(client, weeks=6)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "PLAN_EXISTS"
    assert generate(client, weeks=6, confirm=True).status_code == 200


def test_plan_length_is_validated(client, repo):
    onboard(client, repo)
    detail = generate(client, weeks=99).json()["detail"]
    assert detail["code"] == "VALIDATION" and "weeks" in detail["fieldErrors"]


def test_recalculate_and_acknowledge(client, repo):
    onboard(client, repo)
    generate(client)
    adapted = client.post("/api/v1/training/plan/recalculate", headers=headers()).json()
    assert adapted["lastAdaptation"]["trigger"] == "manual" and adapted["lastAdaptation"]["acknowledged"] is False
    assert client.post("/api/v1/training/plan/adaptation/acknowledge", headers=headers()).status_code == 204
    assert client.get("/api/v1/training/plan", headers=headers()).json()["lastAdaptation"]["acknowledged"] is True


# ------------------------------------------------------------------ sessions


def sessions_of(client, start: date, end: date, user: str = USER_A) -> list:
    response = client.get(f"/api/v1/training/schedule?from={start}&to={end}", headers=headers(user))
    assert response.status_code == 200
    return response.json()["sessions"]


def test_schedule_move_refusal_carries_a_suggested_day_and_success_marks_it_moved(client, repo):
    onboard(client, repo)
    generate(client)
    saturday = sessions_of(client, date(2026, 10, 10), date(2026, 10, 10))[0]

    refused = client.patch(f"/api/v1/training/sessions/{saturday['id']}", json={"date": "2026-10-11"}, headers=headers())
    detail = refused.json()["detail"]
    assert refused.status_code == 409
    assert detail["code"] == "CONSECUTIVE_HIGH_INTENSITY" and detail["suggestedDate"] == "2026-10-08"

    moved = client.patch(f"/api/v1/training/sessions/{saturday['id']}", json={"date": detail["suggestedDate"]}, headers=headers())
    assert moved.status_code == 200 and moved.json()["status"] == "moved"


def test_remove_respond_and_log(client, repo):
    onboard(client, repo)
    generate(client)
    today_session = sessions_of(client, TODAY, TODAY)[0]

    accepted = client.post(f"/api/v1/training/sessions/{today_session['id']}/respond", json={"action": "accept"}, headers=headers())
    assert accepted.json()["status"] == "accepted"

    bad_swap = client.post(f"/api/v1/training/sessions/{today_session['id']}/respond", json={"action": "swap"}, headers=headers())
    assert bad_swap.status_code == 422 and bad_swap.json()["detail"]["code"] == "VALIDATION"

    log = {"date": TODAY.isoformat(), "activityType": "run", "actualDurationMin": 40, "actualVolume": today_session["targetVolume"], "rpe": 6, "avgHr": 140}
    logged = client.post(f"/api/v1/training/sessions/{today_session['id']}/log", json=log, headers=headers())
    assert logged.status_code == 200
    assert logged.json()["session"]["status"] == "completed" and logged.json()["workout"]["plannedSessionId"] == today_session["id"]

    friday = sessions_of(client, TODAY + timedelta(days=2), TODAY + timedelta(days=2))[0]
    removed = client.delete(f"/api/v1/training/sessions/{friday['id']}", headers=headers())
    assert removed.status_code == 200 and removed.json()["redistributedCount"] >= 1


def test_ad_hoc_logging_and_field_errors(client, repo):
    onboard(client, repo)
    ok = client.post("/api/v1/training/sessions", json={"date": TODAY.isoformat(), "activityType": "gym", "actualDurationMin": 30, "actualVolume": 20}, headers=headers())
    assert ok.status_code == 200 and ok.json()["session"] is None

    bad = client.post("/api/v1/training/sessions", json={"date": TODAY.isoformat(), "activityType": "gym", "actualDurationMin": 0, "actualVolume": -1, "rpe": 11}, headers=headers())
    fields = bad.json()["detail"]["fieldErrors"]
    assert bad.status_code == 422 and {"actualDurationMin", "actualVolume", "rpe"} <= set(fields)

    future = client.post("/api/v1/training/sessions", json={"date": (TODAY + timedelta(days=1)).isoformat(), "activityType": "gym", "actualDurationMin": 30, "actualVolume": 20}, headers=headers())
    assert future.json()["detail"]["fieldErrors"]["date"]


def test_calories_are_accepted_returned_and_validated_like_the_other_log_fields(client, repo):
    onboard(client, repo)
    entry = {"date": TODAY.isoformat(), "activityType": "run", "actualDurationMin": 30, "actualVolume": 25}

    with_calories = client.post("/api/v1/training/sessions", json={**entry, "calories": 310}, headers=headers())
    assert with_calories.status_code == 200 and with_calories.json()["workout"]["calories"] == 310
    without = client.post("/api/v1/training/sessions", json=entry, headers=headers())
    assert without.status_code == 200 and without.json()["workout"]["calories"] is None

    shown = client.get(f"/api/v1/training/schedule?from={TODAY.isoformat()}&to={TODAY.isoformat()}", headers=headers())
    assert sorted(w["calories"] for w in shown.json()["workouts"] if w["calories"] is not None) == [310]

    for bad in (-5, 20001, "lots", 12.5):
        refused = client.post("/api/v1/training/sessions", json={**entry, "calories": bad}, headers=headers())
        assert refused.status_code == 422 and "calories" in refused.json()["detail"]["fieldErrors"], bad


def test_a_malformed_session_id_is_a_validation_error_not_a_server_error(client):
    assert client.delete("/api/v1/training/sessions/not-a-uuid", headers=headers()).status_code == 422


def test_users_cannot_touch_each_others_sessions_over_http(client, repo):
    onboard(client, repo, USER_A)
    generate(client)
    theirs = sessions_of(client, TODAY, TODAY)[0]
    for call in (
        lambda: client.patch(f"/api/v1/training/sessions/{theirs['id']}", json={"date": "2026-10-01"}, headers=headers(USER_B)),
        lambda: client.delete(f"/api/v1/training/sessions/{theirs['id']}", headers=headers(USER_B)),
        lambda: client.post(f"/api/v1/training/sessions/{theirs['id']}/respond", json={"action": "skip"}, headers=headers(USER_B)),
    ):
        response = call()
        assert response.status_code == 404 and response.json()["detail"]["code"] == "NOT_FOUND"
    assert sessions_of(client, TODAY, TODAY, USER_B) == []


# ------------------------------------------------------------------ planning by hand


ADD = "/api/v1/training/plan/sessions"
THURSDAY = "2026-10-08"  # a free day in the second week of the standard plan


def add_body(**over) -> dict:
    return {"date": THURSDAY, "activityType": "run", "intensityBand": "light", **over}


def test_adding_a_session_over_http_returns_it_and_how_many_others_made_room(client, repo):
    onboard(client, repo)
    generate(client)
    before = sum(s["targetVolume"] for s in sessions_of(client, date(2026, 10, 5), date(2026, 10, 11)))

    response = client.post(ADD, json=add_body(), headers=headers())

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"session", "adjustedCount"} and body["adjustedCount"] == 4
    assert set(body["session"]) == {
        "id", "planId", "date", "activityType", "targetVolume", "targetDurationMin", "intensityBand", "status"
    }
    assert (body["session"]["date"], body["session"]["status"], body["session"]["targetDurationMin"]) == (THURSDAY, "planned", 35)
    week = sessions_of(client, date(2026, 10, 5), date(2026, 10, 11))
    assert body["session"]["id"] in {s["id"] for s in week}
    assert sum(s["targetVolume"] for s in week) == before  # the week's load is the plan's


def test_a_chosen_length_is_used_and_checked(client, repo):
    onboard(client, repo)
    generate(client)
    ok = client.post(ADD, json=add_body(targetDurationMin=60), headers=headers())
    assert ok.status_code == 200 and ok.json()["session"]["targetDurationMin"] == 60
    for bad in (5, 14, 181, 500, 40.5, "long"):
        refused = client.post(ADD, json=add_body(date="2026-10-06", targetDurationMin=bad), headers=headers())
        assert refused.status_code == 422, bad
        assert "targetDurationMin" in refused.json()["detail"]["fieldErrors"], bad


def test_a_malformed_add_is_reported_field_by_field_in_the_usual_shape(client, repo):
    onboard(client, repo)
    generate(client)
    refused = client.post(ADD, json={"activityType": "swim", "intensityBand": "extreme"}, headers=headers())
    detail = refused.json()["detail"]
    assert refused.status_code == 422 and detail["code"] == "VALIDATION"
    assert {"date", "activityType", "intensityBand"} <= set(detail["fieldErrors"])


def test_adding_on_a_day_the_rules_forbid_is_a_409_with_the_nearest_day_that_works(client, repo):
    onboard(client, repo)
    generate(client)
    taken = client.post(ADD, json=add_body(date="2026-10-07"), headers=headers())  # Wednesday already has a session
    detail = taken.json()["detail"]
    assert taken.status_code == 409 and detail["code"] == "DAY_OCCUPIED"
    assert client.post(ADD, json=add_body(date=detail["suggestedDate"]), headers=headers()).status_code == 200

    beside_a_push = client.post(ADD, json=add_body(date="2026-10-11", intensityBand="push"), headers=headers())
    assert beside_a_push.status_code == 409 and beside_a_push.json()["detail"]["code"] == "CONSECUTIVE_HIGH_INTENSITY"
    assert beside_a_push.json()["detail"]["suggestedDate"]

    past = client.post(ADD, json=add_body(date="2026-09-29"), headers=headers())
    assert past.status_code == 409 and past.json()["detail"]["code"] == "IN_PAST"


def test_a_band_or_activity_the_week_or_athlete_doesnt_allow_is_a_422_against_that_field(client, repo):
    onboard(client, repo)
    generate(client)
    deload_week_push = client.post(ADD, json=add_body(date="2026-10-20", intensityBand="push"), headers=headers())
    assert deload_week_push.status_code == 422
    assert "deload week" in deload_week_push.json()["detail"]["fieldErrors"]["intensityBand"]
    other_activity = client.post(ADD, json=add_body(activityType="bodyweight"), headers=headers())
    assert other_activity.status_code == 422 and "activityType" in other_activity.json()["detail"]["fieldErrors"]


def test_a_week_with_no_load_left_is_a_409_week_full(client, repo):
    onboard(client, repo)
    generate(client)
    for session in sessions_of(client, date(2026, 10, 5), date(2026, 10, 11)):
        owner, stored = repo.sessions[session["id"]]
        repo.sessions[session["id"]] = (owner, stored.model_copy(update={"status": "completed"}))
    refused = client.post(ADD, json=add_body(), headers=headers())
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "WEEK_FULL"


def test_adding_without_a_plan_is_a_404_no_plan(client):
    client.put("/api/v1/training/preferences", json=PREFS, headers=headers())
    refused = client.post(ADD, json=add_body(), headers=headers())
    assert refused.status_code == 404 and refused.json()["detail"]["code"] == "NO_PLAN"


def test_adding_needs_a_token_and_writes_nothing_without_one(client, repo):
    onboard(client, repo)
    generate(client)
    before = len(repo.sessions)
    for headers_ in ({}, {"Authorization": "Bearer forged-or-expired"}):
        assert client.post(ADD, json=add_body(), headers=headers_).status_code in (401, 403)
    assert len(repo.sessions) == before


def test_one_users_new_session_goes_into_their_own_plan_and_the_token_is_the_only_identity(client, repo):
    onboard(client, repo, USER_A)
    generate(client)
    onboard(client, repo, USER_B)
    generate(client, user=USER_B)
    theirs = sessions_of(client, date(2026, 10, 5), date(2026, 10, 11), USER_B)

    added = client.post(ADD + "?userId=" + USER_B, json={**add_body(), "userId": USER_B}, headers=headers(USER_A))

    assert added.status_code == 200
    assert repo.sessions[added.json()["session"]["id"]][0] == USER_A
    assert sessions_of(client, date(2026, 10, 5), date(2026, 10, 11), USER_B) == theirs


def test_a_session_can_be_changed_in_place_over_http(client, repo):
    onboard(client, repo)
    generate(client)
    wednesday = sessions_of(client, date(2026, 10, 7), date(2026, 10, 7))[0]
    url = f"/api/v1/training/sessions/{wednesday['id']}"

    renamed = client.patch(url, json={"activityType": "run"}, headers=headers())
    assert renamed.status_code == 200
    assert renamed.json()["activityType"] == "run" and renamed.json()["targetVolume"] == wednesday["targetVolume"]

    harder = client.patch(url, json={"intensityBand": "push", "targetDurationMin": 50}, headers=headers())
    assert harder.status_code == 200
    assert (harder.json()["intensityBand"], harder.json()["targetDurationMin"]) == ("push", 50)
    assert harder.json()["targetVolume"] > wednesday["targetVolume"]
    week = sessions_of(client, date(2026, 10, 5), date(2026, 10, 11))
    assert sum(s["targetVolume"] for s in week) == 104


def test_changing_a_session_is_refused_in_the_usual_shape(client, repo):
    onboard(client, repo)
    generate(client)
    friday = sessions_of(client, date(2026, 10, 9), date(2026, 10, 9))[0]
    url = f"/api/v1/training/sessions/{friday['id']}"

    beside_a_push = client.patch(url, json={"intensityBand": "push"}, headers=headers())  # Saturday is a push
    assert beside_a_push.status_code == 409 and beside_a_push.json()["detail"]["code"] == "CONSECUTIVE_HIGH_INTENSITY"

    unchanged = client.patch(url, json={"activityType": friday["activityType"]}, headers=headers())
    assert unchanged.status_code == 409 and unchanged.json()["detail"]["code"] == "NO_CHANGE"

    deload = client.patch(url, json={"intensityBand": "deload"}, headers=headers())
    assert deload.status_code == 422 and "intensityBand" in deload.json()["detail"]["fieldErrors"]

    swim = client.patch(url, json={"activityType": "swim"}, headers=headers())
    assert swim.status_code == 422 and "activityType" in swim.json()["detail"]["fieldErrors"]

    too_short = client.patch(url, json={"targetDurationMin": 3}, headers=headers())
    assert too_short.status_code == 422 and "targetDurationMin" in too_short.json()["detail"]["fieldErrors"]


def test_a_patch_is_a_move_or_a_change_never_both_and_never_nothing(client, repo):
    onboard(client, repo)
    generate(client)
    friday = sessions_of(client, date(2026, 10, 9), date(2026, 10, 9))[0]
    url = f"/api/v1/training/sessions/{friday['id']}"

    both = client.patch(url, json={"date": THURSDAY, "activityType": "gym"}, headers=headers())
    assert both.status_code == 422 and "not both at once" in both.json()["detail"]["fieldErrors"]["form"]
    nothing = client.patch(url, json={}, headers=headers())
    assert nothing.status_code == 422 and "Say what to change" in nothing.json()["detail"]["fieldErrors"]["form"]
    assert sessions_of(client, date(2026, 10, 9), date(2026, 10, 9))[0] == friday

    moved = client.patch(url, json={"date": THURSDAY}, headers=headers())
    assert moved.status_code == 200 and moved.json()["status"] == "moved"


def test_nobody_else_can_change_a_session(client, repo):
    onboard(client, repo)
    generate(client)
    theirs = sessions_of(client, date(2026, 10, 7), date(2026, 10, 7))[0]
    refused = client.patch(f"/api/v1/training/sessions/{theirs['id']}", json={"activityType": "run"}, headers=headers(USER_B))
    assert refused.status_code == 404 and refused.json()["detail"]["code"] == "NOT_FOUND"
    assert sessions_of(client, date(2026, 10, 7), date(2026, 10, 7))[0] == theirs


def test_the_new_route_carries_no_readiness(app):
    """Hard Rule 4 again, at the schema: planning a session can't be a way to read a score."""
    schema = app.openapi()
    reply = str(schema["paths"][ADD]["post"]["responses"]).lower()
    assert "readiness" not in reply and "score" not in reply


# ------------------------------------------------------------------ today and readiness


def test_today_returns_readiness_and_the_reconciled_workout(client, repo):
    onboard(client, repo)
    generate(client)
    body = client.get("/api/v1/training/today", headers=headers()).json()
    assert body["date"] == TODAY.isoformat()
    assert 0 <= body["readiness"]["score"] <= 100 and body["readiness"]["factors"]
    assert body["planned"]["id"] and body["recommendation"]["explanation"]


def test_scoring_endpoint_is_stateless_and_validated(client, repo):
    features = {"acwr": 1.6, "sleepHours": 5.5, "checkinLoadRating": 4}
    first = client.post("/api/v1/readiness/score", json=features, headers=headers())
    assert first.status_code == 200
    assert first.json() == client.post("/api/v1/readiness/score", json=features, headers=headers()).json()
    assert repo.readiness == {}  # nothing stored

    assert client.post("/api/v1/readiness/score", json={"sleepHours": 99}, headers=headers()).status_code == 422
    assert client.post("/api/v1/readiness/score", json=features).status_code == 401


# ------------------------------------------------------------------ goal, exam dates and sleep


def put_sleep(client, hours, user: str = USER_A):
    return client.put("/api/v1/training/sleep", json={"hours": hours}, headers=headers(user))


def today_body(client, user: str = USER_A) -> dict:
    return client.get("/api/v1/training/today", headers=headers(user)).json()


def test_sleep_is_logged_for_the_users_today_and_feeds_the_readiness_card(client):
    before = today_body(client)
    assert before["sleepHours"] is None
    saved = put_sleep(client, 5.5)
    assert saved.status_code == 200 and saved.json() == {"date": TODAY.isoformat(), "hours": 5.5}
    after = today_body(client)
    assert after["sleepHours"] == 5.5 and after["readiness"]["score"] < before["readiness"]["score"]
    assert any(f["key"] == "sleep" and f["detail"] == "5.5 h last night" for f in after["readiness"]["factors"])


def test_one_users_sleep_is_invisible_to_everyone_else(client):
    put_sleep(client, 3)
    mine, other = today_body(client, USER_A), today_body(client, USER_B)
    assert other["sleepHours"] is None and other["readiness"]["score"] > mine["readiness"]["score"]


@pytest.mark.parametrize("body", [{"hours": -1}, {"hours": 17}, {}, {"hours": "lots"}, {"hours": None}])
def test_bad_sleep_is_a_validation_error_and_nothing_is_stored(client, repo, body):
    response = client.put("/api/v1/training/sleep", json=body, headers=headers())
    detail = response.json()["detail"]
    assert response.status_code == 422 and detail["code"] == "VALIDATION" and "hours" in detail["fieldErrors"]
    assert repo.sleep == {}


def test_sleep_can_be_cleared_again(client, repo):
    put_sleep(client, 6)
    assert client.delete("/api/v1/training/sleep", headers=headers()).status_code == 204
    assert repo.sleep == {} and today_body(client)["sleepHours"] is None


def test_the_sleep_routes_need_a_token(client, repo):
    assert client.put("/api/v1/training/sleep", json={"hours": 6}).status_code in (401, 403)
    assert client.delete("/api/v1/training/sleep").status_code in (401, 403)
    assert client.put("/api/v1/training/sleep", json={"hours": 6}, headers={"Authorization": "Bearer forged"}).status_code == 401
    assert repo.sleep == {}


def test_exam_dates_come_back_sorted_and_an_exam_that_has_passed_is_dropped(client):
    soon, later, gone = (TODAY + timedelta(days=3)).isoformat(), (TODAY + timedelta(days=10)).isoformat(), (TODAY - timedelta(days=1)).isoformat()
    saved = client.put("/api/v1/training/preferences", json={**PREFS, "examDates": [later, gone, soon]}, headers=headers()).json()
    assert saved["examDates"] == [soon, later]
    assert client.get("/api/v1/training/preferences", headers=headers()).json()["examDates"] == [soon, later]


def test_exam_dates_are_optional(client):
    assert client.put("/api/v1/training/preferences", json=PREFS, headers=headers()).json()["examDates"] == []


@pytest.mark.parametrize("dates", [
    [(TODAY + timedelta(days=i)).isoformat() for i in range(RULES.exam_dates_max + 1)],
    [(TODAY + timedelta(days=RULES.exam_dates_horizon_days + 1)).isoformat()],
    ["2026-13-45"],
    ["soon"],
])
def test_too_many_too_distant_or_malformed_exam_dates_are_field_errors(client, dates):
    response = client.put("/api/v1/training/preferences", json={**PREFS, "examDates": dates}, headers=headers())
    detail = response.json()["detail"]
    assert response.status_code == 422 and detail["code"] == "VALIDATION"
    assert any(key.startswith("examDates") for key in detail["fieldErrors"])
    assert client.get("/api/v1/training/preferences", headers=headers()).json() is None


def test_an_exam_date_lowers_todays_readiness_over_http(client):
    before = today_body(client)
    exam = (TODAY + timedelta(days=1)).isoformat()
    assert client.put("/api/v1/training/preferences", json={**PREFS, "examDates": [exam]}, headers=headers()).status_code == 200
    after = today_body(client)
    assert after["readiness"]["score"] < before["readiness"]["score"]
    assert any(f["key"] == "exam" and f["detail"] == "Exam in 1 day" for f in after["readiness"]["factors"])


def test_the_plan_reports_the_goal_it_was_built_for(client, repo):
    onboard(client, repo)
    assert generate(client).json()["goal"] is None  # no profile, no goal

    repo.profiles[USER_A] = AthleteProfile(fitness_goal="DEFICIT")
    plan = generate(client, confirm=True).json()
    assert plan["goal"] == "lose_weight"
    assert client.get("/api/v1/training/plan", headers=headers()).json()["goal"] == "lose_weight"


# ------------------------------------------------------------------ Home summary and the coach


class StubCoach:
    model = "gemini-2.5-flash"

    def __init__(self, reply="Keep it easy today."):
        self.reply, self.calls = reply, 0

    def complete(self, system, prompt):
        self.calls += 1
        return self.reply


def with_coach(app, repo, coach, clock=None):
    # One service for every request, like the deployed app, so what the coach remembers persists.
    service = TrainingService(repo, RuleBasedScorer(), coach=coach, clock=clock or (lambda: 1000.0))
    app.dependency_overrides[get_service] = lambda: service
    return TestClient(app)


def test_the_summary_is_one_call_with_everything_a_home_card_needs(client, repo):
    onboard(client, repo)
    generate(client)
    response = client.get("/api/v1/training/summary", headers=headers())
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"date", "hasPlan", "goal", "readiness", "today", "week", "nextSession"}
    assert body["hasPlan"] is True and body["today"]["state"] == "to_do"
    assert body["today"]["session"]["id"] and body["today"]["recommendation"]["explanation"]
    assert set(body["week"]) == {"start", "end", "plannedSessions", "completedSessions", "missedSessions", "loggedMinutes"}
    assert body["nextSession"]["date"] > body["date"]
    assert body["readiness"] == client.get("/api/v1/training/today", headers=headers()).json()["readiness"]


def test_the_summary_for_a_new_user_is_empty_but_valid(client):
    body = client.get("/api/v1/training/summary", headers=headers()).json()
    assert body["hasPlan"] is False and body["today"]["state"] == "no_plan" and body["nextSession"] is None
    assert body["week"]["plannedSessions"] == 0 and body["readiness"]["score"] >= 0


def test_the_summary_is_private_to_the_signed_in_user(client, repo):
    onboard(client, repo, USER_A)
    generate(client, user=USER_A)
    theirs = client.get("/api/v1/training/summary", headers=headers(USER_B)).json()
    assert theirs["hasPlan"] is False and theirs["today"]["session"] is None and theirs["week"]["loggedMinutes"] == 0


def test_the_summary_and_the_coach_need_a_real_token(client):
    for call in (lambda h: client.get("/api/v1/training/summary", headers=h),
                 lambda h: client.post("/api/v1/training/coach", headers=h)):
        assert call({}).status_code in (401, 403)
        assert call({"Authorization": "Bearer forged"}).status_code == 401


def test_the_coach_answers_with_gemini_text_a_notice_and_no_readiness(app, repo):
    onboard(TestClient(app), repo)
    client = with_coach(app, repo, StubCoach("Easy does it today."))
    generate(client)
    body = client.post("/api/v1/training/coach", headers=headers()).json()
    assert set(body) == {"date", "message", "source", "model", "cached", "notice"}
    assert body["message"] == "Easy does it today." and body["source"] == "gemini" and body["cached"] is False
    assert "not medical advice" in body["notice"]
    assert "readiness" not in str(body).lower() and "score" not in str(body).lower()


def test_the_same_coach_question_twice_costs_one_call(app, repo):
    coach = StubCoach()
    onboard(TestClient(app), repo)
    client = with_coach(app, repo, coach)
    generate(client)
    first = client.post("/api/v1/training/coach", headers=headers()).json()
    second = client.post("/api/v1/training/coach", headers=headers()).json()
    assert coach.calls == 1 and second["cached"] is True and second["message"] == first["message"]


def test_asking_again_after_things_changed_too_quickly_is_a_429_in_the_usual_error_shape(app, repo):
    coach = StubCoach()
    onboard(TestClient(app), repo)
    client = with_coach(app, repo, coach)
    generate(client)
    client.post("/api/v1/training/coach", headers=headers())
    session = sessions_of(client, TODAY, TODAY)[0]
    client.post(f"/api/v1/training/sessions/{session['id']}/log", headers=headers(),
                json={"date": TODAY.isoformat(), "activityType": "run", "actualDurationMin": 30,
                      "actualVolume": session["targetVolume"]})
    refused = client.post("/api/v1/training/coach", headers=headers())
    assert refused.status_code == 429 and refused.json()["detail"]["code"] == "RATE_LIMITED"
    assert coach.calls == 1


def test_without_a_gemini_key_the_coach_still_answers(client, repo):
    onboard(client, repo)
    generate(client)
    body = client.post("/api/v1/training/coach", headers=headers()).json()
    assert body["source"] == "fallback" and body["model"] is None and body["message"]


def test_the_coach_is_a_post_because_it_can_cost_money(client):
    assert client.get("/api/v1/training/coach", headers=headers()).status_code == 405


# ------------------------------------------------------------------ Hard Rule 4: readiness stays private


def _models_in(node, seen: set) -> set:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if ref:
            seen.add(ref.rsplit("/", 1)[-1])
        for value in node.values():
            _models_in(value, seen)
    elif isinstance(node, list):
        for value in node:
            _models_in(value, seen)
    return seen


def test_readiness_appears_in_exactly_three_operations():
    """
    Hard Rule 4: scores are never part of any plan, schedule, coach or friend-style response. The three
    that carry one are the user's own Today view, their own Home summary, and the stateless scoring call.
    Adding a fourth should be a decision, not an accident, so it has to be added here.
    """
    application = FastAPI()
    install(application)
    schema = application.openapi()
    components = schema["components"]["schemas"]

    def reachable(name: str, acc: set) -> set:
        if name in acc:
            return acc
        acc.add(name)
        for child in _models_in(components[name], set()):
            reachable(child, acc)
        return acc

    exposing = []
    for path, operations in schema["paths"].items():
        for method, operation in operations.items():
            direct = _models_in(operation.get("responses", {}), set())
            models = set().union(*[reachable(m, set()) for m in direct]) if direct else set()
            if {"ReadinessScore", "ReadinessFactor"} & models:
                exposing.append((method.upper(), path))

    assert sorted(exposing) == [
        ("GET", "/api/v1/training/summary"),
        ("GET", "/api/v1/training/today"),
        ("POST", "/api/v1/readiness/score"),
    ]
    assert ("POST", "/api/v1/training/coach") not in exposing


# ------------------------------------------------------------------ contract with the frontend


TYPES_FILE = Path(__file__).resolve().parents[3] / "frontend" / "lib" / "training" / "types.ts"


API_FILE = TYPES_FILE.with_name("api.ts")


def _interface_fields(name: str, file: Path = TYPES_FILE) -> set:
    source = file.read_text(encoding="utf-8")
    body = re.search(rf"export interface {name} \{{(.*?)\n\}}", source, re.S).group(1)
    return set(re.findall(r"^\s+(\w+)\??:", body, re.M))


@pytest.mark.skipif(not TYPES_FILE.exists(), reason="frontend types not present")
def test_responses_contain_every_field_the_frontend_types_declare(client, repo):
    """The frontend reads these fields; a rename or omission here would break it silently."""
    onboard(client, repo)
    generate(client)
    saturday = sessions_of(client, TODAY, TODAY + timedelta(days=3))[0]
    client.post(f"/api/v1/training/sessions/{saturday['id']}/log", headers=headers(),
                json={"date": TODAY.isoformat(), "activityType": "run", "actualDurationMin": 30, "actualVolume": 25, "rpe": 5, "avgHr": 140})
    client.post("/api/v1/training/plan/recalculate", headers=headers())
    added = client.post(ADD, json=add_body(date="2026-10-01"), headers=headers()).json()

    plan = client.get("/api/v1/training/plan", headers=headers()).json()
    today = client.get("/api/v1/training/today", headers=headers()).json()
    schedule = client.get(f"/api/v1/training/schedule?from={TODAY}&to={TODAY + timedelta(days=6)}", headers=headers()).json()
    summary = client.get("/api/v1/training/summary", headers=headers()).json()
    coach = client.post("/api/v1/training/coach", headers=headers()).json()

    checks = {
        "TrainingPreferences": client.get("/api/v1/training/preferences", headers=headers()).json(),
        "TrainingPlan": plan,
        "PlanAdaptation": plan["lastAdaptation"],
        "PlannedSession": schedule["sessions"][0],
        "WorkoutSession": schedule["workouts"][0],
        "ReadinessScore": today["readiness"],
        "ReadinessFactor": today["readiness"]["factors"][0],
        "SessionRecommendation": today["recommendation"],
        "TodayView": today,
        "Schedule": schedule,
        "TrainingSummary": summary,
        "TodaySummary": summary["today"],
        "WeekProgress": summary["week"],
        "NextSession": summary["nextSession"],
        "CoachMessage": coach,
    }
    for name, payload in checks.items():
        missing = _interface_fields(name) - set(payload)
        assert not missing, f"{name} is missing {sorted(missing)}"
    assert _interface_fields("AddSessionResult", API_FILE) <= set(added), "AddSessionResult"
    assert _interface_fields("PlannedSession") <= set(added["session"])


# ------------------------------------------------------------------ readiness model


def test_the_model_endpoint_needs_a_token_and_holds_no_user_data(client):
    assert client.get("/api/v1/readiness/model").status_code in (401, 403)
    response = client.get("/api/v1/readiness/model", headers=headers())
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "rules" and body["version"] == RuleBasedScorer.version
    assert USER_A not in response.text


def test_scoring_over_http_works_with_the_trained_model(app, repo):
    app.dependency_overrides[get_service] = lambda: TrainingService(repo, load_scorer())
    client = TestClient(app)

    info = client.get("/api/v1/readiness/model", headers=headers()).json()
    assert info["kind"] == "model" and "synthetic" in info["trainedOn"] and info["fallbackReason"] is None

    response = client.post(
        "/api/v1/readiness/score",
        json={"acwr": 1.8, "sleepHours": 4, "checkinLoadRating": 5},
        headers=headers(),
    )
    body = response.json()
    assert response.status_code == 200
    assert body["classification"] == "deload" and 0 <= body["score"] <= 100
    assert body["factors"] and {"key", "label", "impact", "detail"} <= set(body["factors"][0])


def test_the_app_as_deployed_builds_its_service_on_the_trained_model(monkeypatch):
    monkeypatch.setattr(router_module, "create_repository", lambda: FakeTrainingRepository())
    router_module._default_service.cache_clear()
    try:
        assert isinstance(router_module._default_service().scorer, ModelScorer)
    finally:
        router_module._default_service.cache_clear()

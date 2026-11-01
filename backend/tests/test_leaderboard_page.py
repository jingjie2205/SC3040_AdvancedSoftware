"""
The leaderboard page, run through the same API calls the page makes (frontend/lib/gamification/http-api.ts).
The test_lt<n> tests are test cases LT-1 to LT-5 in the Test Coverage Report.

Uses the in-memory Supabase from test_gamification.py, so nothing here talks to a real database.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.main import app
from app.commons.auth.deps import get_current_user_id
from app.controllers import gamification as gamification_controller
from app.services import gamification as svc
from test_gamification import (
    ALICE, BOB, CAROL, DAVE, METRICS, TODAY, FakeSupabase, add_xp_event, befriend, hold, log_run,
)

NAMES = {ALICE: "Alice Wong", BOB: "Bob Tan", CAROL: "Carol Lim", DAVE: "Dave Ng"}
NOON_TODAY_SGT = datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc)


@pytest.fixture
def sb():
    """Alice is friends with Bob and Carol. Dave has only sent Alice a request, so he isn't a friend yet."""
    fake = FakeSupabase()
    befriend(fake, ALICE, BOB)
    befriend(fake, CAROL, ALICE)
    befriend(fake, DAVE, ALICE, status="pending")
    fake.db["users"] = [{"user_id": uid, "name": name} for uid, name in NAMES.items()]
    return fake


@pytest.fixture
def clock(monkeypatch):
    """Freezes the server's clock at the given UTC time; today_local() works out Singapore's date from it."""
    def set_clock(utc):
        class FrozenDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return utc.astimezone(tz)

        monkeypatch.setattr(svc, "datetime", FrozenDatetime)

    set_clock(NOON_TODAY_SGT)
    return set_clock


@pytest.fixture
def api(sb, clock, monkeypatch):
    monkeypatch.setattr(gamification_controller, "get_supabase_admin", lambda: sb)
    sign_in(ALICE)
    # A server error comes back as the 500 response the page would get, instead of being raised here.
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def sign_in(user_id):
    app.dependency_overrides[get_current_user_id] = lambda: user_id


def board(api, metric):
    return api.get("/gamification/leaderboard", params={"metric": metric}).json()


def challenge_body(**override):
    return {
        "title": "Week of grind",
        "metric": "sessions",
        "targetValue": 2,
        "startDate": TODAY.isoformat(),
        "endDate": (TODAY + timedelta(days=6)).isoformat(),
        "inviteeIds": [BOB, CAROL],
        **override,
    }


def respond(api, challenge_id, accept):
    return api.post(f"/gamification/challenges/{challenge_id}/respond", json={"accept": accept})


def fail_inserts(sb, monkeypatch, table):
    """Inserts into table fail the way PostgREST reports a database it can't reach."""
    real_table = sb.table

    def table_(name):
        query = real_table(name)
        if name == table:
            real_execute = query.execute

            def execute():
                if query.op == "insert":
                    raise APIError({"code": "PGRST000", "message": "Could not connect with the database"})
                return real_execute()

            query.execute = execute
        return query

    monkeypatch.setattr(sb, "table", table_)


# --- The leaderboard panel (G-3) ---------------------------------------------

def test_lt1_leaderboard_ranks_the_user_and_friends_by_xp(api, sb):
    for uid, workouts in ((ALICE, 1), (BOB, 2), (DAVE, 5)):
        for _ in range(workouts):
            svc.award_xp(sb, uid, "workout", 50, str(uuid.uuid4()))

    xp = api.get("/gamification/leaderboard").json()  # the page opens on XP

    assert xp["metric"] == "xp"
    assert xp["friendCount"] == 2
    assert [(e["position"], e["displayName"], e["totalXp"], e["rank"]) for e in xp["entries"]] == [
        (1, "Bob Tan", 100, "Bronze"),
        (2, "Alice Wong", 50, "Beginner"),
        (3, "Carol Lim", 0, "Beginner"),
    ]
    assert [e["isCurrentUser"] for e in xp["entries"]] == [False, True, False]


def test_switching_the_metric_reranks_by_streak_and_by_mileage(api, sb):
    for offset in (1, 0):
        svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=offset))
    svc.perform_checkin(sb, BOB, METRICS, TODAY)
    svc.perform_checkin(sb, CAROL, METRICS, TODAY - timedelta(days=3))  # her streak has lapsed
    log_run(sb, BOB, 10.3)
    log_run(sb, BOB, 5, day=TODAY - timedelta(days=29))
    log_run(sb, BOB, 42, day=TODAY - timedelta(days=30))  # outside the 30-day window
    log_run(sb, ALICE, 8, source="manual")
    log_run(sb, CAROL, 20, activity_type="cycling")

    streak = board(api, "streak")
    mileage = board(api, "mileage")

    assert streak["metric"] == "streak"
    assert [(e["displayName"], e["currentStreak"]) for e in streak["entries"]] == [("Alice Wong", 2), ("Bob Tan", 1)]
    assert mileage["metric"] == "mileage"
    assert [(e["displayName"], e["mileageKm"]) for e in mileage["entries"]] == [
        ("Bob Tan", 15.3),
        ("Alice Wong", 8.0),
        ("Carol Lim", 0.0),
    ]


def test_user_without_friends_gets_the_empty_state(api, sb):
    sign_in(DAVE)

    for metric in ("xp", "streak", "mileage"):
        assert board(api, metric)["friendCount"] == 0

    # Alice accepts Dave's request on the Friends page
    next(r for r in sb.db["friend_requests"] if r["sender_id"] == DAVE)["status"] = "accepted"
    xp = board(api, "xp")

    assert xp["friendCount"] == 1
    assert {e["displayName"] for e in xp["entries"]} == {"Dave Ng", "Alice Wong"}


# --- The daily check-in panel (G-1) ------------------------------------------

def test_lt2_daily_check_in_awards_xp_and_extends_the_streak(api, clock):
    clock(datetime(2026, 10, 4, 4, 0, tzinfo=timezone.utc))  # noon on 4 Oct in Singapore
    before = api.get("/gamification/me").json()
    assert (before["checkedInToday"], before["currentStreak"], before["totalXp"]) == (False, 0, 0)

    first = api.post("/gamification/checkins", json=METRICS)
    me = api.get("/gamification/me").json()

    assert first.status_code == 201
    assert (first.json()["xpAwarded"], first.json()["currentStreak"]) == (10, 1)
    assert me["checkedInToday"] is True
    assert (me["totalXp"], me["rank"], me["nextRank"], me["xpToNextRank"]) == (10, "Beginner", "Bronze", 90)

    # 00:30 on 5 Oct in Singapore is still 4 Oct in UTC, but it is a new day for the user
    clock(datetime(2026, 10, 4, 16, 30, tzinfo=timezone.utc))
    assert api.get("/gamification/me").json()["checkedInToday"] is False
    second = api.post("/gamification/checkins", json=METRICS).json()

    assert (second["date"], second["xpAwarded"], second["currentStreak"], second["totalXp"]) == (
        "2026-10-05", 12, 2, 22,
    )


def test_lt3_second_check_in_on_the_same_day_is_refused(api, sb):
    assert api.post("/gamification/checkins", json=METRICS).status_code == 201

    again = api.post("/gamification/checkins", json=METRICS)
    me = api.get("/gamification/me").json()

    assert again.status_code == 409
    assert again.json()["detail"] == "You have already checked in today"
    assert (me["checkedInToday"], me["totalXp"], me["currentStreak"]) == (True, 10, 1)

    # Bob submits from two tabs at once: the other tab's row lands first, so this one hits the
    # one-check-in-per-day constraint even though his stats haven't caught up yet
    sign_in(BOB)
    sb.db["daily_checkins"].append({"id": str(uuid.uuid4()), "user_id": BOB, "date": TODAY.isoformat()})

    race = api.post("/gamification/checkins", json=METRICS)

    assert race.status_code == 409
    assert not [e for e in sb.db["xp_events"] if e["user_id"] == BOB]


@pytest.mark.parametrize(
    "answers",
    [
        {"muscleFatigue": 3, "mood": 4},  # a question left unanswered
        {**METRICS, "mood": 0},
        {**METRICS, "dietAdherence": 6},
        {**METRICS, "muscleFatigue": 3.5},
    ],
)
def test_check_in_answers_must_be_whole_numbers_from_1_to_5(api, sb, answers):
    response = api.post("/gamification/checkins", json=answers)

    assert response.status_code == 422
    assert not sb.db.get("daily_checkins")
    assert api.get("/gamification/me").json()["checkedInToday"] is False


def test_database_outage_returns_an_error_and_saves_nothing(api, sb, monkeypatch):
    fail_inserts(sb, monkeypatch, "daily_checkins")

    checkin = api.post("/gamification/checkins", json=METRICS)
    me = api.get("/gamification/me").json()

    assert checkin.status_code == 500
    assert (me["checkedInToday"], me["currentStreak"], me["totalXp"]) == (False, 0, 0)
    assert not sb.db.get("xp_events")

    # The challenge is saved before its participants, so a failure there must undo it
    fail_inserts(sb, monkeypatch, "challenge_participants")

    assert api.post("/gamification/challenges", json=challenge_body()).status_code == 500
    assert not sb.db.get("challenges")


# --- XP on hold and Recent XP (G-2) ------------------------------------------

def test_lt4_xp_on_hold_is_listed_and_paid_after_a_resync(api, sb):
    meal = str(uuid.uuid4())
    sb.db["meal_plans"] = [{"log_id": meal, "total_calories": None}]
    hold(sb, ALICE, "meal", meal, 10, "no calorie estimate")

    pending = api.get("/gamification/pending-xp").json()
    unchanged = api.post("/gamification/pending-xp/resync").json()

    assert pending["totalXp"] == 10
    assert [(i["source"], i["amount"], i["reason"]) for i in pending["items"]] == [("meal", 10, "no calorie estimate")]
    assert (unchanged["awardedXp"], unchanged["stillPending"], unchanged["totalXp"]) == (0, 1, 10)

    sb.db["meal_plans"][0]["total_calories"] = 650  # the user adds the meal's calories
    synced = api.post("/gamification/pending-xp/resync").json()

    assert (synced["awardedXp"], synced["released"], synced["items"], synced["totalXp"]) == (10, 1, [], 0)
    assert api.get("/gamification/me").json()["totalXp"] == 10
    assert api.get("/gamification/pending-xp").json()["items"] == []


def test_recent_xp_shows_the_users_latest_20_awards_newest_first(api, sb):
    assert api.get("/gamification/xp-events").json()["events"] == []

    for minute in range(25):
        add_xp_event(sb, ALICE, "meal", 10, datetime(2026, 10, 3, 1, minute, tzinfo=timezone.utc))
    add_xp_event(sb, ALICE, "workout", 50, datetime(2026, 10, 4, 2, 0, tzinfo=timezone.utc))
    add_xp_event(sb, BOB, "workout", 50, datetime(2026, 10, 5, 3, 0, tzinfo=timezone.utc))
    api.post("/gamification/checkins", json=METRICS)

    events = api.get("/gamification/xp-events").json()["events"]

    assert len(events) == 20
    assert [(e["source"], e["amount"]) for e in events[:3]] == [("checkin", 10), ("workout", 50), ("meal", 10)]


# --- Challenges (G-4) --------------------------------------------------------

def test_create_a_challenge_and_invite_friends(api):
    # The form's invite list is the XP leaderboard without the user
    invitable = [e["displayName"] for e in board(api, "xp")["entries"] if not e["isCurrentUser"]]
    assert sorted(invitable) == ["Bob Tan", "Carol Lim"]

    created = api.post("/gamification/challenges", json=challenge_body(title="  Week of grind  "))
    challenge = created.json()

    assert created.status_code == 201
    assert (challenge["title"], challenge["status"], challenge["myStatus"], challenge["rewardXp"]) == (
        "Week of grind", "active", "accepted", 100,
    )
    assert [(p["displayName"], p["status"], p["progress"]) for p in challenge["participants"]] == [
        ("Alice Wong", "accepted", 0),
        ("Bob Tan", "invited", 0),
        ("Carol Lim", "invited", 0),
    ]
    assert [c["id"] for c in api.get("/gamification/challenges").json()["challenges"]] == [challenge["id"]]

    next_week = challenge_body(
        startDate=(TODAY + timedelta(days=7)).isoformat(), endDate=(TODAY + timedelta(days=13)).isoformat()
    )
    assert api.post("/gamification/challenges", json=next_week).json()["status"] == "upcoming"


@pytest.mark.parametrize(
    "override",
    [
        {"title": "   "},
        {"title": "x" * 101},
        {"targetValue": 0},
        {"targetValue": 1.5},
        {"startDate": (TODAY - timedelta(days=1)).isoformat()},
        {"endDate": (TODAY - timedelta(days=1)).isoformat()},
        {"inviteeIds": [str(uuid.uuid4()) for _ in range(21)]},
    ],
)
def test_challenge_form_values_are_checked_on_the_server(api, sb, override):
    assert api.post("/gamification/challenges", json=challenge_body(**override)).status_code == 422
    assert not sb.db.get("challenges")


def test_inviting_someone_who_is_not_a_friend_is_blocked(api, sb):
    stranger = api.post("/gamification/challenges", json=challenge_body(inviteeIds=[BOB, DAVE]))

    assert stranger.status_code == 422
    assert stranger.json()["detail"] == "You can only invite your friends"
    assert not sb.db.get("challenges")

    sb.db["missing_users"] = {CAROL}  # Carol deleted her account
    deleted = api.post("/gamification/challenges", json=challenge_body())

    assert deleted.status_code == 422
    assert deleted.json()["detail"] == "One or more invited athletes don't exist"
    assert not sb.db.get("challenges")


def test_lt5_accepting_an_invite_tracks_progress_and_pays_the_reward_once(api, sb):
    challenge_id = api.post("/gamification/challenges", json=challenge_body()).json()["id"]

    sign_in(BOB)
    [invite] = api.get("/gamification/challenges").json()["challenges"]
    accepted = respond(api, challenge_id, True)

    assert (invite["myStatus"], invite["creatorName"]) == ("invited", "Alice Wong")
    assert accepted.status_code == 200
    assert accepted.json()["myStatus"] == "accepted"

    for _ in range(2):
        svc.award_xp(sb, BOB, "workout", 50, str(uuid.uuid4()))  # what logging a workout does
    [done] = api.get("/gamification/challenges").json()["challenges"]
    api.get("/gamification/challenges")  # opening the page again must not pay twice

    bob = next(p for p in done["participants"] if p["isCurrentUser"])
    assert (bob["progress"], bob["completed"]) == (2, True)
    assert api.get("/gamification/me").json()["totalXp"] == 2 * 50 + 100
    assert [e["source"] for e in api.get("/gamification/xp-events").json()["events"]].count("challenge") == 1

    again = respond(api, challenge_id, True)
    assert again.status_code == 409
    assert again.json()["detail"] == "You have already responded to this challenge"


def test_declined_invites_disappear_and_ended_ones_cannot_be_answered(api, clock):
    challenge_id = api.post("/gamification/challenges", json=challenge_body(endDate=TODAY.isoformat())).json()["id"]

    sign_in(BOB)
    declined = respond(api, challenge_id, False)

    assert declined.status_code == 200
    assert api.get("/gamification/challenges").json()["challenges"] == []

    sign_in(ALICE)
    [mine] = api.get("/gamification/challenges").json()["challenges"]
    assert [(p["displayName"], p["status"]) for p in mine["participants"]] == [
        ("Alice Wong", "accepted"),
        ("Carol Lim", "invited"),
    ]

    clock(datetime(2026, 10, 6, 4, 0, tzinfo=timezone.utc))  # the day after it ended
    sign_in(CAROL)
    late = respond(api, challenge_id, True)

    assert late.status_code == 409
    assert late.json()["detail"] == "This challenge has ended"
    assert respond(api, str(uuid.uuid4()), True).status_code == 404


# --- Signed-out access -------------------------------------------------------

@pytest.mark.parametrize(
    "method, path, body",
    [
        ("GET", "/gamification/me", None),
        ("GET", "/gamification/leaderboard", None),
        ("GET", "/gamification/xp-events", None),
        ("GET", "/gamification/pending-xp", None),
        ("POST", "/gamification/pending-xp/resync", None),
        ("POST", "/gamification/checkins", METRICS),
        ("GET", "/gamification/challenges", None),
        ("POST", "/gamification/challenges", challenge_body()),
    ],
)
def test_page_data_needs_a_signed_in_user(method, path, body):
    response = TestClient(app).request(method, path, json=body)

    assert response.status_code in (401, 403)

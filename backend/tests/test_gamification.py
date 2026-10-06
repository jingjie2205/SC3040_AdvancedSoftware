import os
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")

from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.main import app
from app.commons.auth.deps import get_current_user_id
from app.controllers import gamification as gamification_controller
from app.models.gamification import LeaderboardMetric
from app.services import gamification as svc

TODAY = date(2026, 10, 5)
ALICE = "00000000-0000-0000-0000-00000000000a"
BOB = "00000000-0000-0000-0000-00000000000b"
CAROL = "00000000-0000-0000-0000-00000000000c"


# ---------------------------------------------------------------------------
# In-memory stand-in for the Supabase query builder, mirroring the unique
# constraints in supabase/schema.sql that the service relies on.
# ---------------------------------------------------------------------------
UNIQUE_KEYS = {
    "gamification_stats": ("user_id",),
    "daily_checkins": ("user_id", "date"),
    "xp_events": ("source", "source_id"),
    "challenge_participants": ("challenge_id", "user_id"),
}
DEFAULTS = {
    "gamification_stats": {"total_xp": 0, "current_streak": 0, "longest_streak": 0, "last_check_in_date": None},
}


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.op, self.payload = [], "select", None
        self._order, self._limit = None, None

    def select(self, *_):
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def neq(self, col, val):
        self.filters.append(lambda r: r.get(col) != val)
        return self

    def in_(self, col, vals):
        self.filters.append(lambda r: r.get(col) in vals)
        return self

    def gte(self, col, val):
        self.filters.append(lambda r: r.get(col) is not None and r[col] >= val)
        return self

    def lte(self, col, val):
        self.filters.append(lambda r: r.get(col) is not None and r[col] <= val)
        return self

    def lt(self, col, val):
        self.filters.append(lambda r: r.get(col) is not None and r[col] < val)
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def upsert(self, payload, on_conflict):
        self.op, self.payload = "upsert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def _key(self, row):
        return tuple(row.get(c) for c in UNIQUE_KEYS.get(self.table, ()))

    def _find_conflict(self, row):
        key = self._key(row)
        if not key or None in key:
            return None
        return next((r for r in self.db[self.table] if self._key(r) == key), None)

    def execute(self):
        rows = self.db.setdefault(self.table, [])
        if self.op == "insert":
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            for p in payloads:
                if p.get("user_id") in self.db.get("missing_users", ()):
                    raise APIError({"code": "23503", "message": "foreign key violation"})
                if self._find_conflict(p):
                    raise APIError({"code": "23505", "message": "duplicate key"})
            inserted = [{"id": str(uuid.uuid4()), **DEFAULTS.get(self.table, {}), **p} for p in payloads]
            rows.extend(inserted)
            return SimpleNamespace(data=inserted)
        if self.op == "upsert":
            existing = self._find_conflict(self.payload)
            if existing:
                existing.update(self.payload)
                return SimpleNamespace(data=[existing])
            row = {**DEFAULTS.get(self.table, {}), **self.payload}
            rows.append(row)
            return SimpleNamespace(data=[row])

        matched = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in matched:
                r.update(self.payload)
            return SimpleNamespace(data=matched)
        if self.op == "delete":
            self.db[self.table] = [r for r in rows if r not in matched]
            return SimpleNamespace(data=matched)
        if self._order:
            col, desc = self._order
            matched = sorted(matched, key=lambda r: r[col], reverse=desc)
        if self._limit is not None:
            matched = matched[: self._limit]
        return SimpleNamespace(data=[dict(r) for r in matched])


class FakeSupabase:
    def __init__(self):
        self.db = {}

    def table(self, name):
        return FakeQuery(self.db, name)


METRICS = {"muscleFatigue": 3, "mood": 4, "dietAdherence": 5}


@pytest.fixture
def sb():
    return FakeSupabase()


# --- Pure rules -------------------------------------------------------------

@pytest.mark.parametrize(
    "last, current, expected",
    [
        (None, 0, 1),                          # first ever check-in
        (TODAY - timedelta(days=1), 4, 5),     # consecutive day continues streak
        (TODAY - timedelta(days=2), 4, 1),     # missed a day resets
        (TODAY, 4, 4),                         # same day leaves streak unchanged
    ],
)
def test_next_streak(last, current, expected):
    assert svc.next_streak(last, current, TODAY) == expected


def test_effective_streak_is_zero_once_a_day_is_missed():
    assert svc.effective_streak(TODAY - timedelta(days=1), 6, TODAY) == 6
    assert svc.effective_streak(TODAY - timedelta(days=2), 6, TODAY) == 0
    assert svc.effective_streak(None, 0, TODAY) == 0


def test_checkin_xp_bonus_grows_then_caps_at_a_week():
    assert svc.checkin_xp(1) == 10
    assert svc.checkin_xp(2) == 12
    assert svc.checkin_xp(7) == 22
    assert svc.checkin_xp(30) == 22


@pytest.mark.parametrize(
    "xp, expected",
    [
        (0, ("Beginner", "Bronze", 100)),
        (99, ("Beginner", "Bronze", 1)),
        (100, ("Bronze", "Silver", 400)),
        (3999, ("Gold", "Platinum", 1)),
        (4000, ("Platinum", None, None)),
    ],
)
def test_rank_for_xp_boundaries(xp, expected):
    assert svc.rank_for_xp(xp) == expected


# --- Service against the fake database --------------------------------------

def test_first_checkin_creates_stats(sb):
    result = svc.perform_checkin(sb, ALICE, METRICS, TODAY)

    assert result["currentStreak"] == 1
    assert result["xpAwarded"] == 10
    assert result["totalXp"] == 10
    stats = svc.get_stats(sb, ALICE, TODAY)
    assert stats["checkedInToday"] is True
    assert stats["longestStreak"] == 1
    assert len(sb.db["xp_events"]) == 1


def test_consecutive_checkins_extend_streak_and_bonus(sb):
    svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=1))
    result = svc.perform_checkin(sb, ALICE, METRICS, TODAY)

    assert result["currentStreak"] == 2
    assert result["xpAwarded"] == 12
    assert result["totalXp"] == 22


def test_gap_resets_streak_but_keeps_longest(sb):
    for offset in (5, 4, 3):
        svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=offset))
    result = svc.perform_checkin(sb, ALICE, METRICS, TODAY)

    assert result["currentStreak"] == 1
    assert svc.get_stats(sb, ALICE, TODAY)["longestStreak"] == 3


def test_second_checkin_same_day_is_rejected(sb):
    svc.perform_checkin(sb, ALICE, METRICS, TODAY)
    with pytest.raises(svc.AlreadyCheckedInError):
        svc.perform_checkin(sb, ALICE, METRICS, TODAY)
    assert svc.get_stats(sb, ALICE, TODAY)["totalXp"] == 10


def test_award_xp_is_idempotent_per_source(sb):
    meal_id = str(uuid.uuid4())
    assert svc.award_xp(sb, ALICE, "meal", 10, meal_id) == 10
    assert svc.award_xp(sb, ALICE, "meal", 10, meal_id) == 10
    assert svc.award_xp(sb, ALICE, "workout", 50, str(uuid.uuid4())) == 60


def test_stats_for_new_user_are_zero(sb):
    stats = svc.get_stats(sb, BOB, TODAY)
    assert stats["totalXp"] == 0
    assert stats["rank"] == "Beginner"
    assert stats["checkedInToday"] is False


def test_leaderboard_by_xp_orders_and_flags_current_user(sb):
    svc.award_xp(sb, ALICE, "workout", 50, str(uuid.uuid4()))
    svc.award_xp(sb, BOB, "workout", 50, str(uuid.uuid4()))
    svc.award_xp(sb, BOB, "meal", 10, str(uuid.uuid4()))

    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 10, TODAY)

    assert [e["userId"] for e in entries] == [BOB, ALICE]
    assert [e["position"] for e in entries] == [1, 2]
    assert entries[1]["isCurrentUser"] is True


def test_leaderboard_by_streak_excludes_broken_streaks(sb):
    for offset in (4, 3, 2):  # Alice's 3-day streak ended two days ago
        svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=offset))
    svc.perform_checkin(sb, BOB, METRICS, TODAY)

    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.STREAK, 10, TODAY)

    assert [e["userId"] for e in entries] == [BOB]


# --- HTTP layer -------------------------------------------------------------

@pytest.fixture
def client(sb, monkeypatch):
    monkeypatch.setattr(gamification_controller, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(svc, "today_local", lambda: TODAY)
    app.dependency_overrides[get_current_user_id] = lambda: ALICE
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_checkin_endpoint_then_conflict(client):
    first = client.post("/gamification/checkins", json=METRICS)
    assert first.status_code == 201
    assert first.json()["currentStreak"] == 1

    second = client.post("/gamification/checkins", json=METRICS)
    assert second.status_code == 409


def test_checkin_endpoint_validates_scale(client):
    response = client.post("/gamification/checkins", json={**METRICS, "mood": 6})
    assert response.status_code == 422


def test_stats_and_leaderboard_endpoints(client):
    client.post("/gamification/checkins", json=METRICS)

    stats = client.get("/gamification/me").json()
    assert stats["totalXp"] == 10
    assert stats["xpToNextRank"] == 90

    board = client.get("/gamification/leaderboard", params={"metric": "streak"}).json()
    assert board["metric"] == "streak"
    assert board["entries"][0]["isCurrentUser"] is True


def test_endpoints_require_auth():
    assert TestClient(app).get("/gamification/me").status_code in (401, 403)


# --- Challenges ---------------------------------------------------------------

def make_challenge(sb, metric="xp", target=100, start=TODAY, end=TODAY + timedelta(days=6), invitees=(BOB,)):
    return svc.create_challenge(
        sb,
        ALICE,
        {
            "title": "Week of grind",
            "metric": metric,
            "targetValue": target,
            "startDate": start,
            "endDate": end,
            "inviteeIds": list(invitees),
        },
        TODAY,
    )


def add_xp_event(sb, user_id, source, amount, at_utc):
    sb.db.setdefault("xp_events", []).append(
        {"user_id": user_id, "source": source, "amount": amount, "created_at": at_utc.isoformat()}
    )


def test_longest_run_counts_consecutive_days_only():
    days = [TODAY, TODAY - timedelta(days=1), TODAY - timedelta(days=3), TODAY - timedelta(days=1)]
    assert svc.longest_run(days) == 2
    assert svc.longest_run([]) == 0


def test_challenge_status_from_dates():
    assert svc.challenge_status(TODAY + timedelta(days=1), TODAY + timedelta(days=2), TODAY) == "upcoming"
    assert svc.challenge_status(TODAY, TODAY, TODAY) == "active"
    assert svc.challenge_status(TODAY - timedelta(days=2), TODAY - timedelta(days=1), TODAY) == "ended"


def test_create_challenge_accepts_creator_and_invites_others_once(sb):
    challenge = make_challenge(sb, invitees=(BOB, BOB, ALICE))

    assert challenge["myStatus"] == "accepted"
    assert challenge["status"] == "active"
    assert [(p["userId"], p["status"]) for p in challenge["participants"]] == [
        (ALICE, "accepted"),
        (BOB, "invited"),
    ]


def test_create_challenge_rejects_past_start(sb):
    with pytest.raises(svc.InvalidChallengeError):
        make_challenge(sb, start=TODAY - timedelta(days=1))


def test_create_challenge_with_unknown_invitee_leaves_nothing_behind(sb):
    sb.db["missing_users"] = {CAROL}
    with pytest.raises(svc.InvalidChallengeError):
        make_challenge(sb, invitees=(BOB, CAROL))
    assert sb.db["challenges"] == []


def test_xp_progress_counts_only_events_inside_the_local_window(sb):
    challenge = make_challenge(sb, target=50)
    # 00:30 on the start day in Singapore is still the previous day in UTC
    add_xp_event(sb, ALICE, "checkin", 30, datetime(2026, 10, 4, 16, 30, tzinfo=timezone.utc))
    add_xp_event(sb, ALICE, "meal", 10, datetime(2026, 10, 4, 15, 30, tzinfo=timezone.utc))
    add_xp_event(sb, ALICE, "workout", 50, datetime(2026, 10, 11, 16, 30, tzinfo=timezone.utc))

    [listed] = svc.list_challenges(sb, ALICE, TODAY)

    me = listed["participants"][0]
    assert listed["id"] == challenge["id"]
    assert me["progress"] == 30
    assert me["completed"] is False


def test_sessions_progress_counts_workouts_only(sb):
    make_challenge(sb, metric="sessions", target=2)
    at = datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc)
    add_xp_event(sb, ALICE, "workout", 50, at)
    add_xp_event(sb, ALICE, "workout", 50, at)
    add_xp_event(sb, ALICE, "meal", 10, at)

    me = svc.list_challenges(sb, ALICE, TODAY)[0]["participants"][0]

    assert me["progress"] == 2
    assert me["completed"] is True


def test_checkin_streak_progress_uses_longest_run_in_window(sb):
    make_challenge(sb, metric="checkin_streak", target=3)
    for offset in (1, 0):  # the day before the challenge starts doesn't count
        svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=offset))
    svc.perform_checkin(sb, ALICE, METRICS, TODAY + timedelta(days=1))

    me = svc.list_challenges(sb, ALICE, TODAY + timedelta(days=1))[0]["participants"][0]

    assert me["progress"] == 2


def test_invitee_sees_invite_and_progress_starts_after_accepting(sb):
    challenge = make_challenge(sb)
    add_xp_event(sb, BOB, "workout", 50, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))

    [invite] = svc.list_challenges(sb, BOB, TODAY)
    assert invite["myStatus"] == "invited"
    assert next(p for p in invite["participants"] if p["isCurrentUser"])["progress"] == 0

    accepted = svc.respond_to_challenge(sb, BOB, challenge["id"], True, TODAY)

    assert accepted["myStatus"] == "accepted"
    assert accepted["participants"][0]["userId"] == BOB
    assert accepted["participants"][0]["progress"] == 50


def test_declined_challenge_is_hidden(sb):
    challenge = make_challenge(sb)
    svc.respond_to_challenge(sb, BOB, challenge["id"], False, TODAY)

    assert svc.list_challenges(sb, BOB, TODAY) == []
    assert [p["userId"] for p in svc.list_challenges(sb, ALICE, TODAY)[0]["participants"]] == [ALICE]


def test_respond_errors(sb):
    challenge = make_challenge(sb, end=TODAY)
    with pytest.raises(svc.ChallengeNotFoundError):
        svc.respond_to_challenge(sb, CAROL, challenge["id"], True, TODAY)
    with pytest.raises(svc.ChallengeConflictError):
        svc.respond_to_challenge(sb, ALICE, challenge["id"], True, TODAY)
    with pytest.raises(svc.ChallengeConflictError):
        svc.respond_to_challenge(sb, BOB, challenge["id"], True, TODAY + timedelta(days=1))


def test_challenge_endpoints(client):
    body = {
        "title": "  Ten workouts  ",
        "metric": "sessions",
        "targetValue": 10,
        "startDate": TODAY.isoformat(),
        "endDate": (TODAY + timedelta(days=13)).isoformat(),
        "inviteeIds": [BOB],
    }
    created = client.post("/gamification/challenges", json=body)
    assert created.status_code == 201
    assert created.json()["title"] == "Ten workouts"

    listed = client.get("/gamification/challenges").json()["challenges"]
    assert [c["id"] for c in listed] == [created.json()["id"]]

    assert client.post(f"/gamification/challenges/{uuid.uuid4()}/respond", json={"accept": True}).status_code == 404
    assert client.post(f"/gamification/challenges/{created.json()['id']}/respond", json={"accept": True}).status_code == 409


@pytest.mark.parametrize(
    "override",
    [
        {"endDate": (TODAY - timedelta(days=1)).isoformat()},
        {"startDate": (TODAY - timedelta(days=1)).isoformat()},
        {"title": "   "},
        {"targetValue": 0},
        {"inviteeIds": ["not-a-uuid"]},
    ],
)
def test_create_challenge_endpoint_validation(client, override):
    body = {
        "title": "Streak battle",
        "metric": "checkin_streak",
        "targetValue": 5,
        "startDate": TODAY.isoformat(),
        "endDate": TODAY.isoformat(),
        **override,
    }
    assert client.post("/gamification/challenges", json=body).status_code == 422

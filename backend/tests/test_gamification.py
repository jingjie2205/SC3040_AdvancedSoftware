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
DAVE = "00000000-0000-0000-0000-00000000000d"


# ---------------------------------------------------------------------------
# In-memory stand-in for the Supabase query builder, mirroring the unique
# constraints in supabase/schema.sql that the service relies on.
# ---------------------------------------------------------------------------
UNIQUE_KEYS = {
    "gamification_user_stats": ("user_id",),
    "daily_checkins": ("user_id", "date"),
    "xp_events": ("user_id", "source", "source_id"),
    "challenge_participants": ("challenge_id", "user_id"),
}
DEFAULTS = {
    "gamification_user_stats": {"total_xp": 0, "current_streak": 0, "longest_streak": 0, "last_check_in_date": None},
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


AWARDED_AT = "2026-10-05T04:00:00+00:00"


class FakeSupabase:
    def __init__(self):
        self.db = {}

    def table(self, name):
        return FakeQuery(self.db, name)

    def rpc(self, name, params):
        """Mirrors the database functions in the gamification migrations."""
        handler = {"award_gamification_xp": self._award, "resync_gamification_xp": self._resync}[name]
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=handler(**params)))

    def _award(self, p_user_id, p_source, p_source_id, p_amount):
        events = self.db.setdefault("xp_events", [])
        stats = self.db.setdefault("gamification_user_stats", [])
        row = next((r for r in stats if r["user_id"] == p_user_id), None)
        key = (p_user_id, p_source, p_source_id)
        held = any((h["user_id"], h["source"], h["source_id"]) == key for h in self.db.get("pending_xp", []))
        duplicate = p_source_id is not None and any(
            (e["user_id"], e["source"], e.get("source_id")) == key for e in events
        )
        if held or duplicate:
            return row["total_xp"] if row else 0
        events.append(
            {
                "id": str(uuid.uuid4()),
                "user_id": p_user_id,
                "source": p_source,
                "source_id": p_source_id,
                "amount": p_amount,
                "created_at": AWARDED_AT,
            }
        )
        if row is None:
            row = {"user_id": p_user_id, **DEFAULTS["gamification_user_stats"]}
            stats.append(row)
        row["total_xp"] += p_amount
        return row["total_xp"]

    def _problem(self, source, source_id):
        """gamification_xp_problem: the day is TODAY rather than the real date in Singapore."""
        if source == "workout":
            row = next((r for r in self.db.get("training_workout_logs", []) if r["id"] == source_id), None)
            if row is None:
                return "missing"
            return "dated in the future" if row["date"] > TODAY.isoformat() else None
        row = next((r for r in self.db.get("meal_plans", []) if r["log_id"] == source_id), None)
        if row is None:
            return "missing"
        return "no calorie estimate" if not row.get("total_calories") else None

    def _resync(self, p_user_id):
        counts = {"awardedXp": 0, "released": 0, "stillPending": 0, "removed": 0}
        for item in [h for h in self.db.get("pending_xp", []) if h["user_id"] == p_user_id]:
            problem = self._problem(item["source"], item["source_id"])
            if problem == "missing":
                self.db["pending_xp"].remove(item)
                counts["removed"] += 1
            elif problem is None:
                self.db["pending_xp"].remove(item)
                self._award(item["user_id"], item["source"], item["source_id"], item["amount"])
                counts["awardedXp"] += item["amount"]
                counts["released"] += 1
            else:
                item["reason"] = problem
                counts["stillPending"] += 1
        return counts


METRICS = {"muscleFatigue": 3, "mood": 4, "dietAdherence": 5}


def befriend(sb, sender, recipient, status="accepted"):
    sb.db.setdefault("friend_requests", []).append(
        {"sender_id": sender, "recipient_id": recipient, "status": status}
    )


@pytest.fixture
def sb():
    """Alice is friends with Bob (she sent the request) and Carol (Carol sent it); Dave is a stranger."""
    fake = FakeSupabase()
    befriend(fake, ALICE, BOB)
    befriend(fake, CAROL, ALICE)
    return fake


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

    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 10, TODAY)["entries"]

    # Carol is a friend without XP yet, so she is listed last with 0
    assert [(e["userId"], e["totalXp"]) for e in entries] == [(BOB, 60), (ALICE, 50), (CAROL, 0)]
    assert [e["position"] for e in entries] == [1, 2, 3]
    assert entries[1]["isCurrentUser"] is True


def test_leaderboard_by_streak_excludes_broken_streaks(sb):
    for offset in (4, 3, 2):  # Alice's 3-day streak ended two days ago
        svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=offset))
    svc.perform_checkin(sb, BOB, METRICS, TODAY)

    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.STREAK, 10, TODAY)["entries"]

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
        {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "source": source,
            "amount": amount,
            "created_at": at_utc.isoformat(),
        }
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


# --- XP sources, history, rewards and names ---------------------------------

def test_same_source_id_awards_each_user_once(sb):
    challenge_id = str(uuid.uuid4())
    assert svc.award_xp(sb, ALICE, "challenge", 100, challenge_id) == 100
    assert svc.award_xp(sb, BOB, "challenge", 100, challenge_id) == 100
    assert svc.award_xp(sb, ALICE, "challenge", 100, challenge_id) == 100


def test_xp_history_is_newest_first_and_own_only(sb):
    add_xp_event(sb, ALICE, "meal", 10, datetime(2026, 10, 4, 1, 0, tzinfo=timezone.utc))
    add_xp_event(sb, ALICE, "workout", 50, datetime(2026, 10, 5, 1, 0, tzinfo=timezone.utc))
    add_xp_event(sb, BOB, "workout", 50, datetime(2026, 10, 5, 2, 0, tzinfo=timezone.utc))

    history = svc.get_xp_history(sb, ALICE)

    assert [(e["source"], e["amount"]) for e in history] == [("workout", 50), ("meal", 10)]


def test_completed_challenge_pays_reward_once(sb):
    make_challenge(sb, metric="sessions", target=1)
    add_xp_event(sb, ALICE, "workout", 50, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))

    svc.list_challenges(sb, ALICE, TODAY)
    [challenge] = svc.list_challenges(sb, ALICE, TODAY)

    rewards = [e for e in sb.db["xp_events"] if e["source"] == "challenge"]
    assert len(rewards) == 1
    assert svc.get_stats(sb, ALICE, TODAY)["totalXp"] == challenge["rewardXp"] == 100


def test_unfinished_or_invited_challenge_pays_nothing(sb):
    challenge = make_challenge(sb, metric="sessions", target=2)
    add_xp_event(sb, ALICE, "workout", 50, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))
    add_xp_event(sb, BOB, "workout", 50, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))
    add_xp_event(sb, BOB, "workout", 50, datetime(2026, 10, 5, 5, 0, tzinfo=timezone.utc))

    svc.list_challenges(sb, ALICE, TODAY)
    svc.list_challenges(sb, BOB, TODAY)

    assert not [e for e in sb.db["xp_events"] if e["source"] == "challenge"]
    svc.respond_to_challenge(sb, BOB, challenge["id"], True, TODAY)
    svc.list_challenges(sb, BOB, TODAY)
    assert [e["user_id"] for e in sb.db["xp_events"] if e["source"] == "challenge"] == [BOB]


def test_challenge_rewards_dont_count_towards_xp_challenges(sb):
    make_challenge(sb, metric="xp", target=30)
    add_xp_event(sb, ALICE, "checkin", 30, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))

    svc.list_challenges(sb, ALICE, TODAY)
    me = svc.list_challenges(sb, ALICE, TODAY)[0]["participants"][0]

    assert me["progress"] == 30


def test_profile_names_are_shown_when_set(sb):
    sb.db["users"] = [{"user_id": BOB, "name": "Bob Tan"}, {"user_id": ALICE, "name": None}]
    svc.award_xp(sb, ALICE, "meal", 10, str(uuid.uuid4()))
    svc.award_xp(sb, BOB, "meal", 10, str(uuid.uuid4()))
    challenge = make_challenge(sb)

    names = {e["userId"]: e["displayName"] for e in svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 10, TODAY)["entries"]}
    assert names == {ALICE: None, BOB: "Bob Tan", CAROL: None}
    assert {p["userId"]: p["displayName"] for p in challenge["participants"]} == {ALICE: None, BOB: "Bob Tan"}
    assert challenge["creatorName"] is None


def test_xp_history_endpoint(client):
    client.post("/gamification/checkins", json=METRICS)

    events = client.get("/gamification/xp-events").json()["events"]

    assert [(e["source"], e["amount"]) for e in events] == [("checkin", 10)]


# --- Friends ----------------------------------------------------------------

def test_friends_are_found_whichever_side_sent_the_request(sb):
    befriend(sb, DAVE, BOB, status="pending")
    befriend(sb, ALICE, DAVE, status="rejected")

    assert sorted(svc.friend_ids(sb, ALICE)) == sorted([BOB, CAROL])
    assert svc.friend_ids(sb, BOB) == [ALICE]
    assert svc.friend_ids(sb, DAVE) == []


def test_leaderboard_shows_only_the_user_and_their_friends(sb):
    for uid in (ALICE, BOB, DAVE):
        svc.award_xp(sb, uid, "meal", 10, str(uuid.uuid4()))
    svc.perform_checkin(sb, DAVE, METRICS, TODAY)

    by_xp = {e["userId"] for e in svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 10, TODAY)["entries"]}
    by_streak = {e["userId"] for e in svc.get_leaderboard(sb, ALICE, LeaderboardMetric.STREAK, 10, TODAY)["entries"]}
    dave_view = [e["userId"] for e in svc.get_leaderboard(sb, DAVE, LeaderboardMetric.XP, 10, TODAY)["entries"]]

    assert by_xp == {ALICE, BOB, CAROL}
    assert by_streak == set()
    assert dave_view == [DAVE]


def test_leaderboard_limit_applies_after_adding_friends_without_xp(sb):
    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 2, TODAY)["entries"]
    assert len(entries) == 2


def test_only_friends_can_be_invited(sb):
    with pytest.raises(svc.InvalidChallengeError, match="friends"):
        make_challenge(sb, invitees=(BOB, DAVE))
    assert not sb.db.get("challenges")


def test_inviting_a_non_friend_over_http_is_rejected(client):
    body = {
        "title": "Sneaky",
        "metric": "xp",
        "targetValue": 10,
        "startDate": TODAY.isoformat(),
        "endDate": TODAY.isoformat(),
        "inviteeIds": [DAVE],
    }
    response = client.post("/gamification/challenges", json=body)
    assert response.status_code == 422
    assert response.json()["detail"] == "You can only invite your friends"


# --- Home-page calendar reads the same check-ins ------------------------------

def test_calendar_dates_come_from_the_questionnaire_check_ins(client, sb, monkeypatch):
    from app.controllers import checkin as checkin_controller

    monkeypatch.setattr(checkin_controller, "get_supabase_admin", lambda: sb)
    svc.perform_checkin(sb, ALICE, METRICS, TODAY - timedelta(days=1))
    client.post("/gamification/checkins", json=METRICS)
    svc.perform_checkin(sb, BOB, METRICS, TODAY)

    body = client.get("/checkin/me/dates").json()

    assert body == {"user_id": ALICE, "dates": [(TODAY - timedelta(days=1)).isoformat(), TODAY.isoformat()]}
    assert client.post("/checkin/me").status_code == 404  # one-click check-in was removed


def count_queries(sb, monkeypatch):
    calls = []
    table, rpc = sb.table, sb.rpc
    monkeypatch.setattr(sb, "table", lambda name: calls.append(name) or table(name))
    monkeypatch.setattr(sb, "rpc", lambda name, params: calls.append(name) or rpc(name, params))
    return calls


@pytest.mark.parametrize("metric", ["xp", "sessions", "checkin_streak"])
def test_listing_challenges_uses_the_same_number_of_queries_for_1_or_10(sb, monkeypatch, metric):
    def queries_for(n):
        fake = FakeSupabase()
        befriend(fake, ALICE, BOB)
        for i in range(n):
            make_challenge(fake, metric=metric, target=1, invitees=(BOB,))
            svc.respond_to_challenge(fake, BOB, fake.db["challenges"][-1]["id"], True, TODAY)
            add_xp_event(fake, BOB, "workout", 50, datetime(2026, 10, 5, 4, i, tzinfo=timezone.utc))
        svc.perform_checkin(fake, BOB, METRICS, TODAY)
        svc.list_challenges(fake, BOB, TODAY)  # pays the rewards, so the timed call below is steady state
        calls = count_queries(fake, monkeypatch)
        svc.list_challenges(fake, BOB, TODAY)
        return len(calls)

    assert queries_for(10) == queries_for(1)


def test_batched_progress_keeps_each_challenge_window_separate(sb):
    early = make_challenge(sb, metric="xp", target=1000, end=TODAY + timedelta(days=1))
    late = make_challenge(sb, metric="xp", target=1000, start=TODAY + timedelta(days=2), end=TODAY + timedelta(days=3))
    add_xp_event(sb, ALICE, "meal", 10, datetime(2026, 10, 5, 4, 0, tzinfo=timezone.utc))
    add_xp_event(sb, ALICE, "meal", 20, datetime(2026, 10, 7, 4, 0, tzinfo=timezone.utc))

    mine = {c["id"]: c["participants"][0]["progress"] for c in svc.list_challenges(sb, ALICE, TODAY)}

    assert mine == {early["id"]: 10, late["id"]: 20}


def test_leaderboard_reports_how_many_friends_the_user_has(client, sb):
    befriend(sb, DAVE, ALICE, status="pending")

    assert svc.get_leaderboard(sb, DAVE, LeaderboardMetric.STREAK, 10, TODAY)["friendCount"] == 0
    board = client.get("/gamification/leaderboard", params={"metric": "streak"}).json()
    assert board["friendCount"] == 2


# --- Pending XP (G-2: XP held when an activity fails a check) ----------------

def hold(sb, user_id, source, source_id, amount, reason="held"):
    """What the database trigger does when a logged workout or meal fails its check."""
    sb.db.setdefault("pending_xp", []).append(
        {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "source": source,
            "source_id": source_id,
            "amount": amount,
            "reason": reason,
            "created_at": AWARDED_AT,
        }
    )


def test_held_xp_is_listed_with_its_total(sb):
    hold(sb, ALICE, "meal", str(uuid.uuid4()), 10, "no calorie estimate")
    hold(sb, ALICE, "workout", str(uuid.uuid4()), 50, "dated in the future")
    hold(sb, BOB, "meal", str(uuid.uuid4()), 10)

    pending = svc.get_pending_xp(sb, ALICE)

    assert pending["totalXp"] == 60
    assert [(i["source"], i["reason"]) for i in pending["items"]] == [
        ("meal", "no calorie estimate"),
        ("workout", "dated in the future"),
    ]


def test_held_xp_cannot_be_paid_by_a_direct_award(sb):
    workout = str(uuid.uuid4())
    hold(sb, ALICE, "workout", workout, 50)

    assert svc.award_xp(sb, ALICE, "workout", 50, workout) == 0
    assert not sb.db.get("xp_events")


def test_resync_pays_fixed_items_drops_deleted_ones_and_keeps_the_rest(sb):
    fixed_meal, empty_meal, deleted_meal, past_workout, future_workout = (str(uuid.uuid4()) for _ in range(5))
    sb.db["meal_plans"] = [
        {"log_id": fixed_meal, "total_calories": 640},
        {"log_id": empty_meal, "total_calories": None},
    ]
    sb.db["training_workout_logs"] = [
        {"id": past_workout, "date": TODAY.isoformat()},
        {"id": future_workout, "date": (TODAY + timedelta(days=2)).isoformat()},
    ]
    for source, source_id, amount in [
        ("meal", fixed_meal, 10), ("meal", empty_meal, 10), ("meal", deleted_meal, 10),
        ("workout", past_workout, 50), ("workout", future_workout, 50),
    ]:
        hold(sb, ALICE, source, source_id, amount)

    result = svc.resync_pending_xp(sb, ALICE)

    assert {k: result[k] for k in ("awardedXp", "released", "stillPending", "removed")} == {
        "awardedXp": 60, "released": 2, "stillPending": 2, "removed": 1,
    }
    assert {i["sourceId"] for i in result["items"]} == {empty_meal, future_workout}
    assert result["totalXp"] == 60
    assert svc.get_stats(sb, ALICE, TODAY)["totalXp"] == 60
    assert svc.resync_pending_xp(sb, ALICE)["awardedXp"] == 0


def test_pending_xp_endpoints(client, sb):
    meal = str(uuid.uuid4())
    sb.db["meal_plans"] = [{"log_id": meal, "total_calories": 0}]
    hold(sb, ALICE, "meal", meal, 10, "no calorie estimate")

    assert client.get("/gamification/pending-xp").json()["totalXp"] == 10

    sb.db["meal_plans"][0]["total_calories"] = 500
    synced = client.post("/gamification/pending-xp/resync").json()

    assert synced["awardedXp"] == 10 and synced["items"] == [] and synced["totalXp"] == 0
    assert client.get("/gamification/me").json()["totalXp"] == 10


# --- Mileage leaderboard (runs saved from Strava) -----------------------------

def log_run(sb, user_id, km, day=TODAY, activity_type="run", source="strava"):
    sb.db.setdefault("training_workout_logs", []).append(
        {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "date": day.isoformat(),
            "activity_type": activity_type,
            "source": source,
            "distance_m": None if km is None else km * 1000,
        }
    )


def test_mileage_ranks_running_km_over_the_last_30_days(sb):
    log_run(sb, BOB, 10.3)
    log_run(sb, BOB, 5, day=TODAY - timedelta(days=29))
    log_run(sb, BOB, 42, day=TODAY - timedelta(days=30))  # one day too old
    log_run(sb, ALICE, 8)
    log_run(sb, ALICE, 50, activity_type="cycling")  # rides aren't running mileage
    log_run(sb, ALICE, None, source="manual")  # manual logs have no distance
    log_run(sb, DAVE, 100)  # not a friend

    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.MILEAGE, 10, TODAY)["entries"]

    assert [(e["userId"], e["mileageKm"]) for e in entries] == [(BOB, 15.3), (ALICE, 8.0), (CAROL, 0.0)]
    assert [e["position"] for e in entries] == [1, 2, 3]


def test_other_boards_leave_mileage_at_zero(sb):
    log_run(sb, ALICE, 12)
    entries = svc.get_leaderboard(sb, ALICE, LeaderboardMetric.XP, 10, TODAY)["entries"]
    assert {e["mileageKm"] for e in entries} == {0.0}


def test_mileage_endpoint(client, sb):
    log_run(sb, CAROL, 21.1)

    board = client.get("/gamification/leaderboard", params={"metric": "mileage"}).json()

    assert board["metric"] == "mileage"
    assert board["entries"][0]["userId"] == CAROL and board["entries"][0]["mileageKm"] == 21.1

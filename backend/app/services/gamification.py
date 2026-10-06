from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Optional, Tuple
from postgrest.exceptions import APIError
from supabase import Client
from app.models.gamification import ChallengeMetric, LeaderboardMetric

# Users are in Singapore (no DST), so a fixed offset decides which calendar day a
# check-in belongs to without needing the tzdata package on Windows/slim images.
APP_TZ = timezone(timedelta(hours=8))

XP_REWARDS = {"checkin": 10, "workout": 50, "meal": 10}
STREAK_BONUS_PER_DAY = 2
STREAK_BONUS_CAP_DAYS = 7

# (minimum total XP, rank name), ascending
RANKS = [(0, "Beginner"), (100, "Bronze"), (500, "Silver"), (1500, "Gold"), (4000, "Platinum")]

PG_UNIQUE_VIOLATION = "23505"
PG_FOREIGN_KEY_VIOLATION = "23503"


class AlreadyCheckedInError(Exception):
    pass


class ChallengeNotFoundError(Exception):
    pass


class ChallengeConflictError(Exception):
    """The request clashes with the challenge's current state; str(e) is shown to the user."""


class InvalidChallengeError(Exception):
    """str(e) is shown to the user."""


def today_local() -> date:
    return datetime.now(APP_TZ).date()


def next_streak(last_check_in: Optional[date], current_streak: int, today: date) -> int:
    """Streak after checking in today: continues from yesterday, otherwise restarts at 1."""
    if last_check_in == today:
        return current_streak
    if last_check_in == today - timedelta(days=1):
        return current_streak + 1
    return 1


def effective_streak(last_check_in: Optional[date], current_streak: int, today: date) -> int:
    """Stored streaks are only updated on check-in, so a streak whose last check-in is
    older than yesterday is already broken even though the row still holds the old value."""
    if last_check_in and last_check_in >= today - timedelta(days=1):
        return current_streak
    return 0


def checkin_xp(streak: int) -> int:
    """Base check-in XP plus a bonus that grows with the streak, capped after a week."""
    bonus_days = min(streak, STREAK_BONUS_CAP_DAYS) - 1
    return XP_REWARDS["checkin"] + STREAK_BONUS_PER_DAY * max(bonus_days, 0)


def rank_for_xp(total_xp: int) -> Tuple[str, Optional[str], Optional[int]]:
    """Returns (rank, next rank, XP still needed); the last two are None at the top rank."""
    current = RANKS[0][1]
    for threshold, name in RANKS:
        if total_xp < threshold:
            return current, name, threshold - total_xp
        current = name
    return current, None, None


def _parse_date(value: Optional[str]) -> Optional[date]:
    return date.fromisoformat(value) if value else None


def _get_stats_row(supabase: Client, user_id: str) -> Optional[dict]:
    res = supabase.table("gamification_stats").select("*").eq("user_id", user_id).limit(1).execute()
    return res.data[0] if res.data else None


def get_stats(supabase: Client, user_id: str, today: date) -> dict:
    row = _get_stats_row(supabase, user_id) or {}
    total_xp = row.get("total_xp", 0)
    last_check_in = _parse_date(row.get("last_check_in_date"))
    rank, next_rank, xp_to_next = rank_for_xp(total_xp)
    return {
        "userId": user_id,
        "totalXp": total_xp,
        "currentStreak": effective_streak(last_check_in, row.get("current_streak", 0), today),
        "longestStreak": row.get("longest_streak", 0),
        "lastCheckInDate": last_check_in,
        "checkedInToday": last_check_in == today,
        "rank": rank,
        "nextRank": next_rank,
        "xpToNextRank": xp_to_next,
    }


def award_xp(
    supabase: Client, user_id: str, source: str, amount: int, source_id: Optional[str] = None
) -> int:
    """Records an XP award and returns the user's new total.

    Awarding the same (source, source_id) twice is a no-op, so callers can retry safely.
    Used by other features, e.g. award_xp(sb, uid, "workout", XP_REWARDS["workout"], session_id).
    """
    try:
        supabase.table("xp_events").insert(
            {"user_id": user_id, "source": source, "source_id": source_id, "amount": amount}
        ).execute()
    except APIError as e:
        if e.code != PG_UNIQUE_VIOLATION:
            raise
        row = _get_stats_row(supabase, user_id)
        return row["total_xp"] if row else 0

    # Read-modify-write is not atomic; two simultaneous awards for one user could lose an
    # increment. Acceptable for the prototype; move into a SQL function if that changes.
    row = _get_stats_row(supabase, user_id)
    new_total = (row["total_xp"] if row else 0) + amount
    supabase.table("gamification_stats").upsert(
        {"user_id": user_id, "total_xp": new_total, "updated_at": datetime.now(timezone.utc).isoformat()},
        on_conflict="user_id",
    ).execute()
    return new_total


def perform_checkin(supabase: Client, user_id: str, metrics: dict, today: date) -> dict:
    """Saves today's questionnaire, extends the streak and awards check-in XP.

    Raises AlreadyCheckedInError if the user has already checked in today.
    """
    row = _get_stats_row(supabase, user_id) or {}
    last_check_in = _parse_date(row.get("last_check_in_date"))
    if last_check_in == today:
        raise AlreadyCheckedInError()

    streak = next_streak(last_check_in, row.get("current_streak", 0), today)
    xp = checkin_xp(streak)

    try:
        res = supabase.table("daily_checkins").insert(
            {
                "user_id": user_id,
                "date": today.isoformat(),
                "muscle_fatigue": metrics["muscleFatigue"],
                "mood": metrics["mood"],
                "diet_adherence": metrics["dietAdherence"],
                "xp_awarded": xp,
            }
        ).execute()
    except APIError as e:
        if e.code == PG_UNIQUE_VIOLATION:
            raise AlreadyCheckedInError() from e
        raise
    checkin_id = res.data[0]["id"]

    total_xp = award_xp(supabase, user_id, "checkin", xp, checkin_id)
    supabase.table("gamification_stats").update(
        {
            "current_streak": streak,
            "longest_streak": max(row.get("longest_streak", 0), streak),
            "last_check_in_date": today.isoformat(),
        }
    ).eq("user_id", user_id).execute()

    return {
        "checkInId": checkin_id,
        "date": today,
        "xpAwarded": xp,
        "currentStreak": streak,
        "totalXp": total_xp,
        "rank": rank_for_xp(total_xp)[0],
    }


def get_leaderboard(
    supabase: Client, user_id: str, metric: LeaderboardMetric, limit: int, today: date
) -> list:
    query = supabase.table("gamification_stats").select(
        "user_id,total_xp,current_streak,last_check_in_date"
    )
    if metric == LeaderboardMetric.STREAK:
        # Only streaks still alive (checked in today or yesterday) can be ranked by stored value
        query = query.gte("last_check_in_date", (today - timedelta(days=1)).isoformat()).order(
            "current_streak", desc=True
        )
    else:
        query = query.order("total_xp", desc=True)
    rows = query.limit(limit).execute().data or []

    return [
        {
            "position": position,
            "userId": row["user_id"],
            "totalXp": row["total_xp"],
            "currentStreak": effective_streak(
                _parse_date(row.get("last_check_in_date")), row["current_streak"], today
            ),
            "rank": rank_for_xp(row["total_xp"])[0],
            "isCurrentUser": row["user_id"] == user_id,
        }
        for position, row in enumerate(rows, start=1)
    ]


def challenge_status(start: date, end: date, today: date) -> str:
    if today < start:
        return "upcoming"
    if today > end:
        return "ended"
    return "active"


def longest_run(days: Iterable[date]) -> int:
    """Length of the longest run of consecutive calendar days."""
    best = run = 0
    previous = None
    for day in sorted(set(days)):
        run = run + 1 if previous and day - previous == timedelta(days=1) else 1
        best = max(best, run)
        previous = day
    return best


def _local_day_start_utc(day: date) -> str:
    return datetime.combine(day, time.min, APP_TZ).astimezone(timezone.utc).isoformat()


def _progress_by_user(supabase: Client, challenge: dict, user_ids: list) -> dict:
    progress = {uid: 0 for uid in user_ids}
    if not user_ids:
        return progress
    start, end = _parse_date(challenge["start_date"]), _parse_date(challenge["end_date"])
    metric = ChallengeMetric(challenge["metric"])

    if metric == ChallengeMetric.CHECKIN_STREAK:
        rows = (
            supabase.table("daily_checkins").select("user_id,date").in_("user_id", user_ids)
            .gte("date", start.isoformat()).lte("date", end.isoformat()).execute().data or []
        )
        days = defaultdict(list)
        for row in rows:
            days[row["user_id"]].append(_parse_date(row["date"]))
        for uid, user_days in days.items():
            progress[uid] = longest_run(user_days)
        return progress

    query = (
        supabase.table("xp_events").select("user_id,amount").in_("user_id", user_ids)
        .gte("created_at", _local_day_start_utc(start))
        .lt("created_at", _local_day_start_utc(end + timedelta(days=1)))
    )
    if metric == ChallengeMetric.SESSIONS:
        query = query.eq("source", "workout")
    for row in query.execute().data or []:
        progress[row["user_id"]] += row["amount"] if metric == ChallengeMetric.XP else 1
    return progress


def _build_challenge(
    supabase: Client, challenge: dict, participants: list, user_id: str, today: date
) -> dict:
    """Declined invitees are hidden; only accepted participants accumulate progress."""
    visible = [p for p in participants if p["status"] != "declined"]
    progress = _progress_by_user(
        supabase, challenge, [p["user_id"] for p in visible if p["status"] == "accepted"]
    )
    target = challenge["target_value"]
    entries = [
        {
            "userId": p["user_id"],
            "status": p["status"],
            "progress": progress.get(p["user_id"], 0),
            "completed": progress.get(p["user_id"], 0) >= target,
            "isCurrentUser": p["user_id"] == user_id,
        }
        for p in visible
    ]
    entries.sort(key=lambda e: (e["status"] != "accepted", -e["progress"]))
    start, end = _parse_date(challenge["start_date"]), _parse_date(challenge["end_date"])
    return {
        "id": challenge["id"],
        "creatorId": challenge["creator_id"],
        "title": challenge["title"],
        "metric": challenge["metric"],
        "targetValue": target,
        "startDate": start,
        "endDate": end,
        "status": challenge_status(start, end, today),
        "myStatus": next(p["status"] for p in participants if p["user_id"] == user_id),
        "participants": entries,
    }


def list_challenges(supabase: Client, user_id: str, today: date) -> list:
    """Challenges the user created, joined or is invited to; declined ones are left out."""
    mine = (
        supabase.table("challenge_participants").select("challenge_id").eq("user_id", user_id)
        .neq("status", "declined").execute().data or []
    )
    if not mine:
        return []
    ids = [row["challenge_id"] for row in mine]
    challenges = (
        supabase.table("challenges").select("*").in_("id", ids)
        .order("start_date", desc=True).execute().data or []
    )
    participants = defaultdict(list)
    for row in (
        supabase.table("challenge_participants").select("challenge_id,user_id,status")
        .in_("challenge_id", ids).execute().data or []
    ):
        participants[row["challenge_id"]].append(row)
    return [_build_challenge(supabase, c, participants[c["id"]], user_id, today) for c in challenges]


def create_challenge(supabase: Client, user_id: str, data: dict, today: date) -> dict:
    """Creates a challenge with the creator already accepted and everyone else invited.

    Raises InvalidChallengeError if it starts in the past or an invitee doesn't exist.
    """
    if data["startDate"] < today:
        raise InvalidChallengeError("A challenge can't start in the past")
    invitees = list(dict.fromkeys(str(i) for i in data["inviteeIds"] if str(i) != user_id))

    challenge = supabase.table("challenges").insert(
        {
            "creator_id": user_id,
            "title": data["title"],
            "metric": ChallengeMetric(data["metric"]).value,
            "target_value": data["targetValue"],
            "start_date": data["startDate"].isoformat(),
            "end_date": data["endDate"].isoformat(),
        }
    ).execute().data[0]

    participants = [
        {
            "challenge_id": challenge["id"],
            "user_id": user_id,
            "status": "accepted",
            "joined_at": datetime.now(timezone.utc).isoformat(),
        }
    ] + [{"challenge_id": challenge["id"], "user_id": uid, "status": "invited"} for uid in invitees]
    try:
        supabase.table("challenge_participants").insert(participants).execute()
    except APIError as e:
        # Two inserts with no transaction over PostgREST, so undo the first by hand.
        supabase.table("challenges").delete().eq("id", challenge["id"]).execute()
        if e.code == PG_FOREIGN_KEY_VIOLATION:
            raise InvalidChallengeError("One or more invited athletes don't exist") from e
        raise
    return _build_challenge(supabase, challenge, participants, user_id, today)


def respond_to_challenge(
    supabase: Client, user_id: str, challenge_id: str, accept: bool, today: date
) -> dict:
    """Accepts or declines an invitation.

    Raises ChallengeNotFoundError if the user wasn't invited, and ChallengeConflictError if
    they already responded or the challenge has ended.
    """
    invite = (
        supabase.table("challenge_participants").select("status").eq("challenge_id", challenge_id)
        .eq("user_id", user_id).limit(1).execute().data
    )
    rows = supabase.table("challenges").select("*").eq("id", challenge_id).limit(1).execute().data
    if not invite or not rows:
        raise ChallengeNotFoundError()
    if invite[0]["status"] != "invited":
        raise ChallengeConflictError("You have already responded to this challenge")
    challenge = rows[0]
    if challenge_status(
        _parse_date(challenge["start_date"]), _parse_date(challenge["end_date"]), today
    ) == "ended":
        raise ChallengeConflictError("This challenge has ended")

    update = {"status": "accepted" if accept else "declined"}
    if accept:
        update["joined_at"] = datetime.now(timezone.utc).isoformat()
    supabase.table("challenge_participants").update(update).eq("challenge_id", challenge_id).eq(
        "user_id", user_id
    ).execute()

    participants = (
        supabase.table("challenge_participants").select("challenge_id,user_id,status")
        .eq("challenge_id", challenge_id).execute().data or []
    )
    return _build_challenge(supabase, challenge, participants, user_id, today)

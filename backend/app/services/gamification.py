from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, Optional, Tuple
from postgrest.exceptions import APIError
from supabase import Client
from app.models.gamification import ChallengeMetric, LeaderboardMetric

# Users are in Singapore (no DST), so a fixed offset decides which calendar day a
# check-in belongs to without needing the tzdata package on Windows/slim images.
APP_TZ = timezone(timedelta(hours=8))

# workout and meal amounts are also hard-coded in the gamification_xp_sources migration's trigger
XP_REWARDS = {"checkin": 10, "workout": 50, "meal": 10, "challenge": 100}
XP_HISTORY_LIMIT = 20
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
    res = supabase.table("gamification_user_stats").select("*").eq("user_id", user_id).limit(1).execute()
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

    Awarding the same (user, source, source_id) twice is a no-op, so callers can retry safely.
    Workouts and meals are awarded by database triggers (see the gamification_xp_sources
    migration), so their features don't need to call this.
    """
    res = supabase.rpc(
        "award_gamification_xp",
        {"p_user_id": user_id, "p_source": source, "p_source_id": source_id, "p_amount": amount},
    ).execute()
    return res.data


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
    supabase.table("gamification_user_stats").update(
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


def get_xp_history(supabase: Client, user_id: str, limit: int = XP_HISTORY_LIMIT) -> list:
    rows = (
        supabase.table("xp_events").select("id,source,amount,created_at").eq("user_id", user_id)
        .order("created_at", desc=True).limit(limit).execute().data or []
    )
    return [
        {"id": r["id"], "source": r["source"], "amount": r["amount"], "createdAt": r["created_at"]}
        for r in rows
    ]


def get_pending_xp(supabase: Client, user_id: str) -> dict:
    """XP held back because its workout or meal failed a check (see the pending_xp migration)."""
    rows = (
        supabase.table("pending_xp").select("id,source,source_id,amount,reason,created_at")
        .eq("user_id", user_id).order("created_at").execute().data or []
    )
    items = [
        {
            "id": r["id"],
            "source": r["source"],
            "sourceId": r["source_id"],
            "amount": r["amount"],
            "reason": r["reason"],
            "createdAt": r["created_at"],
        }
        for r in rows
    ]
    return {"items": items, "totalXp": sum(item["amount"] for item in items)}


def resync_pending_xp(supabase: Client, user_id: str) -> dict:
    """Checks every held item again: pays those that now pass, drops those whose activity was deleted."""
    result = supabase.rpc("resync_gamification_xp", {"p_user_id": user_id}).execute().data
    return {**result, **get_pending_xp(supabase, user_id)}


def _display_names(supabase: Client, user_ids: Iterable[str]) -> dict:
    """Profile names from the team's users table; users without a profile or name are left out."""
    ids = list(set(user_ids))
    if not ids:
        return {}
    rows = supabase.table("users").select("user_id,name").in_("user_id", ids).execute().data or []
    return {row["user_id"]: row["name"] for row in rows if row.get("name")}


def friend_ids(supabase: Client, user_id: str) -> list:
    """Users with an accepted friend request to or from user_id (the friends feature's table)."""
    sent = (
        supabase.table("friend_requests").select("recipient_id").eq("sender_id", user_id)
        .eq("status", "accepted").execute().data or []
    )
    received = (
        supabase.table("friend_requests").select("sender_id").eq("recipient_id", user_id)
        .eq("status", "accepted").execute().data or []
    )
    return [r["recipient_id"] for r in sent] + [r["sender_id"] for r in received]


def get_leaderboard(
    supabase: Client, user_id: str, metric: LeaderboardMetric, limit: int, today: date
) -> dict:
    """The user and their friends. On the XP board, anyone who hasn't earned XP yet shows with 0."""
    friends = friend_ids(supabase, user_id)
    members = list(dict.fromkeys([user_id, *friends]))
    query = supabase.table("gamification_user_stats").select(
        "user_id,total_xp,current_streak,last_check_in_date"
    ).in_("user_id", members)
    if metric == LeaderboardMetric.STREAK:
        # Only streaks still alive (checked in today or yesterday) can be ranked by stored value
        query = query.gte("last_check_in_date", (today - timedelta(days=1)).isoformat()).order(
            "current_streak", desc=True
        )
    else:
        query = query.order("total_xp", desc=True)
    rows = query.execute().data or []
    if metric == LeaderboardMetric.XP:
        ranked = {row["user_id"] for row in rows}
        rows += [
            {"user_id": uid, "total_xp": 0, "current_streak": 0, "last_check_in_date": None}
            for uid in members
            if uid not in ranked
        ]
    rows = rows[:limit]
    names = _display_names(supabase, [row["user_id"] for row in rows])

    entries = [
        {
            "position": position,
            "userId": row["user_id"],
            "displayName": names.get(row["user_id"]),
            "totalXp": row["total_xp"],
            "currentStreak": effective_streak(
                _parse_date(row.get("last_check_in_date")), row["current_streak"], today
            ),
            "rank": rank_for_xp(row["total_xp"])[0],
            "isCurrentUser": row["user_id"] == user_id,
        }
        for position, row in enumerate(rows, start=1)
    ]
    return {"friendCount": len(set(friends)), "entries": entries}


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


def _local_day_start_utc(day: date) -> datetime:
    return datetime.combine(day, time.min, APP_TZ).astimezone(timezone.utc)


def _challenge_window(challenge: dict) -> Tuple[date, date]:
    return _parse_date(challenge["start_date"]), _parse_date(challenge["end_date"])


def _challenge_progress(supabase: Client, challenges: list, accepted: dict) -> dict:
    """Progress of every accepted participant, keyed by challenge id then user id.

    Reads each source once for all challenges together (check-ins for streak challenges, XP events
    for the rest), so the number of queries doesn't grow with the number of challenges.
    """
    progress = {c["id"]: {uid: 0 for uid in accepted[c["id"]]} for c in challenges}
    streak = [c for c in challenges if c["metric"] == ChallengeMetric.CHECKIN_STREAK and accepted[c["id"]]]
    earned = [c for c in challenges if c["metric"] != ChallengeMetric.CHECKIN_STREAK and accepted[c["id"]]]

    if streak:
        users = sorted({uid for c in streak for uid in accepted[c["id"]]})
        first = min(_challenge_window(c)[0] for c in streak)
        last = max(_challenge_window(c)[1] for c in streak)
        rows = (
            supabase.table("daily_checkins").select("user_id,date").in_("user_id", users)
            .gte("date", first.isoformat()).lte("date", last.isoformat()).execute().data or []
        )
        days_by_user = defaultdict(list)
        for row in rows:
            days_by_user[row["user_id"]].append(_parse_date(row["date"]))
        for c in streak:
            start, end = _challenge_window(c)
            for uid in accepted[c["id"]]:
                progress[c["id"]][uid] = longest_run(d for d in days_by_user[uid] if start <= d <= end)

    if earned:
        users = sorted({uid for c in earned for uid in accepted[c["id"]]})
        first = _local_day_start_utc(min(_challenge_window(c)[0] for c in earned))
        last = _local_day_start_utc(max(_challenge_window(c)[1] for c in earned) + timedelta(days=1))
        # Challenge rewards never count, or finishing one challenge would feed the others.
        rows = (
            supabase.table("xp_events").select("user_id,source,amount,created_at").in_("user_id", users)
            .gte("created_at", first.isoformat()).lt("created_at", last.isoformat())
            .neq("source", "challenge").execute().data or []
        )
        for row in rows:
            row["at"] = datetime.fromisoformat(row["created_at"])
        for c in earned:
            start, end = _challenge_window(c)
            lo, hi = _local_day_start_utc(start), _local_day_start_utc(end + timedelta(days=1))
            members = set(accepted[c["id"]])
            for row in rows:
                if row["user_id"] not in members or not lo <= row["at"] < hi:
                    continue
                if c["metric"] == ChallengeMetric.XP:
                    progress[c["id"]][row["user_id"]] += row["amount"]
                elif row["source"] == "workout":
                    progress[c["id"]][row["user_id"]] += 1
    return progress


def _build_challenges(
    supabase: Client, challenges: list, participants: dict, user_id: str, today: date
) -> list:
    """Response bodies for the given challenges; participants maps challenge id to its rows.

    Declined invitees are hidden; only accepted participants accumulate progress.
    """
    visible = {c["id"]: [p for p in participants[c["id"]] if p["status"] != "declined"] for c in challenges}
    accepted = {cid: [p["user_id"] for p in rows if p["status"] == "accepted"] for cid, rows in visible.items()}
    progress = _challenge_progress(supabase, challenges, accepted)
    names = _display_names(
        supabase,
        [p["user_id"] for rows in visible.values() for p in rows] + [c["creator_id"] for c in challenges],
    )

    built = []
    for c in challenges:
        target = c["target_value"]
        entries = [
            {
                "userId": p["user_id"],
                "displayName": names.get(p["user_id"]),
                "status": p["status"],
                "progress": progress[c["id"]].get(p["user_id"], 0),
                "completed": progress[c["id"]].get(p["user_id"], 0) >= target,
                "isCurrentUser": p["user_id"] == user_id,
            }
            for p in visible[c["id"]]
        ]
        entries.sort(key=lambda e: (e["status"] != "accepted", -e["progress"]))
        start, end = _challenge_window(c)
        built.append(
            {
                "id": c["id"],
                "creatorId": c["creator_id"],
                "creatorName": names.get(c["creator_id"]),
                "title": c["title"],
                "metric": c["metric"],
                "targetValue": target,
                "startDate": start,
                "endDate": end,
                "status": challenge_status(start, end, today),
                "myStatus": next(p["status"] for p in participants[c["id"]] if p["user_id"] == user_id),
                "rewardXp": XP_REWARDS["challenge"],
                "participants": entries,
            }
        )
    return built


def list_challenges(supabase: Client, user_id: str, today: date) -> list:
    """Challenges the user created, joined or is invited to; declined ones are left out.

    Also pays the user's reward for any challenge they have completed. Rewards are paid when the
    user next views their challenges, and only once per challenge.
    """
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

    built = _build_challenges(supabase, challenges, participants, user_id, today)
    completed = [
        c["id"] for c in built
        if any(p["isCurrentUser"] and p["status"] == "accepted" and p["completed"] for p in c["participants"])
    ]
    if completed:
        paid = {
            row["source_id"]
            for row in supabase.table("xp_events").select("source_id").eq("user_id", user_id)
            .eq("source", "challenge").in_("source_id", completed).execute().data or []
        }
        for challenge_id in completed:
            if challenge_id not in paid:
                award_xp(supabase, user_id, "challenge", XP_REWARDS["challenge"], challenge_id)
    return built


def create_challenge(supabase: Client, user_id: str, data: dict, today: date) -> dict:
    """Creates a challenge with the creator already accepted and everyone else invited.

    Raises InvalidChallengeError if it starts in the past or an invitee isn't one of the user's friends.
    """
    if data["startDate"] < today:
        raise InvalidChallengeError("A challenge can't start in the past")
    invitees = list(dict.fromkeys(str(i) for i in data["inviteeIds"] if str(i) != user_id))
    if not set(invitees) <= set(friend_ids(supabase, user_id)):
        raise InvalidChallengeError("You can only invite your friends")

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
    return _build_challenges(supabase, [challenge], {challenge["id"]: participants}, user_id, today)[0]


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
    return _build_challenges(supabase, [challenge], {challenge_id: participants}, user_id, today)[0]

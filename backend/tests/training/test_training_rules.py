from datetime import date, datetime, timedelta, timezone
from typing import List

import pytest

from app.training.models import PlannedSession, ReadinessScore
from app.training.rules import MoveContext, band_refusal, check_move, check_placement, reconcile

TODAY = date(2026, 9, 30)  # Wednesday
PLAN_START = date(2026, 9, 14)
PLAN_END = date(2026, 11, 8)


def session(day: date, band: str = "light", status: str = "planned", sid: str = "") -> PlannedSession:
    return PlannedSession(
        id=sid or f"s-{day.isoformat()}", plan_id="p", date=day, activity_type="run",
        target_volume=30, target_duration_min=45, intensity_band=band, status=status,  # type: ignore[arg-type]
    )


def ctx(sessions: List[PlannedSession]) -> MoveContext:
    return MoveContext(sessions=sessions, plan_start=PLAN_START, plan_end=PLAN_END, today=TODAY)


# ------------------------------------------------------------------ moves (T-7)


def test_a_free_day_is_allowed():
    mover = session(date(2026, 10, 2))
    assert check_move(mover, date(2026, 10, 3), ctx([mover])) is None


@pytest.mark.parametrize("status", ["completed", "partial", "missed"])
def test_finished_sessions_cannot_be_moved(status):
    mover = session(date(2026, 10, 2), status=status)
    refusal = check_move(mover, date(2026, 10, 5), ctx([mover]))
    assert refusal and refusal.code == "NOT_MOVABLE" and refusal.suggested_date is None


@pytest.mark.parametrize("status", ["planned", "accepted", "moved"])
def test_unfinished_sessions_can_be_moved(status):
    mover = session(date(2026, 10, 2), status=status)
    assert check_move(mover, date(2026, 10, 3), ctx([mover])) is None


def test_moving_to_the_same_day_is_refused_without_a_suggestion():
    mover = session(date(2026, 10, 2))
    refusal = check_move(mover, mover.date, ctx([mover]))
    assert refusal and refusal.code == "NO_CHANGE" and refusal.suggested_date is None


def test_past_dates_and_dates_outside_the_plan_are_refused():
    mover = session(date(2026, 10, 2))
    assert check_move(mover, date(2026, 9, 29), ctx([mover])).code == "IN_PAST"
    assert check_move(mover, PLAN_END + timedelta(days=1), ctx([mover])).code == "OUT_OF_PLAN"


def test_an_occupied_day_is_refused():
    mover, other = session(date(2026, 10, 2)), session(date(2026, 10, 3))
    assert check_move(mover, other.date, ctx([mover, other])).code == "DAY_OCCUPIED"


def test_two_push_sessions_on_consecutive_days_are_refused_with_the_nearest_valid_day():
    push_sat = session(date(2026, 10, 17), "push")
    push_mon = session(date(2026, 10, 19), "push")
    wed = session(date(2026, 10, 21), "light")
    fri = session(date(2026, 10, 16), "light")
    all_sessions = [push_sat, push_mon, wed, fri]

    refusal = check_move(push_sat, date(2026, 10, 18), ctx(all_sessions))  # Sunday, next to Monday's push

    assert refusal.code == "CONSECUTIVE_HIGH_INTENSITY"
    assert refusal.suggested_date == date(2026, 10, 15)  # Thursday: Fri/Tue/Wed are unusable
    assert check_move(push_sat, refusal.suggested_date, ctx(all_sessions)) is None


def test_a_light_session_may_sit_next_to_a_push_session():
    push = session(date(2026, 10, 19), "push")
    light = session(date(2026, 10, 15), "light")
    assert check_move(light, date(2026, 10, 18), ctx([push, light])) is None


def test_a_missed_push_does_not_block_the_adjacent_day():
    missed_push = session(date(2026, 10, 19), "push", status="missed")
    push = session(date(2026, 10, 15), "push")
    assert check_move(push, date(2026, 10, 18), ctx([missed_push, push])) is None


# ------------------------------------------------------------------ placing a session by hand


def new_session(day: date, band: str = "light", sid: str = "new") -> PlannedSession:
    return session(day, band, sid=sid)


def test_a_new_session_may_go_on_a_free_day_in_the_plan_and_on_today():
    for day in (TODAY, date(2026, 10, 3), PLAN_END):
        assert check_placement(new_session(day), day, ctx([])) is None


def test_a_new_session_cannot_go_in_the_past():
    refusal = check_placement(new_session(TODAY - timedelta(days=1)), TODAY - timedelta(days=1), ctx([]))
    assert refusal.code == "IN_PAST"
    assert refusal.suggested_date == TODAY  # the nearest day that works


def test_a_new_session_cannot_go_outside_the_plan():
    after = PLAN_END + timedelta(days=1)
    assert check_placement(new_session(after), after, ctx([])).code == "OUT_OF_PLAN"
    before_start = MoveContext(sessions=[], plan_start=date(2026, 10, 12), plan_end=PLAN_END, today=TODAY)
    assert check_placement(new_session(date(2026, 10, 10)), date(2026, 10, 10), before_start).code == "OUT_OF_PLAN"


@pytest.mark.parametrize("status", ["planned", "accepted", "moved", "completed", "partial", "missed"])
def test_a_session_in_any_state_takes_its_day_and_the_refusal_names_the_nearest_free_one(status):
    other = session(date(2026, 10, 3), status=status)
    refusal = check_placement(new_session(other.date), other.date, ctx([other]))
    assert refusal.code == "DAY_OCCUPIED"
    assert refusal.suggested_date == date(2026, 10, 4)  # the later day wins a tie
    assert check_placement(new_session(refusal.suggested_date), refusal.suggested_date, ctx([other])) is None


def test_a_new_push_cannot_sit_beside_a_push_and_is_pointed_to_a_day_that_works():
    neighbours = [session(date(2026, 10, 19), "push")]
    refusal = check_placement(new_session(date(2026, 10, 18), "push"), date(2026, 10, 18), ctx(neighbours))
    assert refusal.code == "CONSECUTIVE_HIGH_INTENSITY"
    assert refusal.suggested_date == date(2026, 10, 17)
    assert check_placement(new_session(refusal.suggested_date, "push"), refusal.suggested_date, ctx(neighbours)) is None


def test_a_new_light_session_may_sit_beside_a_push():
    neighbours = [session(date(2026, 10, 19), "push")]
    assert check_placement(new_session(date(2026, 10, 18), "light"), date(2026, 10, 18), ctx(neighbours)) is None


def test_a_push_the_day_after_a_finished_push_is_refused_but_not_after_a_missed_one():
    done = session(date(2026, 10, 19), "push", status="completed")
    missed = session(date(2026, 10, 19), "push", status="missed")
    day = date(2026, 10, 20)
    assert check_placement(new_session(day, "push"), day, ctx([done])).code == "CONSECUTIVE_HIGH_INTENSITY"
    assert check_placement(new_session(day, "push"), day, ctx([missed])) is None


def test_changing_a_session_to_push_where_it_stands_is_checked_against_its_neighbours_not_itself():
    mine = session(date(2026, 10, 17), "light", sid="mine")
    next_door = session(date(2026, 10, 18), "push")
    as_push = mine.model_copy(update={"intensity_band": "push"})
    assert check_placement(as_push, as_push.date, ctx([mine, next_door])).code == "CONSECUTIVE_HIGH_INTENSITY"
    assert check_placement(as_push, as_push.date, ctx([mine])) is None  # its own day isn't "occupied"


def test_a_session_on_a_day_of_its_own_choice_is_not_a_no_change():
    """Moving refuses staying put; placing a new session on the day it was drafted for is exactly the point."""
    day = date(2026, 10, 3)
    assert check_placement(new_session(day), day, ctx([])) is None
    assert check_move(new_session(day), day, ctx([])).code == "NO_CHANGE"


def test_deload_weeks_take_only_deload_sessions_and_other_weeks_never_do():
    assert band_refusal("deload", deload_week=True) is None
    assert "deload week" in band_refusal("push", deload_week=True)
    assert "deload week" in band_refusal("light", deload_week=True)
    assert band_refusal("push", deload_week=False) is None
    assert band_refusal("light", deload_week=False) is None
    assert "Deload is only for deload weeks" in band_refusal("deload", deload_week=False)


# ------------------------------------------------------------------ reconciliation (Hard Rule 2)


def readiness(classification: str, score: int = 60) -> ReadinessScore:
    return ReadinessScore(
        score=score, classification=classification, factors=[], explanation="",  # type: ignore[arg-type]
        date=TODAY, computed_at=datetime(2026, 9, 30, tzinfo=timezone.utc),
    )


RANK = {"deload": 0, "light": 1, "push": 2}


@pytest.mark.parametrize("planned_band", ["deload", "light", "push"])
@pytest.mark.parametrize("classification", ["deload", "light", "push"])
def test_readiness_only_ever_pulls_a_session_down(planned_band, classification):
    """Hard Rule 2: the recommended band is never above the planned band, and only drops when readiness is lower."""
    planned = session(TODAY, planned_band)
    result = reconcile(planned, readiness(classification))

    assert RANK[result.intensity_band] <= RANK[planned_band]
    assert result.intensity_band == min(planned_band, classification, key=lambda b: RANK[b])
    assert result.downgraded == (RANK[classification] < RANK[planned_band])


def test_high_readiness_never_upgrades_a_planned_light_session():
    planned = session(TODAY, "light")
    result = reconcile(planned, readiness("push", 90))
    assert result.intensity_band == "light" and not result.downgraded
    assert (result.target_volume, result.target_duration_min) == (30, 45)
    assert "plan stays" in result.explanation


def test_downgrade_reduces_the_session_and_says_why():
    planned = session(TODAY, "push")
    result = reconcile(planned, readiness("light", 58))
    assert result.downgraded and result.intensity_band == "light"
    assert result.target_volume < 30 and result.target_duration_min < 45
    assert "58/100" in result.explanation and "push" in result.explanation

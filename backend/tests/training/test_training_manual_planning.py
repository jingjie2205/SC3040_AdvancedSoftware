"""
Planning the schedule by hand: adding a session, changing one, and the rules both keep.

The plan decides how much training a week carries: its whole load with the usual number of sessions (four here) and a
proportional share with fewer, as the generator builds a week that is already partly gone. A session joins by taking its
share of that (by intensity and length), and the week's other sessions give a little to make room, the same promise
removing one makes the other way round. Beyond the usual number of sessions the load is only shared, never grown.
Hard Rule 1 is checked by behaviour: Strava logs are on the schedule, but nothing here reads them.

The plan these tests use (Wednesday 30 Sep is "today"; sessions Monday, Wednesday, Friday and Saturday):
  week 0, 28 Sep (partly gone): Wed 30 light, Fri 2 Oct light, Sat 3 Oct push        75 of the plan's 99 pts
  week 1, 5 Oct:  Mon push, Wed 7 light, Fri 9 light, Sat 10 push                    104 pts
  week 2, 12 Oct: Mon push, Wed 14 light, Fri 16 light, Sat 17 push                  108 pts
  week 3, 19 Oct: all four deload                                                     76 pts
"""
import re
from copy import deepcopy
from datetime import date, timedelta
from pathlib import Path
from typing import get_args

import pytest

from app.training.config import RULES
from app.training.errors import ErrorCode, TrainingError
from app.training.models import (
    AddSessionRequest,
    GeneratePlanRequest,
    LogWorkoutInput,
    PlannedSession,
    SessionResponseRequest,
    SessionUpdateRequest,
    TrainingPreferencesInput,
)
from app.training.planner import plan_week_target, week_start
from app.training.readiness import RuleBasedScorer
from app.training.service import TrainingService
from training_fakes import STANDARD_PREFS, TODAY, USER_A, USER_B, FakeTrainingRepository, seed_history, workout

MONDAY = week_start(TODAY)
WEEK1 = MONDAY + timedelta(days=7)
WEEK2 = MONDAY + timedelta(days=14)
DELOAD_WEEK = MONDAY + timedelta(days=21)

THURSDAY = date(2026, 10, 8)  # free, in week 1
SUNDAY = date(2026, 10, 11)  # free, in week 1, the day after a push


def planned(user: str = USER_A, weeks: int = 8):
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    seed_history(repo, user, MONDAY)
    plan = service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=weeks))
    return service, repo, plan


def week_of(repo, monday: date, user: str = USER_A):
    return repo.list_sessions(user, monday, monday + timedelta(days=6))


def load(repo, monday: date, user: str = USER_A) -> int:
    return sum(s.target_volume for s in week_of(repo, monday, user))


def at(repo, day: date, user: str = USER_A):
    return repo.list_sessions(user, day, day)[0]


def add(service, day: date, activity: str = "run", band: str = "light", minutes=None, today: date = TODAY,
        user: str = USER_A):
    return service.add_session(
        user, today,
        AddSessionRequest(date=day, activity_type=activity, intensity_band=band, target_duration_min=minutes),
    )


def change(service, session_id: str, today: date = TODAY, user: str = USER_A, **fields):
    return service.update_session(user, today, session_id, SessionUpdateRequest(**fields))


def error_of(call) -> TrainingError:
    with pytest.raises(TrainingError) as raised:
        call()
    return raised.value


def untouched(repo, call) -> TrainingError:
    """The call is refused and the database is exactly as it was: no partial write."""
    before = (deepcopy(repo.sessions), repo.apply_calls)
    error = error_of(call)
    assert (repo.sessions, repo.apply_calls) == before
    return error


# ------------------------------------------------------------------ adding a session


def test_an_added_session_is_on_the_schedule_in_the_plan_and_the_weeks_load_is_unchanged():
    service, repo, plan = planned()
    before = {s.id: s.target_volume for s in week_of(repo, WEEK1)}
    calls = repo.apply_calls

    result = add(service, THURSDAY, "run", "light")

    added = result.session
    assert (added.date, added.activity_type, added.intensity_band, added.status) == (THURSDAY, "run", "light", "planned")
    assert added.plan_id == plan.id and repo.get_session(USER_A, added.id) == added
    assert repo.apply_calls == calls + 1  # one transaction
    assert load(repo, WEEK1) == sum(before.values()) == 104
    assert result.adjusted_count == len(before) == 4
    # Everything that was already there gave something up, and the new session is lighter than the hard ones.
    after = {s.id: s.target_volume for s in week_of(repo, WEEK1) if s.id in before}
    assert all(after[sid] < before[sid] for sid in before)
    assert added.target_volume < min(at(repo, day).target_volume for day in (date(2026, 10, 5), date(2026, 10, 10)))


def test_without_a_length_a_session_gets_the_preferred_length_for_its_intensity():
    for band, minutes in (("light", 35), ("push", 45)):  # 45 is the preference itself
        service, repo, _ = planned()
        assert add(service, THURSDAY, band=band).session.target_duration_min == minutes


def test_a_chosen_length_is_kept_and_a_longer_session_takes_a_bigger_share():
    service, repo, _ = planned()
    short = add(service, THURSDAY, band="light", minutes=20).session
    assert short.target_duration_min == 20
    service.remove_session(USER_A, TODAY, short.id)
    long_ = add(service, THURSDAY, band="light", minutes=90).session
    assert long_.target_duration_min == 90 and long_.target_volume > short.target_volume


def test_a_harder_session_takes_a_bigger_share_than_an_easier_one_of_the_same_length():
    service, repo, _ = planned()
    easy = add(service, THURSDAY, band="light", minutes=40).session
    service.remove_session(USER_A, TODAY, easy.id)
    hard = add(service, THURSDAY, band="push", minutes=40).session
    assert hard.target_volume > easy.target_volume


def test_the_other_sessions_keep_their_order_of_size():
    service, repo, _ = planned()
    push, light = at(repo, date(2026, 10, 5)), at(repo, date(2026, 10, 7))
    assert push.target_volume > light.target_volume

    add(service, THURSDAY)

    assert at(repo, push.date).target_volume > at(repo, light.date).target_volume


def test_adding_again_keeps_sharing_the_same_load_not_growing_it():
    service, repo, _ = planned()
    add(service, THURSDAY)
    add(service, date(2026, 10, 6))
    add(service, SUNDAY, band="light")
    assert load(repo, WEEK1) == 104
    assert len(week_of(repo, WEEK1)) == 7


def test_a_week_the_plan_has_thinned_out_is_brought_back_to_the_plans_load_and_no_further():
    service, repo, plan = planned()
    assert load(repo, MONDAY) == 75 and plan_week_target(plan, MONDAY) == 99  # this week started midweek

    add(service, date(2026, 10, 1))
    assert load(repo, MONDAY) == 99
    add(service, date(2026, 10, 4))
    assert load(repo, MONDAY) == 99  # now it is only shared out


def test_a_hand_planned_week_carries_more_with_each_session_until_it_has_the_usual_four_then_only_shares():
    service, repo, plan = planned()
    for session in week_of(repo, WEEK2):
        service.remove_session(USER_A, TODAY, session.id)
    assert load(repo, WEEK2) == 0
    assert plan_week_target(plan, WEEK2) == 109

    totals = []
    for day, band in ((13, "light"), (15, "light"), (17, "push"), (12, "push")):
        result = add(service, date(2026, 10, day), band=band)
        totals.append(load(repo, WEEK2))
        assert result.session.target_volume > 0
    assert totals == [27, 55, 82, 109]  # a quarter, a half, three quarters, all of the plan's 109

    add(service, date(2026, 10, 14), band="light")  # a fifth session shares the same 109
    assert load(repo, WEEK2) == 109


def test_a_week_whose_load_is_already_done_has_nothing_left_to_share():
    service, repo, _ = planned()
    for session in week_of(repo, WEEK1):
        repo.sessions[session.id] = (USER_A, session.model_copy(update={"status": "completed"}))

    error = untouched(repo, lambda: add(service, THURSDAY))

    assert error.code == "WEEK_FULL" and error.status_code == 409
    assert "log it as an extra workout" in error.message


def test_missed_sessions_have_used_their_share_too():
    service, repo, plan = planned()
    missed = at(repo, date(2026, 10, 5))
    repo.sessions[missed.id] = (USER_A, missed.model_copy(update={"status": "missed"}))
    left_to_do = load(repo, WEEK1) - missed.target_volume

    add(service, THURSDAY)

    # The missed push is not made up for: the rest of the week is shared out, and the total stays where it was.
    assert load(repo, WEEK1) == left_to_do + missed.target_volume
    assert repo.get_session(USER_A, missed.id).target_volume == missed.target_volume


def test_the_added_session_can_be_logged_and_completed_like_any_other():
    service, repo, _ = planned()
    day = date(2026, 10, 1)
    result = add(service, day, "gym", "light", today=day)

    logged = service.log_session(
        USER_A, day, result.session.id,
        LogWorkoutInput(date=day, activity_type="gym", actual_duration_min=35, actual_volume=result.session.target_volume),
    )

    assert logged.session.status == "completed"
    assert service.get_today(USER_A, day).planned.id == result.session.id


def test_an_added_session_for_today_is_todays_workout():
    service, repo, _ = planned()
    day = date(2026, 10, 1)
    result = add(service, day, "gym", "light", today=day)
    today_view = service.get_today(USER_A, day)
    assert today_view.planned.id == result.session.id
    assert today_view.recommendation.activity_type == "gym"


def _plan_made_on(day: date):
    """A plan generated on `day`, so the part of that week before it is simply not part of the plan."""
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    service.save_preferences(USER_A, day, STANDARD_PREFS)
    seed_history(repo, USER_A, week_start(day))
    plan = service.generate_plan(USER_A, day, GeneratePlanRequest(weeks=8))
    return service, repo, plan


def test_a_session_added_to_a_week_that_is_nearly_over_brings_a_usual_share_not_the_whole_weeks_load():
    """Made on a Sunday (a rest day), this week has no sessions at all. One on Sunday is one of its usual four."""
    sunday = date(2026, 10, 4)
    service, repo, plan = _plan_made_on(sunday)
    assert week_of(repo, MONDAY) == [] and plan_week_target(plan, MONDAY) == 99

    result = add(service, sunday, "run", "light", today=sunday)

    assert result.session.target_volume == 25 and result.adjusted_count == 0  # a quarter of 99, not all of it


def test_a_second_session_in_a_week_made_on_its_last_days_takes_it_to_a_proportional_share_only():
    saturday = date(2026, 10, 3)
    service, repo, plan = _plan_made_on(saturday)
    assert [(s.date, s.target_volume) for s in week_of(repo, MONDAY)] == [(saturday, 25)]

    add(service, date(2026, 10, 4), "run", "light", today=saturday)

    assert load(repo, MONDAY) == 50  # two of the usual four sessions, so half of the plan's 99 (not all of it)


# ------------------------------------------------------------------ what adding refuses


@pytest.mark.parametrize(
    "day,band,code",
    [
        (TODAY - timedelta(days=1), "light", "IN_PAST"),
        (date(2026, 11, 23), "light", "OUT_OF_PLAN"),  # the plan ends on 22 Nov
        (SUNDAY, "push", "CONSECUTIVE_HIGH_INTENSITY"),  # the day after Saturday's push
    ],
)
def test_a_day_the_rules_forbid_is_refused_and_nothing_is_written(day, band, code):
    service, repo, _ = planned()
    error = untouched(repo, lambda: add(service, day, band=band))
    assert error.code == code and error.status_code == 409


def test_a_refused_day_comes_with_the_nearest_day_that_works():
    service, repo, _ = planned()
    for day, band in ((SUNDAY, "push"),):
        suggestion = untouched(repo, lambda: add(service, day, band=band)).suggested_date
        assert suggestion is not None and suggestion != day
        add(service, suggestion, band=band)  # and it really does work
        service.remove_session(USER_A, TODAY, at(repo, suggestion).id)


def test_a_light_session_may_follow_a_push():
    service, repo, _ = planned()
    assert add(service, SUNDAY, band="light").session.date == SUNDAY


def test_a_deload_week_only_takes_deload_sessions():
    service, repo, _ = planned()
    tuesday = DELOAD_WEEK + timedelta(days=1)
    for band in ("push", "light"):
        error = untouched(repo, lambda: add(service, tuesday, band=band))
        assert error.code == "VALIDATION" and error.status_code == 422
        assert "deload week" in error.detail["fieldErrors"]["intensityBand"]
    assert add(service, tuesday, band="deload").session.intensity_band == "deload"


def test_a_deload_session_is_for_deload_weeks_only():
    service, repo, _ = planned()
    error = untouched(repo, lambda: add(service, THURSDAY, band="deload"))
    assert error.code == "VALIDATION" and "only for deload weeks" in error.detail["fieldErrors"]["intensityBand"]


def test_only_the_athletes_own_activities_can_be_planned():
    service, repo, _ = planned()
    error = untouched(repo, lambda: add(service, THURSDAY, activity="bodyweight"))  # run, gym and cycling are theirs
    assert error.code == "VALIDATION" and "activityType" in error.detail["fieldErrors"]


def test_both_problems_are_reported_together():
    service, repo, _ = planned()
    error = untouched(repo, lambda: add(service, THURSDAY, activity="bodyweight", band="deload"))
    assert set(error.detail["fieldErrors"]) == {"activityType", "intensityBand"}


def test_without_a_plan_there_is_nothing_to_add_to():
    service = TrainingService(FakeTrainingRepository(), RuleBasedScorer())
    service.save_preferences(USER_A, TODAY, STANDARD_PREFS)
    error = error_of(lambda: add(service, THURSDAY))
    assert error.code == "NO_PLAN" and error.status_code == 404


def test_without_preferences_the_athlete_is_asked_for_them():
    service, repo, _ = planned()
    del repo.preferences[USER_A]
    assert untouched(repo, lambda: add(service, THURSDAY)).code == "NO_PREFERENCES"


# ------------------------------------------------------------------ days held by an older plan


def _replaced_plan_with_a_finished_session_today():
    """Today's session is logged, then the plan is replaced: that finished session stays on its day as history."""
    service, repo, old = planned()
    todays = at(repo, TODAY)
    service.log_session(
        USER_A, TODAY, todays.id,
        LogWorkoutInput(date=TODAY, activity_type=todays.activity_type, actual_duration_min=35,
                        actual_volume=todays.target_volume),
    )
    new = service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=6, confirm_replace=True))
    history = repo.get_session(USER_A, todays.id)
    assert history.plan_id == old.id and history.status == "completed" and new.id != old.id
    return service, repo, new, history


def test_a_day_held_by_a_replaced_plans_finished_session_can_be_shared():
    service, repo, _, history = _replaced_plan_with_a_finished_session_today()
    added = add(service, history.date)
    assert added.session.date == history.date
    assert len([s for s in repo.list_sessions(USER_A, history.date, history.date)]) >= 2


def test_moving_a_session_onto_that_day_works_too():
    service, repo, new, history = _replaced_plan_with_a_finished_session_today()
    mover = next(s for s in repo.list_sessions(USER_A, TODAY + timedelta(days=1), new.end_date) if s.plan_id == new.id)

    moved = service.reschedule_session(USER_A, TODAY, mover.id, history.date)

    assert moved.date == history.date and moved.status == "moved"


def test_a_second_session_on_a_busy_day_takes_its_share_of_the_week_like_any_other():
    service, repo, plan = planned()
    wednesday = date(2026, 10, 7)
    before = sum(s.target_volume for s in week_of(repo, MONDAY))
    added = add(service, wednesday)
    assert len(repo.list_sessions(USER_A, wednesday, wednesday)) == 2
    assert sum(s.target_volume for s in week_of(repo, MONDAY)) == before + 0 and added.session.target_volume > 0  # the week still adds up to the plan's


def test_a_finished_push_from_a_replaced_plan_still_counts_as_a_neighbour():
    service, repo, old = planned()
    push = at(repo, date(2026, 10, 3))  # Saturday's push
    assert push.intensity_band == "push"
    repo.sessions[push.id] = (USER_A, push.model_copy(update={"status": "completed"}))
    service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=6, confirm_replace=True))
    assert repo.get_session(USER_A, push.id).plan_id == old.id
    # Monday's push belongs to the new plan; take it away so the only push beside Sunday is the old plan's.
    service.remove_session(USER_A, TODAY, at(repo, date(2026, 10, 5)).id)

    error = untouched(repo, lambda: add(service, date(2026, 10, 4), band="push"))
    assert error.code == "CONSECUTIVE_HIGH_INTENSITY"
    assert add(service, date(2026, 10, 4), band="light").session.date == date(2026, 10, 4)


def test_a_push_the_day_before_the_plan_starts_counts_as_a_neighbour_of_its_first_day():
    monday = date(2026, 10, 5)  # the plan's first day, and today
    prefs = TrainingPreferencesInput(days_per_week=3, session_duration_min=45, activity_types=["run", "gym"],
                                     rest_days=["mon", "tue", "thu", "sun"])  # Monday and Tuesday are free days
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    service.save_preferences(USER_A, monday, prefs)
    seed_history(repo, USER_A, week_start(monday))
    plan = service.generate_plan(USER_A, monday, GeneratePlanRequest(weeks=6))
    assert plan.start_date == monday and week_of(repo, monday)[0].date > monday
    repo.sessions["older"] = (USER_A, PlannedSession(
        id="older", plan_id="an-older-plan", date=monday - timedelta(days=1), activity_type="run", target_volume=30,
        target_duration_min=45, intensity_band="push", status="completed"))

    error = untouched(repo, lambda: add(service, monday, band="push", today=monday))
    assert error.code == "CONSECUTIVE_HIGH_INTENSITY"
    assert add(service, monday, band="light", today=monday).session.date == monday


# ------------------------------------------------------------------ the rest of the system


def test_adapting_the_plan_rebuilds_the_weeks_to_come_so_hand_planned_sessions_in_them_go():
    """Like a moved session, a hand-planned one belongs to the weeks Adapt rebuilds. This pins that down on purpose."""
    service, repo, _ = planned()
    added = add(service, THURSDAY).session
    assert repo.get_session(USER_A, added.id) is not None

    service.recalculate_plan(USER_A, TODAY)

    assert repo.get_session(USER_A, added.id) is None
    assert all(s.date.weekday() in (0, 2, 4, 5) for s in week_of(repo, WEEK1))


def test_strava_logs_never_change_what_a_session_gets():
    plain_service, plain_repo, _ = planned()
    busy_service, busy_repo, _ = planned()
    for n in range(12):
        row = workout(date(2026, 9, 1) + timedelta(days=n * 3), volume=900, avg_hr=170, source="strava")
        busy_repo.workouts[row.id] = (USER_A, row)

    quiet = add(plain_service, THURSDAY)
    noisy = add(busy_service, THURSDAY)

    assert (quiet.session.target_volume, quiet.adjusted_count) == (noisy.session.target_volume, noisy.adjusted_count)
    assert [s.target_volume for s in week_of(plain_repo, WEEK1)] == [s.target_volume for s in week_of(busy_repo, WEEK1)]


def test_one_athletes_plan_is_untouched_by_another_planning_theirs():
    service, repo, _ = planned()
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    service.generate_plan(USER_B, TODAY, GeneratePlanRequest(weeks=8))
    theirs = [deepcopy(s) for s in week_of(repo, WEEK1, USER_B)]

    add(service, THURSDAY)

    assert week_of(repo, WEEK1, USER_B) == theirs
    assert len(week_of(repo, WEEK1, USER_A)) == 5


def test_nobody_can_add_to_a_plan_they_dont_have():
    service, repo, _ = planned()
    assert untouched(repo, lambda: add(service, THURSDAY, user=USER_B)).code == "NO_PLAN"


# ------------------------------------------------------------------ changing a session


def test_changing_only_the_activity_leaves_every_points_value_alone():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    before = [(s.id, s.target_volume) for s in week_of(repo, WEEK1)]
    calls = repo.apply_calls

    updated = change(service, wednesday.id, activity_type="run")

    assert updated.activity_type == "run" and updated.status == "planned"
    assert [(s.id, s.target_volume) for s in week_of(repo, WEEK1)] == before
    assert repo.apply_calls == calls + 1
    assert repo.get_session(USER_A, wednesday.id).activity_type == "run"


def test_making_a_session_easier_gives_its_share_to_the_others_and_the_weeks_total_holds():
    service, repo, _ = planned()
    monday = at(repo, date(2026, 10, 5))
    others = {s.id: s.target_volume for s in week_of(repo, WEEK1) if s.id != monday.id}

    updated = change(service, monday.id, intensity_band="light", target_duration_min=35)

    assert (updated.intensity_band, updated.target_duration_min) == ("light", 35)
    assert updated.target_volume < monday.target_volume
    assert load(repo, WEEK1) == 104
    assert all(repo.get_session(USER_A, sid).target_volume >= v for sid, v in others.items())


def test_making_a_session_longer_takes_a_bigger_share_and_the_total_holds():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))

    updated = change(service, wednesday.id, target_duration_min=90)

    assert updated.target_duration_min == 90 and updated.target_volume > wednesday.target_volume
    assert load(repo, WEEK1) == 104


def test_changing_the_intensity_alone_keeps_the_length_the_athlete_had():
    service, repo, _ = planned()
    monday = at(repo, date(2026, 10, 5))
    assert change(service, monday.id, intensity_band="light").target_duration_min == monday.target_duration_min


def test_a_session_alone_in_its_week_keeps_the_whole_week_when_it_changes():
    service, repo, _ = planned()
    for session in week_of(repo, WEEK2)[1:]:
        service.remove_session(USER_A, TODAY, session.id)
    only = week_of(repo, WEEK2)[0]

    updated = change(service, only.id, intensity_band="light", target_duration_min=20)

    assert updated.target_volume == only.target_volume == load(repo, WEEK2)


def test_a_session_keeps_its_status_when_its_details_change():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    service.respond_to_session(USER_A, TODAY, wednesday.id, SessionResponseRequest(action="accept"))
    assert change(service, wednesday.id, activity_type="gym").status == "accepted"

    friday = at(repo, date(2026, 10, 9))
    service.reschedule_session(USER_A, TODAY, friday.id, THURSDAY)
    assert change(service, friday.id, activity_type="gym").status == "moved"


def test_asking_for_what_is_already_there_changes_nothing_and_says_so():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    error = untouched(
        repo,
        lambda: change(service, wednesday.id, activity_type=wednesday.activity_type,
                       target_duration_min=wednesday.target_duration_min),
    )
    assert error.code == "NO_CHANGE"


def test_a_session_cannot_become_a_push_next_to_a_push_but_no_other_day_is_suggested():
    service, repo, _ = planned()
    friday = at(repo, date(2026, 10, 9))  # Saturday is a push
    error = untouched(repo, lambda: change(service, friday.id, intensity_band="push"))
    assert error.code == "CONSECUTIVE_HIGH_INTENSITY" and error.suggested_date is None


def test_a_session_can_become_a_push_where_nothing_pushes_beside_it():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    assert change(service, wednesday.id, intensity_band="push").intensity_band == "push"


def test_the_deload_rules_hold_when_changing_a_session_too():
    service, repo, _ = planned()
    deload = at(repo, DELOAD_WEEK)
    assert untouched(repo, lambda: change(service, deload.id, intensity_band="push")).code == "VALIDATION"
    normal = at(repo, date(2026, 10, 7))
    assert untouched(repo, lambda: change(service, normal.id, intensity_band="deload")).code == "VALIDATION"


def test_a_changed_activity_must_be_one_of_the_athletes_own():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    error = untouched(repo, lambda: change(service, wednesday.id, activity_type="bodyweight"))
    assert error.code == "VALIDATION" and "activityType" in error.detail["fieldErrors"]


def test_an_activity_the_athlete_no_longer_lists_can_stay_when_something_else_changes():
    service, repo, _ = planned()
    wednesday = at(repo, date(2026, 10, 7))
    repo.sessions[wednesday.id] = (USER_A, wednesday.model_copy(update={"activity_type": "bodyweight"}))
    assert change(service, wednesday.id, target_duration_min=40).activity_type == "bodyweight"


def test_finished_sessions_and_other_peoples_cannot_be_changed():
    service, repo, old = planned()
    todays = at(repo, TODAY)
    service.log_session(
        USER_A, TODAY, todays.id,
        LogWorkoutInput(date=TODAY, activity_type=todays.activity_type, actual_duration_min=35, actual_volume=20),
    )
    assert untouched(repo, lambda: change(service, todays.id, activity_type="run")).code == "NOT_MOVABLE"

    wednesday = at(repo, date(2026, 10, 7))
    assert untouched(repo, lambda: change(service, wednesday.id, user=USER_B, activity_type="run")).code == "NOT_FOUND"
    assert untouched(repo, lambda: change(service, "no-such-session", activity_type="run")).code == "NOT_FOUND"


def test_a_session_of_a_replaced_plan_cannot_be_changed():
    service, repo, old = planned()
    stale = at(repo, date(2026, 10, 7))
    repo.plans[old.id] = (USER_A, old.model_copy(update={"status": "superseded"}))
    service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=4))
    repo.sessions[stale.id] = (USER_A, stale)  # keep it around, as an old plan's session
    assert untouched(repo, lambda: change(service, stale.id, activity_type="run")).code == "NOT_MOVABLE"


def test_a_date_in_the_same_request_is_a_move_and_follows_the_move_rules():
    service, repo, _ = planned()
    friday = at(repo, date(2026, 10, 9))
    moved = service.update_session(USER_A, TODAY, friday.id, SessionUpdateRequest(date=THURSDAY))
    assert (moved.date, moved.status, moved.target_volume) == (THURSDAY, "moved", friday.target_volume)


def test_a_request_must_ask_for_a_move_or_for_a_change_and_not_both():
    for body in ({}, {"date": THURSDAY, "activity_type": "run"}):
        with pytest.raises(ValueError):
            SessionUpdateRequest(**body)
    assert SessionUpdateRequest(date=THURSDAY).date == THURSDAY
    assert SessionUpdateRequest(intensity_band="light").intensity_band == "light"


# ------------------------------------------------------------------ the frontend's copy of the rules

LIB = Path(__file__).resolve().parents[3] / "frontend" / "lib" / "training"
frontend_copy = pytest.mark.skipif(not LIB.exists(), reason="frontend not present")


def _ts_numbers(block: str) -> dict:
    return {key: float(value) for key, value in re.findall(r"(\w+):\s*(-?[\d.]+)", block)}


def _config_block(name: str) -> dict:
    source = (LIB / "config.ts").read_text(encoding="utf-8")
    found = re.search(rf"\b{name}:\s*\{{([^}}]*)\}}", source)
    assert found, f"{name} is not in config.ts"
    return _ts_numbers(found.group(1))


def _config_number(name: str) -> float:
    source = (LIB / "config.ts").read_text(encoding="utf-8")
    found = re.search(rf"\b{name}:\s*(-?[\d.]+)", source)
    assert found, f"{name} is not in config.ts"
    return float(found.group(1))


@frontend_copy
def test_the_frontends_band_tables_match_the_backends():
    """The fixtures and the dialog's default lengths are computed from these, so they have to agree with the server."""
    assert _config_block("bandWeight") == RULES.band_weight
    assert _config_block("bandDurationFactor") == RULES.band_duration_factor


@frontend_copy
def test_the_frontends_length_and_deload_rules_match_the_backends():
    lengths = _config_block("sessionDurationMin")
    assert (lengths["min"], lengths["max"]) == (RULES.session_duration_min, RULES.session_duration_max)
    assert _config_number("deloadEveryNWeeks") == RULES.deload_every_n_weeks
    assert _config_number("deloadVolumeFactor") == RULES.deload_volume_factor
    assert _config_number("weeklyProgressionPct") == RULES.weekly_progression_pct


@frontend_copy
def test_the_frontend_knows_every_error_code_the_backend_can_send():
    known = (LIB / "api.ts").read_text(encoding="utf-8") + (LIB / "rules.ts").read_text(encoding="utf-8")
    missing = [code for code in get_args(ErrorCode) if f'"{code}"' not in known]
    assert missing == []


# ------------------------------------------------------------------ two sessions on one day


def _two_sessions_today():
    service, repo, _ = planned()
    first = at(repo, TODAY)
    second = add(service, TODAY, band="light").session
    assert {s.id for s in repo.list_sessions(USER_A, TODAY, TODAY)} == {first.id, second.id}
    return service, repo, sorted([first, second], key=lambda s: s.id)


def _log_session(service, session):
    return service.log_session(
        USER_A, TODAY, session.id,
        LogWorkoutInput(date=TODAY, activity_type=session.activity_type, actual_duration_min=30,
                        actual_volume=session.target_volume),
    )


@pytest.mark.parametrize("done_first", [0, 1])
def test_today_and_the_summary_show_the_session_still_to_do_when_the_day_holds_two(done_first):
    service, repo, pair = _two_sessions_today()
    finished, waiting = pair[done_first], pair[1 - done_first]
    assert service.get_today(USER_A, TODAY).planned.id == min(s.id for s in pair)  # nothing done: the same one every read

    _log_session(service, finished)

    assert service.get_today(USER_A, TODAY).planned.id == waiting.id
    summary = service.get_summary(USER_A, TODAY).today
    assert summary.state == "to_do" and summary.session.id == waiting.id

    _log_session(service, waiting)

    assert service.get_summary(USER_A, TODAY).today.state == "done"
    assert service.get_today(USER_A, TODAY).planned.id in {finished.id, waiting.id}

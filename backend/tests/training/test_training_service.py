from datetime import date, datetime, timedelta, timezone

import pytest

from app.training.config import PLAN_NOTICE, RULES
from app.training.errors import TrainingError
from app.training.models import (
    GeneratePlanRequest,
    LogWorkoutInput,
    ReadinessScore,
    SessionResponseRequest,
)
from app.training.planner import AthleteProfile, week_start
from app.training.readiness import Checkin, RuleBasedScorer
from app.training.service import TrainingService
from training_fakes import (
    STANDARD_PREFS,
    TODAY,
    USER_A,
    USER_B,
    FakeTrainingRepository,
    seed_history,
    workout,
)

MONDAY = week_start(TODAY)


def make() -> tuple:
    repo = FakeTrainingRepository()
    return TrainingService(repo, RuleBasedScorer()), repo


def onboarded(user: str = USER_A) -> tuple:
    service, repo = make()
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    seed_history(repo, user, MONDAY)
    return service, repo


def with_plan(user: str = USER_A, weeks: int = 8) -> tuple:
    service, repo = onboarded(user)
    plan = service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=weeks))
    return service, repo, plan


def log_input(day: date, volume: float = 30, minutes: int = 40, **extra) -> LogWorkoutInput:
    return LogWorkoutInput(date=day, activity_type="run", actual_duration_min=minutes,
                           actual_volume=volume, **extra)


def error_of(call) -> TrainingError:
    with pytest.raises(TrainingError) as raised:
        call()
    return raised.value


# ------------------------------------------------------------------ preferences


def test_preferences_round_trip_and_are_per_user():
    service, _ = make()
    saved = service.save_preferences(USER_A, TODAY, STANDARD_PREFS)
    assert service.get_preferences(USER_A) == saved
    assert service.get_preferences(USER_B) is None


# ------------------------------------------------------------------ generate (T-2)


def test_generating_needs_preferences():
    service, _ = make()
    assert error_of(lambda: service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))).code == "NO_PREFERENCES"


def test_a_generated_plan_carries_the_medical_notice_and_a_baseline_from_history():
    """Hard Rule 5: every generated plan carries the not-medical-advice notice."""
    service, repo, plan = with_plan()
    assert plan.notice == PLAN_NOTICE and "not medical advice" in plan.notice
    assert plan.baseline_volume == 99  # three 33-point sessions a week
    assert plan.start_date == MONDAY and plan.weeks == 8 and plan.status == "active"
    sessions = repo.list_sessions(USER_A, plan.start_date, plan.end_date)
    assert sessions and min(s.date for s in sessions) >= TODAY
    assert all(s.plan_id == plan.id and s.status == "planned" for s in sessions)


def _first_plan(profile=None, user: str = USER_A):
    """A brand-new user (no history) generating their first plan."""
    service, repo = make()
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    if profile:
        repo.profiles[user] = profile
    return service, service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=4))


def test_a_new_users_first_plan_starts_from_their_activity_level():
    _, plan = _first_plan(AthleteProfile(activity_level="SEDENTARY"))
    assert plan.baseline_volume == RULES.default_baseline_for("SEDENTARY") < RULES.default_baseline_volume


def test_without_a_profile_the_first_plan_uses_the_plain_default():
    _, plan = _first_plan()
    assert plan.baseline_volume == RULES.default_baseline_volume


def test_logged_history_beats_the_profile_when_generating():
    with_profile, repo = onboarded()
    repo.profiles[USER_A] = AthleteProfile(activity_level="EXTRA_ACTIVE")
    plan = with_profile.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=4, confirm_replace=True))
    plain, _ = onboarded()
    assert plan.baseline_volume == plain.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=4)).baseline_volume


def test_one_users_profile_never_shapes_another_users_plan():
    service, repo = make()
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    repo.profiles[USER_A] = AthleteProfile(activity_level="SEDENTARY")
    plan = service.generate_plan(USER_B, TODAY, GeneratePlanRequest(weeks=4))
    assert plan.baseline_volume == RULES.default_baseline_volume


def test_the_adaptation_note_names_the_activity_level_when_it_set_the_default():
    service, plan = _first_plan(AthleteProfile(activity_level="SEDENTARY"))
    adapted = service.recalculate_plan(USER_A, TODAY)
    assert adapted.last_adaptation is not None
    assert "for your activity level" in adapted.last_adaptation.reason


def test_plan_and_sessions_are_written_in_one_transaction():
    service, repo = onboarded()
    before = repo.apply_calls
    service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert repo.apply_calls == before + 1


def test_replacing_a_plan_needs_explicit_confirmation_and_changes_nothing_without_it():
    service, repo, plan = with_plan()
    before = (repo.apply_calls, len(repo.sessions))
    assert error_of(lambda: service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=6))).code == "PLAN_EXISTS"
    assert (repo.apply_calls, len(repo.sessions)) == before
    assert service.get_plan(USER_A, TODAY).id == plan.id


def test_replacing_keeps_history_and_leaves_exactly_one_active_plan():
    service, repo, old = with_plan()
    today_session = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.log_session(USER_A, TODAY, today_session.id, log_input(TODAY, today_session.target_volume))

    new = service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=6, confirm_replace=True))

    plans = [p for o, p in repo.plans.values() if o == USER_A]
    assert sorted(p.status for p in plans) == ["active", "superseded"]
    assert service.get_plan(USER_A, TODAY).id == new.id
    survivor = repo.get_session(USER_A, today_session.id)
    assert survivor is not None and survivor.status == "completed"  # today's finished session is history
    assert not [s for s in repo.list_sessions(USER_A, TODAY, TODAY) if s.plan_id == new.id]  # no double-booking
    assert not [s for s in repo.sessions.values() if s[1].plan_id == old.id and s[1].date > TODAY]


def test_plan_length_outside_the_allowed_range_is_rejected_by_the_model():
    with pytest.raises(ValueError):
        GeneratePlanRequest(weeks=RULES.plan_weeks_max + 1)


# ------------------------------------------------------------------ today (T-3, T-4)


def test_today_without_a_plan_still_returns_readiness_and_no_workout():
    service, _ = onboarded()
    view = service.get_today(USER_A, TODAY)
    assert view.planned is None and view.recommendation is None and view.logged is None
    assert 0 <= view.readiness.score <= 100


def test_today_reconciles_the_planned_session_with_readiness():
    service, repo, _ = with_plan()
    service.repo.checkins[USER_A] = Checkin(load_rating=5, sleep_hours=4.0)  # drags readiness down
    planned = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    view = service.get_today(USER_A, TODAY)

    assert view.planned.id == planned.id
    assert view.readiness.classification in {"light", "deload"}
    assert view.recommendation.downgraded == (view.readiness.classification != "push" and planned.intensity_band != "deload"
                                              and view.readiness.classification != planned.intensity_band)


def test_readiness_is_cached_per_day_and_recomputed_when_an_input_changes():
    service, repo = onboarded()
    first = service.get_today(USER_A, TODAY).readiness
    again = service.get_today(USER_A, TODAY).readiness
    assert again.computed_at == first.computed_at  # served from cache

    stored_hash = repo.readiness[(USER_A, TODAY)][1]
    repo.checkins[USER_A] = Checkin(load_rating=5, sleep_hours=4.0)
    changed = service.get_today(USER_A, TODAY).readiness
    assert changed.score < first.score
    assert repo.readiness[(USER_A, TODAY)][1] != stored_hash


def test_logging_history_invalidates_the_next_days_cached_score():
    service, repo = onboarded()
    tomorrow = TODAY + timedelta(days=1)
    before = service.get_today(USER_A, tomorrow).readiness
    stored_hash = repo.readiness[(USER_A, tomorrow)][1]

    service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, volume=400, minutes=200, avg_hr=None))
    after = service.get_today(USER_A, tomorrow).readiness

    assert repo.readiness[(USER_A, tomorrow)][1] != stored_hash
    assert after.score <= before.score


def test_readiness_ignores_strava_rows_even_when_present_in_history():
    """Hard Rule 1 at the service level: the score doesn't move when Strava rows are added."""
    service, repo = onboarded()
    baseline = service.get_today(USER_A, TODAY).readiness.score
    repo.readiness.clear()
    for d in range(1, 8):
        w = workout(TODAY - timedelta(days=d), 900, avg_hr=195, source="strava", wid=f"strava-{d}")
        repo.workouts[w.id] = (USER_A, w)
    assert service.get_today(USER_A, TODAY).readiness.score == baseline


# ------------------------------------------------------------------ lazy sync and adaptation (T-8)


def test_days_that_pass_unlogged_become_missed_and_finished_ones_stay():
    service, repo, plan = with_plan()
    first = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.log_session(USER_A, TODAY, first.id, log_input(TODAY, first.target_volume))

    service.get_plan(USER_A, TODAY + timedelta(days=2))  # Friday

    assert repo.get_session(USER_A, first.id).status == "completed"
    assert all(s.status == "missed" for s in repo.list_sessions(USER_A, TODAY + timedelta(days=1), TODAY + timedelta(days=1)))
    friday = repo.list_sessions(USER_A, TODAY + timedelta(days=2), TODAY + timedelta(days=2))
    assert all(s.status == "planned" for s in friday)  # today isn't over yet


def test_three_missed_sessions_in_a_row_adapts_the_plan_and_says_why():
    service, repo, plan = with_plan()
    sunday = MONDAY + timedelta(days=6)  # Wed, Fri, Sat all passed unlogged

    adapted = service.get_plan(USER_A, sunday)

    assert adapted.last_adaptation is not None
    assert adapted.last_adaptation.trigger == "missed_sessions"
    assert "missed your last 3 sessions" in adapted.last_adaptation.reason
    assert adapted.last_adaptation.acknowledged is False


def test_the_same_misses_do_not_trigger_adaptation_twice():
    service, repo, plan = with_plan()
    sunday = MONDAY + timedelta(days=6)
    first = service.get_plan(USER_A, sunday)
    calls = repo.apply_calls
    second = service.get_plan(USER_A, sunday)

    assert second.last_adaptation.adapted_at == first.last_adaptation.adapted_at
    assert repo.apply_calls == calls


def test_a_completed_session_breaks_the_missed_streak():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume))
    plan = service.get_plan(USER_A, MONDAY + timedelta(days=6))
    assert plan.last_adaptation is None


def test_persistently_low_readiness_adapts_the_plan():
    service, repo, plan = with_plan()
    later = TODAY + timedelta(days=3)  # Saturday: the three days before it are all inside the plan
    now = datetime(2026, 9, 30, tzinfo=timezone.utc)
    for offset in (1, 2, 3):
        day = later - timedelta(days=offset)
        repo.readiness[(USER_A, day)] = (
            ReadinessScore(score=30, classification="deload", factors=[], explanation="", date=day, computed_at=now),
            "x",
        )
    adapted = service.get_plan(USER_A, later)
    assert adapted.last_adaptation.trigger == "low_readiness"
    assert "readiness stayed low for 3 days" in adapted.last_adaptation.reason


def test_low_readiness_from_before_the_plan_existed_does_not_adapt_it():
    service, repo, plan = with_plan()
    now = datetime(2026, 9, 30, tzinfo=timezone.utc)
    for offset in (1, 2, 3):
        day = TODAY - timedelta(days=offset)  # 27, 28, 29 Sep: the 27th is before the plan started
        repo.readiness[(USER_A, day)] = (
            ReadinessScore(score=30, classification="deload", factors=[], explanation="", date=day, computed_at=now),
            "x",
        )
    assert service.get_plan(USER_A, TODAY).last_adaptation is None


def test_manual_adaptation_rebaselines_on_completed_work_and_regenerates_only_what_is_left():
    service, repo, plan = with_plan()
    past = repo.list_sessions(USER_A, plan.start_date, TODAY - timedelta(days=1))
    calls = repo.apply_calls

    adapted = service.recalculate_plan(USER_A, TODAY)

    assert repo.apply_calls == calls + 1  # one transaction
    assert adapted.last_adaptation.trigger == "manual"
    assert "Rebaselined" in adapted.last_adaptation.reason or "conservative default" in adapted.last_adaptation.reason
    assert repo.list_sessions(USER_A, plan.start_date, TODAY - timedelta(days=1)) == past  # earlier weeks untouched
    future = repo.list_sessions(USER_A, TODAY, plan.end_date)
    assert future and all(s.plan_id == plan.id for s in future)


def test_adaptation_can_be_acknowledged_and_needs_a_plan():
    service, repo, _ = with_plan()
    service.recalculate_plan(USER_A, TODAY)
    service.acknowledge_adaptation(USER_A)
    assert service.get_plan(USER_A, TODAY).last_adaptation.acknowledged is True

    empty, _ = make()
    assert error_of(lambda: empty.recalculate_plan(USER_A, TODAY)).code == "NO_PLAN"


def test_a_finished_plan_cannot_be_adapted():
    service, repo, plan = with_plan()
    assert error_of(lambda: service.recalculate_plan(USER_A, plan.end_date + timedelta(days=1))).code == "PLAN_ENDED"


# ------------------------------------------------------------------ schedule and moves (T-6, T-7)


def test_schedule_returns_sessions_and_workouts_in_range_and_limits_the_range():
    service, repo, plan = with_plan()
    schedule = service.get_schedule(USER_A, TODAY, MONDAY, MONDAY + timedelta(days=13))
    assert schedule.sessions and all(MONDAY <= s.date <= MONDAY + timedelta(days=13) for s in schedule.sessions)

    too_long = MONDAY + timedelta(days=RULES.schedule_max_range_days + 1)
    assert error_of(lambda: service.get_schedule(USER_A, TODAY, MONDAY, too_long)).code == "VALIDATION"
    assert error_of(lambda: service.get_schedule(USER_A, TODAY, TODAY, MONDAY)).code == "VALIDATION"


def test_rescheduling_moves_the_session_and_marks_it_moved():
    service, repo, plan = with_plan()
    friday = repo.list_sessions(USER_A, TODAY + timedelta(days=2), TODAY + timedelta(days=2))[0]
    thursday = TODAY + timedelta(days=1)

    moved = service.reschedule_session(USER_A, TODAY, friday.id, thursday)

    assert moved.date == thursday and moved.status == "moved"
    assert repo.get_session(USER_A, friday.id).date == thursday


def test_a_move_that_makes_two_push_days_in_a_row_is_refused_with_a_suggestion():
    service, repo, plan = with_plan()
    saturday_push = repo.list_sessions(USER_A, date(2026, 10, 10), date(2026, 10, 10))[0]
    monday_push = repo.list_sessions(USER_A, date(2026, 10, 12), date(2026, 10, 12))[0]
    sunday = date(2026, 10, 11)
    assert saturday_push.intensity_band == monday_push.intensity_band == "push"

    error = error_of(lambda: service.reschedule_session(USER_A, TODAY, saturday_push.id, sunday))

    assert error.code == "CONSECUTIVE_HIGH_INTENSITY"
    assert error.suggested_date == date(2026, 10, 9)  # Friday: a day may hold several sessions, Tue touches Monday
    assert error.detail["suggestedDate"] == "2026-10-09"
    moved = service.reschedule_session(USER_A, TODAY, saturday_push.id, error.suggested_date)
    assert moved.date == error.suggested_date


def test_completed_sessions_cannot_be_moved_or_removed():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume))
    assert error_of(lambda: service.reschedule_session(USER_A, TODAY, wed.id, TODAY + timedelta(days=1))).code == "NOT_MOVABLE"
    assert error_of(lambda: service.remove_session(USER_A, TODAY, wed.id)).code == "NOT_MOVABLE"


def test_sessions_of_a_replaced_plan_cannot_be_moved():
    service, repo, old = with_plan()
    stale = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    # A replacement that leaves the stale session in place: mark the old plan superseded.
    repo.plans[old.id] = (USER_A, old.model_copy(update={"status": "superseded"}))
    service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=4))
    repo.sessions[stale.id] = (USER_A, stale)  # keep it around as history
    assert error_of(lambda: service.reschedule_session(USER_A, TODAY, stale.id, TODAY + timedelta(days=1))).code in {
        "NOT_MOVABLE", "DAY_OCCUPIED"}


def test_removing_a_session_spreads_its_volume_over_the_rest_of_the_week_in_one_transaction():
    service, repo, plan = with_plan()
    week = repo.list_sessions(USER_A, MONDAY, MONDAY + timedelta(days=6))
    removed = week[0]
    rest_before = {s.id: s.target_volume for s in week[1:]}
    calls = repo.apply_calls

    result = service.remove_session(USER_A, TODAY, removed.id)

    assert repo.apply_calls == calls + 1
    assert result.redistributed_count == len(rest_before)
    assert repo.get_session(USER_A, removed.id) is None
    gained = sum(repo.get_session(USER_A, sid).target_volume - v for sid, v in rest_before.items())
    assert abs(gained - removed.target_volume) <= len(rest_before)  # rounding only


# ------------------------------------------------------------------ respond (T-4)


def test_accept_swap_and_skip():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]

    assert service.respond_to_session(USER_A, TODAY, wed.id, SessionResponseRequest(action="accept")).status == "accepted"
    other = next(t for t in STANDARD_PREFS.activity_types if t != wed.activity_type)
    swapped = service.respond_to_session(USER_A, TODAY, wed.id, SessionResponseRequest(action="swap", activity_type=other))
    assert swapped.activity_type == other
    assert service.respond_to_session(USER_A, TODAY, wed.id, SessionResponseRequest(action="skip")).status == "missed"


def test_swapping_to_an_activity_outside_preferences_is_refused_and_finished_sessions_cannot_respond():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    error = error_of(lambda: service.respond_to_session(
        USER_A, TODAY, wed.id, SessionResponseRequest(action="swap", activity_type="bodyweight")))
    assert error.code == "INVALID_STATE"

    service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume))
    assert error_of(lambda: service.respond_to_session(USER_A, TODAY, wed.id, SessionResponseRequest(action="accept"))).code == "INVALID_STATE"


# ------------------------------------------------------------------ logging (T-5)


def test_logging_a_planned_session_links_it_and_completes_or_partials_by_volume():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]

    full = service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume, rpe=6, avg_hr=140))
    assert full.session.status == "completed"
    assert full.workout.planned_session_id == wed.id and full.workout.source == "manual"
    assert repo.get_workout_for_session(USER_A, wed.id).rpe == 6

    friday = TODAY + timedelta(days=2)
    fri = repo.list_sessions(USER_A, friday, friday)[0]
    partial_volume = fri.target_volume * RULES.partial_completion_ratio * 0.5
    assert service.log_session(USER_A, friday, fri.id, log_input(friday, partial_volume)).session.status == "partial"


def test_a_session_can_only_be_logged_once_and_not_before_it_happens():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume))
    assert error_of(lambda: service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, 10))).code == "INVALID_STATE"

    later = repo.list_sessions(USER_A, TODAY + timedelta(days=2), TODAY + timedelta(days=2))[0]
    assert error_of(lambda: service.log_session(USER_A, TODAY, later.id, log_input(TODAY, 10))).code == "INVALID_STATE"


def test_a_missed_session_can_still_be_logged_late():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.get_plan(USER_A, TODAY + timedelta(days=1))  # Wed passes unlogged
    assert repo.get_session(USER_A, wed.id).status == "missed"
    logged = service.log_session(USER_A, TODAY + timedelta(days=1), wed.id, log_input(TODAY, wed.target_volume))
    assert logged.session.status == "completed"


def test_future_dates_are_rejected_with_a_field_error():
    service, repo, _ = with_plan()
    error = error_of(lambda: service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY + timedelta(days=1))))
    assert error.code == "VALIDATION" and "date" in error.detail["fieldErrors"]


def test_ad_hoc_sessions_are_logged_without_a_plan_entry():
    service, repo = onboarded()
    result = service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, 25))
    assert result.session is None and result.workout.planned_session_id is None
    assert repo.list_workouts(USER_A, TODAY, TODAY)[0].id == result.workout.id


def test_calories_the_athlete_enters_are_kept_on_the_log_and_come_back_with_the_schedule():
    service, repo, _ = with_plan()
    wed = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    planned = service.log_session(USER_A, TODAY, wed.id, log_input(TODAY, wed.target_volume, calories=410))
    ad_hoc = service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, 20, calories=250))
    plain = service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, 20))
    assert (planned.workout.calories, ad_hoc.workout.calories, plain.workout.calories) == (410, 250, None)
    assert repo.get_workout_for_session(USER_A, wed.id).calories == 410

    shown = service.get_schedule(USER_A, TODAY, TODAY, TODAY).workouts
    assert sorted(w.calories for w in shown if w.calories is not None) == [250, 410]
    assert any(w.calories is None for w in shown), "a log with no calories stays empty; nothing is estimated"


def test_calories_are_a_whole_number_within_the_configured_limit():
    for bad in (-1, RULES.workout_calories_max + 1):
        with pytest.raises(ValueError):
            log_input(TODAY, 20, calories=bad)
    assert log_input(TODAY, 20, calories=0).calories == 0
    assert log_input(TODAY, 20, calories=RULES.workout_calories_max).calories == RULES.workout_calories_max


# ------------------------------------------------------------------ isolation (Hard Rule 4 and scoping)


def test_another_users_data_is_invisible_and_untouchable():
    service, repo, plan = with_plan(USER_A)
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    a_session = repo.list_sessions(USER_A, TODAY, TODAY)[0]
    service.get_today(USER_A, TODAY)  # writes A's readiness

    assert service.get_plan(USER_B, TODAY) is None
    assert service.get_schedule(USER_B, TODAY, MONDAY, MONDAY + timedelta(days=30)).sessions == []
    view = service.get_today(USER_B, TODAY)
    assert view.planned is None
    assert (USER_A, TODAY) in repo.readiness and repo.readiness[(USER_B, TODAY)][0] is not repo.readiness[(USER_A, TODAY)][0]

    for attempt in (
        lambda: service.reschedule_session(USER_B, TODAY, a_session.id, TODAY + timedelta(days=1)),
        lambda: service.remove_session(USER_B, TODAY, a_session.id),
        lambda: service.respond_to_session(USER_B, TODAY, a_session.id, SessionResponseRequest(action="skip")),
        lambda: service.log_session(USER_B, TODAY, a_session.id, log_input(TODAY)),
    ):
        assert error_of(attempt).code == "NOT_FOUND"
    assert repo.get_session(USER_A, a_session.id).status == "planned"


def test_replacing_one_users_plan_does_not_touch_the_other():
    service, repo, plan_a = with_plan(USER_A)
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    seed_history(repo, USER_B, MONDAY)
    service.generate_plan(USER_B, TODAY, GeneratePlanRequest(weeks=4))
    service.generate_plan(USER_B, TODAY, GeneratePlanRequest(weeks=4, confirm_replace=True))
    assert service.get_plan(USER_A, TODAY).id == plan_a.id


def test_a_distance_the_athlete_enters_is_kept_in_metres_on_the_log():
    service, repo, _ = with_plan()
    run = service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, 20, distance_km=5.23))
    plain = service.log_ad_hoc_session(USER_A, TODAY, log_input(TODAY, 20))
    assert (run.workout.distance_m, plain.workout.distance_m) == (5230.0, None)


def test_a_distance_is_only_for_runs_and_rides_and_within_the_limit():
    with pytest.raises(ValueError):
        LogWorkoutInput(date=TODAY, activity_type="gym", actual_duration_min=30, actual_volume=20, distance_km=3)
    for bad in (0, -1, RULES.workout_distance_km_max + 1):
        with pytest.raises(ValueError):
            log_input(TODAY, 20, distance_km=bad)
    ride = LogWorkoutInput(date=TODAY, activity_type="cycling", actual_duration_min=60, actual_volume=40, distance_km=30)
    assert ride.distance_km == 30

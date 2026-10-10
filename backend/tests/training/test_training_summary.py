"""
The Home summary: one read for a Home card, built from the same pieces as the Today view.

Hard Rule 4: it carries the user's own readiness, so it belongs to the same small set of operations as the
Today view and is only ever computed for the signed-in user. Hard Rule 1: the week's minutes leave out Strava rows.
"""
from datetime import timedelta

from app.training.models import GeneratePlanRequest, LogWorkoutInput, SessionResponseRequest
from app.training.planner import AthleteProfile, week_start
from app.training.readiness import RuleBasedScorer
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

MONDAY = week_start(TODAY)  # TODAY is a Wednesday
THURSDAY = TODAY + timedelta(days=1)  # a rest day in STANDARD_PREFS


def with_plan(user=USER_A, profile=None):
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    seed_history(repo, user, MONDAY)
    if profile:
        repo.profiles[user] = profile
    service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=8))
    return service, repo


def todays_session(repo, user=USER_A):
    return repo.list_sessions(user, TODAY, TODAY)[0]


def log_today(service, repo, minutes=40):
    session = todays_session(repo)
    service.log_session(
        USER_A, TODAY, session.id,
        LogWorkoutInput(date=TODAY, activity_type=session.activity_type, actual_duration_min=minutes,
                        actual_volume=session.target_volume),
    )


# ------------------------------------------------------------------ with no plan


def test_someone_with_no_plan_gets_a_valid_empty_summary():
    service = TrainingService(FakeTrainingRepository(), RuleBasedScorer())
    summary = service.get_summary(USER_A, TODAY)
    assert summary.date == TODAY and summary.has_plan is False and summary.goal is None
    assert summary.today.state == "no_plan" and summary.today.session is None and summary.today.recommendation is None
    assert (summary.week.start, summary.week.end) == (MONDAY, MONDAY + timedelta(days=6))
    assert (summary.week.planned_sessions, summary.week.completed_sessions, summary.week.missed_sessions,
            summary.week.logged_minutes) == (0, 0, 0, 0)
    assert summary.next_session is None
    assert 0 <= summary.readiness.score <= 100


# ------------------------------------------------------------------ with a plan


def test_a_session_still_to_do_comes_with_a_recommendation_and_the_next_one_is_the_one_after_today():
    service, repo = with_plan()
    summary = service.get_summary(USER_A, TODAY)
    session = todays_session(repo)
    assert summary.has_plan is True and summary.today.state == "to_do"
    assert summary.today.session == session
    assert summary.today.recommendation is not None and summary.today.logged is None
    # The plan was generated on a Wednesday, so this week holds Wednesday, Friday and Saturday.
    assert summary.week.planned_sessions == 3
    assert summary.next_session is not None
    assert summary.next_session.date == TODAY + timedelta(days=2)
    upcoming = repo.list_sessions(USER_A, summary.next_session.date, summary.next_session.date)[0]
    assert (summary.next_session.activity_type, summary.next_session.intensity_band,
            summary.next_session.target_duration_min) == (upcoming.activity_type, upcoming.intensity_band,
                                                           upcoming.target_duration_min)


def test_the_summary_shows_the_same_readiness_as_the_today_view():
    service, _ = with_plan()
    summary, today = service.get_summary(USER_A, TODAY), service.get_today(USER_A, TODAY)
    assert summary.readiness == today.readiness


def test_logging_todays_session_makes_it_done_and_counts_toward_the_week():
    service, repo = with_plan()
    log_today(service, repo, minutes=40)
    summary = service.get_summary(USER_A, TODAY)
    assert summary.today.state == "done" and summary.today.logged is not None
    assert summary.today.recommendation is None
    assert (summary.week.completed_sessions, summary.week.logged_minutes) == (1, 40)
    assert summary.next_session is not None and summary.next_session.date == TODAY + timedelta(days=2)


def test_a_partly_done_session_counts_as_done_and_as_completed_for_the_week():
    service, repo = with_plan()
    session = todays_session(repo)
    service.log_session(
        USER_A, TODAY, session.id,
        LogWorkoutInput(date=TODAY, activity_type=session.activity_type, actual_duration_min=20,
                        actual_volume=max(1, session.target_volume // 2)),
    )
    assert repo.get_session(USER_A, session.id).status == "partial"
    summary = service.get_summary(USER_A, TODAY)
    assert summary.today.state == "done" and summary.week.completed_sessions == 1


def test_skipping_todays_session_makes_it_missed():
    service, repo = with_plan()
    service.respond_to_session(USER_A, TODAY, todays_session(repo).id, SessionResponseRequest(action="skip"))
    summary = service.get_summary(USER_A, TODAY)
    assert summary.today.state == "missed" and summary.today.recommendation is None
    assert summary.week.missed_sessions == 1


def test_a_day_with_nothing_planned_is_a_rest_day_and_overdue_sessions_count_as_missed():
    service, _ = with_plan()
    summary = service.get_summary(USER_A, THURSDAY)
    assert summary.today.state == "rest_day" and summary.today.session is None
    assert summary.has_plan is True
    # Wednesday's session went unlogged, so reading the plan the next day marks it missed.
    assert summary.week.missed_sessions == 1
    assert summary.next_session is not None and summary.next_session.date == TODAY + timedelta(days=2)


def test_nothing_is_offered_as_next_after_the_last_planned_session():
    service, repo = with_plan()
    last = max(s.date for s in repo.list_sessions(USER_A, TODAY, TODAY + timedelta(days=200)))
    assert service.get_summary(USER_A, last).next_session is None


def test_the_goal_is_the_one_the_plan_was_built_for():
    service, repo = with_plan(profile=AthleteProfile(fitness_goal="SURPLUS"))
    assert service.get_summary(USER_A, TODAY).goal == "build_muscle"
    repo.profiles[USER_A] = AthleteProfile(fitness_goal="DEFICIT")  # changed in Settings since
    assert service.get_summary(USER_A, TODAY).goal == "build_muscle"


# ------------------------------------------------------------------ Hard Rules


def test_strava_rows_never_count_toward_the_weeks_minutes():
    """Hard Rule 1."""
    service, repo = with_plan()
    for row in (workout(TODAY, volume=500, source="strava", wid="s1"),
                workout(TODAY - timedelta(days=1), volume=300, source="strava", wid="s2"),
                workout(TODAY - timedelta(days=1), volume=20, source="manual", wid="m1")):
        repo.workouts[row.id] = (USER_A, row)
    assert service.get_summary(USER_A, TODAY).week.logged_minutes == 20


def test_one_users_summary_never_holds_another_users_data():
    service, repo = with_plan(USER_B)
    summary = service.get_summary(USER_A, TODAY)
    assert summary.has_plan is False and summary.today.state == "no_plan"
    assert summary.week.logged_minutes == 0 and summary.next_session is None

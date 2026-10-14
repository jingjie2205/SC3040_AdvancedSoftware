"""
The inputs that used to have no source: the profile goal (shapes the activity mix), exam dates and last
night's sleep (both feed readiness).

Hard Rule 4: sleep and exam dates are private to their owner, like the score they feed. Every read and
write here names the user, and one user's entries never reach another user's score.
"""
from collections import Counter
from dataclasses import replace
from datetime import date, datetime, timedelta

import pytest
from postgrest.exceptions import APIError
from pydantic import ValidationError

from app.training.config import RULES
from app.training.errors import TrainingError
from app.training.ml.scorer import ModelScorer, load_scorer
from app.training.models import (
    GeneratePlanRequest,
    SleepInput,
    TrainingPreferences,
    TrainingPreferencesInput,
)
from app.training.planner import (
    AthleteProfile,
    activity_rotation,
    build_sessions,
    goal_for,
    week_start,
    weekly_targets,
)
from app.training.readiness import Checkin, RuleBasedScorer, build_features, days_until_next_exam
from app.training.repository import SupabaseTrainingRepository
from app.training.service import TrainingService
from training_fakes import (
    STANDARD_PREFS,
    TODAY,
    USER_A,
    USER_B,
    FakeTrainingRepository,
    TableClient,
)

MONDAY = week_start(TODAY)
ALL_THREE = ["run", "gym", "cycling"]


def prefs(types=ALL_THREE, days_per_week=3, rest_days=(), exam_dates=()) -> TrainingPreferencesInput:
    return TrainingPreferencesInput(
        days_per_week=days_per_week,
        session_duration_min=45,
        activity_types=list(types),
        rest_days=list(rest_days),
        exam_dates=list(exam_dates),
    )


def drafts(preferences, goal=None, weeks=15):
    return build_sessions(preferences, MONDAY, weekly_targets(100, weeks), MONDAY, RULES, goal)


def mix(sessions) -> Counter:
    return Counter(s.activity_type for s in sessions)


def api_error(code, message="boom"):
    return APIError({"message": message, "code": code, "hint": None, "details": None})


def service_and_repo(scorer=None):
    repo = FakeTrainingRepository()
    return TrainingService(repo, scorer or RuleBasedScorer()), repo


# ------------------------------------------------------------------ the profile goal


@pytest.mark.parametrize("stored,goal", [
    ("DEFICIT", "lose_weight"),
    ("MAINTAIN", "maintain"),
    ("SURPLUS", "build_muscle"),
    ("deficit", "lose_weight"),  # nothing else writes this column, but a stray case shouldn't lose the goal
    ("  SURPLUS ", "build_muscle"),
])
def test_the_goal_settings_stores_becomes_one_this_feature_understands(stored, goal):
    assert goal_for(AthleteProfile(fitness_goal=stored)) == goal


@pytest.mark.parametrize("profile", [None, AthleteProfile(), AthleteProfile(fitness_goal=""),
                                     AthleteProfile(fitness_goal="LOSE FAT FAST"), AthleteProfile(fitness_goal="x")])
def test_a_missing_or_unrecognised_goal_is_no_goal(profile):
    assert goal_for(profile) is None


def test_every_goal_settings_can_store_is_mapped():
    # If Settings adds an option and this fails, decide what that option should mean for a plan.
    assert set(RULES.profile_goal_map) == {"DEFICIT", "MAINTAIN", "SURPLUS"}
    assert set(RULES.profile_goal_map.values()) >= set(RULES.goal_activity_weights)


@pytest.mark.parametrize("goal", [None, "maintain", "no-such-goal"])
def test_without_a_goal_that_favours_anything_the_rotation_is_the_users_own_list(goal):
    assert activity_rotation(["gym", "run", "cycling"], goal) == ["gym", "run", "cycling"]


def test_a_goal_gives_the_activities_it_favours_extra_turns_interleaved_with_the_rest():
    assert activity_rotation(["run", "gym", "cycling"], "lose_weight") == ["run", "gym", "cycling", "run", "cycling"]
    assert activity_rotation(["run", "gym", "bodyweight"], "build_muscle") == [
        "run", "gym", "bodyweight", "gym", "bodyweight",
    ]


def test_a_goal_never_adds_an_activity_the_user_did_not_pick():
    assert activity_rotation(["gym"], "lose_weight") == ["gym"]
    assert activity_rotation(["gym", "bodyweight"], "lose_weight") == ["gym", "bodyweight"]
    for goal in RULES.goal_activity_weights:
        for chosen in (["run"], ["run", "gym"], ["gym", "cycling", "bodyweight"], ["run", "gym", "cycling", "bodyweight"]):
            assert set(mix(drafts(prefs(chosen), goal))) == set(chosen)


def test_losing_weight_shifts_the_mix_toward_cardio_and_building_muscle_toward_resistance():
    assert mix(drafts(prefs(), "lose_weight")) == {"run": 18, "gym": 9, "cycling": 18}
    assert mix(drafts(prefs(["run", "gym", "bodyweight"]), "build_muscle")) == {"run": 9, "gym": 18, "bodyweight": 18}


def test_with_no_goal_every_activity_gets_an_equal_share_exactly_as_before():
    plain = drafts(prefs())
    assert mix(plain) == {"run": 15, "gym": 15, "cycling": 15}
    # The previous rule, written out independently: the activity at (slot in the week + week number).
    for index, session in enumerate(plain):
        week, order = divmod(index, 3)
        assert session.activity_type == ALL_THREE[(order + week) % 3]
    assert drafts(prefs(), "maintain") == plain
    assert drafts(prefs(), None) == build_sessions(prefs(), MONDAY, weekly_targets(100, 15), MONDAY)


def test_a_goal_changes_only_which_activity_never_when_or_how_hard():
    plain, tilted = drafts(prefs()), drafts(prefs(), "lose_weight")
    assert len(plain) == len(tilted)
    assert [replace(s, activity_type="run") for s in plain] == [replace(s, activity_type="run") for s in tilted]


# ------------------------------------------------------------------ the goal in a generated plan


def new_user_with(profile, user=USER_A, weeks=12):
    service, repo = service_and_repo()
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    if profile is not None:
        repo.profiles[user] = profile
    plan = service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=weeks))
    return service, repo, plan


def planned_mix(repo, plan, user=USER_A) -> Counter:
    return mix(s for s in repo.list_sessions(user, TODAY, plan.end_date) if s.plan_id == plan.id)


def test_the_plan_records_the_goal_it_was_built_for():
    for stored, goal in (("DEFICIT", "lose_weight"), ("MAINTAIN", "maintain"), ("SURPLUS", "build_muscle")):
        _, repo, plan = new_user_with(AthleteProfile(fitness_goal=stored))
        assert plan.goal == goal
        assert repo.get_active_plan(USER_A).goal == goal


@pytest.mark.parametrize("profile", [None, AthleteProfile(activity_level="SEDENTARY"), AthleteProfile(fitness_goal="???")])
def test_a_plan_for_someone_with_no_usable_goal_has_none_and_an_even_mix(profile):
    _, repo, plan = new_user_with(profile)
    mixed = planned_mix(repo, plan)
    assert plan.goal is None
    assert max(mixed.values()) - min(mixed.values()) <= 1


def test_the_goal_tilts_the_sessions_that_are_actually_planned():
    _, repo, cardio = new_user_with(AthleteProfile(fitness_goal="DEFICIT"))
    counts = planned_mix(repo, cardio)
    assert counts["run"] > counts["gym"] and counts["cycling"] > counts["gym"]

    _, repo, strength = new_user_with(AthleteProfile(fitness_goal="SURPLUS"))
    counts = planned_mix(repo, strength)
    assert counts["gym"] > counts["run"] and counts["gym"] > counts["cycling"]


def test_one_users_goal_never_shapes_another_users_plan():
    service, repo = service_and_repo()
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    repo.profiles[USER_A] = AthleteProfile(fitness_goal="DEFICIT")
    assert service.generate_plan(USER_B, TODAY, GeneratePlanRequest(weeks=4)).goal is None


def test_adapting_a_plan_follows_the_goal_as_it_now_stands():
    service, repo, plan = new_user_with(AthleteProfile(fitness_goal="MAINTAIN"))
    assert plan.goal == "maintain"
    repo.profiles[USER_A] = AthleteProfile(fitness_goal="SURPLUS")
    adapted = service.recalculate_plan(USER_A, TODAY)
    assert adapted.goal == "build_muscle" and repo.get_active_plan(USER_A).goal == "build_muscle"
    counts = planned_mix(repo, adapted)
    assert counts["gym"] > counts["run"] and counts["gym"] > counts["cycling"]


# ------------------------------------------------------------------ exam dates in preferences


def saved_exam_dates(*dates, today=TODAY):
    service, _ = service_and_repo()
    return service.save_preferences(USER_A, today, prefs(exam_dates=dates)).exam_dates


def test_exam_dates_are_kept_in_order_without_duplicates():
    soon, later = TODAY + timedelta(days=3), TODAY + timedelta(days=10)
    assert saved_exam_dates(later, soon, later) == [soon, later]


def test_an_exam_that_has_passed_is_dropped_and_one_today_is_kept():
    yesterday, tomorrow = TODAY - timedelta(days=1), TODAY + timedelta(days=1)
    assert saved_exam_dates(yesterday, TODAY, tomorrow) == [TODAY, tomorrow]


def test_exam_dates_far_in_the_future_are_refused_with_a_field_error():
    limit = TODAY + timedelta(days=RULES.exam_dates_horizon_days)
    assert saved_exam_dates(limit) == [limit]
    with pytest.raises(TrainingError) as refused:
        saved_exam_dates(limit + timedelta(days=1))
    assert refused.value.code == "VALIDATION" and "examDates" in refused.value.detail["fieldErrors"]


def test_there_is_a_limit_on_how_many_exam_dates_can_be_saved():
    many = [TODAY + timedelta(days=i) for i in range(RULES.exam_dates_max + 1)]
    with pytest.raises(ValidationError):
        prefs(exam_dates=many)
    assert len(prefs(exam_dates=many[:-1]).exam_dates) == RULES.exam_dates_max


def test_exam_dates_round_trip_per_user():
    service, _ = service_and_repo()
    exam = TODAY + timedelta(days=4)
    service.save_preferences(USER_A, TODAY, prefs(exam_dates=[exam]))
    assert service.get_preferences(USER_A).exam_dates == [exam]
    assert service.get_preferences(USER_B) is None


def test_preferences_saved_before_exam_dates_existed_read_as_having_none():
    row = {"days_per_week": 3, "session_duration_min": 40, "activity_types": ["run"], "rest_days": [],
           "updated_at": "2026-09-30T10:00:00+00:00"}
    assert TrainingPreferences.model_validate(row).exam_dates == []


# ------------------------------------------------------------------ days until the next exam


def test_the_next_exam_is_the_nearest_one_that_has_not_passed():
    dates = [TODAY + timedelta(days=20), TODAY - timedelta(days=2), TODAY + timedelta(days=3), TODAY + timedelta(days=9)]
    assert days_until_next_exam(dates, TODAY) == 3


def test_an_exam_today_is_zero_days_away_and_none_left_is_none():
    assert days_until_next_exam([TODAY], TODAY) == 0
    assert days_until_next_exam([TODAY - timedelta(days=1)], TODAY) is None
    assert days_until_next_exam([], TODAY) is None


def test_an_exam_further_off_than_a_year_still_builds_valid_features():
    days = days_until_next_exam([TODAY + timedelta(days=700)], TODAY)
    assert days == 365
    assert build_features([], None, TODAY, days).days_until_exam == 365


# ------------------------------------------------------------------ readiness with exams and sleep


def today_of(service, user=USER_A):
    return service.get_today(user, TODAY)


def factor_of(view, key):
    return next((f for f in view.readiness.factors if f.key == key), None)


def test_with_nothing_entered_the_score_is_the_base_score():
    service, _ = service_and_repo()
    view = today_of(service)
    assert view.readiness.score == 80 and view.sleep_hours is None
    assert factor_of(view, "exam") is None and factor_of(view, "sleep") is None


@pytest.mark.parametrize("days,score", [(0, 70), (2, 73), (6, 79), (7, 80)])
def test_an_exam_inside_the_window_lowers_readiness_more_the_closer_it_is(days, score):
    service, _ = service_and_repo()
    service.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=days)]))
    view = today_of(service)
    assert view.readiness.score == score
    assert factor_of(view, "exam") is not None


def test_the_exam_factor_says_how_long_to_go():
    service, _ = service_and_repo()
    for days, wording in ((0, "Exam today"), (1, "Exam in 1 day"), (4, "Exam in 4 days")):
        service.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=days)]))
        factor = factor_of(today_of(service), "exam")
        assert (factor.label, factor.detail) == ("Academic load", wording)
        service.repo.readiness.clear()


def test_an_exam_beyond_the_window_changes_nothing_and_the_nearest_of_several_counts():
    service, _ = service_and_repo()
    service.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=8)]))
    assert today_of(service).readiness.score == 80
    service.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=30), TODAY + timedelta(days=1), TODAY + timedelta(days=5)]))
    view = today_of(service)
    assert factor_of(view, "exam").detail == "Exam in 1 day"


def test_an_exam_date_that_has_since_passed_no_longer_counts():
    service, repo = service_and_repo()
    repo.preferences[USER_A] = TrainingPreferences(
        **{**STANDARD_PREFS.model_dump(), "exam_dates": [TODAY - timedelta(days=1)]},
        updated_at=datetime(2026, 9, 29, 10, 0),
    )
    assert today_of(service).readiness.score == 80


def test_adding_an_exam_after_the_score_was_first_read_recomputes_it():
    service, _ = service_and_repo()
    before = today_of(service).readiness
    service.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=1)]))
    after = today_of(service).readiness
    assert after.score < before.score


def test_one_users_exam_never_lowers_another_users_score():
    service, _ = service_and_repo()
    service.save_preferences(USER_B, TODAY, prefs(exam_dates=[TODAY]))
    assert today_of(service, USER_A).readiness.score == 80
    assert today_of(service, USER_B).readiness.score < 80


# ---- sleep


def test_logged_sleep_feeds_today_and_is_shown_back():
    service, repo = service_and_repo()
    entry = service.log_sleep(USER_A, TODAY, SleepInput(hours=5))
    assert (entry.date, entry.hours) == (TODAY, 5.0)
    assert repo.sleep == {(USER_A, TODAY): 5.0}
    view = today_of(service)
    assert view.sleep_hours == 5.0 and view.readiness.score == 65
    sleep = factor_of(view, "sleep")
    assert (sleep.impact, sleep.detail) == ("negative", "5.0 h last night")


def test_well_slept_adds_a_little_and_the_middle_ground_adds_nothing():
    for hours, score in ((8.0, 83), (7.5, 80), (7.0, 80), (6.0, 72)):  # 80 - 7.5 = 72.5, which rounds to 72
        service, _ = service_and_repo()
        service.log_sleep(USER_A, TODAY, SleepInput(hours=hours))
        assert today_of(service).readiness.score == score, hours


def test_logging_sleep_again_replaces_it_and_the_score_follows():
    service, repo = service_and_repo()
    service.log_sleep(USER_A, TODAY, SleepInput(hours=5))
    assert today_of(service).readiness.score == 65
    service.log_sleep(USER_A, TODAY, SleepInput(hours=8))
    view = today_of(service)
    assert repo.sleep == {(USER_A, TODAY): 8.0}
    assert view.sleep_hours == 8.0 and view.readiness.score == 83


def test_clearing_sleep_takes_it_out_of_the_score_and_is_harmless_when_there_is_none():
    service, repo = service_and_repo()
    service.clear_sleep(USER_A, TODAY)
    service.log_sleep(USER_A, TODAY, SleepInput(hours=4))
    assert today_of(service).readiness.score < 80
    service.clear_sleep(USER_A, TODAY)
    view = today_of(service)
    assert repo.sleep == {} and view.sleep_hours is None and view.readiness.score == 80


def test_only_todays_sleep_counts_for_today():
    service, repo = service_and_repo()
    repo.sleep[(USER_A, TODAY - timedelta(days=1))] = 3.0
    view = today_of(service)
    assert view.sleep_hours is None and view.readiness.score == 80


def test_one_users_sleep_never_reaches_another_users_score_or_view():
    service, _ = service_and_repo()
    service.log_sleep(USER_A, TODAY, SleepInput(hours=3))
    other = today_of(service, USER_B)
    assert other.sleep_hours is None and other.readiness.score == 80
    assert today_of(service, USER_A).readiness.score < 80


def test_hours_are_kept_to_two_decimals():
    service, repo = service_and_repo()
    assert service.log_sleep(USER_A, TODAY, SleepInput(hours=7.256)).hours == 7.26
    assert repo.sleep[(USER_A, TODAY)] == 7.26


@pytest.mark.parametrize("hours", [-0.1, 16.01, 24, float("inf"), float("nan")])
def test_impossible_sleep_is_refused(hours):
    with pytest.raises(ValidationError):
        SleepInput(hours=hours)


@pytest.mark.parametrize("hours", [0, 0.25, 16])
def test_the_ends_of_the_range_are_allowed(hours):
    assert SleepInput(hours=hours).hours == hours


def test_an_explicit_sleep_entry_beats_a_check_ins_own_answer_and_survives_a_stale_check_in():
    check_in = Checkin(3, 6.0, TODAY)
    assert build_features([], check_in, TODAY).sleep_hours == 6.0
    assert build_features([], check_in, TODAY, sleep_hours=8.0).sleep_hours == 8.0
    stale = Checkin(3, 6.0, TODAY - timedelta(days=5))
    assert build_features([], stale, TODAY, sleep_hours=8.0).sleep_hours == 8.0
    assert build_features([], stale, TODAY).sleep_hours is None


def test_the_trained_model_reads_sleep_and_exams_too():
    quiet, _ = service_and_repo(load_scorer())
    assert isinstance(quiet.scorer, ModelScorer)
    baseline = today_of(quiet).readiness.score

    busy, _ = service_and_repo(load_scorer())
    busy.save_preferences(USER_A, TODAY, prefs(exam_dates=[TODAY + timedelta(days=1)]))
    busy.log_sleep(USER_A, TODAY, SleepInput(hours=4))
    view = today_of(busy)
    assert view.readiness.score < baseline
    assert {"sleep", "exam"} <= {f.key for f in view.readiness.factors}


# ------------------------------------------------------------------ the database side


DAY = date(2026, 10, 7)


def sleep_row(user, day, hours):
    return {"user_id": user, "date": day.isoformat(), "hours": hours}


def tables(**kwargs):
    return TableClient(kwargs)


def test_sleep_is_read_for_this_user_and_this_day_only_and_only_the_hours():
    client = tables(training_sleep_logs=[
        sleep_row(USER_A, DAY, 7.5), sleep_row(USER_B, DAY, 4.0), sleep_row(USER_A, DAY - timedelta(days=1), 9.0),
    ])
    repo = SupabaseTrainingRepository(client)
    assert repo.get_sleep(USER_A, DAY) == 7.5
    request = client.requests[-1]
    assert request.table == "training_sleep_logs" and request.columns == "hours"
    assert ("eq", "user_id", USER_A) in request.filters and ("eq", "date", DAY.isoformat()) in request.filters
    assert repo.get_sleep(USER_B, DAY) == 4.0
    assert repo.get_sleep("a-stranger", DAY) is None


def test_sleep_numbers_come_back_as_floats_whatever_postgres_called_them():
    repo = SupabaseTrainingRepository(tables(training_sleep_logs=[sleep_row(USER_A, DAY, "7.50")]))
    assert repo.get_sleep(USER_A, DAY) == 7.5
    assert isinstance(repo.get_sleep(USER_A, DAY), float)


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST204", "PGRST205"])
def test_a_database_without_the_sleep_table_scores_without_sleep_and_says_so_once(code, caplog):
    repo = SupabaseTrainingRepository(TableClient(error=api_error(code)))
    with caplog.at_level("WARNING"):
        assert repo.get_sleep(USER_A, DAY) is None
        assert repo.get_sleep(USER_B, DAY) is None
    assert caplog.text.count(code) == 1


def test_any_other_database_error_reading_sleep_is_not_swallowed():
    repo = SupabaseTrainingRepository(TableClient(error=api_error("42501")))
    with pytest.raises(APIError):
        repo.get_sleep(USER_A, DAY)


def test_saving_sleep_upserts_one_row_per_user_and_day():
    client = tables(training_sleep_logs=[])
    repo = SupabaseTrainingRepository(client)
    repo.save_sleep(USER_A, DAY, 6.0)
    repo.save_sleep(USER_A, DAY, 8.0)
    repo.save_sleep(USER_B, DAY, 5.0)
    request = client.requests[0]
    assert request.operation == "upsert" and request.on_conflict == "user_id,date"
    assert request.payload == {"user_id": USER_A, "date": "2026-10-07", "hours": 6.0}
    assert sorted((r["user_id"], r["hours"]) for r in client.tables["training_sleep_logs"]) == [(USER_A, 8.0), (USER_B, 5.0)]


def test_clearing_sleep_removes_only_this_users_row_for_that_day():
    other_day = DAY - timedelta(days=1)
    client = tables(training_sleep_logs=[
        sleep_row(USER_A, DAY, 6.0), sleep_row(USER_B, DAY, 5.0), sleep_row(USER_A, other_day, 7.0),
    ])
    SupabaseTrainingRepository(client).delete_sleep(USER_A, DAY)
    left = {(r["user_id"], r["date"]) for r in client.tables["training_sleep_logs"]}
    assert left == {(USER_B, DAY.isoformat()), (USER_A, other_day.isoformat())}
    delete = client.requests[-1]
    assert ("eq", "user_id", USER_A) in delete.filters and ("eq", "date", DAY.isoformat()) in delete.filters


@pytest.mark.parametrize("code", ["42P01", "PGRST205"])
@pytest.mark.parametrize("write", [lambda r: r.save_sleep(USER_A, DAY, 6.0), lambda r: r.delete_sleep(USER_A, DAY)])
def test_writing_sleep_to_a_database_without_the_table_says_what_to_do(write, code):
    repo = SupabaseTrainingRepository(TableClient(error=api_error(code)))
    with pytest.raises(TrainingError) as refused:
        write(repo)
    assert refused.value.code == "UNAVAILABLE" and refused.value.status_code == 503
    assert "migration" in refused.value.message


def test_any_other_database_error_writing_sleep_is_not_swallowed():
    repo = SupabaseTrainingRepository(TableClient(error=api_error("42501")))
    with pytest.raises(APIError):
        repo.save_sleep(USER_A, DAY, 6.0)


def _preferences_with_exam(*days):
    return TrainingPreferences(**{**STANDARD_PREFS.model_dump(), "exam_dates": list(days)},
                               updated_at=datetime(2026, 10, 7, 9, 0))


def test_exam_dates_are_saved_as_plain_dates():
    client = tables(training_preferences=[])
    SupabaseTrainingRepository(client).save_preferences(USER_A, _preferences_with_exam(DAY, DAY + timedelta(days=2)))
    assert client.tables["training_preferences"][0]["exam_dates"] == ["2026-10-07", "2026-10-09"]


def _missing(column):
    return lambda request: (
        api_error("PGRST204", f"Could not find the '{column}' column of 'training_preferences' in the schema cache")
        if request.operation == "upsert" and column in request.payload else None
    )


def test_a_database_without_the_exam_dates_column_still_saves_a_form_that_has_no_exam_dates(caplog):
    client = TableClient({"training_preferences": []}, error_when=_missing("exam_dates"))
    repo = SupabaseTrainingRepository(client)
    with caplog.at_level("WARNING"):
        repo.save_preferences(USER_A, _preferences_with_exam())
        repo.save_preferences(USER_A, _preferences_with_exam())
    saved = client.tables["training_preferences"]
    assert len(saved) == 1 and "exam_dates" not in saved[0] and saved[0]["days_per_week"] == 4
    assert caplog.text.count("exam_dates") == 1, "say it once, not on every save"


def test_a_database_without_the_exam_dates_column_refuses_exam_dates_instead_of_dropping_them_quietly():
    client = TableClient({"training_preferences": []}, error_when=_missing("exam_dates"))
    with pytest.raises(TrainingError) as refused:
        SupabaseTrainingRepository(client).save_preferences(USER_A, _preferences_with_exam(DAY))
    assert refused.value.code == "UNAVAILABLE" and refused.value.status_code == 503
    assert "migration" in refused.value.message and "exam dates" in refused.value.message.lower()
    assert client.tables["training_preferences"] == [], "nothing is saved when the form can't be saved as typed"


def test_a_missing_column_that_is_not_exam_dates_is_not_papered_over(caplog):
    client = TableClient({"training_preferences": []}, error_when=_missing("days_per_week"))
    with caplog.at_level("WARNING"), pytest.raises(APIError):
        SupabaseTrainingRepository(client).save_preferences(USER_A, _preferences_with_exam())
    # It isn't the exam-dates column, so there is no "save it without them" retry and no such warning.
    assert len(client.requests) == 1 and "exam_dates" not in caplog.text


def test_a_permissions_error_saving_preferences_is_not_papered_over():
    error = api_error("42501", "permission denied for table training_preferences, column exam_dates")
    repo = SupabaseTrainingRepository(TableClient({"training_preferences": []}, error=error))
    with pytest.raises(APIError):
        repo.save_preferences(USER_A, _preferences_with_exam(DAY))

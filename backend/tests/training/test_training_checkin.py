"""
Reading the daily check-in for readiness: what is asked of the table, which check-ins count, and what
a missing table or a bad row does.

Hard Rule 4: check-in answers are private. The repository reads only this user's own muscle soreness
answer (never mood or diet, never another user's row), and nothing here sends it anywhere but back to
the same user's readiness card.
"""
from dataclasses import fields, replace
from datetime import date, timedelta

import pytest
from postgrest.exceptions import APIError

from app.training.config import READINESS_RULES
from app.training.ml.artifact import _NOT_SCORING, rules_fingerprint
from app.training.ml.scorer import ModelScorer, load_scorer
from app.training.readiness import Checkin, ReadinessFeatures, RuleBasedScorer, build_features, fingerprint
from app.training.repository import SupabaseTrainingRepository
from app.training.service import TrainingService
from training_fakes import TODAY, USER_A, USER_B, FakeTrainingRepository, TableClient

DAY = date(2026, 10, 7)


def checkin_row(user, day, soreness=3, mood=4, diet=2):
    return {
        "user_id": user, "date": day.isoformat(), "muscle_fatigue": soreness,
        "mood": mood, "diet_adherence": diet, "xp_awarded": 10,
    }


def repo_with(*rows, error=None):
    client = TableClient({"daily_checkins": list(rows)}, error)
    return SupabaseTrainingRepository(client), client


def api_error(code):
    return APIError({"message": "boom", "code": code, "hint": None, "details": None})


# ------------------------------------------------------------------ what is read


def test_it_reads_only_the_date_and_the_soreness_answer_for_this_user_and_no_one_else():
    repo, client = repo_with(checkin_row(USER_A, DAY, soreness=4, mood=1, diet=1))
    checkin = repo.get_latest_checkin(USER_A, DAY)
    request = client.requests[-1]
    assert request.table == "daily_checkins"
    assert request.columns == "date,muscle_fatigue"  # never mood or diet, never "*"
    assert ("eq", "user_id", USER_A) in request.filters
    assert checkin == Checkin(load_rating=4, sleep_hours=None, day=DAY)


def test_another_users_check_in_is_never_returned_even_when_it_is_newer():
    repo, _ = repo_with(
        checkin_row(USER_A, DAY - timedelta(days=1), soreness=2),
        checkin_row(USER_B, DAY, soreness=5),
    )
    assert repo.get_latest_checkin(USER_A, DAY).load_rating == 2
    assert repo.get_latest_checkin("a-stranger", DAY) is None


def test_the_newest_check_in_wins():
    repo, _ = repo_with(
        checkin_row(USER_A, DAY - timedelta(days=3), soreness=1),
        checkin_row(USER_A, DAY, soreness=5),
        checkin_row(USER_A, DAY - timedelta(days=1), soreness=2),
    )
    assert repo.get_latest_checkin(USER_A, DAY) == Checkin(5, None, DAY)


def test_a_check_in_dated_a_day_ahead_counts_but_not_two_days_ahead():
    """The questionnaire dates check-ins on a fixed UTC+8 day, so for a user to the west it can be tomorrow."""
    tomorrow, repo = DAY + timedelta(days=1), None
    repo, _ = repo_with(checkin_row(USER_A, tomorrow, soreness=4))
    assert repo.get_latest_checkin(USER_A, DAY).day == tomorrow
    repo, _ = repo_with(checkin_row(USER_A, DAY + timedelta(days=2), soreness=4))
    assert repo.get_latest_checkin(USER_A, DAY) is None


def test_with_no_check_ins_there_is_none():
    repo, _ = repo_with()
    assert repo.get_latest_checkin(USER_A, DAY) is None


def test_a_timestamp_shaped_date_is_understood():
    row = {**checkin_row(USER_A, DAY), "date": "2026-10-07T00:00:00+00:00"}
    repo, _ = repo_with(row)
    assert repo.get_latest_checkin(USER_A, DAY).day == DAY


# ------------------------------------------------------------------ a table that isn't there, and bad data


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST204", "PGRST205"])
def test_a_missing_check_in_table_means_no_check_in_and_is_logged_once(code, caplog):
    repo, _ = repo_with(error=api_error(code))
    with caplog.at_level("WARNING"):
        assert repo.get_latest_checkin(USER_A, DAY) is None
        assert repo.get_latest_checkin(USER_A, DAY) is None
        assert repo.get_latest_checkin(USER_B, DAY) is None
    assert caplog.text.count(code) == 1, "readiness is read on every page load; don't log it every time"


def test_any_other_database_error_reading_a_check_in_is_not_swallowed():
    repo, _ = repo_with(error=api_error("42501"))
    with pytest.raises(APIError):
        repo.get_latest_checkin(USER_A, DAY)


@pytest.mark.parametrize("bad", [0, 6, -1, None, "4", 4.5, True])
def test_a_check_in_with_an_impossible_rating_is_ignored_not_a_crash(bad, caplog):
    repo, _ = repo_with({**checkin_row(USER_A, DAY), "muscle_fatigue": bad})
    with caplog.at_level("WARNING"):
        assert repo.get_latest_checkin(USER_A, DAY) is None
    assert "muscle_fatigue" in caplog.text


# ------------------------------------------------------------------ which check-ins count for today


@pytest.mark.parametrize("days_old,counts", [(-1, True), (0, True), (1, True), (2, False), (30, False)])
def test_a_check_in_only_counts_while_it_is_recent_enough(days_old, counts):
    features = build_features([], Checkin(4, None, DAY - timedelta(days=days_old)), DAY)
    assert features.checkin_load_rating == (4 if counts else None)


def test_how_recent_is_a_setting():
    today_only = replace(READINESS_RULES, checkin_max_age_days=0)
    yesterday = Checkin(4, None, DAY - timedelta(days=1))
    assert build_features([], yesterday, DAY, rules=today_only).checkin_load_rating is None
    assert build_features([], Checkin(4, None, DAY), DAY, rules=today_only).checkin_load_rating == 4


def test_a_check_in_with_no_date_is_taken_as_current():
    assert build_features([], Checkin(4, None), DAY).checkin_load_rating == 4


def test_a_stale_check_in_leaves_sleep_out_too():
    assert build_features([], Checkin(4, 5.0, DAY - timedelta(days=5)), DAY).sleep_hours is None


# ------------------------------------------------------------------ what it does to the score


def test_the_factor_says_what_the_user_actually_answered():
    result = RuleBasedScorer().score(ReadinessFeatures(checkin_load_rating=4))
    factor = next(f for f in result.factors if f.key == "checkin")
    assert factor.detail == "Muscle soreness 4 out of 5" and factor.impact == "negative"


def test_sore_muscles_lower_the_score_and_fresh_ones_do_not():
    sore = RuleBasedScorer().score(ReadinessFeatures(checkin_load_rating=5)).score
    fresh = RuleBasedScorer().score(ReadinessFeatures(checkin_load_rating=1)).score
    assert sore < fresh


def _today_score(repo) -> int:
    return TrainingService(repo, RuleBasedScorer()).get_today(USER_A, TODAY).readiness.score


def test_today_uses_a_recent_check_in_and_ignores_a_stale_one():
    none_yet = FakeTrainingRepository()
    sore_today, stale = FakeTrainingRepository(), FakeTrainingRepository()
    sore_today.checkins[USER_A] = Checkin(5, None, TODAY)
    stale.checkins[USER_A] = Checkin(5, None, TODAY - timedelta(days=4))
    assert _today_score(sore_today) < _today_score(none_yet)
    assert _today_score(stale) == _today_score(none_yet)
    # and the cache key agrees: a stale check-in is the same input as no check-in
    assert none_yet.readiness[(USER_A, TODAY)][1] == stale.readiness[(USER_A, TODAY)][1]


def test_a_check_in_made_after_the_score_was_first_read_recomputes_it():
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    before = service.get_today(USER_A, TODAY).readiness
    repo.checkins[USER_A] = Checkin(5, None, TODAY)
    after = service.get_today(USER_A, TODAY).readiness
    assert after.score < before.score and after.computed_at >= before.computed_at


# ------------------------------------------------------------------ the model is not retired by a setting that isn't a scoring rule


def test_changing_a_scoring_rule_changes_the_fingerprint_and_a_display_or_input_setting_does_not():
    base = rules_fingerprint(READINESS_RULES)
    names = {f.name for f in fields(READINESS_RULES)}
    assert _NOT_SCORING <= names, "a name in _NOT_SCORING is not a ReadinessRules field"
    for f in fields(READINESS_RULES):
        value = getattr(READINESS_RULES, f.name)
        changed = (not value) if isinstance(value, bool) else value + 1
        differs = rules_fingerprint(replace(READINESS_RULES, **{f.name: changed})) != base
        assert differs == (f.name not in _NOT_SCORING), f.name


@pytest.mark.parametrize("setting", [{"max_factors_shown": 2}, {"checkin_max_age_days": 0}])
def test_the_trained_model_stays_in_use_when_only_a_non_scoring_setting_is_changed(setting):
    assert isinstance(load_scorer(replace(READINESS_RULES, **setting)), ModelScorer)


def test_the_cache_key_still_tells_scorers_apart():
    f = ReadinessFeatures(checkin_load_rating=4)
    assert fingerprint(f, "rules-v1") != fingerprint(f, "mlp-v1")

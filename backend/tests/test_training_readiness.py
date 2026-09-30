from datetime import date, timedelta

import pytest

from app.training.config import ReadinessRules
from app.training.readiness import (
    ActivityRecord,
    Checkin,
    ReadinessFeatures,
    RuleBasedScorer,
    build_features,
    fingerprint,
)

AS_OF = date(2026, 9, 30)


def rec(days_ago: int, volume: float = 30, avg_hr=None, source: str = "manual") -> ActivityRecord:
    return ActivityRecord(day=AS_OF - timedelta(days=days_ago), volume=volume, avg_hr=avg_hr, source=source)


def steady_history(source: str = "manual") -> list:
    """Every 2 days for 28 days, so load is steady."""
    return [rec(d, 30, 140, source) for d in range(1, 29, 2)]


scorer = RuleBasedScorer()


# ------------------------------------------------------------------ Hard Rule 1


def test_a_strava_row_cannot_influence_a_score():
    """Hard Rule 1: Strava-sourced activity is excluded from the features, however it got in."""
    real = steady_history()
    strava_spike = [rec(d, 500, 190, "strava") for d in range(1, 8)]

    without = build_features(real, Checkin(2, 8.0), AS_OF)
    with_strava = build_features(real + strava_spike, Checkin(2, 8.0), AS_OF)

    assert with_strava == without
    assert scorer.score(with_strava) == scorer.score(without)


def test_strava_only_history_is_the_same_as_no_history():
    only_strava = build_features(steady_history("strava"), None, AS_OF)
    assert only_strava == build_features([], None, AS_OF)
    assert only_strava.acwr is None and only_strava.hr_trend_delta is None


def test_manual_and_imported_history_both_count():
    manual = build_features(steady_history("manual"), None, AS_OF)
    imported = build_features(steady_history("import"), None, AS_OF)
    assert manual.acwr is not None and manual == imported


# ------------------------------------------------------------------ features


def test_only_days_before_the_score_date_are_used():
    today_only = [rec(0, 999)]
    assert build_features(today_only, None, AS_OF).acwr is None


def test_acwr_is_acute_load_over_the_chronic_weekly_average():
    history = [rec(d, 10) for d in range(29 - 1, 0, -1)]  # 10 a day for 28 days
    features = build_features(history, None, AS_OF)
    assert features.acwr == pytest.approx(1.0, abs=0.01)

    spike = history + [rec(1, 200)]
    assert build_features(spike, None, AS_OF).acwr > 1.3


def test_acwr_needs_enough_history():
    short = [rec(d, 30) for d in range(1, 10)]
    assert build_features(short, None, AS_OF).acwr is None


def test_heart_rate_trend_compares_recent_sessions_with_the_baseline():
    baseline = [rec(d, 30, 140) for d in (10, 14, 18, 22)]
    elevated = [rec(d, 30, 152) for d in (1, 3)]
    assert build_features(baseline + elevated, None, AS_OF).hr_trend_delta == pytest.approx(12.0)
    assert build_features(baseline, None, AS_OF).hr_trend_delta is None


# ------------------------------------------------------------------ scoring


def test_the_same_features_always_give_the_same_score():
    features = ReadinessFeatures(acwr=1.4, hr_trend_delta=5, checkin_load_rating=4, sleep_hours=5.5)
    assert scorer.score(features) == scorer.score(features.model_copy())
    assert fingerprint(features) == fingerprint(features.model_copy())


def test_no_data_is_neutral_and_does_not_hold_anyone_back():
    result = scorer.score(ReadinessFeatures())
    assert result.classification == "push"
    assert result.factors[0].key == "data"


def test_good_signals_score_push_and_bad_signals_score_deload():
    good = scorer.score(ReadinessFeatures(acwr=1.0, hr_trend_delta=-3, checkin_load_rating=1, sleep_hours=8.5))
    bad = scorer.score(ReadinessFeatures(acwr=1.9, hr_trend_delta=10, checkin_load_rating=5, sleep_hours=4))
    assert good.classification == "push" and good.score > 85
    assert bad.classification == "deload" and bad.score < 45


def test_a_moderate_load_spike_moves_the_score_into_light():
    result = scorer.score(ReadinessFeatures(acwr=1.6, checkin_load_rating=3, sleep_hours=6))
    assert result.classification == "light"
    assert result.factors[0].impact == "negative"


@pytest.mark.parametrize("field,worse,better", [
    ("acwr", 1.8, 1.0),
    ("hr_trend_delta", 10.0, 0.0),
    ("checkin_load_rating", 5, 1),
    ("sleep_hours", 4.0, 8.0),
])
def test_each_signal_moves_the_score_in_the_expected_direction(field, worse, better):
    assert scorer.score(ReadinessFeatures(**{field: worse})).score < scorer.score(ReadinessFeatures(**{field: better})).score


def test_score_is_clamped_to_zero_and_one_hundred():
    assert scorer.score(ReadinessFeatures(acwr=10, hr_trend_delta=60, checkin_load_rating=5, sleep_hours=0, days_until_exam=0)).score >= 0
    assert scorer.score(ReadinessFeatures(acwr=1.0, hr_trend_delta=-30, checkin_load_rating=1, sleep_hours=9)).score <= 100


def test_top_factors_are_ranked_by_impact_and_capped():
    result = scorer.score(ReadinessFeatures(acwr=1.5, hr_trend_delta=8, checkin_load_rating=4, sleep_hours=5, days_until_exam=2))
    assert len(result.factors) == ReadinessRules().max_factors_shown
    assert result.factors[0].key in {"sleep", "load", "hr_trend", "checkin", "exam"}
    assert all(f.impact in {"positive", "negative", "neutral"} for f in result.factors)


def test_exam_proximity_only_counts_inside_the_window():
    far = scorer.score(ReadinessFeatures(days_until_exam=30))
    near = scorer.score(ReadinessFeatures(days_until_exam=1))
    assert far.factors[0].key == "data"
    assert near.score < far.score
    assert any(f.key == "exam" for f in near.factors)


def test_explanation_names_the_main_drag_when_there_is_one():
    result = scorer.score(ReadinessFeatures(acwr=1.6, sleep_hours=8))
    assert "Training load" in result.explanation


def test_fingerprint_changes_when_any_input_changes():
    base = ReadinessFeatures(acwr=1.0, sleep_hours=7)
    assert fingerprint(base) != fingerprint(base.model_copy(update={"sleep_hours": 6}))
    assert fingerprint(base) != fingerprint(base.model_copy(update={"checkin_load_rating": 3}))

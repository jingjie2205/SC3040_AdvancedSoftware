"""
The load forecast that sets how fast a plan progresses: the weekly series, the smoothing fit, the backtest, plan
completion, the rate and the plan it ends up in.

Hard Rule 1 is checked by behaviour (a Strava log changes nothing here), Hard Rule 3 by what the series is built from
(what was logged, never what was planned), and the plan's safety check stays the last word.
"""
import dataclasses
import math
import random
import re
from datetime import date, timedelta
from pathlib import Path

import pytest

from app.training.config import FORECAST_RULES, READINESS_RULES, RULES, ForecastRules
from app.training.errors import TrainingError
from app.training.forecast import (
    Backtest,
    _holt_pass,
    _record_step,
    adherence,
    backtest,
    build_forecast,
    fit_holt,
    fmt,
    forecast_path,
    forecast_view,
    trust_in,
    weekly_load_series,
)
from app.training.models import GeneratePlanRequest, PlannedSession
from app.training.planner import first_unsafe_week, is_deload_week, plan_week_target, week_start, weekly_targets
from app.training.readiness import RuleBasedScorer
from app.training.service import TrainingService
from training_fakes import STANDARD_PREFS, USER_A, FakeTrainingRepository, workout

TODAY = date(2026, 10, 14)  # a Wednesday
MONDAY = week_start(TODAY)


def history(loads, source="manual"):
    """One logged workout a week carrying that week's load, ending with the last whole week before TODAY's."""
    out = []
    for i, load in enumerate(reversed(loads), start=1):
        if load > 0:
            out.append(workout(MONDAY - timedelta(days=7 * i - 1), volume=load, source=source))
    return out


def forecast_of(loads, sessions=(), acwr=None, today=TODAY, **kw):
    return build_forecast(history(loads), list(sessions), acwr, today, **kw)


def step(forecast, key):
    """One of the steps that explain the rate, by name (the order may grow; the names are the contract)."""
    return next(s for s in forecast.steps if s.key == key)


GROWING_5 = [round(60 * 1.05**i) for i in range(10)]
GROWING_10 = [round(50 * 1.10**i) for i in range(10)]
DECLINING = [round(120 * 0.95**i) for i in range(10)]
STEADY = [100] * 10
# Swings both ways, so "the average of the last few weeks" forecasts it better than the smoothing does.
NOISY = [60, 100, 55, 105, 58, 98, 60, 102, 57, 99]
# Eight good weeks and then two lost ones: the smoothing does a little worse than "the same as last week".
FALLING_AFTER_MISSES = [80, 84, 88, 84, 92, 96, 100, 104, 92, 76]
# Settings that let the trend keep its whole say whatever its record, to see what the record changed.
ALWAYS_TRUSTED = ForecastRules(trust_full_ratio=1e9, trust_none_ratio=2e9)


# ------------------------------------------------------------------ the weekly series


def test_the_series_is_the_load_completed_in_each_whole_week_before_this_one():
    series = weekly_load_series(history([60, 70, 80]), TODAY)
    assert series.loads == (60, 70, 80)
    assert series.weeks == (MONDAY - timedelta(weeks=3), MONDAY - timedelta(weeks=2), MONDAY - timedelta(weeks=1))


def test_the_current_week_is_never_part_of_it():
    now = [workout(TODAY - timedelta(days=1), volume=500)]  # yesterday, this week
    assert weekly_load_series(now, TODAY).loads == ()


def test_a_week_with_nothing_logged_between_trained_weeks_counts_as_zero_but_leading_empty_weeks_do_not():
    assert weekly_load_series(history([0, 0, 60, 0, 0, 80]), TODAY).loads == (60, 0, 0, 80)


def test_several_workouts_in_a_week_add_up():
    week = MONDAY - timedelta(weeks=1)
    logs = [workout(week + timedelta(days=d), volume=v) for d, v in ((0, 30), (2, 25.5), (5, 40))]
    assert weekly_load_series(logs, TODAY).loads == (95.5,)


def test_only_the_window_is_looked_at():
    far = [workout(MONDAY - timedelta(weeks=FORECAST_RULES.window_weeks + 3), volume=400)]
    assert weekly_load_series(far + history([60]), TODAY).loads == (60,)


def test_strava_logs_never_count_toward_the_series_the_forecast_or_the_rate():
    """Hard Rule 1: shown on the schedule, counted nowhere."""
    plain = forecast_of(GROWING_5)
    noisy = build_forecast(history(GROWING_5) + history([900] * 10, source="strava"), [], None, TODAY)
    assert noisy.series == plain.series
    assert (noisy.rate_pct, noisy.fit, noisy.backtest) == (plain.rate_pct, plain.fit, plain.backtest)
    assert weekly_load_series(history([900] * 10, source="strava"), TODAY).loads == ()


# ------------------------------------------------------------------ the smoothing fit


def test_a_straight_climb_is_found_and_a_steady_week_has_no_trend():
    climbing = fit_holt([60, 70, 80, 90, 100, 110, 120, 130])
    assert climbing.trend == pytest.approx(10, rel=0.15) and climbing.level == pytest.approx(130, rel=0.05)
    steady = fit_holt(STEADY)
    assert steady.trend == pytest.approx(0, abs=1e-9) and steady.level == pytest.approx(100)


def test_a_falling_load_has_a_negative_trend():
    assert fit_holt(DECLINING).trend < 0


def test_each_athlete_gets_the_smoothing_that_forecasts_their_own_weeks_best():
    smooth = fit_holt([90, 91, 90, 92, 91, 90, 91, 92, 90, 91])
    jumpy = fit_holt([60, 100, 55, 105, 58, 98, 60, 102, 57, 99])
    assert (smooth.alpha, smooth.beta) != (jumpy.alpha, jumpy.beta)
    for series, fit in (([90, 91, 90, 92, 91, 90, 91, 92, 90, 91], smooth), ([60, 100, 55, 105, 58, 98, 60, 102, 57, 99], jumpy)):
        for alpha in FORECAST_RULES.alpha_grid:
            for beta in FORECAST_RULES.beta_grid:
                    assert fit.sse <= _holt_pass(series, alpha, beta, FORECAST_RULES.damping)[2] + 1e-9


def test_there_is_nothing_to_fit_under_three_weeks():
    assert fit_holt([100, 100]) is None and fit_holt([]) is None


def test_the_fit_is_deterministic_and_ties_keep_the_first_pair():
    assert fit_holt(GROWING_5) == fit_holt(list(GROWING_5))
    flat = fit_holt(STEADY)  # every pair is perfect: the first in the grids wins
    assert (flat.alpha, flat.beta) == (FORECAST_RULES.alpha_grid[0], FORECAST_RULES.beta_grid[0])


def test_the_fitted_values_are_one_week_ahead_predictions_for_every_week_after_the_first():
    fit = fit_holt(GROWING_5)
    assert len(fit.fitted) == len(GROWING_5) - 1
    errors = [a - p for a, p in zip(GROWING_5[1:], fit.fitted)]
    assert sum(e * e for e in errors) == pytest.approx(fit.sse)


def test_the_smoothing_follows_the_damped_trend_equations_step_by_step():
    """
    Worked by hand for four weeks, alpha 0.8, beta 0.3, damping 0.9. Each week the model expects last level plus the
    faded trend; the new level leans 80% on what happened and 20% on what was expected; the new trend is 30% the change
    in level and 70% the faded old trend. (Alpha is not a half here, so swapping the two weights would show.)
    """
    level, trend, sse, predictions = _holt_pass([100, 110, 120, 130], 0.8, 0.3, 0.9)
    assert predictions == pytest.approx([109.0, 118.116, 127.514544])
    assert level == pytest.approx(129.5029088) and trend == pytest.approx(8.48785344)
    assert sse == pytest.approx(1**2 + 1.884**2 + 2.485456**2)


def test_the_path_ahead_carries_the_damped_trend_and_its_band_widens():
    fit = fit_holt(GROWING_5)
    path = forecast_path(fit, TODAY)
    assert [p.week_start for p in path] == [MONDAY + timedelta(weeks=i) for i in range(FORECAST_RULES.horizon_weeks)]
    assert all(a.value < b.value for a, b in zip(path, path[1:]))  # still climbing
    phi = FORECAST_RULES.damping
    assert path[0].value == pytest.approx(fit.level + fit.trend * phi)
    assert path[1].value == pytest.approx(fit.level + fit.trend * (phi + phi**2))
    widths = [p.high - p.low for p in path]
    assert widths == sorted(widths) and all(p.low <= p.value <= p.high for p in path)


def test_the_band_is_the_spread_of_the_fits_own_misses_widening_with_the_square_root_of_the_weeks_ahead():
    loads = [90, 96, 88, 97, 91, 99, 92, 98, 93, 100]  # a little noise, so the band is narrow enough to stay above zero
    fit = fit_holt(loads)
    assert fit.sd == pytest.approx(math.sqrt(fit.sse / (len(loads) - 3)))  # n - 1 errors, less the two parameters
    path = forecast_path(fit, TODAY)
    for h, point in enumerate(path, start=1):
        assert point.high - point.value == pytest.approx(FORECAST_RULES.interval_z * fit.sd * math.sqrt(h))
        assert point.value - point.low == pytest.approx(FORECAST_RULES.interval_z * fit.sd * math.sqrt(h))
    assert all(a.high - a.low < b.high - b.low for a, b in zip(path, path[1:]))


def test_the_path_never_goes_below_zero():
    path = forecast_path(fit_holt([60, 40, 25, 12, 5, 1, 0, 0]), TODAY)
    assert all(p.value >= 0 and p.low >= 0 for p in path)
    assert any(p.value == 0 for p in path)  # the damped fall does reach it, and stops there


# ------------------------------------------------------------------ the backtest


def test_on_a_trending_history_the_forecast_beats_both_plain_alternatives():
    result = backtest(GROWING_10)
    assert result.folds == len(GROWING_10) - FORECAST_RULES.backtest_min_train
    assert result.model_mae < result.last_week_mae < result.average_mae


def test_on_a_steady_history_nobody_is_wrong():
    result = backtest(STEADY)
    assert (result.model_mae, result.last_week_mae, result.average_mae) == (0, 0, 0)


def test_the_two_plain_guesses_are_scored_exactly_as_described():
    """Weeks 5 and 6 are predicted: 'same as last week' misses by 10 each time, 'the last four weeks' average' by 25."""
    result = backtest([10, 20, 30, 40, 50, 60])
    assert result.folds == 2
    assert result.last_week_mae == 10 and result.average_mae == 25


def test_it_does_not_claim_a_result_from_too_few_weeks():
    assert backtest([60, 70, 80, 90, 100]) is None  # one prediction is not a test
    assert backtest([60, 70, 80, 90, 100, 110]) is not None


def test_a_prediction_never_sees_the_week_it_predicts():
    """A walk-forward test: changing the last week can't change how well the earlier weeks were predicted."""
    a = backtest([60, 70, 80, 90, 100, 110, 120])
    b = backtest([60, 70, 80, 90, 100, 110, 400])
    assert a.folds == b.folds == 3
    assert b.model_mae > a.model_mae  # the surprise shows up, and only at the end


# ------------------------------------------------------------------ the rate


def test_with_too_little_history_the_standard_rate_stands_and_the_steps_say_why():
    forecast = forecast_of([60, 64, 70, 73, 80])
    assert forecast.method == "default" and forecast.fit is None and forecast.future == () and forecast.backtest is None
    assert forecast.rate_pct == RULES.weekly_progression_pct
    assert "needs 6" in step(forecast, "history").detail and "standard 5.0%" in step(forecast, "history").detail
    assert [s.key for s in forecast.steps] == ["history", "adherence", "load", "limits", "rate"]  # no trend, no record


def test_with_no_history_at_all_it_says_so():
    forecast = build_forecast([], [], None, TODAY)
    assert forecast.method == "default" and forecast.series.loads == () and forecast.rate_pct == 5.0
    assert forecast.steps[0].detail.startswith("No logged training yet")


def test_the_rate_follows_the_athletes_own_trend():
    rates = {name: forecast_of(loads).rate_pct for name, loads in
             (("steady", STEADY), ("5", GROWING_5), ("10", GROWING_10), ("down", DECLINING))}
    assert rates["down"] == 0 < rates["steady"] < rates["5"] < rates["10"]
    assert rates["5"] == pytest.approx(4.58, abs=0.05)


def test_the_athletes_trend_is_blended_with_the_standard_by_how_much_history_there_is():
    short = forecast_of(GROWING_10[-6:])
    long = forecast_of(GROWING_10 + [round(50 * 1.1**i) for i in range(10, 12)])
    standard = RULES.weekly_progression_pct
    assert short.method == long.method == "holt"
    # more history moves the rate toward the athlete's own trend, whichever side of the standard that is on
    assert abs(long.rate_pct - long.trend_pct) < abs(short.rate_pct - short.trend_pct) or long.rate_pct == FORECAST_RULES.rate_max_pct
    assert short.rate_pct != standard


def test_the_rate_is_never_above_the_cap_or_below_holding_the_load():
    rules = FORECAST_RULES
    wild = forecast_of([20, 40, 80, 160, 300, 500, 800])
    assert wild.trend_pct > rules.rate_max_pct and wild.rate_pct == rules.rate_max_pct
    assert forecast_of(DECLINING).rate_pct == rules.rate_min_pct
    assert rules.rate_max_pct < RULES.max_weekly_increase_pct  # the cap sits under the plan's own safety limit


def test_the_cap_and_floor_are_configuration_not_code():
    tight = ForecastRules(rate_max_pct=2.0, rate_min_pct=1.0)
    assert forecast_of(GROWING_10, forecast_rules=tight).rate_pct == 2.0
    assert forecast_of(DECLINING, forecast_rules=tight).rate_pct == 1.0


def test_how_much_history_is_needed_is_configuration_too():
    assert forecast_of(GROWING_10[:5], forecast_rules=ForecastRules(min_weeks=5)).method == "holt"
    assert forecast_of(GROWING_10, forecast_rules=ForecastRules(min_weeks=12)).method == "default"


# ------------------------------------------------------------------ the track record


def test_trust_runs_from_all_of_the_say_to_none_of_it_between_the_two_ratios():
    full, none = FORECAST_RULES.trust_full_ratio, FORECAST_RULES.trust_none_ratio
    assert trust_in(10, 10, 12) == 1 and trust_in(9, 10, 12) == 1  # as good as the better guess, or better
    assert trust_in(10 * none, 10, 12) == 0 and trust_in(50, 10, 12) == 0
    assert trust_in(10 * (full + none) / 2, 10, 12) == pytest.approx(0.5)
    assert trust_in(10, 12, 10) == 1 and 0 < trust_in(12.2, 12, 10) < 1  # the bar is the better guess, whichever it is


def test_a_bar_without_a_single_miss_can_only_be_matched():
    assert trust_in(0, 0, 0) == 1 and trust_in(0.1, 0, 5) == 0


def test_the_ratios_are_configuration():
    strict = ForecastRules(trust_full_ratio=0.8, trust_none_ratio=1.0)  # beat the guess by a fifth to be fully trusted
    assert trust_in(9, 10, 12, strict) == pytest.approx(0.5) and trust_in(9, 10, 12) == 1
    assert trust_in(14, 10, 12, ForecastRules(trust_none_ratio=2.0)) == pytest.approx(0.6)


def test_each_athletes_forecast_is_judged_on_their_own_weeks():
    assert backtest(GROWING_5).trust == 1  # it forecast the climb better than either plain guess
    middling = backtest(FALLING_AFTER_MISSES)
    assert middling.model_mae > min(middling.last_week_mae, middling.average_mae)  # it lost to the better guess...
    assert 0 < middling.trust < 1  # ...by a little, so it keeps some of its say
    noisy = backtest(NOISY)
    assert noisy.model_mae > noisy.average_mae * FORECAST_RULES.trust_none_ratio and noisy.trust == 0


def test_a_share_of_the_say_is_never_written_as_all_or_nothing():
    """A sliver short of the bar is still 99%, and a sliver short of the cut-off is still 1%: the words must not contradict."""
    barely_lost = Backtest(6, 10.0005, 10, 11, trust_in(10.0005, 10, 11))  # a hair over the bar
    barely_kept = Backtest(6, 12.4995, 10, 11, trust_in(12.4995, 10, 11))  # a hair under the cut-off
    assert "keeps 99% of its say" in _record_step(barely_lost).detail
    assert "keeps 1% of its say" in _record_step(barely_kept).detail


def test_a_trend_with_no_record_to_show_leaves_the_standard_rate_alone():
    forecast = forecast_of(NOISY)
    assert forecast.method == "holt" and forecast.backtest.trust == 0 and forecast.trend_pct != 0
    assert forecast.rate_pct == RULES.weekly_progression_pct  # whatever the smoothing made of those weeks
    assert "gets no say" in step(forecast, "record").detail
    assert "0% of the say" in step(forecast, "blend").detail and "and that record" in step(forecast, "blend").detail


def test_a_trend_that_earned_its_say_has_the_say_the_history_allows():
    forecast = forecast_of(GROWING_5)
    assert forecast.backtest.trust == 1
    assert "63% of the say" in step(forecast, "blend").detail and "that record" not in step(forecast, "blend").detail
    assert step(forecast, "record").detail.endswith("so your trend keeps its full say.")
    assert "better than the best of them" in step(forecast, "record").detail


def test_a_partly_earned_say_is_blended_in_proportion():
    unclamped = ForecastRules(rate_min_pct=-50.0, rate_max_pct=50.0)  # so the blend itself shows
    forecast = forecast_of(FALLING_AFTER_MISSES, forecast_rules=unclamped)
    n, trust = len(FALLING_AFTER_MISSES), forecast.backtest.trust
    full_say = n / (n + unclamped.prior_weeks)
    say = full_say * trust
    assert 0 < say < full_say
    assert forecast.rate_pct == pytest.approx(say * forecast.trend_pct + (1 - say) * RULES.weekly_progression_pct, abs=0.005)
    assert f"keeps {int(100 * trust + 0.5)}% of its say" in step(forecast, "record").detail
    assert f"{fmt(100 * say, 0)}% of the say" in step(forecast, "blend").detail


def test_the_record_step_gives_the_numbers_it_was_judged_on():
    record = step(forecast_of(GROWING_5), "record").detail
    result = backtest(GROWING_5)
    for number in (result.model_mae, result.last_week_mae, result.average_mae):
        assert fmt(number) in record
    assert f"({result.folds} predictions)" in record and '"same as last week"' in record


def test_losing_its_say_only_ever_moves_the_rate_toward_the_standard_one_and_never_past_it():
    rng = random.Random(7)
    standard = RULES.weekly_progression_pct
    for _ in range(300):
        loads = [round(rng.uniform(20, 160)) for _ in range(rng.randint(6, 14))]
        earned, trusted = forecast_of(loads), forecast_of(loads, forecast_rules=ALWAYS_TRUSTED)
        low, high = sorted((standard, trusted.rate_pct))
        assert low <= earned.rate_pct <= high, loads


def test_a_forecast_that_cannot_be_tested_gets_no_say():
    rules = ForecastRules(min_weeks=5)  # five weeks fit a trend but allow only one prediction, which is not a test
    forecast = forecast_of(GROWING_10[:5], forecast_rules=rules)
    assert forecast.method == "holt" and forecast.backtest is None
    assert forecast.rate_pct == RULES.weekly_progression_pct
    assert "no say yet" in step(forecast, "record").detail and forecast_view(forecast, None).backtest is None


def test_the_rules_agree_with_each_other():
    rules = FORECAST_RULES
    assert rules.trust_full_ratio < rules.trust_none_ratio
    assert rules.min_weeks >= rules.backtest_min_train + rules.backtest_min_folds  # a fitted trend can always be tested
    assert rules.rate_min_pct <= RULES.weekly_progression_pct <= rules.rate_max_pct < RULES.max_weekly_increase_pct
    assert 0 < rules.adherence_low < rules.adherence_high <= 1
    assert rules.window_weeks >= max(rules.min_weeks, rules.adherence_window_weeks)


# ------------------------------------------------------------------ plan completion


def planned(day, volume=30, sid=None):
    return PlannedSession(id=sid or f"s-{day}", plan_id="p", date=day, activity_type="run", target_volume=volume,
                          target_duration_min=35, intensity_band="light", status="planned")


def session_week(week_offset, planned_volumes, done_volumes):
    """Sessions due in the whole week `week_offset` weeks before this one, and the logs against them."""
    monday = MONDAY - timedelta(weeks=week_offset)
    sessions = [planned(monday + timedelta(days=2 * i), v, f"s{week_offset}-{i}") for i, v in enumerate(planned_volumes)]
    logs = [workout(s.date, volume=d, planned_session_id=s.id) for s, d in zip(sessions, done_volumes) if d > 0]
    return sessions, logs


def test_completion_is_the_load_done_over_the_load_planned_in_the_recent_whole_weeks():
    sessions, logs = session_week(1, [30, 30, 40], [30, 20, 40])
    assert adherence(sessions, logs, TODAY) == pytest.approx(90 / 100)


def test_a_session_that_came_due_and_was_never_logged_counts_as_not_done():
    sessions, logs = session_week(1, [50, 50], [50, 0])
    assert adherence(sessions, logs, TODAY) == pytest.approx(0.5)


def test_extra_workouts_that_were_not_the_plan_do_not_make_up_for_it():
    sessions, logs = session_week(1, [50, 50], [50, 0])
    assert adherence(sessions, logs + [workout(MONDAY - timedelta(days=3), volume=500)], TODAY) == pytest.approx(0.5)


def test_a_strava_log_never_stands_in_for_a_planned_session():
    """Hard Rule 1: even one that somehow carried a session's id adds nothing to what was done."""
    sessions, logs = session_week(1, [50, 50], [50, 0])
    strava = workout(sessions[1].date, volume=50, planned_session_id=sessions[1].id, source="strava")
    assert adherence(sessions, logs + [strava], TODAY) == pytest.approx(0.5)


def test_doing_more_than_was_planned_does_not_speed_the_plan_up():
    sessions, logs = session_week(1, [10, 10], [15, 15])  # 150% of the plan
    workouts = history(STEADY) + logs
    over = build_forecast(workouts, sessions, None, TODAY)
    unscaled = build_forecast(workouts, [], None, TODAY)  # the same weeks with nothing planned to measure them against
    assert over.adherence == pytest.approx(1.5)
    assert 0 < unscaled.rate_pct < FORECAST_RULES.rate_max_pct / 2  # room for a boost to show, if there were one
    assert over.rate_pct == unscaled.rate_pct


def test_only_the_last_few_whole_weeks_count_and_the_current_week_does_not():
    old_s, old_l = session_week(FORECAST_RULES.adherence_window_weeks + 1, [50], [0])
    this_s = [planned(MONDAY + timedelta(days=1), 50)]
    recent_s, recent_l = session_week(2, [40], [40])
    assert adherence(old_s + this_s + recent_s, old_l + recent_l, TODAY) == pytest.approx(1.0)


def test_with_nothing_due_there_is_no_completion_figure():
    assert adherence([], [], TODAY) is None
    assert adherence([planned(MONDAY + timedelta(days=2), 40)], [], TODAY) is None


def test_progression_is_scaled_by_how_much_of_the_plan_was_done():
    def forecast_when_done(done):
        sessions, logs = session_week(1, [40, 40], done)
        return build_forecast(history(GROWING_5) + logs, sessions, None, TODAY)

    full, partial, low = forecast_when_done([40, 40]), forecast_when_done([40, 12]), forecast_when_done([20, 10])
    assert full.adherence == 1 and partial.adherence == pytest.approx(0.65) and low.adherence == pytest.approx(0.375)
    assert 0 < partial.rate_pct < full.rate_pct  # 65% of the plan: some, not all, of the progression
    assert low.rate_pct == 0  # under the floor: hold
    assert "scaled to 17%" in step(partial, "adherence").detail


def test_the_completion_thresholds_are_configuration():
    sessions, logs = session_week(1, [40, 40], [40, 12])  # 65% completed
    strict = ForecastRules(adherence_low=0.9, adherence_high=0.99)
    lenient = ForecastRules(adherence_low=0.1, adherence_high=0.2)
    with_logs = history(GROWING_5) + logs
    assert build_forecast(with_logs, sessions, None, TODAY, forecast_rules=strict).rate_pct == 0
    unscaled = build_forecast(with_logs, [], None, TODAY).rate_pct  # no sessions due: nothing to scale by
    assert unscaled > 0
    assert build_forecast(with_logs, sessions, None, TODAY, forecast_rules=lenient).rate_pct == unscaled


def test_completion_applies_before_there_is_enough_history_to_fit_a_trend_too():
    sessions, logs = session_week(1, [40, 40], [0, 0])
    forecast = build_forecast(logs, sessions, None, TODAY)
    assert forecast.method == "default" and forecast.adherence == 0 and forecast.rate_pct == 0


# ------------------------------------------------------------------ recent load


def test_while_the_recent_load_is_above_the_usual_range_progression_is_held():
    assert forecast_of(GROWING_5, acwr=1.31).rate_pct == 0
    assert forecast_of(GROWING_5, acwr=1.3).rate_pct > 0  # the edge of the range is still inside it
    assert forecast_of(GROWING_5, acwr=0.4).rate_pct > 0  # a light week is not a reason to hold
    assert forecast_of(GROWING_5, acwr=None).rate_pct > 0


def test_the_hold_follows_the_readiness_ranges_not_a_number_of_its_own():
    from app.training.config import ReadinessRules

    relaxed = ReadinessRules(acwr_high=2.0)
    assert forecast_of(GROWING_5, acwr=1.5, readiness_rules=relaxed).rate_pct > 0


# ------------------------------------------------------------------ the explanation


def test_the_steps_tell_the_whole_story_in_order():
    forecast = forecast_of(GROWING_5, acwr=1.1)
    keys = ["history", "trend", "record", "blend", "adherence", "load", "limits", "rate"]
    assert [s.key for s in forecast.steps] == keys
    text = " ".join(s.detail for s in forecast.steps)
    assert "10 whole weeks" in text and "rising about 4.3% a week" in text and "63% of the say" in text
    assert "1.10" in text and step(forecast, "rate").detail == "4.58% a week."


def test_the_steps_say_when_progression_was_held():
    held = forecast_of(GROWING_5, acwr=1.45)
    assert "above 1.3, so progression is held at 0%" in step(held, "load").detail and held.rate_pct == 0


def test_a_light_recent_week_is_described_as_light_not_as_inside_the_usual_range():
    light = forecast_of(GROWING_5, acwr=0.4)
    assert "lighter than your usual (under 0.8)" in step(light, "load").detail and "no hold" in step(light, "load").detail
    assert "within the usual range" in step(forecast_of(GROWING_5, acwr=0.8), "load").detail
    assert "No hold" not in step(light, "load").detail and light.rate_pct == forecast_of(GROWING_5, acwr=1.0).rate_pct


def test_a_ratio_just_across_a_limit_is_written_with_enough_digits_not_to_contradict_itself():
    """Two decimals make 0.797 into 0.80, which reads as the limit it is under (and 1.301 into 1.30, the limit it is over)."""
    assert "ratio is 0.797, lighter than your usual (under 0.8)" in step(forecast_of(GROWING_5, acwr=0.797), "load").detail
    assert "ratio is 1.301, above 1.3, so progression is held" in step(forecast_of(GROWING_5, acwr=1.301), "load").detail
    assert "ratio is 0.79, lighter" in step(forecast_of(GROWING_5, acwr=0.79), "load").detail  # two decimals say it
    assert "ratio is 1.31, above" in step(forecast_of(GROWING_5, acwr=1.31), "load").detail
    assert "ratio is 0.80, within the usual range" in step(forecast_of(GROWING_5, acwr=0.8), "load").detail
    assert "ratio is 1.30, within the usual range" in step(forecast_of(GROWING_5, acwr=1.3), "load").detail


def test_numbers_are_written_with_halves_rounded_up_so_two_languages_agree():
    assert fmt(0.25) == "0.3" and fmt(2.25) == "2.3" and fmt(2.5, 0) == "3" and fmt(-0.04) == "0.0" and fmt(12.345, 2) == "12.35"


# ------------------------------------------------------------------ the view the page draws


def test_the_view_carries_what_the_chart_needs_and_nothing_private():
    forecast = forecast_of(GROWING_5, acwr=1.1)
    view = forecast_view(forecast, 4.58)
    assert view.method == "holt" and view.weeks_of_history == 10 and view.weeks_needed == 6
    assert len(view.history) == 10 and len(view.fitted) == 9 and len(view.ahead) == FORECAST_RULES.horizon_weeks
    assert view.fitted[0].week_start == view.history[1].week_start
    assert view.progression_pct == forecast.rate_pct and view.plan_progression_pct == 4.58
    assert view.cap_pct == FORECAST_RULES.rate_max_pct and view.standard_pct == RULES.weekly_progression_pct
    assert view.backtest.folds == 6 and view.backtest.trust == 1 and view.steps[0].key == "history"
    assert "readiness" not in view.model_dump_json().lower()


def test_the_view_reports_how_far_the_trend_is_trusted_not_just_that_it_was_tested():
    for loads in (NOISY, FALLING_AFTER_MISSES, GROWING_5):
        forecast = forecast_of(loads)
        view = forecast_view(forecast, None)
        assert view.backtest.trust == pytest.approx(forecast.backtest.trust, abs=0.005)
    assert forecast_view(forecast_of(NOISY), None).backtest.trust == 0
    assert 0 < forecast_view(forecast_of(FALLING_AFTER_MISSES), None).backtest.trust < 1


def test_the_view_for_a_newcomer_is_honest_about_having_no_forecast():
    view = forecast_view(build_forecast([], [], None, TODAY), None)
    assert (view.method, view.weeks_of_history, view.history, view.fitted, view.ahead) == ("default", 0, [], [], [])
    assert view.level is None and view.trend_pct is None and view.backtest is None and view.plan_progression_pct is None


# ------------------------------------------------------------------ the frontend's copy

LIB = Path(__file__).resolve().parents[3] / "frontend" / "lib" / "training"
frontend_copy = pytest.mark.skipif(not LIB.exists(), reason="frontend not present")


def _interface_keys(name):
    source = (LIB / "types.ts").read_text(encoding="utf-8")
    body = re.search(rf"export interface {name} \{{(.*?)\n\}}", source, re.S).group(1)
    return set(re.findall(r"^\s+(\w+)\??:", body, re.M))


def _snake(name):
    return re.sub(r"[A-Z]", lambda found: "_" + found.group(0).lower(), name)


def _ts_forecast_rules():
    source = (LIB / "config.ts").read_text(encoding="utf-8")
    block = re.search(r"FORECAST_RULES\s*=\s*\{(.*?)\n\}\s*as const", source, re.S).group(1)
    block = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", block, flags=re.S))
    found = {}
    for key, value in re.findall(r"(\w+):\s*(\[[^\]]*\]|-?[\d.]+)", block):
        numbers = [float(x) for x in re.findall(r"-?[\d.]+", value)]
        found[_snake(key)] = numbers if value.startswith("[") else numbers[0]
    return found


def _ts_number(name):
    source = (LIB / "config.ts").read_text(encoding="utf-8")
    return float(re.search(rf"\b{name}:\s*(-?[\d.]+)", source).group(1))


@frontend_copy
def test_a_fitted_view_has_exactly_the_fields_the_frontend_types_declare():
    view = forecast_view(forecast_of(GROWING_5, acwr=1.1), 4.58).model_dump(mode="json", by_alias=True)
    for name, payload in (
        ("ForecastView", view),
        ("ForecastWeek", view["history"][0]),
        ("ForecastAhead", view["ahead"][0]),
        ("ForecastBacktest", view["backtest"]),
        ("ForecastStep", view["steps"][0]),
    ):
        assert _interface_keys(name) == set(payload), name


@frontend_copy
def test_the_frontends_forecast_rules_match_the_backends():
    """The fixtures run the same forecast from these numbers, so a change on one side alone would make them disagree."""
    python = {}
    for field in dataclasses.fields(FORECAST_RULES):
        value = getattr(FORECAST_RULES, field.name)
        python[field.name] = list(value) if isinstance(value, tuple) else value
    assert _ts_forecast_rules() == python


@frontend_copy
def test_the_frontends_load_limits_match_the_backends():
    assert (_ts_number("acwrLow"), _ts_number("acwrHigh")) == (READINESS_RULES.acwr_low, READINESS_RULES.acwr_high)
    assert _ts_number("maxWeeklyIncreasePct") == RULES.max_weekly_increase_pct
    assert _ts_number("weeklyProgressionPct") == RULES.weekly_progression_pct


# ------------------------------------------------------------------ in the plan


def service(history_loads=None, progression_supported=True):
    repo = FakeTrainingRepository()
    repo.progression_supported = progression_supported
    svc = TrainingService(repo, RuleBasedScorer())
    svc.save_preferences(USER_A, TODAY, STANDARD_PREFS)
    for log in history(history_loads or []):
        repo.workouts[log.id] = (USER_A, log)
    return svc, repo


def test_a_plan_is_built_at_the_rate_the_forecast_chose_and_remembers_it():
    svc, repo = service(GROWING_10)
    expected = forecast_of(GROWING_10).rate_pct
    plan = svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert plan.progression_pct == expected != RULES.weekly_progression_pct
    assert repo.get_active_plan(USER_A).progression_pct == expected
    targets = weekly_targets(plan.baseline_volume, 8, 0, progression_pct=expected)
    assert [plan_week_target(plan, plan.start_date + timedelta(weeks=i)) for i in range(8)] == [t.volume for t in targets]


def test_two_athletes_with_different_histories_get_different_plans():
    climbing, _ = service(GROWING_10)
    falling, _ = service(DECLINING)
    a = climbing.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    b = falling.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert a.progression_pct > b.progression_pct == 0


def test_without_enough_history_the_plan_is_the_standard_one_and_says_so():
    svc, _ = service([60, 64, 70])
    plan = svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert plan.progression_pct == RULES.weekly_progression_pct


def test_a_database_that_cannot_keep_the_rate_still_gets_a_plan_at_the_standard_rate():
    svc, repo = service(GROWING_10, progression_supported=False)
    plan = svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert plan.progression_pct is None and repo.get_active_plan(USER_A).progression_pct is None
    standard = weekly_targets(plan.baseline_volume, 8, 0)
    assert [plan_week_target(plan, plan.start_date + timedelta(weeks=i)) for i in range(8)] == [t.volume for t in standard]


def test_adapting_a_plan_rebuilds_it_at_the_current_rate_and_says_when_that_changed():
    svc, repo = service(GROWING_10)
    plan = svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert plan.progression_pct > RULES.weekly_progression_pct  # a fast climber progresses faster than the standard

    later = TODAY + timedelta(days=21)  # three weeks of the plan go by with nothing done
    adapted = svc.recalculate_plan(USER_A, later)

    assert adapted.progression_pct == 0
    assert "Weekly progression is now 0.0% instead of the standard 5.0%" in adapted.last_adaptation.reason
    assert repo.get_active_plan(USER_A).progression_pct == 0
    weeks = [week_start(later) + timedelta(weeks=i) for i in range(0, 4)]
    loading = [plan_week_target(adapted, w) for w in weeks if not is_deload_week(adapted, w)]
    assert len(loading) >= 2 and len(set(loading)) == 1  # held: the loading weeks stay level (a deload week is the only dip)


def test_adapting_without_a_change_of_rate_says_nothing_about_it():
    svc, _ = service([60, 64, 70])
    svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    adapted = svc.recalculate_plan(USER_A, TODAY)
    assert adapted.progression_pct == RULES.weekly_progression_pct
    assert "Weekly progression" not in adapted.last_adaptation.reason


def test_the_forecast_view_is_a_read_that_changes_nothing():
    svc, repo = service(GROWING_10)
    svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    before, calls = repo.get_active_plan(USER_A), repo.apply_calls
    view = svc.get_forecast(USER_A, TODAY)
    assert (repo.get_active_plan(USER_A), repo.apply_calls) == (before, calls)
    assert view.plan_progression_pct == before.progression_pct and view.method == "holt"


def test_a_plan_is_not_sped_up_while_the_athletes_recent_load_is_far_above_their_usual():
    """The service hands the forecast the athlete's acute:chronic ratio, so the hold works on real histories, not only in the maths."""
    svc, repo = service(STEADY)
    calm = svc.get_forecast(USER_A, TODAY)
    assert calm.progression_pct > 0  # ten level weeks: the plan would progress

    heavy = workout(MONDAY, volume=300)  # this week already holds three times a normal week's load
    repo.workouts[heavy.id] = (USER_A, heavy)
    view = svc.get_forecast(USER_A, TODAY)
    assert view.acwr > READINESS_RULES.acwr_high and view.progression_pct == 0
    assert "held at 0%" in next(s.detail for s in view.steps if s.key == "load")

    plan = svc.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    assert plan.progression_pct == 0


def test_the_forecast_view_needs_no_plan_and_nothing_else_of_the_athletes():
    svc, _ = service(GROWING_10)
    assert svc.get_forecast(USER_A, TODAY).plan_progression_pct is None
    assert svc.get_forecast("33333333-3333-3333-3333-333333333333", TODAY).weeks_of_history == 0


def test_a_rate_the_safety_check_would_reject_falls_back_to_the_standard_one_not_an_error():
    svc, _ = service()
    unsafe = dataclasses.replace(forecast_of(GROWING_5), rate_pct=12.0)  # a rate the plan check refuses
    assert first_unsafe_week(weekly_targets(100, 8, 0, progression_pct=12.0)) != -1
    targets, used = svc._plan_targets(100, 8, 0, unsafe)
    assert used == RULES.weekly_progression_pct and first_unsafe_week(targets) == -1
    assert [t.volume for t in targets] == [t.volume for t in weekly_targets(100, 8, 0)]


def test_a_plan_the_standard_rate_cannot_make_safe_is_still_refused():
    reckless = type(RULES)(weekly_progression_pct=15.0)
    repo = FakeTrainingRepository()
    svc = TrainingService(repo, RuleBasedScorer(), rules=reckless)
    unsafe = dataclasses.replace(forecast_of(GROWING_5), rate_pct=12.0)
    with pytest.raises(TrainingError) as raised:  # the learned rate is unsafe, and so is the standard one it falls back to
        svc._plan_targets(100, 8, 0, unsafe)
    assert raised.value.code == "PLAN_UNSAFE"
    repo.progression_supported = False
    with pytest.raises(TrainingError) as raised:  # and with nowhere to keep a rate the standard one is all there is
        svc._plan_targets(100, 8, 0, forecast_of(GROWING_5))
    assert raised.value.code == "PLAN_UNSAFE"



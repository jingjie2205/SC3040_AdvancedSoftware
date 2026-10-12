"""
The load forecast behind a plan's weekly progression. Pure functions: no I/O, and the same history gives the same answer.

The plan generator used to add a fixed 5% to the load every week, for everyone. This module replaces that number with one
estimated from the athlete's own logged training:

1. the weekly completed load, from their workout logs (Strava rows never count: Hard Rule 1);
2. Holt's damped-trend exponential smoothing, with the smoothing parameters chosen per athlete by how well they forecast
   that athlete's own earlier weeks, which gives their current level and weekly trend;
3. a walk-forward backtest scores that forecast on the athlete's own earlier weeks against two plain guesses, and the
   trend is only trusted as far as it did at least as well;
4. the trend is blended with the standard progression in proportion to how much history there is and how well it did;
5. the blend is scaled by how much of the plan they actually completed, held at zero while their recent load is above
   their usual range, and capped.

With too little history there is no forecast and the standard progression stands. The plan still has to pass the
generator's own safety check, so nothing here can produce an unsafe plan.

The TypeScript copy for the in-memory fixtures is `frontend/lib/training/forecast.ts`; the two are kept identical (the
steps' wording included) and compared on random inputs.
"""
import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from .config import FORECAST_RULES, READINESS_RULES, RULES, ForecastRules, ReadinessRules, TrainingRules
from .models import (
    ForecastAhead,
    ForecastBacktest,
    ForecastStep,
    ForecastView,
    ForecastWeek,
    PlannedSession,
    WorkoutSession,
)
from .planner import modelling_workouts, round_half_up, week_start


@dataclass(frozen=True)
class WeeklySeries:
    weeks: Tuple[date, ...]  # the Monday of each week, oldest first
    loads: Tuple[float, ...]  # completed load (pts) in that week


@dataclass(frozen=True)
class HoltFit:
    alpha: float
    beta: float
    level: float  # the smoothed weekly load now
    trend: float  # pts a week, as it stands now
    sse: float
    sd: float  # spread of the one-step-ahead errors
    fitted: Tuple[float, ...]  # what the model predicted for weeks 2..n, one week ahead each time


@dataclass(frozen=True)
class Backtest:
    folds: int
    model_mae: float
    last_week_mae: float  # "the same as last week"
    average_mae: float  # "the average of the last four weeks", what the plan's baseline uses
    trust: float  # how much of its usual say the athlete's own trend keeps, 0 to 1


@dataclass(frozen=True)
class FuturePoint:
    week_start: date
    value: float
    low: float
    high: float


@dataclass(frozen=True)
class Step:
    key: str
    label: str
    detail: str


@dataclass(frozen=True)
class LoadForecast:
    method: str  # "holt" when the athlete's own trend was fitted, "default" when there was too little history
    series: WeeklySeries
    fit: Optional[HoltFit]
    trend_pct: Optional[float]  # the fitted trend as a percent of the level, a week
    adherence: Optional[float]
    acwr: Optional[float]
    rate_pct: float  # the weekly progression the plan will use
    future: Tuple[FuturePoint, ...]
    backtest: Optional[Backtest]
    steps: Tuple[Step, ...]


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _total(values: Sequence[float]) -> float:
    """
    The sum added left to right, as the TypeScript copy adds it. Python's own sum() is more exact than that from 3.12,
    which is better arithmetic but would make the two copies differ in the last digit of a value that sits on a rounding
    boundary.
    """
    total = 0.0
    for value in values:
        total += value
    return total


def fmt(value: float, places: int = 1) -> str:
    """`value` to `places` decimals, halves rounded up, the same way in Python and in TypeScript."""
    scale = 10**places
    return f"{math.floor(value * scale + 0.5) / scale:.{places}f}"


# ----------------------------------------------------------------------------- the weekly series


def weekly_load_series(
    workouts: Sequence[WorkoutSession], as_of: date, forecast_rules: ForecastRules = FORECAST_RULES
) -> WeeklySeries:
    """
    The load the athlete completed in each whole week before the week containing `as_of`, from their first week of
    training in the window to the last whole week. A week inside that stretch with nothing logged counts as zero: it
    happened. Strava logs are left out (Hard Rule 1), and so is anything not yet logged.
    """
    this_week = week_start(as_of)
    earliest = this_week - timedelta(weeks=forecast_rules.window_weeks)
    totals: Dict[date, float] = {}
    for workout in modelling_workouts(workouts):
        if earliest <= workout.date < this_week:
            monday = week_start(workout.date)
            totals[monday] = totals.get(monday, 0.0) + workout.actual_volume
    if not totals:
        return WeeklySeries((), ())
    weeks: List[date] = []
    cursor = min(totals)
    while cursor < this_week:
        weeks.append(cursor)
        cursor += timedelta(days=7)
    return WeeklySeries(tuple(weeks), tuple(round_half_up(totals.get(m, 0.0) * 100) / 100 for m in weeks))


# ----------------------------------------------------------------------------- Holt's damped-trend smoothing


def _holt_pass(loads: Sequence[float], alpha: float, beta: float, phi: float) -> Tuple[float, float, float, List[float]]:
    """One run of the recursion over `loads`: (level, trend, sum of squared one-step errors, the one-step forecasts)."""
    n = len(loads)
    reach = min(3, n - 1)
    level = loads[0]
    trend = (loads[reach] - loads[0]) / reach
    sse = 0.0
    predictions: List[float] = []
    for t in range(1, n):
        predicted = level + phi * trend
        predictions.append(predicted)
        error = loads[t] - predicted
        sse += error * error
        new_level = alpha * loads[t] + (1 - alpha) * predicted
        trend = beta * (new_level - level) + (1 - beta) * phi * trend
        level = new_level
    return level, trend, sse, predictions


def fit_holt(loads: Sequence[float], forecast_rules: ForecastRules = FORECAST_RULES) -> Optional[HoltFit]:
    """
    Fit the smoothing to `loads`: of every pair in the grids, keep the one whose one-week-ahead forecasts of this very
    series were closest (the first of any ties). None for fewer than three weeks, where there is nothing to fit.
    """
    n = len(loads)
    if n < 3:
        return None
    best: Optional[Tuple[float, float, float, float, float, List[float]]] = None
    for alpha in forecast_rules.alpha_grid:
        for beta in forecast_rules.beta_grid:
            level, trend, sse, predictions = _holt_pass(loads, alpha, beta, forecast_rules.damping)
            if best is None or sse < best[0]:
                best = (sse, alpha, beta, level, trend, predictions)
    assert best is not None
    sse, alpha, beta, level, trend, predictions = best
    sd = math.sqrt(sse / max(n - 3, 1))  # n - 1 errors, less the two parameters
    return HoltFit(alpha, beta, level, trend, sse, sd, tuple(predictions))


def forecast_path(
    fit: HoltFit, as_of: date, forecast_rules: ForecastRules = FORECAST_RULES
) -> Tuple[FuturePoint, ...]:
    """The weeks ahead from the week containing `as_of`: the damped trend carried forward, with an interval that widens."""
    points: List[FuturePoint] = []
    this_week = week_start(as_of)
    faded = 0.0
    power = 1.0
    for h in range(1, forecast_rules.horizon_weeks + 1):
        power *= forecast_rules.damping
        faded += power
        value = max(fit.level + fit.trend * faded, 0.0)
        spread = forecast_rules.interval_z * fit.sd * math.sqrt(h)
        points.append(
            FuturePoint(this_week + timedelta(weeks=h - 1), value, max(value - spread, 0.0), value + spread)
        )
    return tuple(points)


def trust_in(model_mae: float, last_week_mae: float, average_mae: float, forecast_rules: ForecastRules = FORECAST_RULES) -> float:
    """
    How much of its usual say the athlete's own trend keeps, from how its forecasts did on their own earlier weeks. The
    bar is the better of the two plain guesses: the trend keeps all of its say while its average miss is within
    `trust_full_ratio` times the bar's, none of it once the miss is `trust_none_ratio` times the bar's or more, and a
    proportional share in between. A bar with no misses at all can only be matched, never beaten, so anything short of
    matching it earns nothing.
    """
    bar = min(last_week_mae, average_mae)
    if model_mae <= bar * forecast_rules.trust_full_ratio:
        return 1.0
    if bar <= 0:
        return 0.0
    span = forecast_rules.trust_none_ratio - forecast_rules.trust_full_ratio
    return _clamp((forecast_rules.trust_none_ratio - model_mae / bar) / span, 0.0, 1.0)


def backtest(loads: Sequence[float], forecast_rules: ForecastRules = FORECAST_RULES) -> Optional[Backtest]:
    """
    Walk forward through the athlete's own weeks: fit on the weeks so far, predict the next, score it against what
    happened, and score two plain alternatives the same way. None when there are too few weeks to predict twice.
    """
    model: List[float] = []
    last: List[float] = []
    average: List[float] = []
    for t in range(forecast_rules.backtest_min_train, len(loads)):
        fit = fit_holt(loads[:t], forecast_rules)
        assert fit is not None
        model.append(abs(loads[t] - (fit.level + forecast_rules.damping * fit.trend)))
        last.append(abs(loads[t] - loads[t - 1]))
        recent = loads[max(0, t - 4) : t]
        average.append(abs(loads[t] - _total(recent) / len(recent)))
    if len(model) < forecast_rules.backtest_min_folds:
        return None
    n = len(model)
    model_mae, last_week_mae, average_mae = _total(model) / n, _total(last) / n, _total(average) / n
    return Backtest(n, model_mae, last_week_mae, average_mae, trust_in(model_mae, last_week_mae, average_mae, forecast_rules))


# ----------------------------------------------------------------------------- what the athlete actually completes


def adherence(
    sessions: Sequence[PlannedSession],
    workouts: Sequence[WorkoutSession],
    as_of: date,
    forecast_rules: ForecastRules = FORECAST_RULES,
) -> Optional[float]:
    """
    The share of the planned load the athlete actually did, over the last few whole weeks: the load of the workouts
    logged against those weeks' planned sessions, divided by the load those sessions planned. A session that came due
    and wasn't logged counts as not done. None when no session came due in the window.
    """
    this_week = week_start(as_of)
    earliest = this_week - timedelta(weeks=forecast_rules.adherence_window_weeks)
    due = [s for s in sessions if earliest <= s.date < this_week]
    planned = sum(s.target_volume for s in due)
    if planned <= 0:
        return None
    due_ids = {s.id for s in due}
    done = _total([w.actual_volume for w in modelling_workouts(workouts) if w.planned_session_id in due_ids])
    return done / planned


# ----------------------------------------------------------------------------- the decision


def _ratio(value: float, bound: float) -> str:
    """
    The load ratio to two decimals, or to three when two would read as the very bound it is on the other side of: a
    ratio of 0.797 is under 0.8 even though 0.80 is what two decimals make of it.
    """
    two = fmt(value, 2)
    return fmt(value, 3) if two == fmt(bound, 2) else two


def _record_step(result: Optional[Backtest]) -> Step:
    """What the backtest found, and what it means for the say the athlete's own trend gets."""
    if result is None:
        return Step(
            "record",
            "Track record",
            "Too few weeks to test the forecast on your own earlier weeks, so your trend gets no say yet.",
        )
    bar = min(result.last_week_mae, result.average_mae)
    evidence = (
        f"Predicting your own earlier weeks one at a time ({result.folds} predictions), the forecast missed by "
        f"{fmt(result.model_mae)} pts a week on average, against {fmt(result.last_week_mae)} for \"same as last week\" "
        f"and {fmt(result.average_mae)} for \"the last four weeks' average\"."
    )
    if result.trust >= 1:
        gain = 100 * (bar - result.model_mae) / bar if bar > 0 else 0.0
        verdict = (
            f"It did {fmt(gain, 0)}% better than the best of them, so your trend keeps its full say."
            if gain >= 0.5
            else "It did about as well as the best of them, so your trend keeps its full say."
        )
    elif result.trust > 0:
        kept = _clamp(round_half_up(100 * result.trust), 1, 99)
        verdict = f"It didn't beat the best of them, so your trend keeps {kept}% of its say."
    else:
        verdict = "It didn't beat the best of them, so your trend gets no say and the standard rate carries the plan."
    return Step("record", "Track record", f"{evidence} {verdict}")


def build_forecast(
    workouts: Sequence[WorkoutSession],
    sessions: Sequence[PlannedSession],
    acwr: Optional[float],
    as_of: date,
    rules: TrainingRules = RULES,
    forecast_rules: ForecastRules = FORECAST_RULES,
    readiness_rules: ReadinessRules = READINESS_RULES,
) -> LoadForecast:
    """
    The forecast for `as_of` and the weekly progression it supports. `acwr` is the athlete's acute:chronic load ratio
    now (None when there isn't enough recent history to compute it).
    """
    series = weekly_load_series(workouts, as_of, forecast_rules)
    n = len(series.loads)
    standard = rules.weekly_progression_pct
    steps: List[Step] = []

    fit = fit_holt(series.loads, forecast_rules) if n >= forecast_rules.min_weeks else None
    trend_pct: Optional[float] = None
    future: Tuple[FuturePoint, ...] = ()
    result: Optional[Backtest] = None

    if fit is None:
        weeks = f"{n} whole week{'' if n == 1 else 's'}"
        detail = (
            f"No logged training yet, so the standard {fmt(standard)}% a week is the starting point."
            if n == 0
            else f"{weeks} of logged training. The forecast needs {forecast_rules.min_weeks}, so the standard "
            f"{fmt(standard)}% a week is the starting point."
        )
        steps.append(Step("history", "Your history", detail))
        rate = standard
    else:
        trend_pct = 100 * fit.trend / fit.level if fit.level > 0 else 0.0
        result = backtest(series.loads, forecast_rules)
        trust = result.trust if result is not None else 0.0
        weight = n / (n + forecast_rules.prior_weeks)
        say = weight * trust  # more weeks of data, and a better record, give the athlete's own trend more of the say
        rate = say * trend_pct + (1 - say) * standard
        future = forecast_path(fit, as_of, forecast_rules)
        steps.append(
            Step(
                "history",
                "Your history",
                f"{n} whole weeks of logged training, from {fmt(min(series.loads), 0)} to "
                f"{fmt(max(series.loads), 0)} pts a week.",
            )
        )
        if abs(trend_pct) < 0.05:
            movement = "holding steady"
        elif trend_pct > 0:
            movement = f"rising about {fmt(trend_pct)}% a week"
        else:
            movement = f"falling about {fmt(-trend_pct)}% a week"
        steps.append(
            Step(
                "trend",
                "Your trend",
                f"Smoothing fitted to your own weeks (alpha {fmt(fit.alpha, 2)}, beta {fmt(fit.beta, 2)}) puts your "
                f"weekly load at {fmt(fit.level, 0)} pts, {movement}.",
            )
        )
        steps.append(_record_step(result))
        steps.append(
            Step(
                "blend",
                "Blended with the standard",
                f"With {n} weeks of data{'' if trust >= 1 else ' and that record'} your own trend gets "
                f"{fmt(100 * say, 0)}% of the say and the standard {fmt(standard)}% the rest: {fmt(rate)}% a week.",
            )
        )

    completed = adherence(sessions, workouts, as_of, forecast_rules)
    if completed is None:
        steps.append(
            Step("adherence", "Plan completion", "No finished plan weeks to measure yet, so this doesn't change the rate.")
        )
    else:
        factor = _clamp(
            (completed - forecast_rules.adherence_low) / (forecast_rules.adherence_high - forecast_rules.adherence_low),
            0.0,
            1.0,
        )
        rate = rate * factor
        done = f"You completed {fmt(100 * completed, 0)}% of the last {forecast_rules.adherence_window_weeks} weeks' planned load"
        steps.append(
            Step(
                "adherence",
                "Plan completion",
                f"{done}, so progression is unchanged."
                if factor >= 1
                else f"{done}, so progression is scaled to {fmt(100 * factor, 0)}%: {fmt(rate)}% a week.",
            )
        )

    if acwr is None:
        steps.append(
            Step("load", "Recent load", "Not enough recent days logged to compare this week with your usual, so no hold applies.")
        )
    elif acwr > readiness_rules.acwr_high:
        rate = 0.0
        steps.append(
            Step(
                "load",
                "Recent load",
                f"Your acute:chronic load ratio is {_ratio(acwr, readiness_rules.acwr_high)}, above "
                f"{fmt(readiness_rules.acwr_high, 1)}, so progression is held at 0% until it settles.",
            )
        )
    elif acwr < readiness_rules.acwr_low:
        steps.append(
            Step(
                "load",
                "Recent load",
                f"Your acute:chronic load ratio is {_ratio(acwr, readiness_rules.acwr_low)}, lighter than your usual "
                f"(under {fmt(readiness_rules.acwr_low, 1)}), so there is no hold.",
            )
        )
    else:
        steps.append(
            Step(
                "load",
                "Recent load",
                f"Your acute:chronic load ratio is {fmt(acwr, 2)}, within the usual range (up to "
                f"{fmt(readiness_rules.acwr_high, 1)}), so there is no hold.",
            )
        )

    rate = _clamp(rate, forecast_rules.rate_min_pct, forecast_rules.rate_max_pct)
    rate = round_half_up(rate * 100) / 100
    steps.append(
        Step(
            "limits",
            "Safety limits",
            f"The rate is kept between {fmt(forecast_rules.rate_min_pct)}% and {fmt(forecast_rules.rate_max_pct)}% a week, "
            f"and a plan is rejected above {fmt(rules.max_weekly_increase_pct)}% between loading weeks.",
        )
    )
    steps.append(Step("rate", "Weekly progression", f"{fmt(rate, 2)}% a week."))
    return LoadForecast(
        method="holt" if fit is not None else "default",
        series=series,
        fit=fit,
        trend_pct=trend_pct,
        adherence=completed,
        acwr=acwr,
        rate_pct=rate,
        future=future,
        backtest=result,
        steps=tuple(steps),
    )


def _round2(value: float) -> float:
    return round_half_up(value * 100) / 100


def forecast_view(
    forecast: LoadForecast,
    plan_progression_pct: Optional[float],
    rules: TrainingRules = RULES,
    forecast_rules: ForecastRules = FORECAST_RULES,
) -> ForecastView:
    """The forecast as the API returns it (and the page draws it), with the numbers rounded to what is worth showing."""
    series, fit, backtest_ = forecast.series, forecast.fit, forecast.backtest
    return ForecastView(
        method="holt" if forecast.method == "holt" else "default",
        weeks_of_history=len(series.loads),
        weeks_needed=forecast_rules.min_weeks,
        history=[ForecastWeek(week_start=w, load=_round2(v)) for w, v in zip(series.weeks, series.loads)],
        fitted=[
            ForecastWeek(week_start=w, load=_round2(v)) for w, v in zip(series.weeks[1:], fit.fitted if fit else ())
        ],
        ahead=[
            ForecastAhead(week_start=p.week_start, value=_round2(p.value), low=_round2(p.low), high=_round2(p.high))
            for p in forecast.future
        ],
        level=_round2(fit.level) if fit else None,
        trend_pct=_round2(forecast.trend_pct) if forecast.trend_pct is not None else None,
        alpha=fit.alpha if fit else None,
        beta=fit.beta if fit else None,
        adherence=_round2(forecast.adherence) if forecast.adherence is not None else None,
        acwr=forecast.acwr,
        standard_pct=rules.weekly_progression_pct,
        progression_pct=forecast.rate_pct,
        cap_pct=forecast_rules.rate_max_pct,
        plan_progression_pct=plan_progression_pct,
        backtest=ForecastBacktest(
            folds=backtest_.folds,
            model_mae=_round2(backtest_.model_mae),
            last_week_mae=_round2(backtest_.last_week_mae),
            average_mae=_round2(backtest_.average_mae),
            trust=_round2(backtest_.trust),
        )
        if backtest_
        else None,
        steps=[ForecastStep(key=s.key, label=s.label, detail=s.detail) for s in forecast.steps],
    )

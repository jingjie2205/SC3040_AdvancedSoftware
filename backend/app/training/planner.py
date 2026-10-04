"""
Plan generation as pure functions: no I/O, same inputs give the same plan.
"""
import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Sequence

from .config import RULES, TrainingRules
from .models import (
    WEEKDAYS,
    ActivityType,
    IntensityBand,
    PlannedSession,
    TrainingPreferencesInput,
    WorkoutSession,
)


def round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def week_start(day: date) -> date:
    """Monday of the week containing `day`."""
    return day - timedelta(days=day.weekday())


def modelling_workouts(workouts: Sequence[WorkoutSession]) -> List[WorkoutSession]:
    """
    Hard Rule 1: Strava-sourced rows must never feed a model or a plan decision. They can be
    shown on the schedule, which reads workouts directly, but every calculation goes through here.
    """
    return [w for w in workouts if w.source != "strava"]


@dataclass(frozen=True)
class AthleteProfile:
    """The parts of the user's profile that shape a plan. Anything can be missing."""

    activity_level: Optional[str] = None


@dataclass(frozen=True)
class Baseline:
    volume: float
    session_count: int
    used_default: bool
    from_profile: bool = False


def baseline_from_history(
    workouts: Sequence[WorkoutSession],
    as_of: date,
    rules: TrainingRules = RULES,
    activity_level: Optional[str] = None,
) -> Baseline:
    """
    Mean weekly volume over the last few complete weeks before the week containing `as_of`,
    counting only weeks with training. Whole weeks are used so no week is cut in half.

    Hard Rule 3: this is computed from what was actually logged, never from planned sessions,
    so someone who missed three weeks doesn't get a plan that assumes they trained through them.
    With too little history it falls back to a conservative default, lower for people whose
    profile says they are less active.
    """
    end = week_start(as_of)
    start = end - timedelta(weeks=rules.baseline_window_weeks)
    recent = [w for w in modelling_workouts(workouts) if start <= w.date < end]
    active_weeks = {week_start(w.date) for w in recent}
    if len(active_weeks) < rules.min_history_weeks_for_baseline:
        default = rules.default_baseline_for(activity_level)
        return Baseline(default, len(recent), True, default != rules.default_baseline_volume)
    total = sum(w.actual_volume for w in recent)
    return Baseline(float(round_half_up(total / len(active_weeks))), len(recent), False)


@dataclass(frozen=True)
class WeekTarget:
    volume: int
    deload: bool


def weekly_targets(
    baseline: float, weeks: int, week_offset: int = 0, rules: TrainingRules = RULES
) -> List[WeekTarget]:
    """
    Periodised weekly volume: gentle progression with a deload every N weeks.
    `week_offset` keeps the deload rhythm aligned when only the remaining weeks are regenerated.
    """
    targets: List[WeekTarget] = []
    loading = baseline
    for week in range(weeks):
        if (week + week_offset + 1) % rules.deload_every_n_weeks == 0:
            targets.append(WeekTarget(round_half_up(loading * rules.deload_volume_factor), True))
            continue
        if week > 0:
            loading *= 1 + rules.weekly_progression_pct / 100
        targets.append(WeekTarget(round_half_up(loading), False))
    return targets


def first_unsafe_week(targets: Sequence[WeekTarget], rules: TrainingRules = RULES) -> int:
    """
    Index of the first week whose increase exceeds the safe threshold, or -1.
    A loading week is compared with the previous loading week, so the rebound after a deload
    isn't flagged.
    """
    previous = None
    for index, target in enumerate(targets):
        if target.deload:
            continue
        if previous is not None and (target.volume - previous) / previous * 100 > rules.max_weekly_increase_pct:
            return index
        previous = target.volume
    return -1


def plan_end_date(start: date, weeks: int) -> date:
    return start + timedelta(days=weeks * 7 - 1)


@dataclass(frozen=True)
class SessionDraft:
    date: date
    activity_type: ActivityType
    target_volume: int
    target_duration_min: int
    intensity_band: IntensityBand


def build_sessions(
    prefs: TrainingPreferencesInput,
    start: date,
    targets: Sequence[WeekTarget],
    from_date: date,
    rules: TrainingRules = RULES,
) -> List[SessionDraft]:
    """
    Spread each week's sessions across the available days.

    `start` must be a Monday. Sessions before `from_date` are left out (already in the past).
    Every third session is a push session, and a push is never placed the day after another,
    including across a week boundary.
    """
    available = [i for i, day in enumerate(WEEKDAYS) if day not in prefs.rest_days]
    per_week = min(prefs.days_per_week, len(available))
    if per_week == 0:
        return []

    drafts: List[SessionDraft] = []
    last_push: Optional[date] = None
    for week, target in enumerate(targets):
        week_monday = start + timedelta(days=7 * week)
        slots = [
            (order, week_monday + timedelta(days=available[(order * len(available)) // per_week]))
            for order in range(per_week)
        ]
        slots = [(order, day) for order, day in slots if day >= from_date]
        if not slots:
            continue

        bands: Dict[int, IntensityBand] = {}
        for order, day in slots:
            band: IntensityBand = "deload" if target.deload else ("push" if order % 3 == 0 else "light")
            if band == "push":
                if last_push is not None and (day - last_push).days <= 1:
                    band = "light"
                else:
                    last_push = day
            bands[order] = band

        weight_total = sum(rules.band_weight[bands[order]] for order, _ in slots)
        week_volume = target.volume * len(slots) / per_week
        for order, day in slots:
            band = bands[order]
            drafts.append(
                SessionDraft(
                    date=day,
                    activity_type=prefs.activity_types[(order + week) % len(prefs.activity_types)],
                    target_volume=round_half_up(week_volume * rules.band_weight[band] / weight_total),
                    target_duration_min=_round_duration(
                        prefs.session_duration_min * rules.band_duration_factor[band], rules
                    ),
                    intensity_band=band,
                )
            )
    return drafts


def _round_duration(minutes: float, rules: TrainingRules) -> int:
    return max(rules.session_duration_min, round_half_up(minutes / 5) * 5)


def rescale_for_band(
    session: PlannedSession, band: IntensityBand, rules: TrainingRules = RULES
) -> tuple:
    """(target_volume, target_duration_min) for `session` if it were run at `band` instead."""
    source = session.intensity_band
    volume = round_half_up(session.target_volume / rules.band_weight[source] * rules.band_weight[band])
    duration = _round_duration(
        session.target_duration_min / rules.band_duration_factor[source] * rules.band_duration_factor[band],
        rules,
    )
    return volume, duration

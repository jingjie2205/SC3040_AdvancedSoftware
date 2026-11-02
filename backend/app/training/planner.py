"""
Plan generation as pure functions: no I/O, same inputs give the same plan.
"""
import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from .config import RULES, TrainingRules
from .models import (
    WEEKDAYS,
    ActivityType,
    IntensityBand,
    PlannedSession,
    TrainingPlan,
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
    # As the Settings page stores it: DEFICIT, MAINTAIN or SURPLUS.
    fitness_goal: Optional[str] = None


def goal_for(profile: Optional[AthleteProfile], rules: TrainingRules = RULES) -> Optional[str]:
    """The profile's goal in this feature's terms, or None when it is missing or isn't one Settings offers."""
    if profile is None or profile.fitness_goal is None:
        return None
    return rules.profile_goal_map.get(str(profile.fitness_goal).strip().upper())


def activity_rotation(
    activity_types: Sequence[ActivityType], goal: Optional[str], rules: TrainingRules = RULES
) -> List[ActivityType]:
    """
    The order activities come up in, repeating. With no goal (or one that favours nothing the user
    picked) it is their own list, so every activity gets an equal share. A goal gives the types it
    favours extra turns, interleaved rather than back to back, and never adds a type the user didn't pick.
    """
    weights = rules.goal_activity_weights.get(goal or "", {})
    turns = {kind: max(1, int(weights.get(kind, 1))) for kind in activity_types}
    rotation: List[ActivityType] = []
    for round_ in range(max(turns.values())):
        rotation.extend(kind for kind in activity_types if round_ < turns[kind])
    return rotation


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
    baseline: float,
    weeks: int,
    week_offset: int = 0,
    rules: TrainingRules = RULES,
    *,
    progression_pct: Optional[float] = None,
) -> List[WeekTarget]:
    """
    Periodised weekly volume: progression with a deload every N weeks.
    `week_offset` keeps the deload rhythm aligned when only the remaining weeks are regenerated.
    `progression_pct` is the weekly increase learned from the athlete's own history (forecast.py); without it the
    standard `config.weekly_progression_pct` applies.
    """
    step = rules.weekly_progression_pct if progression_pct is None else progression_pct
    targets: List[WeekTarget] = []
    loading = baseline
    for week in range(weeks):
        if (week + week_offset + 1) % rules.deload_every_n_weeks == 0:
            targets.append(WeekTarget(round_half_up(loading * rules.deload_volume_factor), True))
            continue
        if week > 0:
            loading *= 1 + step / 100
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


def sessions_per_week(prefs: TrainingPreferencesInput) -> int:
    """How many sessions a full week of the plan has: the days the athlete wants, or every free day if there are fewer."""
    return min(prefs.days_per_week, sum(1 for day in WEEKDAYS if day not in prefs.rest_days))


def build_sessions(
    prefs: TrainingPreferencesInput,
    start: date,
    targets: Sequence[WeekTarget],
    from_date: date,
    rules: TrainingRules = RULES,
    goal: Optional[str] = None,
) -> List[SessionDraft]:
    """
    Spread each week's sessions across the available days.

    `start` must be a Monday. Sessions before `from_date` are left out (already in the past).
    Every third session is a push session, and a push is never placed the day after another,
    including across a week boundary. `goal` only changes which of the user's activities come up
    more often (see `activity_rotation`), never when sessions fall or how hard they are.
    """
    available = [i for i, day in enumerate(WEEKDAYS) if day not in prefs.rest_days]
    per_week = sessions_per_week(prefs)
    if per_week == 0:
        return []
    rotation = activity_rotation(prefs.activity_types, goal, rules)

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
                    activity_type=rotation[(order + week) % len(rotation)],
                    target_volume=round_half_up(week_volume * rules.band_weight[band] / weight_total),
                    target_duration_min=default_duration_min(prefs.session_duration_min, band, rules),
                    intensity_band=band,
                )
            )
    return drafts


def _round_duration(minutes: float, rules: TrainingRules) -> int:
    return max(rules.session_duration_min, round_half_up(minutes / 5) * 5)


def default_duration_min(preferred_min: int, band: IntensityBand, rules: TrainingRules = RULES) -> int:
    """How long a session at this intensity is when nobody picks a length: the preferred length scaled by the band."""
    return _round_duration(preferred_min * rules.band_duration_factor[band], rules)


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


# ----------------------------------------------------------------------------- planning a week by hand


def is_deload_week(plan: TrainingPlan, week_monday: date, rules: TrainingRules = RULES) -> bool:
    """Whether the plan's week starting `week_monday` is one of its deload weeks (every session in it is a deload)."""
    index = (week_monday - plan.start_date).days // 7
    return 0 <= index < plan.weeks and (index + 1) % rules.deload_every_n_weeks == 0


def plan_week_target(plan: TrainingPlan, week_monday: date, rules: TrainingRules = RULES) -> Optional[int]:
    """
    The load (pts) the plan itself set for the Monday-to-Sunday week starting `week_monday`, worked out from the plan's
    baseline the way `generate_plan` and an adaptation worked it out: an adaptation restarts the progression from its own
    week, so the weeks it replaced are counted from there. None for a week the plan doesn't cover, or one that an
    adaptation has already left behind.
    """
    index = (week_monday - plan.start_date).days // 7
    if not 0 <= index < plan.weeks:
        return None
    elapsed = 0
    if plan.last_adaptation is not None:
        elapsed = max(0, (week_start(plan.last_adaptation.adapted_on) - plan.start_date).days // 7)
    if index < elapsed:
        return None
    targets = weekly_targets(
        plan.baseline_volume, plan.weeks - elapsed, elapsed, rules, progression_pct=plan.progression_pct
    )
    return targets[index - elapsed].volume


def weight_of(band: IntensityBand, duration_min: int, rules: TrainingRules = RULES) -> float:
    """What a session counts for when a week's load is shared out: intensity times length, which is what a point is."""
    return rules.band_weight[band] * duration_min


def week_pool(target: int, finished: int, now: int, sessions_after: int, per_week: int) -> int:
    """
    The points a week's sessions still to do share once there are `sessions_after` of them. The week carries the plan's
    load (`target`) when it has the usual number of sessions (`per_week`) and a proportional share with fewer, as the
    generator builds a week that is already partly gone. So a session added to a thin week brings its usual share,
    never past what the week's finished sessions (`finished`) left of the plan's load, and one added beyond the usual
    number only shares what is there. A week that already holds more than that (`now` points) is never cut down.
    """
    usual = round_half_up(target * sessions_after / per_week) if per_week > 0 else target
    return max(now, min(target - finished, usual))


@dataclass(frozen=True)
class WeekShare:
    new_volume: int
    others: Dict[str, int]


def share_week(pool: int, others: Sequence[Tuple[str, int, float]], new_weight: float) -> WeekShare:
    """
    A session joins a week that has `pool` points left to do, or one already in it changes weight. It takes its share
    by weight, and the others keep their proportions to one another and split what is left, so the week still adds up
    to `pool`. `others` is (id, current points, weight) for the sessions already there. Every session keeps at least
    one point, so `pool` has to be at least the number of sessions.
    """
    total_weight = sum(weight for _, _, weight in others) + new_weight
    new_volume = round_half_up(pool * new_weight / total_weight)
    current = [points for _, points, _ in others]
    basis = current if sum(current) > 0 else [weight for _, _, weight in others]
    volumes = [new_volume, *_split(max(pool - new_volume, 0), basis)]
    _keep_at_least_one(volumes)
    return WeekShare(volumes[0], {session_id: volumes[i + 1] for i, (session_id, _, _) in enumerate(others)})


def _split(total: int, basis: Sequence[float]) -> List[int]:
    """`total` in whole points in proportion to `basis`, adding up exactly: the biggest remainders get the spare points."""
    if not basis:
        return []
    exact = [total * part / sum(basis) for part in basis]
    parts = [math.floor(value) for value in exact]
    by_remainder = sorted(range(len(parts)), key=lambda i: (-(exact[i] - parts[i]), i))
    for i in by_remainder[: total - sum(parts)]:
        parts[i] += 1
    return parts


def _keep_at_least_one(volumes: List[int]) -> None:
    """Hand points from the biggest share to any that rounded down to nothing. Only a very small week needs it."""
    for i in range(len(volumes)):
        while volumes[i] < 1:
            donor = max(range(len(volumes)), key=lambda j: volumes[j])
            if volumes[donor] <= 1:
                return
            volumes[donor] -= 1
            volumes[i] += 1

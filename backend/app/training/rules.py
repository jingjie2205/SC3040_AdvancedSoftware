"""
Rules about what a session may do: whether it can move, and how readiness reconciles with the plan.
Pure functions, shared by the service and the tests.
"""
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal, Optional, Sequence, Tuple

from .config import RULES, TrainingRules
from .models import IntensityBand, PlannedSession, ReadinessScore, SessionRecommendation
from .planner import rescale_for_band

MOVABLE_STATUSES = ("planned", "accepted", "moved")
LOGGABLE_STATUSES = ("planned", "accepted", "moved", "missed")

BAND_RANK = {"deload": 0, "light": 1, "push": 2}

MoveRefusalCode = Literal[
    "NOT_MOVABLE",
    "NO_CHANGE",
    "IN_PAST",
    "OUT_OF_PLAN",
    "CONSECUTIVE_HIGH_INTENSITY",
]


@dataclass(frozen=True)
class MoveContext:
    sessions: Sequence[PlannedSession]
    plan_start: date
    plan_end: date
    today: date


@dataclass(frozen=True)
class MoveRefusal:
    code: MoveRefusalCode
    reason: str
    suggested_date: Optional[date]


def _find_refusal(
    session: PlannedSession,
    target: date,
    ctx: MoveContext,
    rules: TrainingRules,
    *,
    moving: bool = True,
) -> Optional[Tuple[MoveRefusalCode, str]]:
    if moving:
        if session.status not in MOVABLE_STATUSES:
            return "NOT_MOVABLE", "Completed, partial and missed sessions can't be moved."
        if target == session.date:
            return "NO_CHANGE", "That session is already on this day."
    return _placement_refusal(session, target, ctx, rules)


def _placement_refusal(
    session: PlannedSession, target: date, ctx: MoveContext, rules: TrainingRules
) -> Optional[Tuple[MoveRefusalCode, str]]:
    """
    Whether `session` may sit on `target`: today or later, inside the plan, and with no push on the same day as another
    push or the day before or after one. Any number of other sessions may share the day.
    """
    if target < ctx.today:
        return "IN_PAST", "A session can't be on a day that has already passed."
    if target < ctx.plan_start or target > ctx.plan_end:
        return "OUT_OF_PLAN", "That date is outside your plan."

    others = [s for s in ctx.sessions if s.id != session.id]

    if session.intensity_band == rules.high_intensity_band:
        neighbours = {target - timedelta(days=1), target, target + timedelta(days=1)}
        if any(
            s.intensity_band == rules.high_intensity_band
            and s.status != "missed"
            and s.date in neighbours
            for s in others
        ):
            return (
                "CONSECUTIVE_HIGH_INTENSITY",
                "Two high-intensity (push) sessions can't be on the same day or on consecutive days.",
            )
    return None


def nearest_valid_date(
    session: PlannedSession,
    target: date,
    ctx: MoveContext,
    rules: TrainingRules = RULES,
    *,
    moving: bool = True,
) -> Optional[date]:
    """Nearest day to `target` (the later day on a tie) where the move would be allowed."""
    for offset in range(1, rules.move_search_days + 1):
        for candidate in (target + timedelta(days=offset), target - timedelta(days=offset)):
            if _find_refusal(session, candidate, ctx, rules, moving=moving) is None:
                return candidate
    return None


def _check(
    session: PlannedSession, target: date, ctx: MoveContext, rules: TrainingRules, *, moving: bool
) -> Optional[MoveRefusal]:
    refusal = _find_refusal(session, target, ctx, rules, moving=moving)
    if refusal is None:
        return None
    code, reason = refusal
    suggestion = None
    if code not in ("NOT_MOVABLE", "NO_CHANGE"):
        suggestion = nearest_valid_date(session, target, ctx, rules, moving=moving)
    return MoveRefusal(code=code, reason=reason, suggested_date=suggestion)


def check_move(
    session: PlannedSession, target: date, ctx: MoveContext, rules: TrainingRules = RULES
) -> Optional[MoveRefusal]:
    """None if the move is allowed, otherwise why not, with the nearest valid day when one helps."""
    return _check(session, target, ctx, rules, moving=True)


def check_placement(
    session: PlannedSession, target: date, ctx: MoveContext, rules: TrainingRules = RULES
) -> Optional[MoveRefusal]:
    """
    The day rules for a session that isn't on the calendar yet, or one whose intensity is changing where it stands:
    today or later, inside the plan, and no push on or beside another push. Nothing about a move (it isn't one).
    """
    return _check(session, target, ctx, rules, moving=False)


def band_refusal(band: IntensityBand, deload_week: bool) -> Optional[str]:
    """
    Why a hand-planned session can't have this intensity in this week, or None. The plan's deload weeks stay all-deload
    and its other weeks never hold a deload, which is how the generator builds them and how the Plan tab labels a week.
    """
    if deload_week and band != "deload":
        return "This is a deload week, so its sessions stay at Deload intensity."
    if not deload_week and band == "deload":
        return "Deload is only for deload weeks. Pick Light or Push."
    return None


def reconcile(
    planned: PlannedSession, readiness: ReadinessScore, rules: TrainingRules = RULES
) -> SessionRecommendation:
    """
    Hard Rule 2: one direction only. Low readiness can pull a planned session down a band;
    high readiness never lifts a light day, because that would undo the periodisation.
    """
    if BAND_RANK[readiness.classification] < BAND_RANK[planned.intensity_band]:
        band: IntensityBand = readiness.classification
    else:
        band = planned.intensity_band
    downgraded = band != planned.intensity_band

    if downgraded:
        volume, duration = rescale_for_band(planned, band, rules)
        explanation = (
            f"Readiness is {readiness.classification} today ({readiness.score}/100), so your "
            f"planned {planned.intensity_band} session is dialled back to {band}."
        )
    else:
        volume, duration = planned.target_volume, planned.target_duration_min
        if readiness.classification == "push" and planned.intensity_band == "light":
            explanation = (
                "You're ready to push, but today is a planned light day. The plan stays as "
                "scheduled to protect your progression."
            )
        else:
            explanation = "Readiness matches today's plan, so go ahead as scheduled."

    return SessionRecommendation(
        activity_type=planned.activity_type,
        intensity_band=band,
        target_volume=volume,
        target_duration_min=duration,
        downgraded=downgraded,
        explanation=explanation,
    )

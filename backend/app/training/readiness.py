"""
Daily readiness score (T-3).

Stage 1: a deterministic rule-based scorer behind the `ReadinessScorer` interface. Stage 2
replaces the implementation with a trained model served from this service; callers don't change.
The same features always give the same score.
"""
import hashlib
import json
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean
from typing import Iterable, List, Optional, Protocol, Sequence

from pydantic import Field

from .config import READINESS_RULES, ReadinessRules
from .models import ApiModel, IntensityBand, ModelInfo, ReadinessFactor, ScoreResult

# --------------------------------------------------------------------------- features


@dataclass(frozen=True)
class ActivityRecord:
    """One logged session as the feature builder sees it."""

    day: date
    volume: float
    avg_hr: Optional[int]
    source: str


@dataclass(frozen=True)
class Checkin:
    """
    Latest daily check-in. `load_rating` is the check-in's muscle soreness answer, 1 ("Fresh") to 5
    ("Very sore"), so a higher number is worse. `day` is the date it was made; when the source
    doesn't say, the check-in is taken as current.
    """

    load_rating: Optional[int]
    sleep_hours: Optional[float]
    day: Optional[date] = None


class ReadinessFeatures(ApiModel):
    """Everything the scorer sees. Any field can be missing; the scorer then leaves it out."""

    acwr: Optional[float] = Field(default=None, ge=0, le=10)
    hr_trend_delta: Optional[float] = Field(default=None, ge=-60, le=60)
    checkin_load_rating: Optional[int] = Field(default=None, ge=1, le=5)
    sleep_hours: Optional[float] = Field(default=None, ge=0, le=24)
    days_until_exam: Optional[int] = Field(default=None, ge=0, le=365)


# What `ReadinessFeatures.days_until_exam` accepts. An exam further off than the scorer's window
# changes nothing, so capping it loses no information.
_MAX_EXAM_DAYS = 365


def days_until_next_exam(exam_dates: Iterable[date], today: date) -> Optional[int]:
    """Days from `today` to the nearest exam that hasn't passed (0 if it is today), or None."""
    upcoming = [(d - today).days for d in exam_dates if d >= today]
    if not upcoming:
        return None
    return min(min(upcoming), _MAX_EXAM_DAYS)


def build_features(
    records: Sequence[ActivityRecord],
    checkin: Optional[Checkin],
    as_of: date,
    days_until_exam: Optional[int] = None,
    rules: ReadinessRules = READINESS_RULES,
    sleep_hours: Optional[float] = None,
) -> ReadinessFeatures:
    """
    Turn history into features for the score on `as_of`, using days before `as_of` only.

    `sleep_hours` is last night's sleep as the user entered it today. A check-in that carries its own
    sleep answer is only the fallback, so an explicit entry always wins.

    Hard Rule 1: Strava-sourced records are dropped here, before anything is computed, so they
    can't influence a score however they got into `records`.
    """
    if checkin is not None and checkin.day is not None and (as_of - checkin.day).days > rules.checkin_max_age_days:
        checkin = None  # too old to say anything about today

    usable = [r for r in records if r.source != "strava"]
    acute_start = as_of - timedelta(days=7)
    chronic_start = as_of - timedelta(days=28)
    acute = [r for r in usable if acute_start <= r.day < as_of]
    chronic = [r for r in usable if chronic_start <= r.day < as_of]

    acwr: Optional[float] = None
    if chronic and min(r.day for r in chronic) <= as_of - timedelta(days=rules.min_history_days_for_acwr):
        chronic_weekly = sum(r.volume for r in chronic) / 4
        if chronic_weekly > 0:
            acwr = round(sum(r.volume for r in acute) / chronic_weekly, 3)

    recent_hr = [r.avg_hr for r in acute if r.avg_hr is not None]
    prior_hr = [r.avg_hr for r in chronic if r.avg_hr is not None and r.day < acute_start]
    hr_trend: Optional[float] = None
    if len(recent_hr) >= rules.hr_trend_min_sessions and len(prior_hr) >= rules.hr_trend_min_sessions:
        hr_trend = round(mean(recent_hr) - mean(prior_hr), 2)

    if sleep_hours is None and checkin is not None:
        sleep_hours = checkin.sleep_hours

    return ReadinessFeatures(
        acwr=acwr,
        hr_trend_delta=hr_trend,
        checkin_load_rating=checkin.load_rating if checkin else None,
        sleep_hours=sleep_hours,
        days_until_exam=days_until_exam,
    )


def fingerprint(features: ReadinessFeatures, scorer_version: str = "") -> str:
    """
    Stable id for a feature set and the scorer that read it. A cached score is only valid while
    neither has changed, so switching scorers recomputes instead of serving the old scorer's answer.
    """
    payload = json.dumps({"features": features.model_dump(), "scorer": scorer_version}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- scoring


class ReadinessScorer(Protocol):
    version: str

    def score(self, features: ReadinessFeatures) -> ScoreResult: ...

    def info(self) -> ModelInfo: ...


@dataclass(frozen=True)
class Contribution:
    delta: float
    factor: ReadinessFactor


def impact_for(delta: float) -> str:
    if delta <= -1:
        return "negative"
    if delta >= 1:
        return "positive"
    return "neutral"


def classify(score: int, rules: ReadinessRules = READINESS_RULES) -> IntensityBand:
    if score >= rules.push_min_score:
        return "push"
    if score >= rules.light_min_score:
        return "light"
    return "deload"


def explain(classification: IntensityBand, ranked: List[Contribution]) -> str:
    """One line on why. `ranked` is ordered by how much each signal moved the score."""
    drags = [c for c in ranked if c.delta <= -1]
    if not ranked:
        return "Not enough data yet, so no adjustments are being made."
    if classification == "deload":
        label = drags[0].factor.label.lower() if drags else "several signals"
        return f"Fatigue signals are stacking up, mainly {label}. Prioritise recovery today."
    if classification == "light":
        label = drags[0].factor.label if drags else "Your recent signals"
        return f"{label} is holding your score back, so keep it easier today."
    if drags:
        return f"Mostly recovered. Keep an eye on {drags[0].factor.label.lower()}."
    return "Well recovered. Nothing is holding your score back today."


def no_data_factor() -> ReadinessFactor:
    return ReadinessFactor(
        key="data",
        label="Not enough data yet",
        impact="neutral",
        detail="Log a few workouts and check in daily to sharpen this score",
    )


class RuleBasedScorer:
    """Starts from a base score and adds or subtracts points for each signal that is present."""

    version = "rules-v1"

    def __init__(
        self, rules: ReadinessRules = READINESS_RULES, fallback_reason: Optional[str] = None
    ) -> None:
        self.rules = rules
        self.fallback_reason = fallback_reason

    def info(self) -> ModelInfo:
        return ModelInfo(
            kind="rules",
            version=self.version,
            description="Deterministic rule-based scorer: a base score adjusted for each signal present.",
            fallback_reason=self.fallback_reason,
        )

    def contributions(self, features: ReadinessFeatures) -> List[Contribution]:
        """What each signal that is present adds or takes away, with the wording to show for it."""
        return [
            c
            for c in (
                self._load(features.acwr),
                self._heart_rate(features.hr_trend_delta),
                self._checkin(features.checkin_load_rating),
                self._sleep(features.sleep_hours),
                self._exam(features.days_until_exam),
            )
            if c is not None
        ]

    def score(self, features: ReadinessFeatures) -> ScoreResult:
        contributions = self.contributions(features)
        total = self.rules.base_score + sum(c.delta for c in contributions)
        score = max(0, min(100, int(round(total))))
        classification = classify(score, self.rules)

        ranked = sorted(contributions, key=lambda c: abs(c.delta), reverse=True)
        factors = [c.factor for c in ranked[: self.rules.max_factors_shown]]
        if not factors:
            factors = [no_data_factor()]
        return ScoreResult(
            score=score,
            classification=classification,
            factors=factors,
            explanation=explain(classification, ranked),
        )

    def _load(self, acwr: Optional[float]) -> Optional[Contribution]:
        if acwr is None:
            return None
        r = self.rules
        if acwr > r.acwr_high:
            delta = -min(r.acwr_penalty_cap, (acwr - r.acwr_high) * r.acwr_penalty_per_unit)
            detail = f"Acute:chronic ratio {acwr:.2f}, above your usual range"
        elif acwr < r.acwr_low:
            delta = 0.0
            detail = f"Acute:chronic ratio {acwr:.2f}, lighter than usual"
        else:
            delta = r.acwr_in_range_bonus
            detail = f"Acute:chronic ratio {acwr:.2f}, right in the productive range"
        return Contribution(delta, ReadinessFactor(key="load", label="Training load", impact=impact_for(delta), detail=detail))

    def _heart_rate(self, trend: Optional[float]) -> Optional[Contribution]:
        if trend is None:
            return None
        r = self.rules
        if trend > r.hr_trend_tolerance_bpm:
            delta = -min(r.hr_trend_penalty_cap, (trend - r.hr_trend_tolerance_bpm) * r.hr_trend_penalty_per_bpm)
            detail = f"Average heart rate {trend:.0f} bpm above your recent baseline"
        elif trend <= -r.hr_trend_improvement_bpm:
            delta = r.hr_trend_improvement_bonus
            detail = f"Average heart rate {abs(trend):.0f} bpm below your recent baseline"
        else:
            delta = 0.0
            detail = "Average heart rate in line with your recent baseline"
        return Contribution(delta, ReadinessFactor(key="hr_trend", label="Heart rate trend", impact=impact_for(delta), detail=detail))

    def _checkin(self, rating: Optional[int]) -> Optional[Contribution]:
        if rating is None:
            return None
        r = self.rules
        raw = -(rating - r.checkin_neutral_rating) * r.checkin_points_per_step
        delta = max(-r.checkin_penalty_cap, min(r.checkin_bonus_cap, raw))
        return Contribution(
            delta,
            ReadinessFactor(
                key="checkin",
                label="Daily check-in",
                impact=impact_for(delta),
                detail=f"Muscle soreness {rating} out of 5",
            ),
        )

    def _sleep(self, hours: Optional[float]) -> Optional[Contribution]:
        if hours is None:
            return None
        r = self.rules
        if hours < r.sleep_target_hours:
            delta = -min(r.sleep_penalty_cap, (r.sleep_target_hours - hours) * r.sleep_penalty_per_hour)
        elif hours >= r.sleep_bonus_hours:
            delta = r.sleep_bonus
        else:
            delta = 0.0
        return Contribution(delta, ReadinessFactor(key="sleep", label="Sleep", impact=impact_for(delta), detail=f"{hours:.1f} h last night"))

    def _exam(self, days: Optional[int]) -> Optional[Contribution]:
        if days is None:
            return None
        r = self.rules
        if days > r.exam_window_days:
            return None
        delta = -(r.exam_window_days - days) / r.exam_window_days * r.exam_max_penalty
        detail = "Exam today" if days == 0 else f"Exam in {days} day{'s' if days != 1 else ''}"
        return Contribution(delta, ReadinessFactor(key="exam", label="Academic load", impact=impact_for(delta), detail=detail))

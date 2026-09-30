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
from typing import List, Optional, Protocol, Sequence

from pydantic import Field

from .config import READINESS_RULES, ReadinessRules
from .models import ApiModel, IntensityBand, ReadinessFactor, ScoreResult

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
    """Latest daily check-in. `load_rating` is perceived load/fatigue, 1 (light) to 5 (exhausting)."""

    load_rating: Optional[int]
    sleep_hours: Optional[float]


class ReadinessFeatures(ApiModel):
    """Everything the scorer sees. Any field can be missing; the scorer then leaves it out."""

    acwr: Optional[float] = Field(default=None, ge=0, le=10)
    hr_trend_delta: Optional[float] = Field(default=None, ge=-60, le=60)
    checkin_load_rating: Optional[int] = Field(default=None, ge=1, le=5)
    sleep_hours: Optional[float] = Field(default=None, ge=0, le=24)
    days_until_exam: Optional[int] = Field(default=None, ge=0, le=365)


def build_features(
    records: Sequence[ActivityRecord],
    checkin: Optional[Checkin],
    as_of: date,
    days_until_exam: Optional[int] = None,
    rules: ReadinessRules = READINESS_RULES,
) -> ReadinessFeatures:
    """
    Turn history into features for the score on `as_of`, using days before `as_of` only.

    Hard Rule 1: Strava-sourced records are dropped here, before anything is computed, so they
    can't influence a score however they got into `records`.
    """
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

    return ReadinessFeatures(
        acwr=acwr,
        hr_trend_delta=hr_trend,
        checkin_load_rating=checkin.load_rating if checkin else None,
        sleep_hours=checkin.sleep_hours if checkin else None,
        days_until_exam=days_until_exam,
    )


def fingerprint(features: ReadinessFeatures) -> str:
    """Stable id for a feature set. A cached score is only valid while this hasn't changed."""
    payload = json.dumps(features.model_dump(), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- scoring


class ReadinessScorer(Protocol):
    def score(self, features: ReadinessFeatures) -> ScoreResult: ...


@dataclass(frozen=True)
class _Contribution:
    delta: float
    factor: ReadinessFactor


def _impact(delta: float) -> str:
    if delta <= -1:
        return "negative"
    if delta >= 1:
        return "positive"
    return "neutral"


class RuleBasedScorer:
    """Starts from a base score and adds or subtracts points for each signal that is present."""

    def __init__(self, rules: ReadinessRules = READINESS_RULES) -> None:
        self.rules = rules

    def score(self, features: ReadinessFeatures) -> ScoreResult:
        contributions = [
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
        total = self.rules.base_score + sum(c.delta for c in contributions)
        score = max(0, min(100, int(round(total))))
        classification = self._classify(score)

        ranked = sorted(contributions, key=lambda c: abs(c.delta), reverse=True)
        factors = [c.factor for c in ranked[: self.rules.max_factors_shown]]
        if not factors:
            factors = [
                ReadinessFactor(
                    key="data",
                    label="Not enough data yet",
                    impact="neutral",
                    detail="Log a few workouts and check in daily to sharpen this score",
                )
            ]
        return ScoreResult(
            score=score,
            classification=classification,
            factors=factors,
            explanation=self._explain(classification, ranked),
        )

    def _classify(self, score: int) -> IntensityBand:
        if score >= self.rules.push_min_score:
            return "push"
        if score >= self.rules.light_min_score:
            return "light"
        return "deload"

    def _load(self, acwr: Optional[float]) -> Optional[_Contribution]:
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
        return _Contribution(delta, ReadinessFactor(key="load", label="Training load", impact=_impact(delta), detail=detail))

    def _heart_rate(self, trend: Optional[float]) -> Optional[_Contribution]:
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
        return _Contribution(delta, ReadinessFactor(key="hr_trend", label="Heart rate trend", impact=_impact(delta), detail=detail))

    def _checkin(self, rating: Optional[int]) -> Optional[_Contribution]:
        if rating is None:
            return None
        r = self.rules
        raw = -(rating - r.checkin_neutral_rating) * r.checkin_points_per_step
        delta = max(-r.checkin_penalty_cap, min(r.checkin_bonus_cap, raw))
        return _Contribution(
            delta,
            ReadinessFactor(
                key="checkin",
                label="Daily check-in",
                impact=_impact(delta),
                detail=f"Felt {rating} out of 5 on load",
            ),
        )

    def _sleep(self, hours: Optional[float]) -> Optional[_Contribution]:
        if hours is None:
            return None
        r = self.rules
        if hours < r.sleep_target_hours:
            delta = -min(r.sleep_penalty_cap, (r.sleep_target_hours - hours) * r.sleep_penalty_per_hour)
        elif hours >= r.sleep_bonus_hours:
            delta = r.sleep_bonus
        else:
            delta = 0.0
        return _Contribution(delta, ReadinessFactor(key="sleep", label="Sleep", impact=_impact(delta), detail=f"{hours:.1f} h last night"))

    def _exam(self, days: Optional[int]) -> Optional[_Contribution]:
        if days is None:
            return None
        r = self.rules
        if days > r.exam_window_days:
            return None
        delta = -(r.exam_window_days - days) / r.exam_window_days * r.exam_max_penalty
        detail = "Exam today" if days == 0 else f"Exam in {days} day{'s' if days != 1 else ''}"
        return _Contribution(delta, ReadinessFactor(key="exam", label="Academic load", impact=_impact(delta), detail=detail))

    def _explain(self, classification: IntensityBand, ranked: List[_Contribution]) -> str:
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

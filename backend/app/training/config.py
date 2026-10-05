"""
Business rules for the training routine. Every tunable number lives here so QA can vary it;
nothing elsewhere in the package hard-codes a threshold.

Volume is expressed in "load points" (roughly minutes weighted by intensity).
"""
from dataclasses import dataclass, field
from typing import Dict, Optional

PLAN_NOTICE = (
    "This plan is a general training guide, not medical advice. Stop and speak to a "
    "qualified professional if you feel pain, dizziness or unusual fatigue."
)


@dataclass(frozen=True)
class TrainingRules:
    days_per_week_min: int = 1
    days_per_week_max: int = 7
    session_duration_min: int = 15
    session_duration_max: int = 180

    plan_weeks_min: int = 2
    plan_weeks_max: int = 16
    deload_every_n_weeks: int = 4
    deload_volume_factor: float = 0.7
    weekly_progression_pct: float = 5.0
    max_weekly_increase_pct: float = 10.0

    baseline_window_weeks: int = 4
    min_history_weeks_for_baseline: int = 2
    default_baseline_volume: float = 100.0
    # Starting weekly volume when there is too little logged history, by the activity level on the
    # user's profile. Lower for people who are less active today, so a beginner isn't handed a week
    # they can't do. A missing profile or an unlisted level gets `default_baseline_volume`.
    default_baseline_by_activity_level: Dict[str, float] = field(
        default_factory=lambda: {
            "SEDENTARY": 60.0,
            "LIGHTLY_ACTIVE": 80.0,
            "MODERATELY_ACTIVE": 100.0,
            "VERY_ACTIVE": 120.0,
            "EXTRA_ACTIVE": 140.0,
        }
    )

    high_intensity_band: str = "push"
    partial_completion_ratio: float = 0.8
    move_search_days: int = 14
    schedule_max_range_days: int = 200

    missed_sessions_trigger: int = 3
    low_readiness_days_trigger: int = 3
    low_readiness_classification: str = "deload"

    workout_duration_max: int = 600
    workout_volume_max: float = 1000.0
    workout_rpe_min: int = 1
    workout_rpe_max: int = 10
    workout_hr_min: int = 30
    workout_hr_max: int = 230

    band_weight: Dict[str, float] = field(
        default_factory=lambda: {"push": 1.0, "light": 0.7, "deload": 0.6}
    )
    band_duration_factor: Dict[str, float] = field(
        default_factory=lambda: {"push": 1.0, "light": 0.75, "deload": 0.6}
    )

    def default_baseline_for(self, activity_level: Optional[str]) -> float:
        return self.default_baseline_by_activity_level.get(activity_level or "", self.default_baseline_volume)


@dataclass(frozen=True)
class ReadinessRules:
    base_score: float = 80.0
    push_min_score: int = 70
    light_min_score: int = 45

    min_history_days_for_acwr: int = 14
    acwr_low: float = 0.8
    acwr_high: float = 1.3
    acwr_in_range_bonus: float = 3.0
    acwr_penalty_per_unit: float = 60.0
    acwr_penalty_cap: float = 25.0

    hr_trend_tolerance_bpm: float = 3.0
    hr_trend_penalty_per_bpm: float = 2.5
    hr_trend_penalty_cap: float = 15.0
    hr_trend_improvement_bpm: float = 2.0
    hr_trend_improvement_bonus: float = 3.0
    hr_trend_min_sessions: int = 2

    checkin_neutral_rating: int = 2
    checkin_points_per_step: float = 4.0
    checkin_bonus_cap: float = 4.0
    checkin_penalty_cap: float = 12.0

    sleep_target_hours: float = 7.0
    sleep_bonus_hours: float = 8.0
    sleep_penalty_per_hour: float = 7.5
    sleep_penalty_cap: float = 15.0
    sleep_bonus: float = 3.0

    exam_window_days: int = 7
    exam_max_penalty: float = 10.0

    max_factors_shown: int = 4

    # Use the trained model when its artifact is present and matches these rules. Turn off to force
    # the rule-based scorer, which is also what runs whenever the model can't be used.
    use_trained_model: bool = True


RULES = TrainingRules()
READINESS_RULES = ReadinessRules()

from datetime import date, timedelta

import pytest

from app.training.config import RULES, TrainingRules
from app.training.models import PlannedSession, TrainingPreferencesInput
from app.training.planner import (
    baseline_from_history,
    build_sessions,
    first_unsafe_week,
    rescale_for_band,
    week_start,
    weekly_targets,
)
from training_fakes import STANDARD_PREFS, TODAY, workout

MONDAY = date(2026, 9, 28)


# ------------------------------------------------------------------ baseline


def test_baseline_is_the_mean_of_weeks_that_had_training():
    history = [workout(MONDAY - timedelta(days=7 * w) + timedelta(days=d), 30) for w in range(1, 5) for d in (0, 2)]
    baseline = baseline_from_history(history, MONDAY)
    assert baseline.volume == 60
    assert baseline.used_default is False
    assert baseline.session_count == 8


ACTIVITY_LEVELS = ["SEDENTARY", "LIGHTLY_ACTIVE", "MODERATELY_ACTIVE", "VERY_ACTIVE", "EXTRA_ACTIVE"]  # as in models/users.py


def test_the_default_baseline_covers_every_activity_level_and_rises_with_activity():
    volumes = [RULES.default_baseline_for(level) for level in ACTIVITY_LEVELS]
    assert volumes == sorted(volumes) and len(set(volumes)) == len(volumes)
    assert RULES.default_baseline_for("MODERATELY_ACTIVE") == RULES.default_baseline_volume


@pytest.mark.parametrize("level", [None, "", "SOMETHING_NEW"])
def test_a_missing_or_unknown_activity_level_gets_the_plain_default(level):
    assert RULES.default_baseline_for(level) == RULES.default_baseline_volume


def test_with_too_little_history_the_default_follows_the_activity_level():
    beginner = baseline_from_history([], MONDAY, activity_level="SEDENTARY")
    assert (beginner.volume, beginner.used_default, beginner.from_profile) == (60, True, True)
    unknown = baseline_from_history([], MONDAY)
    assert (unknown.volume, unknown.from_profile) == (RULES.default_baseline_volume, False)


def test_enough_history_always_beats_the_profile():
    history = [workout(MONDAY - timedelta(days=7 * w) + timedelta(days=d), 30) for w in range(1, 5) for d in (0, 2)]
    with_profile = baseline_from_history(history, MONDAY, activity_level="EXTRA_ACTIVE")
    assert with_profile == baseline_from_history(history, MONDAY)
    assert with_profile.used_default is False and with_profile.from_profile is False


def test_baseline_falls_back_to_conservative_default_with_under_two_weeks_of_history():
    one_week = [workout(MONDAY - timedelta(days=3), 500), workout(MONDAY - timedelta(days=5), 500)]
    baseline = baseline_from_history(one_week, MONDAY)
    assert baseline.used_default is True
    assert baseline.volume == RULES.default_baseline_volume


def test_baseline_ignores_history_older_than_the_window():
    old = [workout(MONDAY - timedelta(days=60 + d), 999) for d in range(0, 14, 2)]
    assert baseline_from_history(old, MONDAY).used_default is True


def test_rebaseline_uses_what_was_completed_not_what_was_planned():
    """Hard Rule 3: three missed weeks must not produce a plan that assumes training happened."""

    def trained(weeks_ago, volume=60):
        return [
            workout(MONDAY - timedelta(days=7 * w) + timedelta(days=d), volume)
            for w in weeks_ago
            for d in (0, 2, 4)
        ]

    assert baseline_from_history(trained([1, 2, 3, 4]), MONDAY).volume == 180

    # Trained in week 4 only, then missed the last three weeks: one week of history is too little,
    # so the conservative default applies. The 180 the plan once assumed is not carried forward.
    missed_recent = baseline_from_history(trained([4]), MONDAY)
    assert missed_recent.used_default and missed_recent.volume == RULES.default_baseline_volume

    # Partly trained: the mean of the weeks that actually had training, not the planned volume.
    partial = trained([4]) + trained([3], volume=20)
    assert baseline_from_history(partial, MONDAY).volume == (180 + 60) / 2

    assert baseline_from_history([], MONDAY).used_default


def test_strava_history_never_shapes_a_baseline():
    """Hard Rule 1 also covers plan calculations: only non-Strava rows count."""
    real = [workout(MONDAY - timedelta(days=7 * w), 30) for w in range(1, 5)]
    strava = [workout(MONDAY - timedelta(days=7 * w + 1), 900, source="strava") for w in range(1, 5)]
    assert baseline_from_history(real + strava, MONDAY) == baseline_from_history(real, MONDAY)


# ------------------------------------------------------------------ targets


def test_targets_progress_and_deload_every_n_weeks():
    targets = weekly_targets(100, 8)
    assert [t.deload for t in targets] == [False, False, False, True, False, False, False, True]
    assert targets[0].volume == 100
    assert targets[1].volume == 105
    assert targets[3].volume < targets[2].volume


def test_week_offset_keeps_the_deload_rhythm_aligned_when_regenerating_the_rest():
    full = weekly_targets(100, 8)
    remaining = weekly_targets(100, 5, week_offset=3)
    assert [t.deload for t in remaining] == [t.deload for t in full][3:]


def test_generated_targets_are_within_the_safe_threshold():
    assert first_unsafe_week(weekly_targets(100, 16)) == -1


def test_unsafe_week_increase_is_rejected_but_deload_rebound_is_not():
    aggressive = TrainingRules(weekly_progression_pct=15.0)
    targets = weekly_targets(100, 6, rules=aggressive)
    assert first_unsafe_week(targets, aggressive) == 1

    normal = weekly_targets(100, 12)
    assert first_unsafe_week(normal) == -1  # the rebound after each deload is fine


# ------------------------------------------------------------------ sessions


def _plan(prefs: TrainingPreferencesInput = STANDARD_PREFS, weeks: int = 8, from_date: date = MONDAY):
    return build_sessions(prefs, MONDAY, weekly_targets(100, weeks), from_date)


def test_sessions_land_only_on_available_days_and_match_days_per_week():
    drafts = _plan()
    assert len(drafts) == 4 * 8
    assert {d.date.weekday() for d in drafts} == {0, 2, 4, 5}  # Mon, Wed, Fri, Sat


def test_two_push_sessions_are_never_on_consecutive_days():
    every_day = TrainingPreferencesInput(
        days_per_week=7, session_duration_min=45, activity_types=["run"], rest_days=[]
    )
    drafts = sorted(_plan(every_day), key=lambda d: d.date)
    pushes = [d.date for d in drafts if d.intensity_band == "push"]
    assert all((b - a).days >= 2 for a, b in zip(pushes, pushes[1:], strict=False))


def test_deload_weeks_are_all_deload_sessions():
    drafts = _plan()
    week4 = [d for d in drafts if MONDAY + timedelta(days=21) <= d.date < MONDAY + timedelta(days=28)]
    assert week4 and {d.intensity_band for d in week4} == {"deload"}


def test_weekly_volume_matches_the_target_within_rounding():
    drafts = _plan(weeks=3)
    week1 = sum(d.target_volume for d in drafts if d.date < MONDAY + timedelta(days=7))
    assert abs(week1 - 100) <= 2


def test_sessions_before_from_date_are_left_out_and_first_week_is_scaled():
    drafts = _plan(from_date=TODAY)  # Wednesday
    assert min(d.date for d in drafts) >= TODAY
    first_week = [d for d in drafts if d.date < MONDAY + timedelta(days=7)]
    assert len(first_week) == 3  # Wed, Fri, Sat
    assert sum(d.target_volume for d in first_week) == pytest.approx(75, abs=2)


def test_only_preferred_activity_types_are_used():
    drafts = _plan(TrainingPreferencesInput(
        days_per_week=3, session_duration_min=30, activity_types=["gym"], rest_days=[]
    ))
    assert {d.activity_type for d in drafts} == {"gym"}


def test_fewer_free_days_than_requested_yields_one_session_per_free_day():
    prefs = TrainingPreferencesInput.model_construct(
        days_per_week=5, session_duration_min=45, activity_types=["run"],
        rest_days=["mon", "tue", "wed", "thu", "fri"],
    )
    per_week = [d for d in _plan(prefs, weeks=1)]
    assert len(per_week) == 2


def test_rescale_for_band_scales_volume_and_duration_down_consistently():
    push = PlannedSession(id="s", plan_id="p", date=TODAY, activity_type="run", target_volume=40,
                          target_duration_min=45, intensity_band="push", status="planned")
    volume, duration = rescale_for_band(push, "light")
    assert volume < 40 and duration < 45
    assert rescale_for_band(push, "push") == (40, 45)


def test_week_start_is_monday():
    assert week_start(date(2026, 10, 4)) == MONDAY  # Sunday
    assert week_start(MONDAY) == MONDAY

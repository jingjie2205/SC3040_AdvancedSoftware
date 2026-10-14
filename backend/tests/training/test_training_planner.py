import random
from datetime import date, datetime, timedelta, timezone

import pytest

from app.training.config import PLAN_NOTICE, RULES, TrainingRules
from app.training.models import PlanAdaptation, PlannedSession, TrainingPlan, TrainingPreferencesInput
from app.training.planner import (
    baseline_from_history,
    build_sessions,
    default_duration_min,
    first_unsafe_week,
    is_deload_week,
    plan_end_date,
    plan_week_target,
    rescale_for_band,
    sessions_per_week,
    share_week,
    week_pool,
    week_start,
    weekly_targets,
    weight_of,
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


# ------------------------------------------------------------------ planning a week by hand


def _plan_of(weeks: int = 8, baseline: float = 100.0, adapted_on: date = None) -> TrainingPlan:
    adaptation = None
    if adapted_on is not None:
        adaptation = PlanAdaptation(trigger="manual", reason="", adapted_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                                    adapted_on=adapted_on)
    return TrainingPlan(id="p", start_date=MONDAY, end_date=plan_end_date(MONDAY, weeks), weeks=weeks, status="active",
                        baseline_volume=baseline, created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                        notice=PLAN_NOTICE, last_adaptation=adaptation)


def _week_totals(drafts, first_monday: date, weeks: int):
    """(Monday, points built, bands built) for each of `weeks` weeks of generated sessions."""
    rows = []
    for w in range(weeks):
        monday = first_monday + timedelta(days=7 * w)
        week = [d for d in drafts if monday <= d.date < monday + timedelta(days=7)]
        rows.append((monday, sum(d.target_volume for d in week), {d.intensity_band for d in week}))
    return rows


def test_the_plans_weekly_target_is_what_the_generator_built_each_week():
    plan = _plan_of(weeks=8, baseline=100)
    drafts = build_sessions(STANDARD_PREFS, MONDAY, weekly_targets(100, 8), MONDAY)
    for monday, built, _ in _week_totals(drafts, MONDAY, 8):
        assert abs(plan_week_target(plan, monday) - built) <= 2, monday


def test_after_an_adaptation_the_weeks_it_rebuilt_follow_its_baseline_and_rhythm():
    third_week = MONDAY + timedelta(days=14)
    adapted = _plan_of(weeks=8, baseline=120, adapted_on=third_week + timedelta(days=2))  # adapted on a Wednesday
    rebuilt = build_sessions(STANDARD_PREFS, third_week, weekly_targets(120, 6, week_offset=2), third_week)
    for monday, built, _ in _week_totals(rebuilt, third_week, 6):
        assert abs(plan_week_target(adapted, monday) - built) <= 2, monday
    assert plan_week_target(adapted, MONDAY) is None  # the weeks before it are history, not something it set
    assert plan_week_target(adapted, MONDAY + timedelta(days=7)) is None


def test_a_week_outside_the_plan_has_no_target():
    plan = _plan_of(weeks=4)
    assert plan_week_target(plan, MONDAY - timedelta(days=7)) is None
    assert plan_week_target(plan, MONDAY + timedelta(days=28)) is None
    assert plan_week_target(plan, MONDAY + timedelta(days=21)) is not None


def test_deload_weeks_are_found_by_their_place_in_the_plan_whether_or_not_it_was_adapted():
    fresh = _plan_of(weeks=8)
    built = build_sessions(STANDARD_PREFS, MONDAY, weekly_targets(100, 8), MONDAY)
    for monday, _, bands in _week_totals(built, MONDAY, 8):
        assert is_deload_week(fresh, monday) == (bands == {"deload"}), monday

    third_week = MONDAY + timedelta(days=14)
    adapted = _plan_of(weeks=8, adapted_on=third_week)
    rebuilt = build_sessions(STANDARD_PREFS, third_week, weekly_targets(100, 6, week_offset=2), third_week)
    for monday, _, bands in _week_totals(rebuilt, third_week, 6):
        assert is_deload_week(adapted, monday) == (bands == {"deload"}), monday


def test_nothing_outside_the_plan_is_a_deload_week():
    plan = _plan_of(weeks=4)
    assert not is_deload_week(plan, MONDAY - timedelta(days=7))
    assert not is_deload_week(plan, MONDAY + timedelta(days=28 + 21))
    assert is_deload_week(plan, MONDAY + timedelta(days=21))


@pytest.mark.parametrize("band,minutes", [("push", 45), ("light", 35), ("deload", 25)])
def test_a_sessions_default_length_is_the_preferred_length_scaled_by_its_intensity(band, minutes):
    assert default_duration_min(45, band) == minutes
    made = [d for d in _plan() if d.intensity_band == band]
    assert made and {d.target_duration_min for d in made} == {minutes}  # exactly what the generator gives it


def test_a_default_length_never_drops_below_the_shortest_session():
    assert default_duration_min(RULES.session_duration_min, "deload") == RULES.session_duration_min


def test_a_sessions_weight_is_its_intensity_times_its_length():
    assert weight_of("push", 45) == 45
    assert weight_of("light", 40) == pytest.approx(28)
    assert weight_of("deload", 30) == pytest.approx(18)


def test_a_session_joining_a_week_takes_its_share_by_weight_and_the_week_still_adds_up():
    share = share_week(100, [("a", 50, 40.0), ("b", 50, 40.0)], new_weight=40.0)
    assert share.new_volume == 33
    assert sorted(share.others.values()) == [33, 34]
    assert share.new_volume + sum(share.others.values()) == 100


def test_the_others_keep_their_proportions_to_one_another():
    share = share_week(90, [("big", 60, 30.0), ("small", 30, 30.0)], new_weight=30.0)
    assert share.new_volume == 30
    assert share.others == {"big": 40, "small": 20}


def test_a_session_alone_in_a_week_carries_all_of_it():
    assert share_week(104, [], new_weight=31.5) == share_week(104, [], new_weight=500.0)
    assert share_week(104, [], new_weight=31.5).new_volume == 104


def test_a_longer_or_harder_session_takes_a_bigger_share():
    others = [("a", 40, 30.0), ("b", 40, 30.0)]
    small = share_week(100, others, new_weight=weight_of("light", 20)).new_volume
    large = share_week(100, others, new_weight=weight_of("push", 60)).new_volume
    assert small < large


def test_sharing_a_week_always_adds_up_exactly_and_never_leaves_a_session_without_a_point():
    rng = random.Random(3040)
    for _ in range(400):
        others = [(f"s{i}", rng.randint(1, 80), rng.uniform(9, 180)) for i in range(rng.randint(0, 6))]
        pool = rng.randint(len(others) + 1, 300)
        share = share_week(pool, others, new_weight=rng.uniform(9, 180))
        volumes = [share.new_volume, *share.others.values()]
        assert sum(volumes) == pool, (pool, others)
        assert min(volumes) >= 1, (pool, others)
        assert set(share.others) == {sid for sid, _, _ in others}


def test_a_very_small_week_still_gives_everyone_a_point():
    share = share_week(4, [("a", 1, 9.0), ("b", 1, 9.0), ("c", 1, 9.0)], new_weight=180.0)
    assert share.new_volume + sum(share.others.values()) == 4
    assert min([share.new_volume, *share.others.values()]) == 1


def test_sharing_is_deterministic():
    others = [("a", 31, 45.0), ("b", 21, 24.5), ("c", 21, 24.5), ("d", 31, 45.0)]
    assert share_week(104, others, 24.5) == share_week(104, others, 24.5)


def test_a_full_week_has_the_days_the_athlete_wants_or_every_free_day_if_fewer():
    assert sessions_per_week(STANDARD_PREFS) == 4
    every_day = TrainingPreferencesInput(days_per_week=7, session_duration_min=45, activity_types=["run"], rest_days=[])
    assert sessions_per_week(every_day) == 7
    few_free = TrainingPreferencesInput.model_construct(
        days_per_week=5, session_duration_min=45, activity_types=["run"], rest_days=["mon", "tue", "wed", "thu", "fri"],
    )
    assert sessions_per_week(few_free) == 2  # only Saturday and Sunday are free
    assert len(_plan(few_free, weeks=1)) == sessions_per_week(few_free)  # and it is what the generator builds


@pytest.mark.parametrize(
    "target,finished,now,after,per_week,expected",
    [
        # nothing planned yet: each session brings a usual share, up to the plan's load
        (100, 0, 0, 1, 4, 25),
        (100, 0, 25, 2, 4, 50),
        (100, 0, 75, 4, 4, 100),
        # beyond the usual number the week only shares what it has
        (100, 0, 100, 5, 4, 100),
        # a week that already holds more than that is never cut down
        (100, 0, 130, 5, 4, 130),
        (100, 0, 90, 2, 4, 90),
        # finished sessions have used up their part of the plan's load
        (100, 40, 60, 4, 4, 60),
        (100, 40, 0, 1, 4, 25),
        (100, 40, 20, 3, 4, 60),  # capped at what the finished ones left
        (100, 100, 0, 1, 4, 0),  # nothing left: the caller refuses
        # a plan week with no target at all
        (0, 0, 0, 1, 4, 0),
    ],
)
def test_the_points_a_week_shares_follow_the_sessions_it_has(target, finished, now, after, per_week, expected):
    assert week_pool(target, finished, now, after, per_week) == expected


def test_a_week_pool_never_goes_below_what_the_week_already_holds_or_above_the_plans_load_unless_it_already_did():
    rng = random.Random(7)
    for _ in range(500):
        target = rng.randint(40, 200)
        finished = rng.randint(0, target)
        now = rng.randint(0, 250)
        pool = week_pool(target, finished, now, rng.randint(1, 9), rng.randint(1, 7))
        assert pool >= now
        assert pool <= max(now, target - finished)

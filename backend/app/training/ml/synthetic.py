"""
A synthetic cohort for training and testing the readiness model.

Features are drawn from plausible, correlated distributions around a shared latent "strain" (heavier
recent load, higher resting heart rate, more tiredness and less sleep tend to go together), with the
missing-data patterns the app actually produces. Each simulated athlete is then labelled by the
Stage 1 rule-based scorer.

That last step is the important caveat: the labels come from the rules, not from measured readiness.
A model trained on this learns to reproduce the rules. See README.md in this folder.
"""
from typing import Tuple

import numpy as np

from ..config import READINESS_RULES, ReadinessRules
from ..readiness import ReadinessFeatures, RuleBasedScorer
from .features import FEATURE_ORDER

# Share of simulated athletes in each data-availability pattern. "Today" is a user who has only logged
# workouts: no check-in, no sleep entry and no exam date. Every signal is optional in the app.
_SCENARIO_WEIGHTS = (0.25, 0.25, 0.15, 0.32, 0.03)  # today, most signals, all signals, random, nothing
_WIDE_SHARE = 0.08  # rows redrawn uniformly over the full range, so the extremes are covered


def generate_raw(n: int, rng: np.random.Generator) -> np.ndarray:
    """(n, 5) in FEATURE_ORDER, NaN where a signal is missing."""
    strain = rng.normal(size=n)
    acwr = np.clip(np.exp(rng.normal(0.03 + 0.22 * strain, 0.22)), 0.2, 2.6)
    hr_trend = np.clip(rng.normal(0.8 + 3.5 * strain, 3.5), -15.0, 20.0)
    rating = np.clip(np.round(3.0 + 1.1 * strain + rng.normal(0.0, 0.8, n)), 1, 5)
    sleep = np.clip(rng.normal(7.2 - 0.5 * strain, 1.1), 2.5, 11.0)
    exam = np.where(rng.random(n) < 0.5, rng.integers(0, 8, n), rng.integers(8, 61, n)).astype(float)

    wide = rng.random(n) < _WIDE_SHARE
    acwr = np.where(wide, rng.uniform(0.0, 3.0, n), acwr)
    hr_trend = np.where(wide, rng.uniform(-15.0, 15.0, n), hr_trend)
    rating = np.where(wide, rng.integers(1, 6, n), rating)
    sleep = np.where(wide, rng.uniform(0.0, 12.0, n), sleep)
    exam = np.where(wide, rng.integers(0, 31, n), exam)

    raw = np.column_stack([acwr, hr_trend, rating, sleep, exam])
    return np.where(_availability(n, rng), raw, np.nan)


def _availability(n: int, rng: np.random.Generator) -> np.ndarray:
    scenario = rng.choice(len(_SCENARIO_WEIGHTS), size=n, p=_SCENARIO_WEIGHTS)
    chance = rng.random((n, len(FEATURE_ORDER)))
    present = np.zeros((n, len(FEATURE_ORDER)), dtype=bool)
    # columns: acwr, hr_trend_delta, checkin, sleep, exam
    odds = {
        0: (0.85, 0.75, 0.0, 0.0, 0.0),
        1: (0.92, 0.92, 0.92, 0.92, 0.0),
        2: (1.0, 1.0, 1.0, 1.0, 0.5),
        3: (0.55, 0.55, 0.55, 0.55, 0.55),
        4: (0.0, 0.0, 0.0, 0.0, 0.0),
    }
    for index, probabilities in odds.items():
        rows = scenario == index
        present[rows] = chance[rows] < np.array(probabilities)
    return present


def label_with_rules(raw: np.ndarray, rules: ReadinessRules = READINESS_RULES) -> np.ndarray:
    """The teacher: what the Stage 1 scorer says for each row (an integer 0 to 100)."""
    scorer = RuleBasedScorer(rules)
    scores = np.empty(len(raw))
    for i, row in enumerate(raw):
        acwr, hr, rating, sleep, exam = row
        features = ReadinessFeatures(
            acwr=None if np.isnan(acwr) else float(acwr),
            hr_trend_delta=None if np.isnan(hr) else float(hr),
            checkin_load_rating=None if np.isnan(rating) else int(rating),
            sleep_hours=None if np.isnan(sleep) else float(sleep),
            days_until_exam=None if np.isnan(exam) else int(exam),
        )
        scores[i] = scorer.score(features).score
    return scores


def generate_cohort(
    n: int, seed: int, rules: ReadinessRules = READINESS_RULES
) -> Tuple[np.ndarray, np.ndarray]:
    raw = generate_raw(n, np.random.default_rng(seed))
    return raw, label_with_rules(raw, rules)

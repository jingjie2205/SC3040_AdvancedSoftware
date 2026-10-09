"""
How a `ReadinessFeatures` becomes the numbers the network sees.

Each of the five signals becomes two inputs: whether it is present, and its value scaled to [-1, 1]
(0 when missing). Missing is a normal state here (new users have no history, and check-ins, sleep and
exam dates are all optional), so the network is trained on it and never has to guess a value.

Values are clipped to the range the network was trained on. The rules saturate beyond these bounds
anyway, so clipping never changes what the rules would say.
"""
from typing import Tuple

import numpy as np

from ..readiness import ReadinessFeatures

# Bump when the encoding changes. An artifact trained on another version is refused at load.
FEATURE_SCHEMA_VERSION = 1

FEATURE_ORDER: Tuple[str, ...] = (
    "acwr",
    "hr_trend_delta",
    "checkin_load_rating",
    "sleep_hours",
    "days_until_exam",
)
INPUT_DIM = 2 * len(FEATURE_ORDER)

# The ReadinessFactor.key the rule scorer uses for each signal, in FEATURE_ORDER.
FACTOR_KEYS: Tuple[str, ...] = ("load", "hr_trend", "checkin", "sleep", "exam")

# (low, high) each signal is clipped to, then mapped onto [-1, 1].
_BOUNDS = {
    "acwr": (0.0, 3.0),
    "hr_trend_delta": (-15.0, 15.0),
    "checkin_load_rating": (1.0, 5.0),
    "sleep_hours": (0.0, 12.0),
    "days_until_exam": (0.0, 30.0),
}


def encode(raw: np.ndarray) -> np.ndarray:
    """`raw` is (n, 5) in FEATURE_ORDER with NaN for a missing signal. Returns (n, 10)."""
    raw = np.asarray(raw, dtype=float)
    present = ~np.isnan(raw)
    out = np.zeros((raw.shape[0], INPUT_DIM))
    for i, name in enumerate(FEATURE_ORDER):
        low, high = _BOUNDS[name]
        clipped = np.clip(np.where(present[:, i], raw[:, i], low), low, high)
        out[:, 2 * i] = present[:, i]
        out[:, 2 * i + 1] = np.where(present[:, i], 2.0 * (clipped - low) / (high - low) - 1.0, 0.0)
    return out


def raw_row(features: ReadinessFeatures) -> np.ndarray:
    values = [getattr(features, name) for name in FEATURE_ORDER]
    return np.array([np.nan if v is None else float(v) for v in values])


def vectorize(features: ReadinessFeatures) -> np.ndarray:
    return encode(raw_row(features)[None, :])[0]


def present_signals(features: ReadinessFeatures) -> Tuple[bool, ...]:
    return tuple(getattr(features, name) is not None for name in FEATURE_ORDER)

"""
Train the readiness model and write the artifact.

    cd backend
    python -m app.training.ml.train                       # synthetic cohort, labelled by the rules
    python -m app.training.ml.train --data labelled.csv   # real labelled data, see README.md

Never train on data that came from the Strava API (Hard Rule 1): the model would then be an AI
feature built on Strava data.
"""
import argparse
import csv
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from pydantic import ValidationError

from ..config import READINESS_RULES, ReadinessRules
from ..readiness import ReadinessFeatures, RuleBasedScorer
from .artifact import ARTIFACT_PATH, rules_fingerprint, write_artifact
from .features import FEATURE_ORDER, FEATURE_SCHEMA_VERSION, INPUT_DIM, encode
from .network import MLP
from .synthetic import generate_cohort

DEFAULT_SAMPLES = 80_000
DEFAULT_SEED = 7
DEFAULT_HIDDEN = (32, 16)
LABEL_NOISE_SD = 1.5  # points; blurs the synthetic labels a little, as real labels would be
LABEL_COLUMN = "readiness_score"


def _bands(scores: np.ndarray, rules: ReadinessRules) -> np.ndarray:
    return np.where(scores >= rules.push_min_score, 2, np.where(scores >= rules.light_min_score, 1, 0))


def predict_scores(network: MLP, raw: np.ndarray) -> np.ndarray:
    return np.clip(np.round(100.0 * network.forward(encode(raw))), 0, 100)


def evaluate(network: MLP, raw: np.ndarray, scores: np.ndarray, rules: ReadinessRules) -> Dict[str, float]:
    predicted = predict_scores(network, raw)
    error = predicted - scores
    variance = float(np.sum((scores - scores.mean()) ** 2))
    return {
        "mae_points": round(float(np.mean(np.abs(error))), 4),
        "rmse_points": round(float(np.sqrt(np.mean(error**2))), 4),
        "max_abs_error_points": float(np.max(np.abs(error))),
        "within_3_points": round(float(np.mean(np.abs(error) <= 3)), 4),
        "r2": round(1.0 - float(np.sum(error**2)) / variance, 4) if variance else 0.0,
        "class_agreement": round(float(np.mean(_bands(predicted, rules) == _bands(scores, rules))), 4),
        "test_samples": float(len(scores)),
    }


def load_labelled_csv(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    """
    Columns: acwr, hr_trend_delta, checkin_load_rating, sleep_hours, days_until_exam (any may be left
    empty for "missing") and readiness_score (0 to 100). Rows are checked against the same limits the
    API enforces.
    """
    raw_rows: List[List[float]] = []
    scores: List[float] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in (*FEATURE_ORDER, LABEL_COLUMN) if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path.name} is missing columns: {', '.join(missing)}")
        for number, row in enumerate(reader, start=2):
            try:
                values = {name: (float(row[name]) if row[name].strip() else None) for name in FEATURE_ORDER}
                label = float(row[LABEL_COLUMN])
                ReadinessFeatures(**values)  # same limits as the API; rejects e.g. a rating of 3.5
            except (ValueError, ValidationError) as error:
                raise ValueError(f"{path.name} line {number}: {error}") from error
            if not 0 <= label <= 100:
                raise ValueError(f"{path.name} line {number}: {LABEL_COLUMN} must be between 0 and 100")
            raw_rows.append([np.nan if values[name] is None else values[name] for name in FEATURE_ORDER])
            scores.append(label)
    if len(scores) < 50:
        raise ValueError(f"{path.name} has only {len(scores)} rows; that is too few to train on")
    return np.array(raw_rows, dtype=float), np.array(scores)


def train(
    *,
    n_samples: int = DEFAULT_SAMPLES,
    seed: int = DEFAULT_SEED,
    version: str = "mlp-v1",
    hidden: Sequence[int] = DEFAULT_HIDDEN,
    epochs: int = 200,
    rules: ReadinessRules = READINESS_RULES,
    data_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Returns the artifact (a JSON-ready dict). Same arguments, same artifact."""
    rng = np.random.default_rng(seed)
    if data_path is None:
        raw, scores = generate_cohort(n_samples, seed, rules)
        trained_on = (
            f"synthetic cohort of {n_samples:,} simulated athletes (seed {seed}), "
            f"labelled by the {RuleBasedScorer.version} rule-based scorer"
        )
        teacher: Optional[Dict[str, str]] = {"scorer": RuleBasedScorer.version, "rules_hash": rules_fingerprint(rules)}
        label_noise = LABEL_NOISE_SD
    else:
        raw, scores = load_labelled_csv(data_path)
        trained_on = f"labelled data from {data_path.name} ({len(scores):,} rows)"
        teacher, label_noise = None, 0.0

    n = len(scores)
    order = rng.permutation(n)
    n_train, n_val = int(0.70 * n), int(0.15 * n)
    train_idx, val_idx, test_idx = np.split(order, [n_train, n_train + n_val])

    noisy = np.clip(scores[train_idx] + rng.normal(0.0, label_noise, len(train_idx)), 0, 100)
    network = MLP.init([INPUT_DIM, *hidden, 1], rng)
    history = network.fit(
        encode(raw[train_idx]),
        noisy / 100.0,
        encode(raw[val_idx]),
        scores[val_idx] / 100.0,
        rng=rng,
        epochs=epochs,
    )

    return {
        "version": version,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "input_dim": INPUT_DIM,
        "output": "readiness score divided by 100",
        "trained_on": trained_on,
        "teacher": teacher,
        "training": {
            "seed": seed,
            "rows": {"train": len(train_idx), "validation": len(val_idx), "test": len(test_idx)},
            "label_noise_sd_points": label_noise,
            "hidden_layers": list(hidden),
            "epochs_run": history["epochs_run"],
            "best_epoch": history["best_epoch"],
        },
        "metrics": evaluate(network, raw[test_idx], scores[test_idx], rules),
        "network": network.to_dict(),
    }


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Train the readiness model.")
    parser.add_argument("--data", type=Path, help="labelled CSV to train on instead of the synthetic cohort")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="synthetic cohort size")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--version", default="mlp-v1")
    parser.add_argument("--out", type=Path, default=ARTIFACT_PATH)
    args = parser.parse_args(argv)

    artifact = train(n_samples=args.samples, seed=args.seed, version=args.version, data_path=args.data)
    write_artifact(artifact, args.out)

    print(f"Trained on: {artifact['trained_on']}")
    print(f"Wrote {args.out}")
    for name, value in artifact["metrics"].items():
        print(f"  {name:>22}: {value}")


if __name__ == "__main__":
    main()

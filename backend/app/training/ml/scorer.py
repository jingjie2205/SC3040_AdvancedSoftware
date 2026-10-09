"""
The model as a `ReadinessScorer`, and the logic that decides whether to use it at all.

`load_scorer()` returns the trained model when its file is present, valid, and was labelled with the
rules that are currently configured. In every other case it returns the rule-based scorer and records
why, so the page never loses its readiness score and QA changing a threshold still has an effect.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

from ..config import READINESS_RULES, ReadinessRules
from ..models import ModelInfo, ReadinessFactor, ScoreResult
from ..readiness import (
    Contribution,
    ReadinessFeatures,
    ReadinessScorer,
    RuleBasedScorer,
    impact_for,
    classify,
    explain,
    no_data_factor,
)
from .artifact import ARTIFACT_PATH, read_artifact, rules_fingerprint
from .features import FACTOR_KEYS, encode, present_signals, raw_row
from .network import MLP

logger = logging.getLogger(__name__)

_INFO_METRICS = ("mae_points", "r2", "class_agreement", "within_3_points")


class ModelScorer:
    """Scores with the trained network and explains with the rule scorer's wording."""

    def __init__(self, network: MLP, artifact: Dict[str, Any], rules: ReadinessRules = READINESS_RULES) -> None:
        self.network = network
        self.artifact = artifact
        self.rules = rules
        self.version = str(artifact["version"])
        self._wording = RuleBasedScorer(rules)

    def info(self) -> ModelInfo:
        metrics = self.artifact.get("metrics", {})
        return ModelInfo(
            kind="model",
            version=self.version,
            description=(
                "Small neural network. It reproduces the rule-based scorer from data and was not "
                "trained on measured readiness, so it is no more accurate than the rules."
            ),
            trained_on=str(self.artifact["trained_on"]),
            metrics={k: float(metrics[k]) for k in _INFO_METRICS if k in metrics},
        )

    def score(self, features: ReadinessFeatures) -> ScoreResult:
        if not any(present_signals(features)):
            return self._wording.score(features)  # nothing to model; the rules' "not enough data" answer

        present = present_signals(features)
        x = encode(raw_row(features)[None, :])
        # Row 0 is the full input. Row i + 1 is the same input with signal i hidden, so the drop in
        # score is that signal's contribution (occlusion), which is what the page shows as "driving".
        variants = [x[0]]
        hidden_index: List[int] = []
        for i, is_present in enumerate(present):
            if is_present:
                hidden = x[0].copy()
                hidden[2 * i] = hidden[2 * i + 1] = 0.0
                variants.append(hidden)
                hidden_index.append(i)
        outputs = 100.0 * self.network.forward(np.array(variants))
        full = float(outputs[0])
        score = int(max(0, min(100, round(full))))
        impact = {FACTOR_KEYS[i]: full - float(outputs[n + 1]) for n, i in enumerate(hidden_index)}

        contributions = [
            Contribution(
                delta=impact.get(c.factor.key, 0.0),
                factor=ReadinessFactor(
                    key=c.factor.key,
                    label=c.factor.label,
                    impact=impact_for(impact.get(c.factor.key, 0.0)),
                    detail=c.factor.detail,
                ),
            )
            for c in self._wording.contributions(features)
        ]
        ranked = sorted(contributions, key=lambda c: abs(c.delta), reverse=True)
        classification = classify(score, self.rules)
        return ScoreResult(
            score=score,
            classification=classification,
            factors=[c.factor for c in ranked[: self.rules.max_factors_shown]] or [no_data_factor()],
            explanation=explain(classification, ranked),
        )


def load_scorer(rules: ReadinessRules = READINESS_RULES, path: Path = ARTIFACT_PATH) -> ReadinessScorer:
    if not rules.use_trained_model:
        return RuleBasedScorer(rules, fallback_reason="The trained model is switched off in the config.")
    try:
        network, artifact = read_artifact(path)
        teacher = artifact.get("teacher")
        if teacher and teacher.get("rules_hash") != rules_fingerprint(rules):
            raise ValueError(
                "the readiness rules have changed since the model was trained; "
                "retrain it with `python -m app.training.ml.train`"
            )
    except (OSError, ValueError) as error:
        reason = f"The trained model isn't being used: {error}."
        logger.warning(reason)
        return RuleBasedScorer(rules, fallback_reason=reason)
    logger.info("Readiness is scored by the trained model %s", artifact["version"])
    return ModelScorer(network, artifact, rules)

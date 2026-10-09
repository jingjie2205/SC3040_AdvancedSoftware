"""
The trained model as a JSON file: the network weights plus everything needed to know what it is.
"""
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Tuple

from ..config import ReadinessRules
from .features import FEATURE_SCHEMA_VERSION, INPUT_DIM
from .network import MLP

ARTIFACT_PATH = Path(__file__).parent / "artifacts" / "readiness_v1.json"


def rules_fingerprint(rules: ReadinessRules) -> str:
    """Identifies the rule settings a model was labelled with, so a change to them is noticed."""
    return hashlib.sha256(json.dumps(asdict(rules), sort_keys=True).encode()).hexdigest()[:16]


def write_artifact(artifact: Dict[str, Any], path: Path = ARTIFACT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(artifact, indent=1) + "\n", encoding="utf-8")


def read_artifact(path: Path = ARTIFACT_PATH) -> Tuple[MLP, Dict[str, Any]]:
    """Load and validate. Raises ValueError (or OSError for a missing file) if it can't be trusted."""
    try:
        artifact = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"model file is not valid JSON: {error}") from error
    if not isinstance(artifact, dict):
        raise ValueError("model file has the wrong shape")
    if artifact.get("feature_schema_version") != FEATURE_SCHEMA_VERSION or artifact.get("input_dim") != INPUT_DIM:
        raise ValueError(
            "model was trained on a different feature encoding "
            f"(file: {artifact.get('feature_schema_version')}, code: {FEATURE_SCHEMA_VERSION})"
        )
    for key in ("version", "trained_on", "metrics", "network"):
        if key not in artifact:
            raise ValueError(f"model file is missing '{key}'")
    network = MLP.from_dict(artifact["network"])
    if network.sizes[0] != INPUT_DIM:
        raise ValueError("model expects a different number of inputs")
    return network, artifact

"""
The Stage 2 readiness model: encoding, the network, training, the shipped artifact, the scorer and
its fallbacks. The artifact tests run against fresh data the model has never seen.
"""
import csv
import json
from dataclasses import replace
from datetime import timedelta

import numpy as np
import pytest

from app.training.config import READINESS_RULES
from app.training.ml.artifact import ARTIFACT_PATH, read_artifact, rules_fingerprint
from app.training.ml.features import FEATURE_ORDER, INPUT_DIM, encode, vectorize
from app.training.ml.network import MLP
from app.training.ml.scorer import ModelScorer, load_scorer
from app.training.ml.synthetic import generate_cohort
from app.training.ml.train import predict_scores, train
from app.training.models import ModelInfo, ScoreResult
from app.training.readiness import ReadinessFeatures, RuleBasedScorer, classify, no_data_factor
from app.training.service import TrainingService
from training_fakes import TODAY, USER_A, FakeTrainingRepository, seed_history, workout

FRESH_SEED = 424242  # never used to train the shipped model


@pytest.fixture(scope="module")
def shipped() -> ModelScorer:
    scorer = load_scorer()
    assert isinstance(scorer, ModelScorer), "the shipped model should load; retrain it if the rules changed"
    return scorer


def features(**values) -> ReadinessFeatures:
    return ReadinessFeatures(**values)


# ------------------------------------------------------------------ encoding


def test_each_signal_becomes_a_presence_flag_and_a_scaled_value():
    x = vectorize(features(acwr=1.5, sleep_hours=6.0))
    assert x.shape == (INPUT_DIM,)
    flags = x[0::2]
    assert list(flags) == [1, 0, 0, 1, 0]
    assert x[1] == 0.0  # acwr 1.5 is the middle of 0..3
    assert x[3] == x[5] == x[9] == 0.0  # missing signals contribute nothing but their flag


def test_values_are_clipped_to_the_trained_range_so_api_extremes_cannot_blow_up():
    extreme = vectorize(features(acwr=10, hr_trend_delta=60, checkin_load_rating=5, sleep_hours=24, days_until_exam=365))
    assert np.all(np.abs(extreme) <= 1.0)
    low = vectorize(features(acwr=0, hr_trend_delta=-60, checkin_load_rating=1, sleep_hours=0, days_until_exam=0))
    assert np.all(np.abs(low) <= 1.0)


def test_encoding_a_batch_matches_encoding_one_row_at_a_time():
    raw, _ = generate_cohort(50, seed=1)
    batch = encode(raw)
    one_by_one = np.array([encode(row[None, :])[0] for row in raw])
    assert np.array_equal(batch, one_by_one)


# ------------------------------------------------------------------ network


def test_backprop_matches_finite_differences():
    rng = np.random.default_rng(0)
    net = MLP.init([3, 5, 4, 1], rng)
    x, y = rng.normal(size=(8, 3)), rng.normal(size=8)
    analytic = net._gradients(x, y, 0.0)

    def loss() -> float:
        return float(np.mean((net.forward(x) - y) ** 2))

    for param, grad in zip(net.weights + net.biases, analytic):
        for index in np.ndindex(param.shape):
            original = param[index]
            param[index] = original + 1e-6
            up = loss()
            param[index] = original - 1e-6
            down = loss()
            param[index] = original
            assert grad[index] == pytest.approx((up - down) / 2e-6, abs=1e-5)


def test_a_network_survives_a_round_trip_through_json_unchanged():
    net = MLP.init([INPUT_DIM, 8, 1], np.random.default_rng(1))
    x = encode(generate_cohort(20, seed=2)[0])
    restored = MLP.from_dict(json.loads(json.dumps(net.to_dict())))
    assert np.array_equal(net.forward(x), restored.forward(x))


@pytest.mark.parametrize("damage", [
    lambda d: d.update(sizes=[INPUT_DIM, 4, 2]),  # output must be a single score
    lambda d: d["weights"][0].pop(),  # wrong shape
    lambda d: d["biases"].pop(),
    lambda d: d["weights"][0][0].__setitem__(0, float("nan")),
    lambda d: d.pop("weights"),
])
def test_a_malformed_network_is_refused(damage):
    data = MLP.init([INPUT_DIM, 4, 1], np.random.default_rng(2)).to_dict()
    damage(data)
    with pytest.raises(ValueError):
        MLP.from_dict(data)


# ------------------------------------------------------------------ training


def test_training_is_reproducible_and_depends_on_the_seed():
    first = train(n_samples=1500, seed=3, epochs=3)
    again = train(n_samples=1500, seed=3, epochs=3)
    other = train(n_samples=1500, seed=4, epochs=3)
    assert first == again
    assert first["network"] != other["network"]


def test_a_cohort_of_a_given_seed_is_always_the_same_and_includes_missing_signals():
    raw, scores = generate_cohort(400, seed=9)
    raw_again, scores_again = generate_cohort(400, seed=9)
    assert np.array_equal(raw, raw_again, equal_nan=True) and np.array_equal(scores, scores_again)
    assert np.isnan(raw).any(axis=0).all(), "every signal should be missing in some rows"
    assert np.isnan(raw).all(axis=1).any(), "some rows should have no signals at all"
    assert ((scores >= 0) & (scores <= 100)).all()


def test_training_on_labelled_csv_records_that_it_was_not_labelled_by_the_rules(tmp_path):
    raw, scores = generate_cohort(300, seed=5)
    path = tmp_path / "labelled.csv"
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([*FEATURE_ORDER, "readiness_score"])
        for row, score in zip(raw, scores):
            writer.writerow(["" if np.isnan(v) else v for v in row] + [score])
    artifact = train(data_path=path, seed=1, epochs=3)
    assert artifact["teacher"] is None
    assert "labelled.csv" in artifact["trained_on"] and "synthetic" not in artifact["trained_on"]


@pytest.mark.parametrize("header,row,message", [
    ("acwr,hr_trend_delta,checkin_load_rating,sleep_hours,days_until_exam", "1,0,3,7,", "readiness_score"),
    ("acwr,hr_trend_delta,checkin_load_rating,sleep_hours,days_until_exam,readiness_score", "1,0,3.5,7,,70", "line 2"),
    ("acwr,hr_trend_delta,checkin_load_rating,sleep_hours,days_until_exam,readiness_score", "1,0,3,7,,120", "between 0 and 100"),
    ("acwr,hr_trend_delta,checkin_load_rating,sleep_hours,days_until_exam,readiness_score", "1,0,3,7,,70", "too few"),
])
def test_bad_training_data_is_rejected_with_the_reason(tmp_path, header, row, message):
    path = tmp_path / "bad.csv"
    path.write_text(f"{header}\n{row}\n", encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        train(data_path=path, epochs=1)


# ------------------------------------------------------------------ the shipped artifact


def test_the_shipped_model_records_how_it_was_made_and_what_it_was_labelled_with():
    _, artifact = read_artifact()
    assert "synthetic" in artifact["trained_on"]
    assert artifact["teacher"]["rules_hash"] == rules_fingerprint(READINESS_RULES), (
        "the readiness rules changed after the model was trained; run `python -m app.training.ml.train`"
    )


def test_the_shipped_model_reproduces_the_rules_on_data_it_never_saw():
    network, _ = read_artifact()
    raw, truth = generate_cohort(5000, seed=FRESH_SEED)
    predicted = predict_scores(network, raw)
    error = predicted - truth
    assert np.abs(error).mean() <= 1.0
    assert np.abs(error).max() <= 8
    assert abs(error.mean()) <= 0.3, "the model should not lean one way"

    bands = lambda s: np.where(s >= READINESS_RULES.push_min_score, 2, np.where(s >= READINESS_RULES.light_min_score, 1, 0))
    assert (bands(predicted) == bands(truth)).mean() >= 0.98
    assert not (np.abs(bands(predicted) - bands(truth)) == 2).any(), "never a push-versus-deload disagreement"


def test_a_better_input_never_lowers_the_score_by_more_than_rounding(shipped):
    contexts = [
        dict(acwr=1.0, hr_trend_delta=1.0, checkin_load_rating=3, sleep_hours=7.0),
        dict(acwr=1.5, hr_trend_delta=1.0, checkin_load_rating=3, sleep_hours=7.0),
        dict(acwr=0.6, hr_trend_delta=1.0, checkin_load_rating=3, sleep_hours=7.0),
        dict(acwr=1.0, hr_trend_delta=6.0, checkin_load_rating=4, sleep_hours=5.0),
    ]
    sweeps = [  # (signal, values from worse to better)
        ("sleep_hours", [3, 4, 5, 6, 7, 8, 9]),
        ("checkin_load_rating", [5, 4, 3, 2, 1]),
        ("hr_trend_delta", list(np.arange(14, -10, -1.0))),
    ]
    for context in contexts:
        for signal, worse_to_better in sweeps:
            base = {k: v for k, v in context.items() if k != signal}
            scores = [shipped.score(features(**base, **{signal: value})).score for value in worse_to_better]
            assert all(later >= earlier - 1 for earlier, later in zip(scores, scores[1:])), (context, signal, scores)

    for context in contexts:  # load above the productive range: more load is never better
        base = {k: v for k, v in context.items() if k != "acwr"}
        scores = [shipped.score(features(**base, acwr=a)).score for a in np.arange(1.35, 2.6, 0.1)]
        assert all(later <= earlier + 1 for earlier, later in zip(scores, scores[1:])), (context, scores)


# ------------------------------------------------------------------ scoring and explanations


def test_the_same_features_always_give_the_same_result(shipped):
    f = features(acwr=1.4, hr_trend_delta=5, checkin_load_rating=4, sleep_hours=5.5)
    assert shipped.score(f) == shipped.score(f.model_copy())


def test_extreme_inputs_stay_inside_zero_to_one_hundred(shipped):
    worst = shipped.score(features(acwr=10, hr_trend_delta=60, checkin_load_rating=5, sleep_hours=0, days_until_exam=0))
    best = shipped.score(features(acwr=1.0, hr_trend_delta=-60, checkin_load_rating=1, sleep_hours=24))
    assert 0 <= worst.score < best.score <= 100
    assert worst.classification == "deload"


def test_with_no_signals_the_answer_is_exactly_the_rule_scorers(shipped):
    assert shipped.score(ReadinessFeatures()) == RuleBasedScorer().score(ReadinessFeatures())


def test_an_exam_date_outside_the_rules_window_alone_is_not_enough_data(shipped):
    result = shipped.score(features(days_until_exam=20))
    assert result.factors == [no_data_factor()]


def test_factors_only_name_signals_that_were_given_and_are_ranked_and_capped(shipped):
    result = shipped.score(features(acwr=1.8, sleep_hours=4.0, checkin_load_rating=5))
    keys = [f.key for f in result.factors]
    assert set(keys) <= {"load", "sleep", "checkin"}
    assert len(result.factors) <= READINESS_RULES.max_factors_shown
    assert result.explanation


def test_the_signal_that_is_hurting_most_is_named_first_and_marked_negative(shipped):
    result = shipped.score(features(acwr=1.0, hr_trend_delta=0, sleep_hours=3.5))
    assert result.factors[0].key == "sleep" and result.factors[0].impact == "negative"


def test_the_classification_always_follows_the_score_by_the_configured_thresholds(shipped):
    raw, _ = generate_cohort(300, seed=FRESH_SEED)
    for row in raw:
        f = ReadinessFeatures(**{
            name: None if np.isnan(v) else (int(v) if name in ("checkin_load_rating", "days_until_exam") else float(v))
            for name, v in zip(FEATURE_ORDER, row)
        })
        result = shipped.score(f)
        assert result.classification == classify(result.score)


def test_model_info_says_what_it_is_and_does_not_oversell(shipped):
    info = shipped.info()
    assert info.kind == "model" and info.version == "mlp-v1"
    assert "synthetic" in info.trained_on
    assert "no more accurate than the rules" in info.description
    assert info.fallback_reason is None and info.metrics["mae_points"] < 1.0


# ------------------------------------------------------------------ choosing the scorer, and falling back


def _copy_artifact(tmp_path, change=None):
    data = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
    if change:
        change(data)
    path = tmp_path / "model.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_a_good_model_file_is_used(tmp_path):
    assert isinstance(load_scorer(path=_copy_artifact(tmp_path)), ModelScorer)


def test_when_the_model_is_switched_off_the_rules_run_and_say_why():
    scorer = load_scorer(replace(READINESS_RULES, use_trained_model=False))
    assert isinstance(scorer, RuleBasedScorer) and "switched off" in scorer.info().fallback_reason


def test_a_missing_model_file_falls_back_to_the_rules(tmp_path):
    scorer = load_scorer(path=tmp_path / "nope.json")
    assert isinstance(scorer, RuleBasedScorer) and scorer.info().fallback_reason


@pytest.mark.parametrize("damage", [
    lambda d: d.update(feature_schema_version=999),
    lambda d: d["network"]["weights"][0][0].__setitem__(0, float("nan")),
    lambda d: d.pop("metrics"),
    lambda d: d["network"].update(sizes=[3, 1]),
])
def test_a_damaged_or_incompatible_model_file_falls_back_to_the_rules(tmp_path, damage):
    scorer = load_scorer(path=_copy_artifact(tmp_path, damage))
    assert isinstance(scorer, RuleBasedScorer) and scorer.info().fallback_reason


def test_a_corrupt_model_file_falls_back_to_the_rules(tmp_path):
    path = tmp_path / "model.json"
    path.write_text("{not json", encoding="utf-8")
    assert isinstance(load_scorer(path=path), RuleBasedScorer)


def test_changing_a_readiness_rule_makes_the_rules_win_so_the_change_takes_effect():
    tweaked = replace(READINESS_RULES, push_min_score=75)
    scorer = load_scorer(tweaked)
    assert isinstance(scorer, RuleBasedScorer)
    assert "rules have changed" in scorer.info().fallback_reason
    borderline = features(acwr=1.0, sleep_hours=5.5)  # 72 points: push by default, light once push needs 75
    assert RuleBasedScorer().score(borderline).classification == "push"
    assert scorer.score(borderline).classification == "light"


def test_a_model_trained_on_real_labels_is_not_tied_to_the_rules(tmp_path):
    scorer = load_scorer(replace(READINESS_RULES, push_min_score=75), _copy_artifact(tmp_path, lambda d: d.update(teacher=None)))
    assert isinstance(scorer, ModelScorer)


# ------------------------------------------------------------------ inside the service


class FixedScorer:
    def __init__(self, version: str, score: int) -> None:
        self.version, self.fixed = version, score

    def info(self) -> ModelInfo:
        return ModelInfo(kind="rules", version=self.version, description="fixed")

    def score(self, _features: ReadinessFeatures) -> ScoreResult:
        return ScoreResult(
            score=self.fixed, classification=classify(self.fixed), factors=[no_data_factor()], explanation="fixed"
        )


def test_switching_scorer_recomputes_instead_of_serving_the_old_scorers_answer():
    repo = FakeTrainingRepository()
    first = TrainingService(repo, FixedScorer("old-v1", 60)).get_today(USER_A, TODAY).readiness
    new_service = TrainingService(repo, FixedScorer("new-v1", 85))
    second = new_service.get_today(USER_A, TODAY).readiness
    assert (first.score, second.score) == (60, 85)
    assert new_service.get_today(USER_A, TODAY).readiness.computed_at == second.computed_at  # same scorer: cached


def test_hard_rule_1_a_strava_row_cannot_move_the_trained_models_score():
    repo = FakeTrainingRepository()
    monday = TODAY - timedelta(days=TODAY.weekday())
    seed_history(repo, USER_A, monday)
    for d in range(1, 25, 2):  # manual sessions with heart rate in both windows, so that signal exists
        w = workout(TODAY - timedelta(days=d), 30, avg_hr=150, wid=f"manual-{d}")
        repo.workouts[w.id] = (USER_A, w)
    service = TrainingService(repo, load_scorer())
    assert isinstance(service.scorer, ModelScorer)
    baseline = service.get_today(USER_A, TODAY).readiness.score

    def with_extra(source: str) -> int:
        repo.readiness.clear()
        for d in range(1, 8):
            w = workout(TODAY - timedelta(days=d), 900, avg_hr=195, source=source, wid=f"{source}-extra-{d}")
            repo.workouts[w.id] = (USER_A, w)
        score = service.get_today(USER_A, TODAY).readiness.score
        for d in range(1, 8):
            repo.workouts.pop(f"{source}-extra-{d}")
        return score

    assert with_extra("strava") == baseline
    assert with_extra("manual") != baseline, "the test must be able to see a leak if there were one"

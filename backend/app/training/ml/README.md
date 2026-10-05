# Readiness model (Stage 2)

A small neural network that scores daily readiness behind the same `ReadinessScorer` interface as
the rule-based scorer. It runs inside the FastAPI service, in plain numpy, and falls back to the
rules whenever it can't be used.

## What it is, and what it is not

Read this before describing the model in the report or in the presentation.

- **It was trained on a synthetic cohort labelled by the rule-based scorer.** 80,000 simulated
  athletes are generated, each is scored by the Stage 1 rules, and the network learns to reproduce
  those scores. It is a distilled copy of the rules.
- **It is not trained on measured readiness, and it knows nothing the rules don't.** On the same
  inputs it gives the same answer as the rules, to within about half a point. It is no more
  accurate than the rules, because the rules are what it was trained to imitate.
- **It is not trained on public datasets.** The Kaggle gym-members and heart-rate-recovery datasets
  have no readiness labels, so they cannot supervise this score. (`CLAUDE.md` describes Stage 2 as
  trained on public data; this is a deliberate departure from that, for this reason.)
- **What it does provide:** a real training pipeline (data generation, split, training, held-out
  evaluation), a versioned artifact, in-process serving, per-factor explanations, a safe fallback,
  and a one-command path to retrain on real labelled data once it exists.

Suggested wording: *"The Stage 2 readiness model is a small neural network trained on a synthetic
cohort labelled by our rule-based scorer. It reproduces the rules smoothly and is wired in with a
rule-based fallback; it is designed to be retrained on real labelled data when we have it."*

## How it works

- **Inputs.** The five signals in `ReadinessFeatures` (load ratio, heart-rate trend, check-in
  rating, sleep, days until an exam). Each becomes two network inputs: whether it is present, and
  its value scaled to [-1, 1]. Missing signals are normal (check-ins, sleep and exam dates are not
  wired up yet), so the cohort deliberately contains many rows with few or no signals.
- **Network.** 10 inputs, two hidden ReLU layers (32 and 16), one output (score / 100). About 900
  weights, shipped as `artifacts/readiness_v1.json`.
- **Score and band.** The output is rounded to 0 to 100. The band (`deload` / `light` / `push`)
  comes from the same configured thresholds as the rules.
- **Explanations.** For each signal present, the signal is hidden and the score re-computed; the
  drop is that signal's contribution (occlusion). Contributions are ranked and worded by the same
  code the rule scorer uses, so the page's "What's driving this score" looks the same either way.
- **With no signals at all** the rule scorer answers directly ("Not enough data yet").
- **Strava.** The model only ever sees `ReadinessFeatures`, which `build_features` has already
  stripped of Strava rows (Hard Rule 1). A test adds extreme Strava rows and checks the score does
  not move, and checks the same test *would* catch the same rows if they were manual.

## Measured quality

On 12,000 held-out simulated athletes (never used for training or early stopping), against the rule
scorer's scores:

| Measure | Value |
|---|---|
| Mean absolute error | 0.49 points |
| Within 3 points | 99.9% |
| R squared | 0.996 |
| Same intensity band as the rules | 98.9% |

On a further fresh cohort of 20,000 (different seed):

- Bias is about zero (mean signed error -0.003) and the worst error is 6 points.
- Where the band differs it is always a threshold-edge case: at most 4 points apart, never a
  push-versus-deload disagreement. The model was the more optimistic one in 125 cases (0.62%) and
  the more cautious one in 76 (0.38%), a slight optimistic lean at the thresholds.
- More sleep, a lower load rating or a lower heart-rate drift never lowers the score by more than a
  point of rounding; load above the productive range never raises it (tested on a grid).

These numbers measure agreement with the rules on simulated data. They say nothing about how well
either scorer predicts a real person's readiness.

## Which scorer is live

`GET /api/v1/readiness/model` returns the live scorer's kind (`model` or `rules`), version, what it
was trained on, headline metrics, and, if it fell back, why. `load_scorer()` falls back to the rules
when:

- `READINESS_RULES.use_trained_model` is `False`;
- the file is missing, malformed, has non-finite weights, or was trained on a different feature
  encoding;
- **the readiness rules in `config.py` have changed since the model was trained.** This is
  intentional: QA varies those thresholds to test behaviour, and a model trained on the old values
  would silently ignore the change. Retrain after changing a rule you intend to keep.

The scorer's version is part of the readiness cache key, so switching scorers recomputes today's
score instead of serving the previous scorer's answer.

## Retraining

```
cd backend
python -m app.training.ml.train                       # synthetic cohort, labelled by the rules
python -m app.training.ml.train --samples 200000 --seed 11 --version mlp-v2
```

The same arguments always produce the same file. It needs no database or network access.

### On real labelled data

Put the data in a CSV with columns `acwr, hr_trend_delta, checkin_load_rating, sleep_hours,
days_until_exam` (leave a cell empty for "missing") and `readiness_score` (0 to 100):

```
python -m app.training.ml.train --data labelled.csv --version mlp-v2
```

Rows are checked against the same limits as the API. A model trained this way records that it was
not labelled by the rules, so it is no longer tied to them and is not retired when they change.

**Never train on data obtained from the Strava API.** That would make the model an AI feature built
on Strava data (Hard Rule 1).

## Files

| File | Role |
|---|---|
| `features.py` | Encoding of `ReadinessFeatures` into network inputs |
| `network.py` | The numpy network: forward pass, Adam training, JSON round trip |
| `synthetic.py` | The synthetic cohort and its labelling by the rules |
| `train.py` | Training and evaluation CLI, and CSV loading |
| `artifact.py` | Reading and writing the model file, and fingerprinting the rules |
| `scorer.py` | `ModelScorer` and `load_scorer()` with its fallbacks |
| `artifacts/readiness_v1.json` | The shipped model |

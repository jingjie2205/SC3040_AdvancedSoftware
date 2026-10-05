"""
Stage 2 of the readiness score: a small neural network behind the same `ReadinessScorer` interface
as the rule-based scorer. Pure numpy, so it adds no dependency and the weights ship as JSON.

Read README.md in this folder before describing what the model is. In short: it is trained on a
synthetic cohort labelled by the Stage 1 rules, so it reproduces them smoothly and can be retrained
on real labelled data. It does not know anything the rules don't.
"""

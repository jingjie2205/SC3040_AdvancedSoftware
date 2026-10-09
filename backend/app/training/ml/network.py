"""
A small fully connected network (ReLU hidden layers, linear output) in plain numpy, with Adam.

Everything is deterministic given the seed. Inference is a handful of matrix products, so it runs
inside the request with no model server.
"""
import math
from typing import Any, Dict, List, Optional, Sequence

import numpy as np


class MLP:
    def __init__(self, weights: List[np.ndarray], biases: List[np.ndarray]) -> None:
        self.weights, self.biases = weights, biases

    # ------------------------------------------------------------------ construction

    @classmethod
    def init(cls, sizes: Sequence[int], rng: np.random.Generator) -> "MLP":
        weights = [rng.normal(0.0, math.sqrt(2.0 / n_in), (n_in, n_out)) for n_in, n_out in zip(sizes, sizes[1:])]
        return cls(weights, [np.zeros(n_out) for n_out in sizes[1:]])

    @property
    def sizes(self) -> List[int]:
        return [self.weights[0].shape[0]] + [w.shape[1] for w in self.weights]

    # ------------------------------------------------------------------ inference

    def forward(self, x: np.ndarray) -> np.ndarray:
        return self._run(x)[0].ravel()

    def _run(self, x: np.ndarray):
        activations = [x]
        for i, (w, b) in enumerate(zip(self.weights, self.biases)):
            z = activations[-1] @ w + b
            activations.append(z if i == len(self.weights) - 1 else np.maximum(z, 0.0))
        return activations[-1], activations

    # ------------------------------------------------------------------ training

    def fit(
        self,
        x: np.ndarray,
        y: np.ndarray,
        x_val: np.ndarray,
        y_val: np.ndarray,
        *,
        rng: np.random.Generator,
        epochs: int = 200,
        batch_size: int = 512,
        lr: float = 3e-3,
        weight_decay: float = 1e-5,
        patience: int = 25,
    ) -> Dict[str, Any]:
        """Mean squared error with Adam and cosine learning-rate decay. Keeps the best validation epoch."""
        params = self.weights + self.biases
        m = [np.zeros_like(p) for p in params]
        v = [np.zeros_like(p) for p in params]
        step, best, best_epoch = 0, math.inf, 0
        best_state = self._snapshot()
        n = x.shape[0]
        history: Dict[str, Any] = {"val_mse": []}

        for epoch in range(epochs):
            rate = lr * 0.5 * (1.0 + math.cos(math.pi * epoch / epochs))
            order = rng.permutation(n)
            for start in range(0, n, batch_size):
                idx = order[start : start + batch_size]
                grads = self._gradients(x[idx], y[idx], weight_decay)
                step += 1
                for j, (p, g) in enumerate(zip(params, grads)):
                    m[j] = 0.9 * m[j] + 0.1 * g
                    v[j] = 0.999 * v[j] + 0.001 * g * g
                    m_hat = m[j] / (1 - 0.9**step)
                    v_hat = v[j] / (1 - 0.999**step)
                    p -= rate * m_hat / (np.sqrt(v_hat) + 1e-8)  # in place: params alias the layers

            val_mse = float(np.mean((self.forward(x_val) - y_val) ** 2))
            history["val_mse"].append(val_mse)
            if val_mse < best - 1e-9:
                best, best_epoch, best_state = val_mse, epoch, self._snapshot()
            elif epoch - best_epoch >= patience:
                break

        self._restore(best_state)
        history.update(best_epoch=best_epoch, epochs_run=len(history["val_mse"]), best_val_mse=best)
        return history

    def _gradients(self, x: np.ndarray, y: np.ndarray, weight_decay: float) -> List[np.ndarray]:
        out, acts = self._run(x)
        delta = 2.0 * (out.ravel() - y)[:, None] / x.shape[0]
        grad_w: List[Optional[np.ndarray]] = [None] * len(self.weights)
        grad_b: List[Optional[np.ndarray]] = [None] * len(self.weights)
        for i in range(len(self.weights) - 1, -1, -1):
            grad_w[i] = acts[i].T @ delta + weight_decay * self.weights[i]
            grad_b[i] = delta.sum(axis=0)
            if i > 0:
                delta = (delta @ self.weights[i].T) * (acts[i] > 0)
        return grad_w + grad_b  # type: ignore[return-value]

    def _snapshot(self):
        return [w.copy() for w in self.weights], [b.copy() for b in self.biases]

    def _restore(self, state) -> None:
        # Copy into the existing arrays so anything holding references stays valid.
        for target, source in zip(self.weights + self.biases, state[0] + state[1]):
            target[...] = source

    # ------------------------------------------------------------------ persistence

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sizes": self.sizes,
            "weights": [w.tolist() for w in self.weights],
            "biases": [b.tolist() for b in self.biases],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MLP":
        """Rebuild a network, refusing anything malformed rather than serving a broken score."""
        try:
            sizes = [int(n) for n in data["sizes"]]
            weights = [np.array(w, dtype=float) for w in data["weights"]]
            biases = [np.array(b, dtype=float) for b in data["biases"]]
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"network is malformed: {error}") from error
        if len(sizes) < 2 or sizes[-1] != 1 or len(weights) != len(sizes) - 1 or len(biases) != len(weights):
            raise ValueError("network layout is inconsistent")
        for i, (w, b) in enumerate(zip(weights, biases)):
            if w.shape != (sizes[i], sizes[i + 1]) or b.shape != (sizes[i + 1],):
                raise ValueError(f"layer {i} has the wrong shape")
            if not (np.isfinite(w).all() and np.isfinite(b).all()):
                raise ValueError(f"layer {i} contains non-finite values")
        return cls(weights, biases)

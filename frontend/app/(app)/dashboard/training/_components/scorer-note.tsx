"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { trainingApi } from "@/lib/training/api";
import type { ModelInfo } from "@/lib/training/types";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Says which scorer produced the readiness score and what it is. The wording comes from the backend,
 * so what the page claims about the model is stated in one place only.
 */
export function ScorerNote() {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    trainingApi
      .getReadinessModel()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="mt-5 border-t border-slate-800 pt-3 text-[11px] text-slate-500">Scorer details unavailable.</p>;
  }
  if (!info) return null;

  const { metrics } = info;
  return (
    <details className="group mt-5 border-t border-slate-800 pt-3 text-[11px] text-slate-400">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-slate-300 outline-none hover:text-white focus-visible:ring-1 focus-visible:ring-emerald-500">
        <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          Scored by {info.kind === "model" ? `trained model ${info.version}` : "the rule-based scorer"}
        </span>
        <span className="ml-auto text-slate-500 group-open:hidden">About this score</span>
        <span className="ml-auto hidden text-slate-500 group-open:inline">Hide</span>
      </summary>

      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p>{info.description}</p>
        {info.trainedOn && <p>Trained on: {info.trainedOn}.</p>}
        {info.kind === "model" && metrics.mae_points !== undefined && (
          <p>
            It differs from the rules by {metrics.mae_points.toFixed(1)} points on average
            {metrics.class_agreement !== undefined &&
              ` and picks the same intensity band ${percent(metrics.class_agreement)} of the time`}
            , measured on simulated athletes.
          </p>
        )}
        {info.fallbackReason && <p className="text-amber-300">{info.fallbackReason}</p>}
      </div>
    </details>
  );
}

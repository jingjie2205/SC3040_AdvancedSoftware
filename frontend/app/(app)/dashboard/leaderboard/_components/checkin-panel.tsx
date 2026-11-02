"use client";

import { useState } from "react";
import { CircleCheck, Flame, Loader2 } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import { checkInXpFor } from "@/lib/gamification/config";
import { checkInSchema, type CheckInInput } from "@/lib/gamification/schemas";
import type { CheckInResult, GamificationStats } from "@/lib/gamification/types";
import { CardHeader, ErrorBox, Segmented, btnPrimary, cardClass } from "./ui";

type Field = keyof CheckInInput;
type Score = "1" | "2" | "3" | "4" | "5";

const SCORES: { value: Score; label: string }[] = ["1", "2", "3", "4", "5"].map((v) => ({
  value: v as Score,
  label: v,
}));

const QUESTIONS: { field: Field; label: string; low: string; high: string }[] = [
  { field: "muscleFatigue", label: "How sore are your muscles?", low: "Fresh", high: "Very sore" },
  { field: "mood", label: "How's your mood?", low: "Low", high: "Great" },
  { field: "dietAdherence", label: "Did you stick to your diet yesterday?", low: "Off track", high: "Spot on" },
];

const EMPTY: Record<Field, Score | null> = { muscleFatigue: null, mood: null, dietAdherence: null };

/** A live streak here always ended yesterday (today's check-in isn't done yet), so checking in extends it. */
function StreakPreview({ currentStreak }: { currentStreak: number }) {
  const next = currentStreak + 1;
  return (
    <div className="mb-5 flex items-center gap-3 rounded-xl border border-orange-500/30 bg-orange-500/10 px-4 py-3">
      <Flame className="h-5 w-5 shrink-0 text-orange-400" aria-hidden="true" />
      <div className="text-xs">
        <p className="font-semibold text-orange-200">
          {currentStreak > 0 ? `${currentStreak}-day streak` : "No streak yet"}
        </p>
        <p className="mt-0.5 text-orange-100/80">
          {currentStreak > 0 ? `Check in today to make it ${next} days` : "Check in today to start one"}{" "}
          <span className="font-semibold text-emerald-300">+{checkInXpFor(next)} XP</span>
        </p>
      </div>
    </div>
  );
}

export function CheckInPanel({
  stats,
  onCheckedIn,
}: {
  stats: GamificationStats;
  onCheckedIn: (result: CheckInResult | null) => void;
}) {
  const [answers, setAnswers] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const parsed = checkInSchema.safeParse({
      muscleFatigue: Number(answers.muscleFatigue),
      mood: Number(answers.mood),
      dietAdherence: Number(answers.dietAdherence),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await gamificationApi.checkIn(parsed.data);
    setBusy(false);

    if (result.ok) {
      setAnswers(EMPTY);
      onCheckedIn(result.data);
    } else if (result.error.code === "CONFLICT") {
      // Checked in from another tab or the home page; reload to show the done state.
      onCheckedIn(null);
    } else {
      setError(result.error.message);
    }
  }

  if (stats.checkedInToday) {
    return (
      <div className={cardClass}>
        <CardHeader title="Daily check-in" subtitle="Log how you feel to keep your streak going" />
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <CircleCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-emerald-300">Checked in for today</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-200/80">
              <Flame className="h-3.5 w-3.5" aria-hidden="true" />
              {stats.currentStreak}-day streak. Come back tomorrow to extend it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <CardHeader title="Daily check-in" subtitle="Three quick questions to earn XP and grow your streak" />
      <StreakPreview currentStreak={stats.currentStreak} />
      <div className="space-y-5">
        {QUESTIONS.map((q) => (
          <div key={q.field}>
            <p className="text-sm font-medium text-slate-200">{q.label}</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="w-14 text-right text-[10px] text-slate-500">{q.low}</span>
              <Segmented
                label={q.label}
                value={answers[q.field]}
                options={SCORES}
                onChange={(v) => setAnswers((a) => ({ ...a, [q.field]: v }))}
              />
              <span className="w-14 text-[10px] text-slate-500">{q.high}</span>
            </div>
          </div>
        ))}

        {error && <ErrorBox message={error} />}

        <button type="button" onClick={submit} disabled={busy} className={`${btnPrimary} w-full py-2`}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Check in
        </button>
      </div>
    </div>
  );
}

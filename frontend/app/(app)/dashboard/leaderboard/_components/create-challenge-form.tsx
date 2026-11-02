"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import { addDaysISO, todayISO } from "@/lib/gamification/dates";
import { challengeSchema, type ChallengeInput } from "@/lib/gamification/schemas";
import { CHALLENGE_METRICS, type Challenge, type ChallengeMetric, type LeaderboardEntry } from "@/lib/gamification/types";
import {
  CHALLENGE_METRIC_INFO,
  ErrorBox,
  FieldError,
  FRIENDS_PATH,
  Loading,
  Segmented,
  btnPrimary,
  btnSecondary,
  displayName,
  inputClass,
} from "./ui";

const METRIC_OPTIONS = CHALLENGE_METRICS.map((value) => ({
  value,
  label: CHALLENGE_METRIC_INFO[value].label,
  icon: CHALLENGE_METRIC_INFO[value].icon,
}));

type Errors = Partial<Record<keyof ChallengeInput, string>>;

export function CreateChallengeForm({
  onCreated,
  onCancel,
}: {
  onCreated: (challenge: Challenge) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState<ChallengeMetric>("xp");
  const [target, setTarget] = useState(String(CHALLENGE_METRIC_INFO.xp.defaultTarget));
  const [startDate, setStartDate] = useState(todayISO);
  const [endDate, setEndDate] = useState(() => addDaysISO(6));
  const [invitees, setInvitees] = useState<string[]>([]);
  const [athletes, setAthletes] = useState<LeaderboardEntry[] | null>(null);
  const [athletesError, setAthletesError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The leaderboard lists the user and their friends, so it doubles as the invite list.
  useEffect(() => {
    let cancelled = false;
    gamificationApi
      .getLeaderboard("xp")
      .then((board) => {
        if (!cancelled) setAthletes(board.entries.filter((e) => !e.isCurrentUser));
      })
      .catch((e: unknown) => {
        if (!cancelled) setAthletesError(e instanceof Error ? e.message : "Couldn't load athletes");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function changeMetric(next: ChallengeMetric) {
    setMetric(next);
    setTarget(String(CHALLENGE_METRIC_INFO[next].defaultTarget));
  }

  function toggleInvitee(userId: string) {
    setInvitees((ids) => (ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = challengeSchema.safeParse({
      title,
      metric,
      targetValue: target === "" ? Number.NaN : Number(target),
      startDate,
      endDate,
      inviteeIds: invitees,
    });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof ChallengeInput;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSubmitError(null);
    setBusy(true);
    const result = await gamificationApi.createChallenge(parsed.data);
    setBusy(false);
    if (result.ok) onCreated(result.data);
    else setSubmitError(result.error.message);
  }

  const info = CHALLENGE_METRIC_INFO[metric];

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <label className="block">
        <span className="text-xs text-slate-400">Name</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Two-week XP sprint"
          maxLength={100}
          aria-invalid={Boolean(errors.title)}
          className={inputClass}
        />
        <FieldError message={errors.title} />
      </label>

      <div>
        <span className="text-xs text-slate-400">Compete on</span>
        <div className="mt-1">
          <Segmented label="Compete on" value={metric} options={METRIC_OPTIONS} onChange={changeMetric} />
        </div>
        <p className="mt-1 text-[11px] text-slate-500">{info.hint}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-slate-400">Target ({info.unit})</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-invalid={Boolean(errors.targetValue)}
            className={inputClass}
          />
          <FieldError message={errors.targetValue} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Starts</span>
          <input
            type="date"
            min={todayISO()}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            aria-invalid={Boolean(errors.startDate)}
            className={inputClass}
          />
          <FieldError message={errors.startDate} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Ends</span>
          <input
            type="date"
            min={startDate}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            aria-invalid={Boolean(errors.endDate)}
            className={inputClass}
          />
          <FieldError message={errors.endDate} />
        </label>
      </div>

      <fieldset>
        <legend className="text-xs text-slate-400">Invite friends</legend>
        {athletesError ? (
          <p className="mt-1 text-xs text-rose-400">{athletesError}</p>
        ) : !athletes ? (
          <div className="mt-2">
            <Loading label="Loading athletes…" />
          </div>
        ) : athletes.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">
            No friends yet.{" "}
            <Link href={FRIENDS_PATH} className="font-semibold text-emerald-400 hover:underline">
              Add friends
            </Link>{" "}
            to invite them, or compete solo.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {athletes.map((a) => {
              const checked = invitees.includes(a.userId);
              return (
                <label
                  key={a.userId}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                    checked
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleInvitee(a.userId)}
                    className="accent-emerald-500"
                  />
                  {displayName(a)}
                  <span className="text-[10px] text-slate-500">{a.rank}</span>
                </label>
              );
            })}
          </div>
        )}
        <FieldError message={errors.inviteeIds} />
      </fieldset>

      {submitError && <ErrorBox message={submitError} />}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={btnSecondary}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Create challenge
        </button>
      </div>
    </form>
  );
}

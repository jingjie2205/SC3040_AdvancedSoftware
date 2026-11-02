"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, Plus, Trophy } from "lucide-react";
import { gamificationApi } from "@/lib/gamification/api";
import type { Challenge, ChallengeParticipant, ChallengeStatus } from "@/lib/gamification/types";
import { CreateChallengeForm } from "./create-challenge-form";
import {
  CHALLENGE_METRIC_INFO,
  CardHeader,
  ErrorBox,
  Loading,
  btnPrimary,
  btnSecondary,
  cardClass,
  displayName,
  tileClass,
} from "./ui";

const STATUS_BADGE: Record<ChallengeStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
  upcoming: { label: "Upcoming", className: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
  ended: { label: "Ended", className: "border-slate-700 bg-slate-800/60 text-slate-400" },
};

/** Invites first since they need an answer, then by how live the challenge is. */
const SORT_ORDER: Record<ChallengeStatus, number> = { active: 1, upcoming: 2, ended: 3 };

function sortKey(c: Challenge): number {
  return c.myStatus === "invited" ? 0 : SORT_ORDER[c.status];
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ParticipantRow({ participant, challenge }: { participant: ChallengeParticipant; challenge: Challenge }) {
  const pct = Math.min(100, Math.round((participant.progress / challenge.targetValue) * 100));
  const bar = participant.completed
    ? "bg-emerald-400"
    : participant.isCurrentUser
      ? "bg-gradient-to-r from-emerald-400 to-teal-500"
      : "bg-slate-500";

  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className={`truncate ${participant.isCurrentUser ? "font-semibold text-emerald-300" : "text-slate-200"}`}>
          {displayName(participant)}
          {participant.status === "invited" && <span className="ml-1.5 text-[10px] text-slate-500">invited</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-semibold text-white">
          {participant.completed && <CircleCheck className="h-3.5 w-3.5 text-emerald-400" aria-label="Target reached" />}
          {participant.progress.toLocaleString()}
          <span className="font-normal text-slate-500">/ {challenge.targetValue.toLocaleString()}</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label={`${displayName(participant)} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

function RewardNote({ challenge }: { challenge: Challenge }) {
  const mine = challenge.participants.find((p) => p.isCurrentUser);
  if (mine?.completed) {
    return (
      <p className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-emerald-300">
        <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
        Target reached: +{challenge.rewardXp} XP earned
      </p>
    );
  }
  if (challenge.status === "ended") return null;
  return (
    <p className="mt-3 text-[11px] text-slate-400">
      Reach the target to earn +{challenge.rewardXp} XP
    </p>
  );
}

function ChallengeCard({
  challenge,
  busy,
  onRespond,
}: {
  challenge: Challenge;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const info = CHALLENGE_METRIC_INFO[challenge.metric];
  const badge = STATUS_BADGE[challenge.status];
  const Icon = info.icon;

  return (
    <li className={tileClass}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{challenge.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
            <Icon className="h-3 w-3" aria-hidden="true" />
            {info.label} · {challenge.targetValue.toLocaleString()} {info.unit} ·{" "}
            {formatDay(challenge.startDate)} – {formatDay(challenge.endDate)}
          </p>
        </div>
        <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {challenge.myStatus === "invited" && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-200">
            {displayName({ userId: challenge.creatorId, isCurrentUser: false, displayName: challenge.creatorName })}{" "}
            invited you
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => onRespond(false)} className={btnSecondary}>
              Decline
            </button>
            <button type="button" disabled={busy} onClick={() => onRespond(true)} className={btnPrimary}>
              Accept
            </button>
          </div>
        </div>
      )}

      <ul className="mt-4 space-y-3">
        {challenge.participants.map((p) => (
          <ParticipantRow key={p.userId} participant={p} challenge={challenge} />
        ))}
      </ul>

      <RewardNote challenge={challenge} />
    </li>
  );
}

export function ChallengesPanel({ refreshKey }: { refreshKey: number }) {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    gamificationApi
      .getChallenges()
      .then((data) => {
        if (!cancelled) setChallenges(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your challenges");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryKey]);

  const sorted = useMemo(
    () => (challenges ? [...challenges].sort((a, b) => sortKey(a) - sortKey(b)) : null),
    [challenges],
  );

  async function respond(challengeId: string, accept: boolean) {
    setRespondingId(challengeId);
    setActionError(null);
    const result = await gamificationApi.respondToChallenge(challengeId, accept);
    setRespondingId(null);

    if (result.ok) {
      setChallenges((list) =>
        accept
          ? (list ?? []).map((c) => (c.id === challengeId ? result.data : c))
          : (list ?? []).filter((c) => c.id !== challengeId),
      );
      return;
    }
    setActionError(result.error.message);
    // The invite changed elsewhere (answered in another tab, challenge ended); show the current state.
    if (result.error.code === "CONFLICT" || result.error.code === "NOT_FOUND") setRetryKey((k) => k + 1);
  }

  return (
    <div className={cardClass}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader title="Challenges" subtitle="Set a goal and race your friends to it" />
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} className={`${btnPrimary} mb-5 w-fit`}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New challenge
          </button>
        )}
      </div>

      <div className="space-y-4">
        {creating && (
          <CreateChallengeForm
            onCancel={() => setCreating(false)}
            onCreated={(challenge) => {
              setChallenges((list) => [challenge, ...(list ?? [])]);
              setCreating(false);
            }}
          />
        )}

        {actionError && <ErrorBox message={actionError} />}

        {loadError ? (
          <ErrorBox message={loadError} onRetry={() => setRetryKey((k) => k + 1)} />
        ) : !sorted ? (
          <Loading label="Loading challenges…" />
        ) : sorted.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-xs text-slate-400">
            No challenges yet. Start one and invite other athletes.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {sorted.map((c) => (
              <ChallengeCard
                key={c.id}
                challenge={c}
                busy={respondingId === c.id}
                onRespond={(accept) => respond(c.id, accept)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

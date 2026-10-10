"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bike,
  CalendarCheck,
  CalendarPlus,
  CloudDownload,
  Dumbbell,
  ExternalLink,
  Footprints,
  HeartPulse,
  Info,
  Loader2,
  Mountain,
  Trash2,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { formatDay } from "@/lib/training/dates";
import {
  loadStatus,
  pullActivities,
  removeFromSchedule,
  saveToSchedule,
  stravaAvailable,
  stravaConnectUrl,
} from "@/lib/training/strava";
import {
  activityUrl,
  canSave,
  describeSave,
  formatDistance,
  formatDuration,
  formatPace,
  iconKind,
  plural,
  saveTone,
  summarisePull,
  typeLabel,
  type IconKind,
  type StravaCard,
  type StravaStatus,
} from "@/lib/training/strava-format";
import {
  ACTIVITY_LABEL,
  ConfirmDialog,
  ErrorBox,
  Loading,
  btnDanger,
  btnPrimary,
  btnSecondary,
  cardClass,
} from "./ui";

/*
 * Hard Rule 1: Strava data never reaches an AI feature. What is saved from this tab is a log flagged "strava": the
 * schedule shows it, and the plan, the readiness score, the summary and the coach never count it. This panel doesn't
 * use `trainingApi`, and nothing it shows is passed to them.
 */

const ICONS: Record<IconKind, LucideIcon> = {
  foot: Footprints,
  bike: Bike,
  gym: Dumbbell,
  swim: Waves,
  other: Activity,
};

interface Notice {
  tone: "ok" | "error";
  text: string;
  /** Offer a way to the schedule, where what was just saved now shows. */
  offerSchedule?: boolean;
}

/** "Fri 14 Aug", with the year added for anything not from this year, since the list can reach back years. */
function dayLabel(day: string): string {
  const year = day.slice(0, 4);
  return year === String(new Date().getFullYear()) ? formatDay(day) : `${formatDay(day)} ${year}`;
}

function ActivityCard({
  card,
  saving,
  locked,
  onSave,
}: {
  card: StravaCard;
  saving: boolean;
  locked: boolean;
  onSave: () => void;
}) {
  const Icon = ICONS[iconKind(card.type)];
  const pace = formatPace(card.type, card.distanceM, card.movingTimeS);

  return (
    <li className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white" title={card.name}>
            {card.name}
          </p>
          <p className="text-xs text-slate-400">
            {typeLabel(card.type)} · {dayLabel(card.day)}
            {card.time ? ` · ${card.time}` : ""}
          </p>
        </div>
        <a
          href={activityUrl(card.stravaId)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-[#FC4C02] hover:underline"
        >
          View on Strava
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only"> ({card.name})</span>
        </a>
      </div>

      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {card.distanceM > 0 && <span>{formatDistance(card.distanceM)}</span>}
        <span>{formatDuration(card.movingTimeS)}</span>
        {pace && <span>{pace}</span>}
        {card.averageHeartrate !== null && (
          <span className="inline-flex items-center gap-1">
            <HeartPulse className="h-3 w-3 text-rose-300" aria-hidden="true" />
            {Math.round(card.averageHeartrate)} bpm avg
          </span>
        )}
        {card.elevationGainM >= 1 && (
          <span className="inline-flex items-center gap-1">
            <Mountain className="h-3 w-3 text-slate-400" aria-hidden="true" />
            {Math.round(card.elevationGainM)} m climb
          </span>
        )}
      </p>

      <div className="mt-auto pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
          <p className="min-w-0 text-[11px] text-slate-400">
            {card.savedAs !== null
              ? `${card.saved ? "Saved" : "Saves"} as ${ACTIVITY_LABEL[card.savedAs]} · ${card.durationMin} min · ${card.points} pts`
              : "The schedule only holds runs, rides, gym and bodyweight sessions, so this one can't be saved."}
          </p>
          {card.saved ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
              On schedule
            </span>
          ) : card.savedAs !== null ? (
            <button
              type="button"
              onClick={onSave}
              disabled={saving || locked}
              aria-label={`Save ${card.name} to schedule`}
              className={`${btnPrimary} shrink-0`}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {saving ? "Saving…" : "Save to schedule"}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function StravaPanel({ onViewSchedule }: { onViewSchedule: () => void }) {
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [cards, setCards] = useState<StravaCard[] | null>(null); // null until the first upload
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState<"all" | number | null>(null); // what is being saved right now
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Opening the tab asks our own server whether Strava is connected. Strava itself is only asked on "Upload".
  useEffect(() => {
    if (!stravaAvailable) return;
    let cancelled = false;
    loadStatus().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setStatus(result.data);
        setStatusError(null);
      } else {
        setStatusError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  async function upload() {
    setUploading(true);
    setNotice(null);
    const result = await pullActivities();
    setUploading(false);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.error.message });
      if (result.error.code === "NOT_CONNECTED") reload(); // the connection may be gone: show Connect instead
      return;
    }
    setCards(result.data);
    reload();
  }

  async function save(stravaIds: number[], marker: "all" | number) {
    setSaving(marker);
    setNotice(null);
    const result = await saveToSchedule(stravaIds);
    setSaving(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.error.message });
      if (result.error.code === "NOT_CONNECTED") reload();
      return;
    }
    const justSaved = new Set(result.data.savedIds);
    setCards((current) =>
      current ? current.map((card) => (justSaved.has(card.stravaId) ? { ...card, saved: true } : card)) : current,
    );
    setNotice({ tone: saveTone(result.data), text: describeSave(result.data), offerSchedule: justSaved.size > 0 });
    reload();
  }

  async function confirmRemove() {
    setRemoving(true);
    const result = await removeFromSchedule();
    setRemoving(false);
    setConfirmingRemove(false);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.error.message });
    } else {
      setNotice({
        tone: "ok",
        text:
          result.data === 0
            ? "There were no Strava activities on your schedule."
            : `Removed ${plural(result.data, "activity", "activities")} from your schedule.`,
      });
      setCards((current) => (current ? current.map((card) => ({ ...card, saved: false })) : current));
    }
    reload();
  }

  const connectUrl = stravaConnectUrl();
  const summary = summarisePull(cards ?? []);
  const saveable = (cards ?? []).filter(canSave);
  const busy = uploading || removing || saving !== null;
  const savedCount = status?.savedCount ?? 0;

  return (
    <section aria-labelledby="strava-heading" className={cardClass}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#FC4C02]/20 bg-[#FC4C02]/10 text-[#FC4C02]">
          <Activity className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 id="strava-heading" className="text-base font-bold text-white">
            Strava activities
          </h2>
          <p className="text-xs text-slate-400">
            Upload your latest activities from Strava, then choose which ones go on your schedule.
          </p>
        </div>
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
        Saved Strava activities show on your schedule so you can see them. They don&apos;t complete planned sessions, and
        they are never used for your plan, readiness score or coach.
      </p>

      <div className="mt-5 space-y-4">
        {!stravaAvailable ? (
          <p className="text-sm text-slate-400">
            Strava needs the backend. Start it, set <code>NEXT_PUBLIC_TRAINING_API=http</code> and sign in.
          </p>
        ) : status === null ? (
          statusError ? (
            <ErrorBox message={statusError} onRetry={reload} />
          ) : (
            <Loading label="Checking your Strava connection…" />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {status.connected ? (
                <button type="button" onClick={upload} disabled={busy} className={btnPrimary}>
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {uploading ? "Uploading…" : "Upload Strava data"}
                </button>
              ) : connectUrl ? (
                <a
                  href={connectUrl}
                  className="flex items-center gap-2 rounded-lg bg-[#FC4C02] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#E34402]"
                >
                  Connect Strava
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              ) : (
                <p className="text-xs text-slate-400">Strava isn&apos;t set up on this server yet.</p>
              )}
              {savedCount > 0 && (
                <button type="button" onClick={() => setConfirmingRemove(true)} disabled={busy} className={btnDanger}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Remove saved activities
                </button>
              )}
              {savedCount > 0 && (
                <span className="text-xs text-slate-400">
                  {plural(savedCount, "Strava activity", "Strava activities")} on your schedule
                </span>
              )}
            </div>

            {notice && (
              <div
                role={notice.tone === "error" ? "alert" : "status"}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-xs ${
                  notice.tone === "error" ? "text-rose-300" : "text-emerald-300"
                }`}
              >
                <span>{notice.text}</span>
                {notice.offerSchedule && (
                  <button type="button" onClick={onViewSchedule} className={btnSecondary}>
                    View schedule
                  </button>
                )}
              </div>
            )}

            {!status.connected && savedCount > 0 && (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Strava isn&apos;t connected, so nothing more can be uploaded. The activities already on your schedule
                stay until you remove them.
              </p>
            )}

            {cards === null ? (
              <p className="text-sm text-slate-400">
                {status.connected
                  ? "Press Upload Strava data to see your latest activities here. Nothing is saved until you say so."
                  : "Connect Strava to upload your activities."}
              </p>
            ) : cards.length === 0 ? (
              <p className="text-sm text-slate-400">Strava has no activities to show yet.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2.5">
                  <p className="text-xs text-slate-300">
                    {plural(summary.total, "activity", "activities")} from Strava
                    <span className="text-slate-400">
                      {" · "}
                      {summary.toSave} to save
                      {summary.onSchedule > 0 && ` · ${summary.onSchedule} on your schedule`}
                      {summary.unsupported > 0 && ` · ${summary.unsupported} can't be saved`}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => save(saveable.map((card) => card.stravaId), "all")}
                    disabled={busy || saveable.length === 0}
                    className={btnPrimary}
                  >
                    {saving === "all" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {saveable.length > 0 ? `Save all to schedule (${saveable.length})` : "Save all to schedule"}
                  </button>
                </div>

                <ul aria-label="Your latest Strava activities" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {cards.map((card) => (
                    <ActivityCard
                      key={card.stravaId}
                      card={card}
                      saving={saving === card.stravaId}
                      locked={busy}
                      onSave={() => save([card.stravaId], card.stravaId)}
                    />
                  ))}
                </ul>

                <p className="text-[11px] text-slate-500">
                  An activity is saved as a log with its moving time rounded to the minute, 1 pt for each minute, and
                  its average heart rate when Strava has one. Saving it again does nothing.
                </p>
              </>
            )}
          </>
        )}
      </div>

      {stravaAvailable && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-4 text-[11px] text-slate-500">
          <span>Powered by Strava</span>
          <Link
            href="/dashboard/settings?tab=integrations"
            className="font-semibold text-slate-400 hover:text-white hover:underline"
          >
            Manage the connection in Settings
          </Link>
        </div>
      )}

      {confirmingRemove && (
        <ConfirmDialog
          title="Remove saved Strava activities?"
          confirmLabel="Remove from schedule"
          tone="danger"
          busy={removing}
          onConfirm={confirmRemove}
          onCancel={() => setConfirmingRemove(false)}
        >
          <p>
            This takes {plural(savedCount, "activity", "activities")} that came from Strava off your schedule. Your own
            logged sessions stay as they are, nothing changes on Strava, and you can upload and save them again later.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

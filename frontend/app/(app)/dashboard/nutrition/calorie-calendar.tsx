"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchCalorieCalendar, saveCalorieTargets, type CalorieDay } from "@/lib/nutrition";
import { addDays, formatDay, todayISO } from "@/lib/training/dates";

export default function CalorieCalendar({ selectedDay, onSelectDay, revision }: {
  selectedDay: string;
  onSelectDay: (day: string) => void;
  revision: number;
}) {
  const [today, setToday] = useState(todayISO);
  const [start, setStart] = useState(todayISO);
  const [days, setDays] = useState<CalorieDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [targetDraft, setTargetDraft] = useState({ date: "", value: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedDate, setSavedDate] = useState("");
  const end = addDays(start, 6);
  const selected = days.find(day => day.date === selectedDay);
  const targetValue = targetDraft.date === selectedDay ? targetDraft.value : String(selected?.target_calories ?? "");

  async function saveTarget() {
    if (saving) return;
    const date = selectedDay;
    const calories = Number(targetValue);
    if (!Number.isInteger(calories) || calories <= 0 || calories > 100000) {
      setSaveError("Enter a whole number between 1 and 100,000 kcal.");
      return;
    }
    setSaving(true); setSaveError(""); setSavedDate("");
    try {
      await saveCalorieTargets([{ date, target_calories: calories }]);
      setDays(current => current.map(day => day.date === date ? { ...day, target_calories: calories, target_source: "saved" } : day));
      setSavedDate(date);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save this day's target. Please retry.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayISO()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setStart(current => selectedDay < current || selectedDay > addDays(current, 6) ? selectedDay : current);
  }, [selectedDay]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setDays([]);
    fetchCalorieCalendar(start, end, controller.signal).then(result => {
      if (!controller.signal.aborted) setDays(result);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load your calorie calendar.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [start, end, revision, retry, today]);

  const navigation = "rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-emerald-400";
  return <section aria-labelledby="calorie-calendar-title" className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/50 p-5 sm:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 id="calorie-calendar-title" className="flex items-center gap-2 text-lg font-semibold"><CalendarDays size={20} className="text-emerald-400" /> Your calorie calendar</h2>
        <p className="mt-1 text-xs text-slate-400">Plan your fuel ahead and look back at what you ate.</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous seven days" onClick={() => setStart(addDays(start, -7))} className={navigation}><ChevronLeft size={18} /></button>
        <button type="button" onClick={() => { setStart(today); onSelectDay(today); }} className={`${navigation} px-3 text-xs`}>Today</button>
        <button type="button" aria-label="Next seven days" onClick={() => setStart(addDays(start, 7))} className={navigation}><ChevronRight size={18} /></button>
      </div>
    </div>
    <p className="mb-3 text-xs text-slate-400">{formatDay(start)} – {formatDay(end)}, {end.slice(0, 4)} · kcal</p>
    {error ? <div role="alert" className="rounded-xl bg-rose-950/40 p-4 text-sm text-rose-200">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="ml-3 underline">Retry calendar</button></div> :
      <div aria-busy={loading} className="overflow-x-auto pb-2">
        <div className="grid min-w-[980px] grid-cols-7 gap-3">
          {Array.from({ length: 7 }, (_, index) => {
            const date = addDays(start, index);
            const entry = days.find(day => day.date === date);
            const current = date === today;
            const future = date > today;
            const target = entry?.target_calories ?? null;
            const consumed = entry?.total_calories ?? null;
            const remaining = target !== null && consumed !== null ? target - consumed : null;
            return <button key={date} type="button" onClick={() => onSelectDay(date)} aria-pressed={date === selectedDay} aria-current={current ? "date" : undefined}
              aria-label={`${formatDay(date)}${current ? ", today" : ""}`}
              className={`rounded-xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-emerald-400 ${current ? "border-emerald-500 bg-emerald-950/40" : "border-slate-700 bg-slate-950/40 hover:border-slate-500"} ${date === selectedDay ? "ring-1 ring-emerald-400" : ""}`}>
              <p className={`text-xs font-semibold ${current ? "text-emerald-300" : "text-slate-300"}`}>{current ? "Today" : formatDay(date).split(",")[0]}</p>
              <p className="mt-1 text-xs text-slate-500">{date.slice(5).replace("-", "/")}</p>
              <p className="mt-5 text-xs text-slate-400">{future ? "Available to eat" : "Consumed"}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{loading ? "…" : (future ? target : consumed)?.toLocaleString() ?? "—"}</p>
              <p className="mt-3 text-xs text-slate-400">{loading ? "Loading…" : target === null ? "Target not set" : `${target.toLocaleString()} target`}</p>
              <p className="mt-2 min-h-8 text-xs text-emerald-300">{loading ? "" : future ? "Planned daily budget" : entry?.meal_count === 0 ? "No meals logged" : consumed === null ? "Intake incomplete" : remaining === null ? "Logged intake" : `${Math.abs(remaining).toLocaleString()} ${remaining < 0 ? "over target" : "remaining"}`}</p>
              <p className="mt-2 text-[10px] text-slate-500">{entry?.target_source === "saved" ? "Saved target" : entry?.target_source === "profile" ? "Profile estimate" : ""}</p>
            </button>;
          })}
        </div>
      </div>}
    {!loading && !error && selected && <form onSubmit={event => { event.preventDefault(); void saveTarget(); }} className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <fieldset disabled={saving} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-sm font-semibold">Target for {formatDay(selectedDay)}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">Adjust this day's total budget for a planned workout or rest day. Other days keep their own targets.</p>
        </div>
        <label className="text-xs text-slate-400">Daily target (kcal)
          <input type="number" required min={1} max={100000} step={1} value={targetValue}
            onChange={event => { setTargetDraft({ date: selectedDay, value: event.target.value }); setSaveError(""); setSavedDate(""); }}
            className="mt-2 block w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400" />
        </label>
        <button type="submit" className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">{saving ? "Saving…" : "Save day's target"}</button>
      </fieldset>
    </form>}
    {!loading && !error && days.some(day => day.target_calories === null) && <p className="mt-3 rounded-xl border border-amber-900 bg-amber-950/30 p-4 text-sm text-amber-200">
      No default target is available from your saved profile. <Link href="/dashboard/settings" className="underline">Complete and save your Settings</Link> to calculate it automatically. Logged calories are still shown above, and you can set a target for an individual day.
    </p>}
    {saveError && <p role="alert" className="mt-3 text-sm text-rose-300">{saveError}</p>}
    {savedDate && <p role="status" className="mt-3 text-sm text-emerald-300">Target saved for {formatDay(savedDate)}.</p>}
    <p className="mt-3 text-xs leading-5 text-slate-500">Select a day to edit its target and see its meal journal. Targets are daily budgets; profile estimates use your current settings. <Link href="/dashboard/settings" className="text-emerald-400 hover:underline">Update profile</Link></p>
  </section>;
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import CalorieCalendar from "./calorie-calendar";
import { ArrowRight, Camera, Check, Flame, Leaf, LoaderCircle, Plus, ScanLine, Sparkles, Trash2, Upload, Utensils } from "lucide-react";
import { analyzeMeal, deleteMeal, fetchDailyLog, mealTotals, mealTypes, saveMeal, scaleItem, type DailyLog, type FoodItem, type MealEstimate, type MealType } from "@/lib/nutrition";

const panel = "rounded-2xl border border-slate-800 bg-slate-900/50 p-5 sm:p-6";
const input = "w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400";
const button = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";
const blankItem = (): FoodItem => ({ name: "", estimated_weight_g: 100, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const display = (value: number | null) => value === null ? "—" : Math.round(value * 10) / 10;

function Macros({ values }: { values: ReturnType<typeof mealTotals> }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    {[["Calories", values.total_calories, "kcal", "text-white"], ["Protein", values.protein_g, "g", "text-emerald-400"], ["Carbs", values.carbs_g, "g", "text-sky-400"], ["Fat", values.fat_g, "g", "text-amber-400"]].map(([label, value, unit, color]) =>
      <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"><p className="text-xs text-slate-400">{label}</p><p className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}<span className="ml-1 text-xs font-normal text-slate-500">{unit}</span></p></div>)}
  </div>;
}

export default function MealAnalysis() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<MealEstimate | null>(null);
  const [mealType, setMealType] = useState<MealType>("lunch");
  const [draftId, setDraftId] = useState("");
  const [loggedAt, setLoggedAt] = useState("");
  const [busy, setBusy] = useState<"analyze" | "save" | "" >("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [day, setDay] = useState(localDate);
  const [daily, setDaily] = useState<DailyLog | null>(null);
  const [logError, setLogError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const operation = useRef(false);

  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setPreviewFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLogError(""); setDaily(null);
    fetchDailyLog(day, controller.signal).then(setDaily).catch((err: unknown) => {
      if (!controller.signal.aborted) setLogError(message(err));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [day, revision]);

  function selectFile(selected?: File) {
    if (!selected || operation.current) return;
    if (selected.size === 0 || selected.size > 10 * 1024 * 1024) { setError("Choose an image between 1 byte and 10 MB."); return; }
    if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(selected.type) && !(selected.type === "" && /\.(heic|heif)$/i.test(selected.name))) {
      setError("Choose a JPEG, PNG, WEBP or HEIC/HEIF image."); return;
    }
    setFile(selected); setDraft(null); setError(""); setSuccess("");
  }

  function beginDraft(estimate: MealEstimate) {
    setDraft(estimate); setDraftId(crypto.randomUUID()); setLoggedAt(new Date().toISOString());
  }

  async function analyze() {
    if (!file || operation.current) return;
    operation.current = true; setBusy("analyze"); setError(""); setSuccess("");
    try { beginDraft(await analyzeMeal(file, notes)); }
    catch (err) { setError(message(err)); }
    finally { operation.current = false; setBusy(""); }
  }

  async function commit() {
    if (!draft || operation.current) return;
    operation.current = true; setBusy("save"); setError(""); setSuccess("");
    try {
      await saveMeal({ meal_name: draft.meal_name, confidence_score: draft.confidence_score,
        training_context_note: draft.training_context_note,
        items: draft.items.map(item => ({ ...item, estimated_weight_g: item.estimated_weight_g > 0 ? item.estimated_weight_g : 100 })),
        id: draftId, meal_type: mealType, logged_at: loggedAt });
      setDraft(null); setFile(null); setNotes(""); setSuccess("Meal saved. Your daily totals have been updated.");
      setDay(localDate(new Date(loggedAt))); setRevision(value => value + 1);
    } catch (err) { setError(message(err)); }
    finally { operation.current = false; setBusy(""); }
  }

  async function remove(id: string) {
    setDeleting(id); setLogError("");
    try { await deleteMeal(id); setConfirmDelete(""); setRevision(value => value + 1); }
    catch (err) { setLogError(message(err)); }
    finally { setDeleting(""); }
  }

  function updateItem(index: number, item: FoodItem) {
    setDraft(current => current ? { ...current, items: current.items.map((old, i) => i === index ? item : old) } : null);
  }

  return <div className="space-y-7">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400"><Leaf size={14} /> Nutrition</p><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Fuel your next best.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">A little clarity on your plate. Capture a meal, review the details, and keep your recovery on track.</p></div>
      <span className="flex items-center gap-2 rounded-full border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300"><Sparkles size={14} /> AI-assisted meal analysis</span>
    </header>
    <CalorieCalendar selectedDay={day} onSelectDay={setDay} revision={revision} />
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-400">{["Capture your meal", "Review & adjust", "Save to your day"].map((step, index) => <span key={step} className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-700 text-emerald-400">{index + 1}</span>{step}{index < 2 && <ArrowRight size={13} className="ml-2 text-slate-700" />}</span>)}</div>
    {error && <div role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</div>}
    {success && <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-800 bg-emerald-950/40 p-4 text-sm text-emerald-200"><Check size={18} />{success}</div>}
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        <section className={panel} aria-labelledby="capture-title">
          <div className="mb-5 flex items-center gap-3"><div className="rounded-xl bg-emerald-500/10 p-2.5 text-emerald-400"><Camera size={20} /></div><div><h2 id="capture-title" className="font-semibold">What’s on your plate?</h2><p className="mt-1 text-xs text-slate-400">Start with a clear photo of your meal.</p></div></div>
          <fieldset disabled={!!busy} className="space-y-4">
            <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); selectFile(event.dataTransfer.files[0]); }} className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950/40 p-6 text-center">
              {preview && !previewFailed ? <img src={preview} alt="Selected meal for analysis" onError={() => setPreviewFailed(true)} className="mb-4 max-h-64 rounded-lg object-contain" /> : <><div className="mb-4 rounded-full bg-slate-800/70 p-4 text-emerald-400"><ScanLine size={32} /></div><p className="text-sm font-medium">{file ? file.name : "Drop your meal photo here"}</p><p className="mt-2 text-xs text-slate-500">{file ? "Your image is ready. HEIC/HEIF is converted securely for analysis." : "JPEG, PNG, WEBP or HEIC/HEIF · up to 10 MB"}</p></>}
              <div className="mt-4 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => fileInput.current?.click()} className={`${button} border border-slate-700 bg-slate-800 text-slate-100`}><Upload size={16} />{file ? "Change photo" : "Choose photo"}</button><button type="button" onClick={() => cameraInput.current?.click()} className={`${button} border border-slate-700 text-slate-300`}><Camera size={16} />Take photo</button></div>
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" className="hidden" aria-label="Choose meal photo" onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ""; }} />
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take meal photo" onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
            <label className="block text-sm text-slate-300">Anything the photo can’t tell us?<textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={1000} rows={3} placeholder="E.g. cooked with 1 tbsp butter, or eaten after a 10 km run. You can paste a voice note transcript here." className={`${input} mt-2 resize-y`} /></label>
            <p className="text-right text-xs text-slate-500">{notes.length}/1,000</p>
            <button type="button" onClick={analyze} disabled={!file || !!busy} className={`${button} w-full bg-emerald-400 text-slate-950 hover:bg-emerald-300`}>{busy === "analyze" ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}{busy === "analyze" ? "Analyzing your meal…" : "Analyze meal"}</button>
            <button type="button" onClick={() => { beginDraft({ meal_name: "", confidence_score: 0, training_context_note: "Manually entered meal; no AI estimate.", items: [blankItem()] }); setError(""); setSuccess(""); }} className="w-full py-2 text-xs text-slate-400 hover:text-white">Or enter a meal manually</button>
          </fieldset>
          <p className="mt-3 text-xs leading-5 text-slate-500">Your photo and notes are sent to Google Gemini for analysis. The photo is not stored in your meal log.</p>
        </section>
        {draft && <form className={panel} onSubmit={event => { event.preventDefault(); void commit(); }}>
          <fieldset disabled={!!busy} className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Review your meal</h2><span className="rounded-full bg-amber-400/10 px-3 py-1 text-xs text-amber-300">{draft.confidence_score ? `${Math.round(draft.confidence_score * 100)}% visual confidence` : "Manual entry"}</span></div>
            <div className="grid gap-3 sm:grid-cols-[1fr_140px]"><label className="text-xs text-slate-400">Meal name<input required maxLength={160} value={draft.meal_name} onChange={event => setDraft({ ...draft, meal_name: event.target.value })} className={`${input} mt-2`} placeholder="Give your meal a name" /></label><label className="text-xs text-slate-400">Meal type<select value={mealType} onChange={event => setMealType(mealTypes.find(type => type === event.target.value) ?? "lunch")} className={`${input} mt-2 capitalize`}>{mealTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label></div>
            <Macros values={mealTotals(draft.items)} />
            {draft.training_context_note && <div className="flex gap-3 rounded-xl border border-emerald-900/70 bg-emerald-950/30 p-4"><Sparkles size={18} className="shrink-0 text-emerald-400" /><div><p className="text-xs font-semibold text-emerald-300">Fuel & recovery insight</p><p className="mt-2 text-sm leading-6 text-slate-300">{draft.training_context_note}</p><p className="mt-2 text-xs text-slate-500">Based on the original estimate and your notes; ingredient edits update totals only.</p></div></div>}
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Ingredients <span className="font-normal text-slate-500">({draft.items.length})</span></h3><button type="button" disabled={draft.items.length >= 50} onClick={() => setDraft({ ...draft, items: [...draft.items, blankItem()] })} className="flex items-center gap-1 text-xs text-emerald-400 disabled:opacity-40"><Plus size={15} />Add ingredient</button></div>
            <p className="text-xs leading-5 text-slate-400">Adjust grams to scale nutrients automatically. Enter nutrition values for the full portion when adding a missing ingredient.</p>
            {draft.items.map((item, index) => <div key={index} className="space-y-3 rounded-xl border border-slate-800 p-4">
              <div className="flex items-center gap-2"><input required maxLength={120} aria-label={`Ingredient ${index + 1} name`} placeholder="Ingredient name" value={item.name} onChange={event => updateItem(index, { ...item, name: event.target.value })} className={input} /><button type="button" aria-label={`Remove ingredient ${index + 1}`} onClick={() => setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) })} className="rounded-lg p-2 text-slate-500 hover:bg-rose-950 hover:text-rose-300"><Trash2 size={17} /></button></div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{([ ["estimated_weight_g", "Weight (g)"], ["calories", "Calories"], ["protein_g", "Protein (g)"], ["carbs_g", "Carbs (g)"], ["fat_g", "Fat (g)"] ] as const).map(([key, label]) => <label key={key} className="text-xs text-slate-400">{label}<input type="number" required min={key === "estimated_weight_g" ? 0.1 : 0} max={key === "estimated_weight_g" ? 10000 : 100000} step="any" placeholder={key === "estimated_weight_g" ? "100" : "0"} value={item[key] === 0 ? "" : display(item[key])} onFocus={event => event.target.select()} onChange={event => { const clean = event.target.value.replace(/^0+(?=\d)/, ""); if (clean !== event.target.value) { event.target.value = clean; } const raw = event.target.value; if (raw === "") { updateItem(index, key === "estimated_weight_g" ? { ...item, estimated_weight_g: 0 } : { ...item, [key]: 0 }); return; } const value = Number(raw); if (Number.isFinite(value) && value >= 0) updateItem(index, key === "estimated_weight_g" ? scaleItem(item, value) : { ...item, [key]: value }); }} className={`${input} mt-1.5 px-2 tabular-nums`} /></label>)}</div>
            </div>)}
            {!draft.items.length && <p className="text-sm text-amber-300">Add at least one ingredient before saving.</p>}
            <p className="text-xs leading-5 text-slate-500">Photo estimates can miss ingredients and portion sizes. Check the values before you save.</p>
            <div className="flex flex-wrap gap-3"><button disabled={!draft.items.length || !draft.meal_name.trim() || draft.items.some(item => !item.name.trim()) || !!busy} className={`${button} flex-1 bg-emerald-400 text-slate-950 hover:bg-emerald-300`}>{busy === "save" ? <LoaderCircle size={17} className="animate-spin" /> : <Check size={17} />}{busy === "save" ? "Saving meal…" : "Confirm & log meal"}</button><button type="button" className={`${button} border border-slate-700 text-slate-300`} onClick={() => setDraft(null)}>Discard draft</button></div>
          </fieldset>
        </form>}
      </div>
      <aside className="space-y-5">
        <section className={panel}><div className="mb-5 flex items-center gap-2"><Flame size={18} className="text-emerald-400" /><h2 className="font-semibold">Your daily fuel</h2></div><label className="block text-xs text-slate-400">Log date<input aria-label="Log date" type="date" required value={day} onChange={event => { if (event.target.value) setDay(event.target.value); }} className={`${input} mt-2 [color-scheme:dark]`} /></label>
          {loading ? <p role="status" className="mt-5 flex items-center gap-2 text-sm text-slate-400"><LoaderCircle size={16} className="animate-spin" />Loading your day…</p> : logError ? <div role="alert" className="mt-4 text-sm text-rose-300">{logError}<button onClick={() => setRevision(value => value + 1)} className="mt-3 block text-emerald-400 underline">Try again</button></div> : daily && <>
            <p className="mt-6 text-4xl font-semibold tabular-nums">{display(daily.total_calories)}<span className="ml-2 text-sm font-normal text-slate-500">kcal eaten</span></p>
            <div className="mt-5 space-y-3">{[["Protein", daily.protein_g, "bg-emerald-400"], ["Carbs", daily.carbs_g, "bg-sky-400"], ["Fat", daily.fat_g, "bg-amber-400"]].map(([label, value, color]) => <div key={label} className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-slate-400"><span className={`h-2 w-2 rounded-full ${color}`} />{label}</span><span className="tabular-nums">{value ?? "—"} g</span></div>)}</div>
            {[daily.total_calories, daily.protein_g, daily.carbs_g, daily.fat_g].includes(null) && <p className="mt-3 text-xs text-slate-500">Some saved meals have incomplete nutrition values. A dash means the total is unavailable.</p>}
            <div className="mt-6 space-y-3 border-t border-slate-800 pt-5 text-sm"><div className="flex justify-between text-slate-400"><span>Basal energy (BMR)</span><span>{daily.bmr === null ? "Unavailable" : `${daily.bmr} kcal`}</span></div><div className="flex justify-between text-slate-400"><span>Imported exercise burn</span><span>{daily.active_calories === null ? "Unavailable" : `${daily.active_calories} kcal`}</span></div><div className="flex justify-between font-semibold"><span>Net energy</span><span className="text-emerald-400">{daily.net_energy === null ? "—" : `${daily.net_energy > 0 ? "+" : ""}${daily.net_energy} kcal`}</span></div><p className="text-xs leading-5 text-slate-500">Intake − BMR − exercise burn. This excludes other daily activity.</p>{daily.bmr === null && <Link href="/dashboard/settings" className="block text-xs text-emerald-400 underline">Complete your profile for BMR</Link>}{daily.active_calories === null && <p className="text-xs leading-5 text-slate-500">Exercise burn appears when all imported activities for this day include calorie data.</p>}</div>
          </>}
        </section>
        <section className="rounded-2xl border border-emerald-900/50 bg-gradient-to-br from-emerald-950/50 to-slate-900/30 p-5"><p className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><Camera size={17} />A clearer photo, a better estimate</p><ul className="mt-3 space-y-2 text-xs leading-5 text-slate-400"><li>Keep the whole plate in frame.</li><li>Use natural light and avoid heavy shadows.</li><li>Mention hidden oils, sauces, and workout context.</li></ul></section>
      </aside>
    </div>
    <section className={panel}><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Meal journal</h2><span className="text-xs text-slate-500">{day} · {daily?.meals.length ?? 0} meals</span></div>
      {!loading && !logError && daily?.meals.length === 0 && <div className="py-10 text-center"><Utensils size={28} className="mx-auto text-slate-600" /><p className="mt-3 text-sm text-slate-300">A fresh plate, a fresh start.</p><p className="mt-2 text-xs text-slate-500">Meals you confirm will appear here.</p></div>}
      {daily?.meals.map(meal => <details key={meal.id} className="border-t border-slate-800 py-4"><summary className="cursor-pointer text-sm"><span className="ml-2 font-medium">{meal.meal_name}</span><span className="ml-3 text-xs capitalize text-slate-500">{meal.meal_type ?? "Meal"} · {new Date(meal.logged_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span className="ml-3 text-emerald-400">{display(meal.total_calories)} kcal</span></summary><div className="mt-4 space-y-3 pl-5"><p className="text-xs text-slate-400">Protein {display(meal.protein_g)} g · Carbs {display(meal.carbs_g)} g · Fat {display(meal.fat_g)} g</p>{meal.items.map((item, index) => <p key={index} className="text-xs text-slate-400">{item.name} · {display(item.estimated_weight_g)} g · {display(item.calories)} kcal</p>)}<p className="text-xs leading-5 text-slate-500">{meal.training_context_note}</p>{confirmDelete === meal.id ? <div className="flex flex-wrap items-center gap-3 text-xs"><span>Delete this meal?</span><button disabled={!!deleting} onClick={() => void remove(meal.id)} className="text-rose-300">{deleting === meal.id ? "Deleting…" : "Yes, delete"}</button><button disabled={!!deleting} onClick={() => setConfirmDelete("")} className="text-slate-400">Keep meal</button></div> : <button onClick={() => setConfirmDelete(meal.id)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-rose-300"><Trash2 size={13} />Delete meal</button>}</div></details>)}
    </section>
  </div>;
}

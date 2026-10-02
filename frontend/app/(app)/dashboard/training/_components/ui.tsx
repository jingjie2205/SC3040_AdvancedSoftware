"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowRightLeft,
  BatteryLow,
  Bike,
  CalendarCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  Contrast,
  Dumbbell,
  Footprints,
  Leaf,
  Loader2,
  PersonStanding,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  ActivityType,
  IntensityBand,
  SessionStatus,
  Weekday,
} from "@/lib/training/types";

/* ------------------------------------------------------------------ */
/* Class strings (same look as the dashboard cards, buttons, inputs)   */
/* ------------------------------------------------------------------ */

export const cardClass =
  "rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md";

export const btnPrimary =
  "flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const btnSecondary =
  "flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";

export const btnDanger =
  "flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50";

export const btnHero =
  "flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-bold text-black shadow-lg shadow-emerald-500/20 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50";

export const inputClass =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500";

/* ------------------------------------------------------------------ */
/* Labels and per-value presentation                                   */
/* ------------------------------------------------------------------ */

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  run: "Run",
  gym: "Gym",
  cycling: "Cycling",
  bodyweight: "Bodyweight",
};

const ACTIVITY_ICON: Record<ActivityType, LucideIcon> = {
  run: Footprints,
  gym: Dumbbell,
  cycling: Bike,
  bodyweight: PersonStanding,
};

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export const BAND_META: Record<
  IntensityBand,
  { label: string; hint: string; icon: LucideIcon; classes: string; stroke: string }
> = {
  push: {
    label: "Push",
    hint: "Ready for hard training",
    icon: Zap,
    classes: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    stroke: "#10b981",
  },
  light: {
    label: "Light",
    hint: "Keep it easy today",
    icon: Leaf,
    classes: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    stroke: "#38bdf8",
  },
  deload: {
    label: "Deload",
    hint: "Prioritise recovery",
    icon: BatteryLow,
    classes: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    stroke: "#f59e0b",
  },
};

/**
 * Every status has its own icon, text label and border style,
 * so none of them depends on colour alone.
 */
export const STATUS_META: Record<
  SessionStatus,
  { label: string; icon: LucideIcon; classes: string }
> = {
  planned: {
    label: "Planned",
    icon: CircleDashed,
    classes: "border-dashed border-slate-500 bg-slate-800/40 text-slate-300",
  },
  accepted: {
    label: "Accepted",
    icon: CalendarCheck,
    classes: "border-solid border-sky-500/50 bg-sky-500/10 text-sky-300",
  },
  completed: {
    label: "Completed",
    icon: CircleCheck,
    classes: "border-solid border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  },
  partial: {
    label: "Partial",
    icon: Contrast,
    classes: "border-dotted border-amber-500/70 bg-amber-500/10 text-amber-300",
  },
  missed: {
    label: "Missed",
    icon: CircleX,
    classes: "border-solid border-rose-500/50 bg-rose-500/10 text-rose-300 line-through",
  },
  moved: {
    label: "Moved",
    icon: ArrowRightLeft,
    classes: "border-dashed border-violet-500/60 bg-violet-500/10 text-violet-300",
  },
};

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

export function ActivityIcon({
  type,
  className = "h-3.5 w-3.5",
}: {
  type: ActivityType;
  className?: string;
}) {
  const Icon = ACTIVITY_ICON[type];
  return <Icon className={className} aria-hidden="true" />;
}

export function BandBadge({ band }: { band: IntensityBand }) {
  const meta = BAND_META[band];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.classes}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.classes}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-rose-400">
      {message}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={btnSecondary}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  fill = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
  /** On phones, share the width equally and drop the icons so every label fits. */
  fill?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex max-w-full gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1 ${
        fill ? "w-full sm:w-fit" : "w-fit"
      }`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md py-1 text-xs font-semibold transition ${
            fill ? "flex-1 px-2 sm:flex-none sm:px-3" : "px-3"
          } ${
            value === option.value
              ? "bg-emerald-500 text-black"
              : "text-slate-400 hover:text-white"
          }`}
        >
          {option.icon && (
            <option.icon className={`h-3.5 w-3.5 ${fill ? "hidden sm:block" : ""}`} aria-hidden="true" />
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select chip. The check mark shows the pressed state without relying on colour. */
export function ToggleChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
        pressed
          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
          : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
      }`}
    >
      {pressed && <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs (native <dialog>: focus trap, Esc and backdrop for free)    */
/* ------------------------------------------------------------------ */

/** Mount it to open it, unmount it to close it. Fields marked `data-autofocus` get focus first. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressStartedOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-base font-bold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="space-y-3 text-sm text-slate-300">{children}</div>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={btnSecondary}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          data-autofocus
          className={tone === "danger" ? btnDanger : btnPrimary}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

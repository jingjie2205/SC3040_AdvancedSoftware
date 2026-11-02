"use client";

import React from "react";
import { X, Calendar, Clock, CheckCircle2 } from "lucide-react";
import { RecommendedPlannedSession, ActivityType, IntensityBand } from "../types";
import type { AddSessionInput } from "@/lib/training/schemas";

interface PlannedSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: RecommendedPlannedSession;
  setSession: React.Dispatch<React.SetStateAction<RecommendedPlannedSession>>;
  onSave: (input: AddSessionInput) => void;
  isSaving?: boolean;
}

const ACTIVITIES: ActivityType[] = ["run", "cycling", "gym", "bodyweight"];
const BANDS: IntensityBand[] = ["light", "push", "deload"];

export function PlannedSessionModal({
  isOpen,
  onClose,
  session,
  setSession,
  onSave,
  isSaving = false,
}: PlannedSessionModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
      <div className="relative w-full max-w-md bg-[#0F172A] border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-100 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Calendar className="w-5 h-5 text-emerald-400" />
              Schedule Planned Session
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Review session metrics before scheduling.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="space-y-4 text-xs">
          {/* Date & Activity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-400 mb-1">Date</label>
              <input
                type="date"
                value={session.date}
                onChange={(e) => setSession((prev) => ({ ...prev, date: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-400 mb-1">Activity</label>
              <select
                value={session.activity_type}
                onChange={(e) =>
                  setSession((prev) => ({
                    ...prev,
                    activity_type: e.target.value as ActivityType,
                  }))
                }
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white capitalize focus:outline-none focus:border-emerald-500"
              >
                {ACTIVITIES.map((act) => (
                  <option key={act} value={act} className="capitalize">
                    {act}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Duration & Intensity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-400 mb-1">Length (min)</label>
              <div className="relative">
                <input
                  type="number"
                  step="5"
                  min="5"
                  max="360"
                  value={session.target_duration_min}
                  onChange={(e) =>
                    setSession((prev) => ({
                      ...prev,
                      target_duration_min: Number(e.target.value),
                    }))
                  }
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
                <Clock className="w-3.5 h-3.5 text-slate-500 absolute right-3 top-2.5" />
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-400 mb-1">Intensity Band</label>
              <select
                value={session.intensity_band}
                onChange={(e) =>
                  setSession((prev) => ({
                    ...prev,
                    intensity_band: e.target.value as IntensityBand,
                  }))
                }
                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white capitalize focus:outline-none focus:border-emerald-500"
              >
                {BANDS.map((band) => (
                  <option key={band} value={band} className="capitalize">
                    {band}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div>
              <p className="text-[11px] text-slate-400">
                The session will be added as planned. Its target volume is calculated by the training plan.
              </p>
            </div>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onSave({
                date: session.date,
                activityType: session.activity_type,
                intensityBand: session.intensity_band,
                targetDurationMin: session.target_duration_min,
              })
            }
            disabled={isSaving}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold rounded-xl text-xs transition flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{isSaving ? "Saving..." : "Save to Schedule"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
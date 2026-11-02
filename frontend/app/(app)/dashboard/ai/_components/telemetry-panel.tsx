"use client";

import React from "react";
import { Flame, Activity, Dumbbell, Utensils, Plus } from "lucide-react";

interface TelemetryPanelProps {
  onOpenWorkoutModal: () => void;
  onOpenNutritionModal: () => void;
}

export function TelemetryPanel({ onOpenWorkoutModal, onOpenNutritionModal }: TelemetryPanelProps) {
  return (
    <div className="flex flex-col gap-5">
      {/* Record */}
      <div className="rounded-2xl bg-[#0B1220] border border-slate-800/70 p-5 space-y-3">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Record Generators
        </h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          Quickly edit and commit plans suggested by Gemini into your system database records.
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={onOpenWorkoutModal}
            className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#0F182A] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Dumbbell className="w-4 h-4 text-emerald-400" /> Open Workout Form
            </span>
            <Plus className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button
            onClick={onOpenNutritionModal}
            className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#0F182A] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Utensils className="w-4 h-4 text-amber-400" /> Open Nutrition Form
            </span>
            <Plus className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
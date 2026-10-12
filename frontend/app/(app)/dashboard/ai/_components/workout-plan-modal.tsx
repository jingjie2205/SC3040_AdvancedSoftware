"use client";

import React from "react";
import { Dumbbell, X, Plus, Trash2 } from "lucide-react";
import { WorkoutPlan } from "../types";

interface WorkoutPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan: WorkoutPlan;
  setPlan: React.Dispatch<React.SetStateAction<WorkoutPlan>>;
  onSave: () => void;
}

export function WorkoutPlanModal({
  isOpen,
  onClose,
  plan,
  setPlan,
  onSave,
}: WorkoutPlanModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#0B1220] border border-slate-800 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-2">
            <Dumbbell className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-bold text-white">Save Workout to Training Page</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Workout Title</label>
            <input
              type="text"
              value={plan.title}
              onChange={(e) => setPlan({ ...plan, title: e.target.value })}
              className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Focus / Objective</label>
            <input
              type="text"
              value={plan.focus}
              onChange={(e) => setPlan({ ...plan, focus: e.target.value })}
              className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-400">Exercises</label>
              <button
                type="button"
                onClick={() =>
                  setPlan({
                    ...plan,
                    exercises: [
                      ...plan.exercises,
                      { name: "New Exercise", sets: 3, reps: "10", targetWeight: "Bodyweight" },
                    ],
                  })
                }
                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add Exercise
              </button>
            </div>

            <div className="space-y-2.5">
              {plan.exercises.map((ex, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 bg-[#0F182A] p-3 rounded-xl border border-slate-800"
                >
                  <input
                    type="text"
                    value={ex.name}
                    onChange={(e) => {
                      const updated = [...plan.exercises];
                      updated[idx].name = e.target.value;
                      setPlan({ ...plan, exercises: updated });
                    }}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white"
                    placeholder="Exercise"
                  />
                  <input
                    type="number"
                    value={ex.sets}
                    onChange={(e) => {
                      const updated = [...plan.exercises];
                      updated[idx].sets = parseInt(e.target.value) || 0;
                      setPlan({ ...plan, exercises: updated });
                    }}
                    className="w-14 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white text-center"
                    placeholder="Sets"
                  />
                  <input
                    type="text"
                    value={ex.reps}
                    onChange={(e) => {
                      const updated = [...plan.exercises];
                      updated[idx].reps = e.target.value;
                      setPlan({ ...plan, exercises: updated });
                    }}
                    className="w-20 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white text-center"
                    placeholder="Reps"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const updated = plan.exercises.filter((_, i) => i !== idx);
                      setPlan({ ...plan, exercises: updated });
                    }}
                    className="text-slate-500 hover:text-red-400 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800/80">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            Save Workout Record
          </button>
        </div>
      </div>
    </div>
  );
}
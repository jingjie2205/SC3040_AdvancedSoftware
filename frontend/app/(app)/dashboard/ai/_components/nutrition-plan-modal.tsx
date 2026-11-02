"use client";

import React from "react";
import { Utensils, X, Trash2 } from "lucide-react";
import { NutritionPlan } from "../types";

interface NutritionPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan: NutritionPlan;
  setPlan: React.Dispatch<React.SetStateAction<NutritionPlan>>;
  onSave: () => void;
}

export function NutritionPlanModal({
  isOpen,
  onClose,
  plan,
  setPlan,
  onSave,
}: NutritionPlanModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#0B1220] border border-slate-800 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-2">
            <Utensils className="w-5 h-5 text-amber-400" />
            <h2 className="text-lg font-bold text-white">Save Plan to Nutrition Page</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Plan Title</label>
            <input
              type="text"
              value={plan.title}
              onChange={(e) => setPlan({ ...plan, title: e.target.value })}
              className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Target Calories (kcal)</label>
            <input
              type="number"
              value={plan.targetCalories}
              onChange={(e) =>
                setPlan({ ...plan, targetCalories: parseInt(e.target.value) || 0 })
              }
              className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Protein (g)</label>
              <input
                type="number"
                value={plan.proteinGrams}
                onChange={(e) =>
                  setPlan({ ...plan, proteinGrams: parseInt(e.target.value) || 0 })
                }
                className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 text-center"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Carbs (g)</label>
              <input
                type="number"
                value={plan.carbsGrams}
                onChange={(e) =>
                  setPlan({ ...plan, carbsGrams: parseInt(e.target.value) || 0 })
                }
                className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500 text-center"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Fat (g)</label>
              <input
                type="number"
                value={plan.fatGrams}
                onChange={(e) =>
                  setPlan({ ...plan, fatGrams: parseInt(e.target.value) || 0 })
                }
                className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-rose-500 text-center"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">Meal Highlights</label>
            <div className="space-y-2">
              {plan.mealHighlights.map((meal, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 bg-[#0F182A] p-2.5 rounded-xl border border-slate-800"
                >
                  <input
                    type="text"
                    value={meal}
                    onChange={(e) => {
                      const updated = [...plan.mealHighlights];
                      updated[idx] = e.target.value;
                      setPlan({ ...plan, mealHighlights: updated });
                    }}
                    className="flex-1 bg-transparent text-xs text-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const updated = plan.mealHighlights.filter((_, i) => i !== idx);
                      setPlan({ ...plan, mealHighlights: updated });
                    }}
                    className="text-slate-500 hover:text-red-400 p-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
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
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors"
          >
            Save Nutrition Record
          </button>
        </div>
      </div>
    </div>
  );
}
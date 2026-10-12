"use client";

import { useState, useMemo } from "react";
import { Calculator, Save, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { updateProfileMetrics } from "./actions";

// GET /users/me
interface ProfileFormProps {
  initialData?: any;
}

export default function ProfileForm({ initialData }: ProfileFormProps) {
  const [age, setAge] = useState<number>(initialData?.age || 25);
  const [weight, setWeight] = useState<number>(initialData?.weight || 70); // kg
  const [height, setHeight] = useState<number>(initialData?.height || 175); // cm
  
  const [sex, setSex] = useState<"MALE" | "FEMALE">(initialData?.biologicalSex || "MALE");
  const [activityEnum, setActivityEnum] = useState<string>(initialData?.activityLevel || "SEDENTARY");
  const [goalEnum, setGoalEnum] = useState<string>(initialData?.fitnessGoal || "MAINTAIN");

  const [isSaving, setIsSaving] = useState(false);
  const [hasSavedMetrics, setHasSavedMetrics] = useState(Boolean(
    initialData?.age && initialData?.weight && initialData?.height &&
    initialData?.biologicalSex && initialData?.activityLevel && initialData?.fitnessGoal
  ));

  const activityMultiplier: Record<string, number> = {
    "SEDENTARY": 1.2,
    "LIGHTLY_ACTIVE": 1.375,
    "MODERATELY_ACTIVE": 1.55,
    "VERY_ACTIVE": 1.725,
    "EXTRA_ACTIVE": 1.9
  };

  const goalCalorieOffset: Record<string, number> = {
    "DEFICIT": -500,
    "MAINTAIN": 0,
    "SURPLUS": 500
  };

  // Mifflin-St Jeor Equation & Macro Calculations
  const stats = useMemo(() => {
    let bmr = (10 * weight) + (6.25 * height) - (5 * age);
    bmr = sex === "MALE" ? bmr + 5 : bmr - 161;

    const currentActivityMultiplier = activityMultiplier[activityEnum] || 1.2;
    const currentGoalOffset = goalCalorieOffset[goalEnum] || 0;

    const tdee = bmr * currentActivityMultiplier;
    const targetCalories = tdee + currentGoalOffset;

    const protein = weight * 2;
    const fats = weight * 1;
    
    const remainingKcal = targetCalories - (protein * 4) - (fats * 9);
    const carbs = Math.max(0, remainingKcal / 4);

    return {
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      calories: Math.round(targetCalories),
      protein: Math.round(protein),
      fats: Math.round(fats),
      carbs: Math.round(carbs),
    };
  }, [age, weight, height, sex, activityEnum, goalEnum]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateProfileMetrics({
        age,
        weight,
        height,
        biologicalSex: sex,
        activityLevel: activityEnum,
        fitnessGoal: goalEnum,
      });
      toast.success("Profile metrics updated successfully");
      setHasSavedMetrics(true);
    } catch (error: any) {
      toast.error(error?.message || "Failed to update profile metrics");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm">
      {!hasSavedMetrics && <p role="status" className="mb-5 rounded-xl border border-amber-900 bg-amber-950/30 p-4 text-sm text-amber-200">
        Your calorie target is a preview using the values below. Check your details and save your profile to use this target as the default in your nutrition calendar.
      </p>}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
          <Calculator className="h-6 w-6" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-white">Profile & TDEE Engine</h3>
          <p className="mt-1 text-xs text-slate-400">
            Configure your biological metrics to calculate baseline energy expenditure.
          </p>
        </div>
      </div>

      <div className="mb-8 rounded-xl bg-slate-800/40 border border-slate-700/50 p-4">
        <div className="flex gap-3">
          <Info className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
          <div className="space-y-2 text-sm text-slate-300">
            <p>
              <strong className="text-emerald-400 font-semibold">Basal Metabolic Rate (BMR)</strong> is the baseline number of calories your body needs to maintain basic life functions (like breathing and circulation) while at complete rest.
            </p>
            <p>
              <strong className="text-emerald-400 font-semibold">Total Daily Energy Expenditure (TDEE)</strong> multiplies your BMR by your daily activity level to estimate the total calories you burn in a day. We use this to calculate your target macronutrients.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Input Form */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">Age (years)</label>
              <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition-all" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">Sex</label>
              <select value={sex} onChange={(e) => setSex(e.target.value as "MALE" | "FEMALE")} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 outline-none">
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">Weight (kg)</label>
              <input type="number" value={weight} onChange={(e) => setWeight(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 outline-none" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">Height (cm)</label>
              <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 outline-none" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Activity Level</label>
            <select value={activityEnum} onChange={(e) => setActivityEnum(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 outline-none">
              <option value="SEDENTARY">Sedentary (Little to no exercise)</option>
              <option value="LIGHTLY_ACTIVE">Lightly Active (1-3 days/week)</option>
              <option value="MODERATELY_ACTIVE">Moderately Active (3-5 days/week)</option>
              <option value="VERY_ACTIVE">Very Active (6-7 days/week)</option>
              <option value="EXTRA_ACTIVE">Extra Active (Physical job + training)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Fitness Goal</label>
            <select value={goalEnum} onChange={(e) => setGoalEnum(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 outline-none">
              <option value="DEFICIT">Deficit (-500 kcal for Weight Loss)</option>
              <option value="MAINTAIN">Maintenance (Maintain Weight)</option>
              <option value="SURPLUS">Surplus (+500 kcal for Muscle Gain)</option>
            </select>
          </div>
          
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isSaving ? "Saving..." : "Save Profile Metrics"}
          </button>
        </div>

        {/* Real-time Results Output */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 flex flex-col justify-center">
          <div className="grid grid-cols-2 gap-4 mb-6 text-center">
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
              <p className="text-xs text-slate-400 mb-1">Base Metabolic Rate</p>
              <p className="text-xl font-bold text-white">{stats.bmr} <span className="text-xs font-normal text-slate-500">kcal</span></p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
              <p className="text-xs text-slate-400 mb-1">Daily TDEE</p>
              <p className="text-xl font-bold text-emerald-400">{stats.tdee} <span className="text-xs font-normal text-emerald-600/50">kcal</span></p>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-slate-300 border-b border-slate-800 pb-2">Target Daily Macros ({stats.calories} kcal)</h4>
            
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Protein (2g/kg)</span>
              <span className="font-semibold text-white">{stats.protein}g</span>
            </div>
            {/* Visual Bar */}
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-blue-400 h-full" style={{ width: `${(stats.protein * 4 / stats.calories) * 100}%` }}></div>
            </div>

            <div className="flex justify-between items-center text-sm pt-2">
              <span className="text-slate-400">Carbohydrates</span>
              <span className="font-semibold text-white">{stats.carbs}g</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-amber-400 h-full" style={{ width: `${(stats.carbs * 4 / stats.calories) * 100}%` }}></div>
            </div>

            <div className="flex justify-between items-center text-sm pt-2">
              <span className="text-slate-400">Fats (1g/kg)</span>
              <span className="font-semibold text-white">{stats.fats}g</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-rose-400 h-full" style={{ width: `${(stats.fats * 9 / stats.calories) * 100}%` }}></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

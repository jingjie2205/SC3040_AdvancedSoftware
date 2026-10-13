"use client";

import { useEffect, useState } from "react";
import { fetchBatchCalories, fetchCalorieCalendar } from "@/lib/nutrition";
import { addDays, startOfWeek, todayISO } from "@/lib/training/dates";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  type TooltipProps,
} from "recharts";

type FoodView = "daily" | "weekly";
type FoodChartData = {
  label: string;
  intake: number;
  goal: number;
  averageIntake?: number;
  averageGoal?: number;
};
type Profile = {
  age?: number;
  weight?: number;
  height?: number;
  biologicalSex?: "MALE" | "FEMALE";
  activityLevel?: string;
};

const activityMultiplier: Record<string, number> = {
  SEDENTARY: 1.2,
  LIGHTLY_ACTIVE: 1.375,
  MODERATELY_ACTIVE: 1.55,
  VERY_ACTIVE: 1.725,
  EXTRA_ACTIVE: 1.9,
};

function calculateTdee(profile: Profile): number | null {
  if (
    profile.age == null ||
    profile.weight == null ||
    profile.height == null ||
    !profile.biologicalSex ||
    !profile.activityLevel
  ) {
    return null;
  }

  const bmr =
    10 * profile.weight +
    6.25 * profile.height -
    5 * profile.age +
    (profile.biologicalSex === "MALE" ? 5 : -161);
  const multiplier = activityMultiplier[profile.activityLevel];
  return multiplier ? Math.round(bmr * multiplier) : null;
}

export default function FoodConsumption() {
  const [foodView, setFoodView] = useState<FoodView>("daily");
  const [dailyFoodData, setDailyFoodData] = useState<FoodChartData[]>([]);
  const [weeklyFoodData, setWeeklyFoodData] = useState<FoodChartData[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchFoodData() {
      const endDate = todayISO();
      const startDate = addDays(endDate, -34);
      const [results, calendar, profileResponse] = await Promise.all([
        fetchBatchCalories(startDate, endDate),
        Promise.all([
          fetchCalorieCalendar(startDate, addDays(startDate, 30)),
          fetchCalorieCalendar(addDays(startDate, 31), endDate),
        ]).then(([firstRange, secondRange]) => [...firstRange, ...secondRange]),
        fetch("/api/user"),
      ]);
      const logsByDate = new Map(results.map((log) => [log.date, log]));
      const targetsByDate = new Map(calendar.map((day) => [day.date, day]));
      if (!profileResponse.ok) {
        throw new Error("Could not load your profile for calorie goals.");
      }
      const tdee = calculateTdee((await profileResponse.json()) as Profile);

      const goalFor = (date: string) =>
        targetsByDate.get(date)?.target_calories ?? tdee ?? 0;

      // Process daily data
      const dailyData: FoodChartData[] = [];
      for (let i = 6; i >= 0; i--) {
        const dateString = addDays(endDate, -i);
        const day = new Date(`${dateString}T12:00:00`);
        const log = logsByDate.get(dateString);
        const intake = log?.total_calories || 0;
        const label = `${day.getMonth() + 1}/${day.getDate()}`;
        dailyData.push({ label, intake, goal: goalFor(dateString) });
      }
      setDailyFoodData(dailyData);

      // Process weekly data
      const weeklyData: FoodChartData[] = [];
      for (let i = 4; i >= 0; i--) {
        const weekStartDate = addDays(startOfWeek(endDate), -i * 7);
        const weekEndDate = addDays(weekStartDate, 6);

        let totalCalories = 0;
        let goal = 0;

        for (let j = 0; j < 7; j++) {
          const dateString = addDays(weekStartDate, j);
          const log = logsByDate.get(dateString);
          goal += goalFor(dateString);
          if (log && log.total_calories) {
            totalCalories += log.total_calories;
          }
        }

        const averageIntake = Math.round(totalCalories / 7);
        const intake = totalCalories;
        const averageGoal = Math.round(goal / 7);
        const weekStart = new Date(`${weekStartDate}T12:00:00`);
        const weekEnd = new Date(`${weekEndDate}T12:00:00`);
        const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${
          weekEnd.getMonth() + 1
        }/${weekEnd.getDate()}`;
        weeklyData.push({ label, intake, goal, averageIntake, averageGoal });
      }
      setWeeklyFoodData(weeklyData);
    }
    fetchFoodData()
      .catch((error: unknown) => {
        console.error("Error fetching food consumption data:", error);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const foodData = foodView === "daily" ? dailyFoodData : weeklyFoodData;

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-white">Food consumption</h3>
          <p className="text-xs text-slate-400">Calorie intake</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1 w-fit">
          {(["daily", "weekly"] as FoodView[]).map((view) => (
            <button
              key={view}
              onClick={() => setFoodView(view)}
              className={`px-3 py-1 rounded-md text-xs font-semibold capitalize transition ${
                foodView === view
                  ? "bg-emerald-500 text-black"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {view}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[240px] w-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Loading data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={foodData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#ffffff" fontSize={11} />
              <Legend
                wrapperStyle={{ color: "#cbd5e1", fontSize: "12px", paddingTop: "8px" }}
              />
              <Tooltip
                cursor={{ fill: "rgba(100, 116, 139, 0.1)" }}
                content={CustomTooltip}
              />
              <Bar dataKey="intake" radius={[4, 4, 0, 0]} name="Consumed" fill="#10b981" />
              <Bar dataKey="goal" radius={[4, 4, 0, 0]} name="Target" fill="#f97316" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  const data = payload?.find(entry => entry.payload)?.payload as FoodChartData | undefined;
  if (active && data) {

    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-2 text-sm shadow-sm backdrop-blur-md">
        <div className="mb-1 font-bold text-white">{label}</div>
        <div className="space-y-1 text-xs">
          {data.averageIntake !== undefined ? (
            <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Total Weekly Intake</span>
                <span className="font-medium text-white">
                  {data.intake} kcal
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Avg. Daily Intake</span>
                <span className="font-medium text-white">
                  {data.averageIntake} kcal
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Daily Intake</span>
              <span className="font-medium text-white">{data.intake} kcal</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-slate-400">
              {data.averageGoal !== undefined ? "Avg. Daily Target" : "Target"}
            </span>
            <span className="font-medium text-white">
              {data.averageGoal ?? data.goal} kcal
            </span>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

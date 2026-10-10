"use client";

import { useEffect, useState } from "react";
import { fetchBatchCalories } from "@/lib/nutrition";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

type FoodView = "daily" | "weekly";

export default function FoodConsumption() {
  const [foodView, setFoodView] = useState<FoodView>("daily");
  const [dailyFoodData, setDailyFoodData] = useState<any[]>([]);
  const [weeklyFoodData, setWeeklyFoodData] = useState<any[]>([]);

  useEffect(() => {
    async function fetchFoodData() {
      const today = new Date();
      const endDate = today.toISOString().split("T")[0];
      const startDate = new Date();
      startDate.setDate(today.getDate() - 34);
      const startDateString = startDate.toISOString().split("T")[0];

      const results = await fetchBatchCalories(startDateString, endDate);
      const logsByDate = new Map(results.map((log) => [log.date, log]));

      // Process daily data
      const dailyData = [];
      for (let i = 6; i >= 0; i--) {
        const day = new Date();
        day.setDate(today.getDate() - i);
        const dateString = day.toISOString().split("T")[0];
        const log = logsByDate.get(dateString);
        const intake = log?.total_calories || 0;
        const goal = 2300; // Default goal
        const label = `${day.getMonth() + 1}/${day.getDate()}`;
        dailyData.push({ label, intake, goal });
      }
      setDailyFoodData(dailyData);

      // Process weekly data
      const weeklyData = [];
      for (let i = 4; i >= 0; i--) {
        const weekStart = new Date();
        weekStart.setDate(today.getDate() - i * 7 - today.getDay() + 1);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        let totalCalories = 0;
        let daysWithData = 0;

        for (let j = 0; j < 7; j++) {
          const day = new Date(weekStart);
          day.setDate(weekStart.getDate() + j);
          const dateString = day.toISOString().split("T")[0];
          const log = logsByDate.get(dateString);
          if (log && log.total_calories) {
            totalCalories += log.total_calories;
            daysWithData++;
          }
        }

        const averageIntake =
          daysWithData > 0 ? Math.round(totalCalories / daysWithData) : 0;
        const intake = totalCalories;
        const goal = 2300; // Default goal
        const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${
          weekEnd.getMonth() + 1
        }/${weekEnd.getDate()}`;
        weeklyData.push({ label, intake, goal, averageIntake });
      }
      setWeeklyFoodData(weeklyData);
    }
    fetchFoodData();
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
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={foodData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
            <YAxis stroke="#ffffff" fontSize={11} />
            <Tooltip
              cursor={{ fill: "rgba(100, 116, 139, 0.1)" }}
              content={CustomTooltip}
            />
            <Bar dataKey="intake" radius={[4, 4, 0, 0]} name="Calories">
              {foodData.map((entry, idx) => (
                <Cell
                  key={idx}
                  fill={entry.intake > entry.goal ? "#f59e0b" : "#10b981"}
                />
              ))}
            </Bar>
            <Line
              type="monotone"
              dataKey="goal"
              stroke="#94a3b8"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              dot={false}
              name="Goal"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;

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
            <span className="text-slate-400">Goal</span>
            <span className="font-medium text-white">{data.goal} kcal</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

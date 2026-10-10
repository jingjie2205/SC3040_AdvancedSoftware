"use client";

import { useEffect, useMemo, useState } from "react";
import { httpTrainingApi } from "@/lib/training/http-api";
import { WorkoutSession } from "@/lib/training/types";
import { getActivityIcon } from "./icons";
import { Heart, Flame } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

type TrainingView = "daily" | "latest";

export default function TrainingOverview() {
  const [trainingView, setTrainingView] = useState<TrainingView>("latest");
  const [latestWorkout, setLatestWorkout] = useState<WorkoutSession | null>(
    null,
  );
  const [weeklyWorkouts, setWeeklyWorkouts] = useState<WorkoutSession[]>([]);

  useEffect(() => {
    async function fetchLatestWorkout() {
      const today = new Date();
      const to = today.toISOString().split("T")[0];
      const from = new Date();
      from.setDate(today.getDate() - 6);
      const fromDate = from.toISOString().split("T")[0];

      try {
        const schedule = await httpTrainingApi.getSchedule(fromDate, to);
        const sortedWorkouts = [...schedule.workouts].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        if (sortedWorkouts.length > 0) {
          setLatestWorkout(sortedWorkouts[0]);
        }
        setWeeklyWorkouts(schedule.workouts);
      } catch (error) {
        console.error("Failed to fetch latest workout:", error);
      }
    }
    fetchLatestWorkout();
  }, []);

  const dailyTrainingData = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyData: Record<
      string,
      { volume: number; duration: number; calories: number }
    > = {};
    let totalVolume = 0;
    let totalDuration = 0;
    let totalCalories = 0;

    // Initialize the last 7 days
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateString = date.toLocaleDateString("en-US", { weekday: "short" });
      dailyData[dateString] = { volume: 0, duration: 0, calories: 0 };
    }

    weeklyWorkouts.forEach((workout) => {
      const workoutDate = new Date(workout.createdAt);
      workoutDate.setHours(0, 0, 0, 0);
      const diffDays = Math.floor(
        (today.getTime() - workoutDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (diffDays >= 0 && diffDays <= 6) {
        const dateString = workoutDate.toLocaleDateString("en-US", {
          weekday: "short",
        });
        dailyData[dateString].volume += workout.actualVolume || 0;
        dailyData[dateString].duration += workout.actualDurationMin || 0;
        dailyData[dateString].calories += workout.calories || 0;

        totalVolume += workout.actualVolume || 0;
        totalDuration += workout.actualDurationMin || 0;
        totalCalories += workout.calories || 0;
      }
    });

    const chartData = Object.keys(dailyData).map((label) => ({
      label,
      ...dailyData[label],
    }));

    return {
      chartData,
      totalVolume,
      totalDuration,
      totalCalories,
    };
  }, [weeklyWorkouts]);

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-md">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-white">Training overview</h3>
          <p className="text-xs text-slate-400">
            Mileage and average heart rate
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1 w-fit">
          {(["daily", "latest"] as TrainingView[]).map((view) => (
            <button
              key={view}
              onClick={() => setTrainingView(view)}
              className={`px-3 py-1 rounded-md text-xs font-semibold capitalize transition ${
                trainingView === view
                  ? "bg-emerald-500 text-black"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {view}
            </button>
          ))}
        </div>
      </div>

      {trainingView === "latest" ? (
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
          {latestWorkout ? (
            (() => {
              const ActivityIcon = getActivityIcon(latestWorkout.activityType);
              return (
                <>
                  <div className="sm:col-span-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-white">
                      <ActivityIcon className="h-4 w-4 text-emerald-400" />
                      {latestWorkout.activityType}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(latestWorkout.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <StatBlock
                    label="Volume"
                    value={`${latestWorkout.actualVolume} points`}
                  />
                  <StatBlock
                    label="Duration"
                    value={`${latestWorkout.actualDurationMin} min`}
                  />
                  <StatBlock
                    label="Avg HR"
                    value={
                      latestWorkout.avgHr ? `${latestWorkout.avgHr} bpm` : "-"
                    }
                    icon={<Heart className="h-3.5 w-3.5 text-rose-400" />}
                  />
                  <StatBlock
                    label="RPE"
                    value={latestWorkout.rpe ? String(latestWorkout.rpe) : "-"}
                  />
                  <StatBlock
                    label="Calories"
                    value={
                      latestWorkout.calories
                        ? `${latestWorkout.calories} kcal`
                        : "-"
                    }
                    icon={<Flame className="h-3.5 w-3.5 text-amber-400" />}
                  />
                </>
              );
            })()
          ) : (
            <div className="sm:col-span-5 text-center py-8 text-slate-400">
              No recent workouts found.
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 flex flex-col gap-4 justify-center">
            <StatBlock
              label="Total Volume"
              value={`${dailyTrainingData.totalVolume} pts`}
            />
            <StatBlock
              label="Total Duration"
              value={`${dailyTrainingData.totalDuration} min`}
            />
            <StatBlock
              label="Total Calories"
              value={`${dailyTrainingData.totalCalories} kcal`}
              icon={<Flame className="h-3.5 w-3.5 text-amber-400" />}
            />
          </div>
          <div className="lg:col-span-2 h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyTrainingData.chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e293b"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  cursor={{ fill: "#1e293b" }}
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
                          <p className="mb-2 text-sm font-bold text-white">
                            {label}
                          </p>
                          <div className="space-y-1">
                            <p className="text-xs text-slate-300">
                              <span className="inline-block w-16 text-slate-400">
                                Volume:
                              </span>
                              <span className="font-semibold">
                                {data.volume} pts
                              </span>
                            </p>
                            <p className="text-xs text-slate-300">
                              <span className="inline-block w-16 text-slate-400">
                                Duration:
                              </span>
                              <span className="font-semibold">
                                {data.duration} min
                              </span>
                            </p>
                            <p className="text-xs text-slate-300">
                              <span className="inline-block w-16 text-slate-400">
                                Calories:
                              </span>
                              <span className="font-semibold text-amber-400">
                                {data.calories} kcal
                              </span>
                            </p>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar
                  dataKey="volume"
                  fill="#10b981"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBlock({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <span className="text-xs text-slate-400 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <div className="mt-2 text-lg font-black text-white">{value}</div>
    </div>
  );
}

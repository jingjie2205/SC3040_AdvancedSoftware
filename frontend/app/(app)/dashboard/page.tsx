"use client";

import { useEffect, useMemo, useState } from "react";
import Calendar from "./components/calendar";
import TrainingOverview from "./components/training-overview";
import FoodConsumption from "./components/food-consumption";
import HealthData from "./components/health-data";

import { useRouter } from "next/navigation";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HomePage() {
  const router = useRouter();

  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-6xl space-y-8 px-4 sm:px-8">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              Today
            </h1>
            <p className="text-sm text-slate-400">
              Your health, training and nutrition, all in one place.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {syncMessage && (
              <span className="text-xs font-medium text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20 w-fit">
                {syncMessage}
              </span>
            )}
          </div>
        </div>

        {/* Health data + Check-in row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Health data overview & editing */}
          <HealthData />

          {/* Daily check-in */}
          <Calendar />
        </div>

        {/* Training overview */}
        <TrainingOverview />

        {/* Food consumption overview */}
        <FoodConsumption />
      </div>
    </div>
  );
}

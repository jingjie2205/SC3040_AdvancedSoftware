"use client";

import React, { useRef, useEffect } from "react";
import {
  Bot,
  User,
  Send,
  Calendar,
  Clock,
  Zap,
  Activity,
  ArrowRight,
  Utensils,
} from "lucide-react";
import {
  Message,
  RecommendedPlannedSession,
  NutritionPlan,
  NutritionScheduleDay,
  WeeklyTrainingDay,
} from "../types";

function PlannedSessionCard({
  session,
  onReview,
}: {
  session: RecommendedPlannedSession;
  onReview: (session: RecommendedPlannedSession) => void;
}) {
  return (
    <div className="mt-1 p-3.5 bg-slate-900/90 border border-emerald-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-emerald-950/20 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
          <Calendar className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-100 capitalize">
              {session.activity_type}
            </span>
            <span
              className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                session.intensity_band === "push"
                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  : session.intensity_band === "deload"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              }`}
            >
              {session.intensity_band}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-500" />
              {session.target_duration_min} min
            </span>
            <span>•</span>
            <span>{session.date}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onReview(session)}
        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors shadow shrink-0 cursor-pointer"
      >
        <span>Review Session</span>
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function WeeklyTrainingCard({
  day,
  onReview,
}: {
  day: WeeklyTrainingDay;
  onReview: (session: RecommendedPlannedSession) => void;
}) {
  const session = toRecommendedSession(day);

  if (!session) {
    return (
      <div className="mt-1 p-3.5 bg-slate-900/90 border border-slate-700 rounded-xl flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 shrink-0">
          <Calendar className="w-4 h-4" />
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-200">Rest day</p>
          <p className="text-[11px] text-slate-400">{day.date}</p>
        </div>
      </div>
    );
  }

  return <PlannedSessionCard session={session} onReview={onReview} />;
}

function toRecommendedSession(
  day: WeeklyTrainingDay,
): RecommendedPlannedSession | null {
  if (
    day.activity_type === "rest" ||
    day.target_duration_min === null ||
    day.intensity_band === null
  ) {
    return null;
  }

  return {
    date: day.date,
    activity_type: day.activity_type,
    target_duration_min: day.target_duration_min,
    intensity_band: day.intensity_band,
    target_volume: day.target_volume ?? null,
    status: "planned",
  };
}

interface ChatPanelProps {
  messages: Message[];
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  onSend: (text?: string) => void;
  onOpenPlannedSessionModal: (session: RecommendedPlannedSession) => void;
  onOpenNutritionModal?: (plan?: NutritionPlan | null) => void;
  onSaveNutritionSchedule?: (
    schedule: NutritionScheduleDay[],
    messageId: string,
  ) => void;
  savingNutritionMessageId?: string | null;
}

export function ChatPanel({
  messages,
  input,
  setInput,
  isLoading,
  onSend,
  onOpenPlannedSessionModal,
  onOpenNutritionModal,
  onSaveNutritionSchedule,
  savingNutritionMessageId,
}: ChatPanelProps) {
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const quickPrompts = [
    { label: "Plan a week's worth of training", icon: Calendar },
    {
      label: "Plan my calorie intake for this week's training",
      icon: Utensils,
    },
  ];

  return (
    <div className="flex flex-col h-[750px] rounded-2xl bg-[#0B1220] border border-slate-800/70 overflow-hidden shadow-2xl">
      {/* Sub-bar */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-800/80 bg-[#090F1B]/90">
        <div className="flex items-center gap-2.5">
          <Bot className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold text-slate-200">
            Fitra Training Copilot
          </span>
        </div>
        <span className="text-[11px] text-slate-400 bg-slate-900 border border-slate-800 px-2.5 py-0.5 rounded-md">
          Schedule Sync Enabled
        </span>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3.5 max-w-[88%] ${
              msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
            }`}
          >
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                msg.role === "assistant"
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                  : "bg-slate-800 border border-slate-700 text-slate-200"
              }`}
            >
              {msg.role === "assistant" ? (
                <Bot className="w-4 h-4" />
              ) : (
                <User className="w-4 h-4" />
              )}
            </div>

            <div className="flex flex-col gap-2 max-w-full">
              {/* Message Bubble */}
              <div
                className={`rounded-2xl px-4 py-3.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-emerald-600 text-white font-medium rounded-tr-none"
                    : "bg-[#0F182A] border border-slate-800 text-slate-200 rounded-tl-none shadow-sm whitespace-pre-wrap"
                }`}
              >
                {msg.content}
                <div
                  className={`mt-1.5 text-[10px] ${
                    msg.role === "user"
                      ? "text-emerald-200/80 text-right"
                      : "text-slate-400"
                  }`}
                >
                  {msg.timestamp}
                </div>
              </div>

              {/* Planned Session Recommendation Card */}
              {msg.role === "assistant" && msg.plannedSession && (
                <PlannedSessionCard
                  session={msg.plannedSession}
                  onReview={onOpenPlannedSessionModal}
                />
              )}

              {/* Optional Nutrition Plan Trigger */}
              {msg.role === "assistant" &&
                msg.hasNutritionPlan &&
                onOpenNutritionModal && (
                  <div className="pt-1 pl-1">
                    <button
                      type="button"
                      onClick={() => onOpenNutritionModal(msg.nutritionPlan)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors"
                    >
                      <Utensils className="w-3.5 h-3.5" />
                      Review Nutrition Plan
                    </button>
                  </div>
                )}

              {msg.role === "assistant" &&
                msg.nutritionSchedule &&
                msg.nutritionSchedule.length > 0 && (
                  <div className="mt-1 overflow-hidden rounded-xl border border-cyan-500/30 bg-slate-900/90 shadow-lg shadow-cyan-950/20">
                    <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
                      <Utensils className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-semibold text-slate-100">
                        Recommended daily calorie targets
                      </span>
                    </div>
                    <div className="grid grid-cols-2 text-xs">
                      <div className="border-b border-slate-800 px-4 py-2 font-semibold text-slate-400">
                        Activity
                      </div>
                      <div className="border-b border-l border-slate-800 px-4 py-2 text-right font-semibold text-slate-400">
                        Target calories
                      </div>
                      {msg.nutritionSchedule.map((day) => (
                        <React.Fragment key={day.date}>
                          <div className="border-b border-slate-800 px-4 py-2.5 text-slate-200">
                            <span className="capitalize">{day.activity}</span>
                            <span className="ml-2 text-[10px] text-slate-500">
                              {day.date}
                            </span>
                          </div>
                          <div className="border-b border-l border-slate-800 px-4 py-2.5 text-right font-semibold tabular-nums text-cyan-300">
                            {day.targetCalories.toLocaleString()} kcal
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                    {onSaveNutritionSchedule && (
                      <div className="border-t border-slate-800 p-3">
                        <button
                          type="button"
                          onClick={() =>
                            onSaveNutritionSchedule(
                              msg.nutritionSchedule!,
                              msg.id,
                            )
                          }
                          disabled={savingNutritionMessageId === msg.id}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cyan-400 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Utensils className="h-3.5 w-3.5" />
                          {savingNutritionMessageId === msg.id
                            ? "Adding to nutritional plan..."
                            : "Add to nutritional plan"}
                        </button>
                      </div>
                    )}

                  </div>
                )}

              {msg.role === "assistant" &&
                msg.weeklyTrainingPlan &&
                msg.weeklyTrainingPlan.length > 0 && (
                  <div className="mt-1 space-y-2">
                    <div className="flex items-center gap-2 px-1 pt-1">
                      <Calendar className="h-4 w-4 text-emerald-400" />
                      <span className="text-xs font-semibold text-slate-100">
                        Weekly training plan
                      </span>
                    </div>
                    {msg.weeklyTrainingPlan.map((day) => (
                      <WeeklyTrainingCard
                        key={day.date}
                        day={day}
                        onReview={onOpenPlannedSessionModal}
                      />
                    ))}
                  </div>
                )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3 max-w-[80%] mr-auto items-center">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 animate-spin" />
            </div>
            <div className="bg-[#0F182A] border border-slate-800 text-slate-400 rounded-2xl rounded-tl-none px-4 py-3 text-xs flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-bounce"></span>
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.2s]"></span>
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:0.4s]"></span>
            </div>
          </div>
        )}
        <div ref={chatBottomRef} />
      </div>

      {/* Quick Prompts */}
      <div className="px-6 py-2.5 bg-[#090F1B]/70 border-t border-slate-800/40 flex items-center gap-2 overflow-x-auto scrollbar-none">
        {quickPrompts.map((item, idx) => (
          <button
            key={idx}
            onClick={() => onSend(item.label)}
            className="flex items-center gap-1.5 whitespace-nowrap bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs px-3 py-1.5 rounded-full transition-colors shrink-0"
          >
            <item.icon className="w-3.5 h-3.5 text-emerald-400" />
            {item.label}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <div className="p-4 border-t border-slate-800/80 bg-[#090F1B]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
          className="flex items-center gap-2 relative"
        >
          <input
            type="text"
            placeholder="Ask AI to recommend your next session (e.g., 'Plan a 45m threshold run for Tuesday')..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full bg-[#0F182A] border border-slate-800 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/80 focus:border-emerald-500/80 transition-all pr-12"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="absolute right-2 p-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:hover:bg-emerald-600 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

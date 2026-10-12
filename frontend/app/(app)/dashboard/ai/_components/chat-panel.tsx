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
import { Message, RecommendedPlannedSession, NutritionPlan } from "../types";

interface ChatPanelProps {
  messages: Message[];
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  onSend: (text?: string) => void;
  onOpenPlannedSessionModal: (session: RecommendedPlannedSession) => void;
  onOpenNutritionModal?: (plan?: NutritionPlan | null) => void;
}

export function ChatPanel({
  messages,
  input,
  setInput,
  isLoading,
  onSend,
  onOpenPlannedSessionModal,
  onOpenNutritionModal,
}: ChatPanelProps) {
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const quickPrompts = [
    { label: "Plan a threshold interval run for tomorrow", icon: Activity },
    { label: "Schedule an active recovery session", icon: Calendar },
    { label: "Suggest weekly deload session timing", icon: Zap },
  ];

  return (
    <div className="flex flex-col h-[750px] rounded-2xl bg-[#0B1220] border border-slate-800/70 overflow-hidden shadow-2xl">
      {/* Sub-bar */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-800/80 bg-[#090F1B]/90">
        <div className="flex items-center gap-2.5">
          <Bot className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold text-slate-200">Fitra Training Copilot</span>
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
              {msg.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
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
                    msg.role === "user" ? "text-emerald-200/80 text-right" : "text-slate-400"
                  }`}
                >
                  {msg.timestamp}
                </div>
              </div>

              {/* Planned Session Recommendation Card */}
              {msg.role === "assistant" && msg.plannedSession && (
                <div className="mt-1 p-3.5 bg-slate-900/90 border border-emerald-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-emerald-950/20 backdrop-blur-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-100 capitalize">
                          {msg.plannedSession.activity_type}
                        </span>
                        <span
                          className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                            msg.plannedSession.intensity_band === "push"
                              ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                              : msg.plannedSession.intensity_band === "deload"
                              ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                              : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          }`}
                        >
                          {msg.plannedSession.intensity_band}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-500" />
                          {msg.plannedSession.target_duration_min} min
                        </span>
                        <span>•</span>
                        <span>{msg.plannedSession.date}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenPlannedSessionModal(msg.plannedSession!)}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors shadow shrink-0 cursor-pointer"
                  >
                    <span>Review Session</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Optional Nutrition Plan Trigger */}
              {msg.role === "assistant" && msg.hasNutritionPlan && onOpenNutritionModal && (
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
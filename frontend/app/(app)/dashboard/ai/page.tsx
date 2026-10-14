"use client";

import React, { useState, useEffect } from "react";
import { Sparkles, CheckCircle, AlertCircle } from "lucide-react";
import {
  Message,
  RecommendedPlannedSession,
  NutritionPlan,
  WeeklyTrainingDay,
} from "./types";
import { ChatPanel } from "./_components/chat-panel";
import { TelemetryPanel } from "./_components/telemetry-panel";
import { SessionSidebar } from "./_components/session-sidebar";
import { PlannedSessionModal } from "./_components/planned-session-modal";
import { NutritionPlanModal } from "./_components/nutrition-plan-modal";
import { chatApi, ApiSession, ApiMessage } from "@/app/api/chat";
import type { NutritionScheduleDay } from "@/app/api/chat";
import { trainingApi } from "@/lib/training/api";
import type { AddSessionInput } from "@/lib/training/schemas";
import { saveCalorieTargets } from "@/lib/nutrition";
import { addDays, todayISO } from "@/lib/training/dates";

export default function AIAssistancePage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);

  // Modal dialog states
  const [plannedSessionModalOpen, setPlannedSessionModalOpen] = useState(false);
  const [nutritionModalOpen, setNutritionModalOpen] = useState(false);
  const [isSavingPlannedSession, setIsSavingPlannedSession] = useState(false);
  const [savingNutritionMessageId, setSavingNutritionMessageId] = useState<
    string | null
  >(null);

  // Active planned session
  const [activePlannedSession, setActivePlannedSession] =
    useState<RecommendedPlannedSession>({
      date: new Date().toISOString().split("T")[0],
      activity_type: "run",
      target_duration_min: 45,
      intensity_band: "light",
      target_volume: null,
      status: "planned",
    });

  const [nutritionPlan, setNutritionPlan] = useState<NutritionPlan>({
    title: "",
    targetCalories: 2000,
    proteinGrams: 120,
    carbsGrams: 200,
    fatGrams: 60,
    mealHighlights: [],
  });

  const showNotice = (text: string, error = false) => {
    setNotice({ text, error });
    setTimeout(() => setNotice(null), 4000);
  };

  // 1. Initial Load: Retrieve all user chat sessions
  useEffect(() => {
    let isMounted = true;

    async function loadSessions() {
      try {
        const fetchedSessions = await chatApi.getSessions();
        if (!isMounted) return;

        setSessions(fetchedSessions);

        if (fetchedSessions.length > 0) {
          const defaultSessionId = fetchedSessions[0].session_id;
          setSessionId(defaultSessionId);
          await loadSessionHistory(defaultSessionId);
        } else {
          const created = await chatApi.createSession();
          if (!isMounted) return;
          setSessions([created]);
          setSessionId(created.session_id);
          setMessages([]);
        }
      } catch (err: unknown) {
        console.error("Failed to load user chat sessions:", err);
      }
    }

    loadSessions();

    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Fetch all messages for a specific session
  const loadSessionHistory = async (targetSessionId: string) => {
    try {
      setIsSwitchingSession(true);
      const detail = await chatApi.getSessionHistory(targetSessionId);

      const parsedMessages: Message[] = (detail.messages || []).map(
        (m: ApiMessage) => {
          const raw = m as any;
          
          // --- UPDATE THIS SECTION ---
          let recommendedSessions: RecommendedPlannedSession[] = [];

          if (Array.isArray(raw.planned_session)) {
            recommendedSessions = raw.planned_session;
          } else if (Array.isArray(raw.recommended_sessions)) {
            recommendedSessions = raw.recommended_sessions;
          } else if (raw.planned_session) {
            recommendedSessions = [raw.planned_session];
          } else if (raw.recommended_session) {
            recommendedSessions = [raw.recommended_session];
          }

          const primarySession: RecommendedPlannedSession | null =
            recommendedSessions.length > 0 ? recommendedSessions[0] : null;
          // ----------------------------

          return {
            id: m.message_id,
            role: m.sender as "user" | "assistant",
            content: m.content,
            timestamp: new Date(m.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            hasPlannedSession: recommendedSessions.length > 0,
            plannedSession: primarySession,
            recommendedSessions,
            hasNutritionPlan: Boolean(raw.nutrition_plan),
            nutritionPlan: raw.nutrition_plan || null,
            nutritionSchedule: raw.nutrition_schedule || null,
            weeklyTrainingPlan: raw.weekly_training_plan || null,
          };
        },
      );

      setMessages(parsedMessages);
    } catch (err) {
      console.error(
        `Failed to load history for session ${targetSessionId}:`,
        err,
      );
    } finally {
      setIsSwitchingSession(false);
    }
  };

  const handleSelectSession = async (targetSessionId: string) => {
    if (targetSessionId === sessionId || isLoading) return;
    setSessionId(targetSessionId);
    await loadSessionHistory(targetSessionId);
  };

  const handleNewSession = async () => {
    if (isLoading) return;
    try {
      setIsLoading(true);
      const newSession = await chatApi.createSession();
      setSessions((prev) => [newSession, ...prev]);
      setSessionId(newSession.session_id);
      setMessages([]);
    } catch (err) {
      console.error("Failed to create new session:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteSession = async (targetSessionId: string) => {
    try {
      await chatApi.deleteSession(targetSessionId);
      const remaining = sessions.filter(
        (s) => s.session_id !== targetSessionId,
      );
      setSessions(remaining);

      if (sessionId === targetSessionId) {
        if (remaining.length > 0) {
          const nextSessionId = remaining[0].session_id;
          setSessionId(nextSessionId);
          await loadSessionHistory(nextSessionId);
        } else {
          await handleNewSession();
        }
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const promptText = (textToSend || input).trim();
    if (!promptText || isLoading) return;

    setIsLoading(true);

    const tempUserId = Date.now().toString();
    const userMessage: Message = {
      id: tempUserId,
      role: "user",
      content: promptText,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    setMessages((prev) => [...prev, userMessage]);
    if (!textToSend) setInput("");

    try {
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const newSession = await chatApi.createSession();
        activeSessionId = newSession.session_id;
        setSessions((prev) => [newSession, ...prev]);
        setSessionId(activeSessionId);
      }

      const schedule = await trainingApi.getSchedule(
        todayISO(),
        addDays(todayISO(), 6),
      );
      const aiReply = await chatApi.sendMessage(
        activeSessionId,
        promptText,
        schedule.sessions,
      );
      const rawReply = aiReply as any;
      const asksForWeeklyPlan =
        /plan (a )?(week|7-day|seven-day)|week'?s worth|weekly (training|workout|schedule|plan)|7-day (training|workout|schedule|plan)|seven-day (training|workout|schedule|plan)/i.test(
          promptText,
        );

      // Extract recommended sessions array
      const receivedSessions: RecommendedPlannedSession[] =
        rawReply.recommended_sessions && rawReply.recommended_sessions.length > 0
          ? rawReply.recommended_sessions
          : rawReply.planned_session
          ? [rawReply.planned_session]
          : rawReply.recommended_session
          ? [rawReply.recommended_session]
          : [];

      const primarySession: RecommendedPlannedSession | null =
        receivedSessions.length > 0 ? receivedSessions[0] : null;

      const receivedNutrition = rawReply.nutrition_plan || null;
      const receivedWeeklyPlan: WeeklyTrainingDay[] | null =
        rawReply.weekly_training_plan ||
        (asksForWeeklyPlan
          ? Array.from({ length: 7 }, (_, offset) => {
              const date = addDays(todayISO(), offset);
              const planned = schedule.sessions.find(
                (session) => session.date === date,
              );
              return planned
                ? {
                    date,
                    activity_type: planned.activityType,
                    target_duration_min: planned.targetDurationMin,
                    intensity_band: planned.intensityBand,
                    target_volume: planned.targetVolume,
                  }
                : {
                    date,
                    activity_type: "rest",
                    target_duration_min: null,
                    intensity_band: null,
                    target_volume: null,
                  };
            })
          : null);

      if (primarySession) setActivePlannedSession(primarySession);
      if (receivedNutrition) setNutritionPlan(receivedNutrition);

      const assistantMessage: Message = {
        id: aiReply.message_id,
        role: "assistant",
        content: aiReply.content || rawReply.reply || "",
        timestamp: new Date(aiReply.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        hasPlannedSession: receivedSessions.length > 0,
        plannedSession: primarySession,
        recommendedSessions: receivedSessions,
        hasNutritionPlan: Boolean(receivedNutrition),
        nutritionPlan: receivedNutrition,
        nutritionSchedule: rawReply.nutrition_schedule || null,
        weeklyTrainingPlan: receivedWeeklyPlan,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: unknown) {
      console.error("Chat flow error:", err);
      const errorText =
        err instanceof Error
          ? err.message
          : "Failed to communicate with AI core.";
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: `Error: ${errorText}`,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveNutritionSchedule = async (
    schedule: NutritionScheduleDay[],
    messageId: string,
  ) => {
    if (savingNutritionMessageId) return;
    setSavingNutritionMessageId(messageId);
    try {
      await saveCalorieTargets(
        schedule.map(({ date, targetCalories }) => ({
          date,
          target_calories: targetCalories,
        })),
      );
      showNotice("Daily calorie targets added to your nutritional plan.");
    } catch (error: unknown) {
      showNotice(
        error instanceof Error
          ? error.message
          : "Could not save your calorie targets.",
        true,
      );
    } finally {
      setSavingNutritionMessageId(null);
    }
  };

  const handleOpenPlannedSessionModal = (
    session?: RecommendedPlannedSession | null,
  ) => {
    if (session) setActivePlannedSession(session);
    setPlannedSessionModalOpen(true);
  };

  const handleOpenNutritionModal = (plan?: NutritionPlan | null) => {
    if (plan) setNutritionPlan(plan);
    setNutritionModalOpen(true);
  };

  const handleSavePlannedSession = async (input: AddSessionInput) => {
    setIsSavingPlannedSession(true);
    try {
      const result = await trainingApi.addSession(input);
      if (!result.ok) {
        showNotice(result.error.message, true);
        return;
      }

      setPlannedSessionModalOpen(false);
      const { adjustedCount } = result.data;
      showNotice(
        adjustedCount > 0
          ? `Session added to your schedule. ${adjustedCount} other session${adjustedCount === 1 ? " was" : "s were"} adjusted.`
          : "Session added to your schedule.",
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save the planned session.";
      showNotice(message, true);
    } finally {
      setIsSavingPlannedSession(false);
    }
  };

  const handleSaveNutrition = () => {
    setNutritionModalOpen(false);
    showNotice(
      `Saved "${nutritionPlan.title || "Nutrition Plan"}" to Nutrition records!`,
    );
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-[1550px] mx-auto px-4 py-4 min-h-screen text-slate-100">
      {/* Toast Notice */}
      {notice && (
        <div
          className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border animate-in fade-in ${
            notice.error
              ? "bg-rose-950/90 border-rose-500/50 text-rose-300"
              : "bg-emerald-950/90 border-emerald-500/50 text-emerald-300"
          }`}
        >
          {notice.error ? (
            <AlertCircle className="w-5 h-5" />
          ) : (
            <CheckCircle className="w-5 h-5" />
          )}
          <span className="text-sm font-medium">{notice.text}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-2.5">
            AI Assistance <Sparkles className="w-6 h-6 text-emerald-400" />
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Endurance telemetry intelligence, customized training protocols, and
            schedule recommendations.
          </p>
        </div>

        <div className="hidden sm:flex items-center gap-2 bg-[#0B1220] border border-slate-800/80 px-3.5 py-1.5 rounded-full text-xs text-slate-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Active Session:{" "}
          {sessionId ? `${sessionId.slice(0, 8)}...` : "Connecting..."}
        </div>
      </div>

      {/* 3-Column Responsive Dashboard Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Chat Sessions List */}
        <div className="lg:col-span-3">
          <SessionSidebar
            sessions={sessions}
            activeSessionId={sessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
            isLoading={isLoading || isSwitchingSession}
          />
        </div>

        {/* Center Column: Active Chat Panel */}
        <div className="lg:col-span-6">
          <ChatPanel
            messages={messages}
            input={input}
            setInput={setInput}
            isLoading={isLoading || isSwitchingSession}
            onSend={handleSendMessage}
            onOpenPlannedSessionModal={handleOpenPlannedSessionModal}
            onOpenNutritionModal={handleOpenNutritionModal}
            onSaveNutritionSchedule={handleSaveNutritionSchedule}
            savingNutritionMessageId={savingNutritionMessageId}
          />
        </div>

        {/* Right Column: Telemetry & Biometrics */}
        <div className="lg:col-span-3">
          <TelemetryPanel
            onOpenWorkoutModal={() =>
              handleOpenPlannedSessionModal(activePlannedSession)
            }
            onOpenNutritionModal={() => handleOpenNutritionModal(nutritionPlan)}
          />
        </div>
      </div>

      {/* Planned Session Review & Schedule Modal */}
      <PlannedSessionModal
        isOpen={plannedSessionModalOpen}
        onClose={() => setPlannedSessionModalOpen(false)}
        session={activePlannedSession}
        setSession={setActivePlannedSession}
        onSave={handleSavePlannedSession}
        isSaving={isSavingPlannedSession}
      />

      {/* Nutrition Plan Modal */}
      <NutritionPlanModal
        isOpen={nutritionModalOpen}
        onClose={() => setNutritionModalOpen(false)}
        plan={nutritionPlan}
        setPlan={setNutritionPlan}
        onSave={handleSaveNutrition}
      />
    </div>
  );
}
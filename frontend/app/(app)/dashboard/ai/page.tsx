"use client";

import React, { useState, useEffect } from "react";
import { Sparkles, CheckCircle, AlertCircle } from "lucide-react";
import { Message, RecommendedPlannedSession, NutritionPlan } from "./types";
import { ChatPanel } from "./_components/chat-panel";
import { TelemetryPanel } from "./_components/telemetry-panel";
import { SessionSidebar } from "./_components/session-sidebar";
import { PlannedSessionModal } from "./_components/planned-session-modal";
import { NutritionPlanModal } from "./_components/nutrition-plan-modal";
import { chatApi, ApiSession, ApiMessage } from "@/app/api/chat";
import { trainingApi } from "@/lib/training/api";

export default function AIAssistancePage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  // Modal dialog states
  const [plannedSessionModalOpen, setPlannedSessionModalOpen] = useState(false);
  const [nutritionModalOpen, setNutritionModalOpen] = useState(false);
  const [isSavingPlannedSession, setIsSavingPlannedSession] = useState(false);

  // Active planned session
  const [activePlannedSession, setActivePlannedSession] = useState<RecommendedPlannedSession>({
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

      const parsedMessages: Message[] = (detail.messages || []).map((m: ApiMessage) => {
        const raw = m as any;
        const plannedSession: RecommendedPlannedSession | null =
          raw.planned_session || raw.recommended_session || null;

        return {
          id: m.message_id,
          role: m.sender as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          hasPlannedSession: Boolean(plannedSession),
          plannedSession,
          hasNutritionPlan: Boolean(raw.nutrition_plan),
          nutritionPlan: raw.nutrition_plan || null,
        };
      });

      setMessages(parsedMessages);
    } catch (err) {
      console.error(`Failed to load history for session ${targetSessionId}:`, err);
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
      const remaining = sessions.filter((s) => s.session_id !== targetSessionId);
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
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
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

      const aiReply = await chatApi.sendMessage(activeSessionId, promptText);
      const rawReply = aiReply as any;

      const receivedSession: RecommendedPlannedSession | null =
        rawReply.planned_session || rawReply.recommended_session || null;
      const receivedNutrition = rawReply.nutrition_plan || null;

      if (receivedSession) setActivePlannedSession(receivedSession);
      if (receivedNutrition) setNutritionPlan(receivedNutrition);

      const assistantMessage: Message = {
        id: aiReply.message_id,
        role: "assistant",
        content: aiReply.content || rawReply.reply || "",
        timestamp: new Date(aiReply.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        hasPlannedSession: Boolean(receivedSession),
        plannedSession: receivedSession,
        hasNutritionPlan: Boolean(receivedNutrition),
        nutritionPlan: receivedNutrition,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: unknown) {
      console.error("Chat flow error:", err);
      const errorText = err instanceof Error ? err.message : "Failed to communicate with AI core.";
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: `Error: ${errorText}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenPlannedSessionModal = (session?: RecommendedPlannedSession | null) => {
    if (session) setActivePlannedSession(session);
    setPlannedSessionModalOpen(true);
  };

  const handleOpenNutritionModal = (plan?: NutritionPlan | null) => {
    if (plan) setNutritionPlan(plan);
    setNutritionModalOpen(true);
  };

  // Persist session (backend automatically binds user's training routine plan)
  const handleSavePlannedSession = async () => {
    try {
      setIsSavingPlannedSession(true);

      const res = await trainingApi.addPlannedSession({
        date: activePlannedSession.date,
        activity_type: activePlannedSession.activity_type,
        target_duration_min: Number(activePlannedSession.target_duration_min),
        intensity_band: activePlannedSession.intensity_band,
        target_volume:
          activePlannedSession.target_volume !== null && activePlannedSession.target_volume !== undefined
            ? Number(activePlannedSession.target_volume)
            : null,
        status: activePlannedSession.status || "planned",
      });

      if (res.ok) {
        setPlannedSessionModalOpen(false);
        showNotice(
          `Added ${activePlannedSession.activity_type} (${activePlannedSession.intensity_band}) on ${activePlannedSession.date} to schedule!`
        );
      } else {
        showNotice(res.error?.message || "Failed to schedule session.", true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error saving planned session.";
      showNotice(msg, true);
    } finally {
      setIsSavingPlannedSession(false);
    }
  };

  const handleSaveNutrition = () => {
    setNutritionModalOpen(false);
    showNotice(`Saved "${nutritionPlan.title || "Nutrition Plan"}" to Nutrition records!`);
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
          {notice.error ? <AlertCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
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
            Endurance telemetry intelligence, customized training protocols, and schedule recommendations.
          </p>
        </div>

        <div className="hidden sm:flex items-center gap-2 bg-[#0B1220] border border-slate-800/80 px-3.5 py-1.5 rounded-full text-xs text-slate-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Active Session: {sessionId ? `${sessionId.slice(0, 8)}...` : "Connecting..."}
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
          />
        </div>

        {/* Right Column: Telemetry & Biometrics */}
        <div className="lg:col-span-3">
          <TelemetryPanel
            onOpenWorkoutModal={() => handleOpenPlannedSessionModal(activePlannedSession)}
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
"use client";

import React from "react";
import { MessageSquare, Plus, Trash2, Calendar } from "lucide-react";
import { ApiSession } from "@/app/api/chat";

interface SessionSidebarProps {
  sessions: ApiSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession?: (sessionId: string) => void;
  isLoading: boolean;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  isLoading,
}: SessionSidebarProps) {
  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "Earlier";
    }
  };

  return (
    <aside className="w-full lg:w-72 flex flex-col bg-[#0B1220]/80 border border-slate-800/80 rounded-2xl p-4 h-[750px] shadow-xl backdrop-blur-md">
      {/* New Chat Button */}
      <button
        onClick={onNewSession}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-slate-950 font-semibold rounded-xl text-sm transition-all shadow-lg shadow-emerald-500/10 cursor-pointer mb-4"
      >
        <Plus className="w-4 h-4 stroke-[2.5]" />
        <span>New Chat Session</span>
      </button>

      {/* Session List Header */}
      <div className="flex items-center justify-between text-xs font-medium text-slate-400 px-2 mb-2 uppercase tracking-wider">
        <span>History</span>
        <span>{sessions.length}</span>
      </div>

      {/* Sessions Scrollable Container */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-slate-500 text-xs px-4">
            <MessageSquare className="w-8 h-8 mb-2 stroke-1 text-slate-600" />
            <span>No previous sessions found. Start a new conversation!</span>
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session.session_id === activeSessionId;
            return (
              <div
                key={session.session_id}
                onClick={() => onSelectSession(session.session_id)}
                className={`group relative flex items-center justify-between p-3 rounded-xl text-left text-sm cursor-pointer transition-all border ${
                  isActive
                    ? "bg-slate-800/90 border-emerald-500/50 text-white font-medium shadow-md shadow-emerald-950/20"
                    : "bg-slate-900/40 border-transparent text-slate-300 hover:bg-slate-800/50 hover:text-white"
                }`}
              >
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <MessageSquare
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-400"
                    }`}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate text-xs font-mono">
                      {session.session_id.slice(0, 8)}...
                    </span>
                    <span className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatDate(session.started_at)}
                    </span>
                  </div>
                </div>

                {onDeleteSession && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.session_id);
                    }}
                    title="Delete session"
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 text-slate-500 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
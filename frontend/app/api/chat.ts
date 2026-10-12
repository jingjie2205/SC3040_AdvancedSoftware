import { createClient } from "@/lib/supabase/client";
import type { PlannedSession } from "@/lib/training/types";
import type {
  RecommendedPlannedSession,
  WeeklyTrainingDay,
} from "@/app/(app)/dashboard/ai/types.ts";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";

export interface ApiMessage {
  message_id: string;
  sender: string;
  content: string;
  timestamp: string;
  reply?: string;
  planned_session?: RecommendedPlannedSession | null;
  recommended_session?: RecommendedPlannedSession | null;
  workout_plan?: any;
  nutrition_plan?: any;
  nutrition_schedule?: NutritionScheduleDay[] | null;
  weekly_training_plan?: WeeklyTrainingDay[] | null;
}

export interface NutritionScheduleDay {
  date: string;
  activity: string;
  targetCalories: number;
}

export interface ApiSession {
  session_id: string;
  user_id: string;
  started_at: string;
}

export interface SessionDetail extends ApiSession {
  messages: ApiMessage[];
}

// --- Auth Helper ---
async function getAuthHeaders(): Promise<HeadersInit> {
  console.log("[AUTH] Getting supabase client...");
  const supabase = createClient();
  
  console.log("[AUTH] Calling getSession()...");
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    console.error("[AUTH ERROR]", error);
  }

  const token = data?.session?.access_token;
  console.log("[AUTH] Access token present?", Boolean(token));

  if (!token) {
    throw new Error("No active session found. Please log in.");
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// --- API Client ---
export const chatApi = {
  async getSessions(): Promise<ApiSession[]> {
    const headers = await getAuthHeaders();
    const res = await fetch(`${BACKEND_URL}/chat/sessions`, { headers });
    if (!res.ok) throw new Error("Failed to load chat sessions");
    return res.json();
  },

  async createSession(): Promise<ApiSession> {
    const headers = await getAuthHeaders();
    const res = await fetch(`${BACKEND_URL}/chat/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error("Failed to create chat session");
    return res.json();
  },

  async getSessionHistory(sessionId: string): Promise<SessionDetail> {
    const headers = await getAuthHeaders();
    const res = await fetch(`${BACKEND_URL}/chat/sessions/${sessionId}`, { headers });
    if (!res.ok) throw new Error("Failed to fetch session history");
    return res.json();
  },

  async sendMessage(
    sessionId: string,
    content: string,
    trainingSchedule: PlannedSession[] = [],
  ): Promise<ApiMessage> {
    console.log("[API] Preparing headers for sendMessage...");
    const headers = await getAuthHeaders();
    
    const targetUrl = `${BACKEND_URL}/chat/sessions/${sessionId}/send`;
    console.log("[API] Fetching POST to:", targetUrl);

    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sender: "user",
        content,
        training_schedule: trainingSchedule,
      }),
    });

    console.log("[API] Response status:", res.status);
    if (!res.ok) {
      const errBody = await res.text();
      console.error("[API ERROR BODY]", errBody);
      throw new Error(`Backend error (${res.status}): ${errBody}`);
    }

    return res.json();
  },

  async deleteSession(sessionId: string): Promise<void> {
    const headers = await getAuthHeaders();
    const res = await fetch(`${BACKEND_URL}/chat/sessions/${sessionId}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        body || `Failed to delete chat session (${res.status}).`,
      );
    }
  },
};
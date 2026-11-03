import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Supabase client to cover getAuthHeaders() branches
const mockGetSession = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
    },
  }),
}));

import { chatApi } from "@/app/api/chat";

describe("chatApi and getAuthHeaders Suite", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default valid token
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "test-valid-bearer-token" } },
      error: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Auth Header Error Branch
  it("throws error when session has no access token", async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: null },
      error: new Error("Session expired"),
    });

    await expect(chatApi.getSessions()).rejects.toThrow(
      "No active session found. Please log in."
    );
  });

  // getSessions
  it("getSessions: returns session array on success and throws when response is not ok", async () => {
    const mockSessions = [{ session_id: "sess-1", user_id: "u1", started_at: "2026-11-03" }];
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockSessions,
    } as Response);

    const res = await chatApi.getSessions();
    expect(res).toEqual(mockSessions);

    // Error branch
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    await expect(chatApi.getSessions()).rejects.toThrow("Failed to load chat sessions");
  });

  // createSession
  it("createSession: returns created session and throws when response is not ok", async () => {
    const mockCreated = { session_id: "sess-new", user_id: "u1", started_at: "2026-11-03" };
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCreated,
    } as Response);

    const res = await chatApi.createSession();
    expect(res).toEqual(mockCreated);

    // Error branch
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    await expect(chatApi.createSession()).rejects.toThrow("Failed to create chat session");
  });

  // getSessionHistory
  it("getSessionHistory: returns history detail and throws when response is not ok", async () => {
    const mockDetail = { session_id: "sess-1", user_id: "u1", started_at: "2026-11-03", messages: [] };
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockDetail,
    } as Response);

    const res = await chatApi.getSessionHistory("sess-1");
    expect(res).toEqual(mockDetail);

    // Error branch
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);
    await expect(chatApi.getSessionHistory("sess-1")).rejects.toThrow("Failed to fetch session history");
  });

  // sendMessage
  it("sendMessage: posts message and returns assistant response", async () => {
    const mockReply = {
      message_id: "m-100",
      sender: "assistant",
      content: "Here is your plan.",
      timestamp: "2026-11-03T10:00:00Z",
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockReply,
    } as Response);

    const res = await chatApi.sendMessage("sess-1", "Plan 45 min run");
    expect(res).toEqual(mockReply);

    // Error branch (parsing text error body)
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "Validation error on payload",
    } as Response);
    await expect(chatApi.sendMessage("sess-1", "Bad prompt")).rejects.toThrow(
      "Backend error (422): Validation error on payload"
    );
  });

  // deleteSession
  it("deleteSession: sends DELETE request and throws on error body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
    } as Response);

    await expect(chatApi.deleteSession("sess-1")).resolves.toBeUndefined();

    // Error branch with text body
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Session does not exist",
    } as Response);
    await expect(chatApi.deleteSession("sess-1")).rejects.toThrow("Session does not exist");
  });
});
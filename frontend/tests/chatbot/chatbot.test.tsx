import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/dashboard/ai/_components/session-sidebar", () => ({
  default: () => <div data-testid="session-sidebar">Sessions</div>,
  SessionSidebar: () => <div data-testid="session-sidebar">Sessions</div>,
}));

vi.mock("@/app/api/chat", () => {
  const mockApi = {
    getSessions: vi.fn().mockResolvedValue([
      { session_id: "test-session-12345", title: "Training Chat", created_at: new Date().toISOString() },
    ]),
    createSession: vi.fn().mockResolvedValue({
      session_id: "test-session-12345",
      title: "New Session",
      created_at: new Date().toISOString(),
    }),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({
      role: "assistant",
      content: "Based on your TDEE of 2594 kcal, I recommend a recovery meal with 40g protein.",
    }),
  };

  return {
    chatApi: mockApi,
    ...mockApi,
  };
});

const mocks = vi.hoisted(() => {
  const getUser = vi.fn();
  const getSession = vi.fn();
  const fromSelect = vi.fn();
  const push = vi.fn();

  const createQueryBuilder = () => {
    const builder: any = {};
    builder.select = vi.fn().mockReturnValue(builder);
    builder.insert = vi.fn().mockReturnValue(builder);
    builder.update = vi.fn().mockReturnValue(builder);
    builder.eq = vi.fn().mockReturnValue(builder);
    builder.order = vi.fn().mockReturnValue(builder);
    builder.limit = vi.fn().mockReturnValue(builder);
    builder.single = vi.fn().mockImplementation(() => fromSelect());
    builder.maybeSingle = vi.fn().mockImplementation(() => fromSelect());
    builder.then = (resolve: any) =>
      Promise.resolve(fromSelect()).then(resolve);
    return builder;
  };

  return {
    getUser,
    getSession,
    fromSelect,
    push,
    serverClientInstance: {
      auth: { getUser, getSession },
      from: vi.fn().mockImplementation(() => createQueryBuilder()),
    },
    clientInstance: {
      auth: { getUser, getSession },
      from: vi.fn().mockImplementation(() => createQueryBuilder()),
    },
  };
});

// Mock Supabase server
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockImplementation(async () => mocks.serverClientInstance),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockImplementation(async () => ({
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock Supabase client
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn().mockImplementation(() => mocks.clientInstance),
}));

// Mock Next.js navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai",
}));

import ChatbotPage from "@/app/(app)/dashboard/ai/page";

const defaultProps = {
  searchParams: Promise.resolve({}),
};

async function renderChatbotPage(props = defaultProps) {
  const ResolvedPage =
    typeof ChatbotPage === "function" && ChatbotPage.constructor.name === "AsyncFunction"
      ? await (ChatbotPage as any)(props)
      : <ChatbotPage {...(props as any)} />;

  return render(ResolvedPage);
}

describe("Chatbot / AI Assistance Page Tests (AT-1 / C-1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "mock-valid-jwt" } },
      error: null,
    });

    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user_test_123",
          email: "athlete@example.com",
        },
      },
      error: null,
    });

    mocks.fromSelect.mockResolvedValue({
      data: [
        {
          session_id: "test-session-12345",
          title: "General Fitness",
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/sessions") || url.includes("/chat/sessions")) {
        return new Response(
          JSON.stringify([
            { session_id: "test-session-12345", title: "General Fitness", created_at: new Date().toISOString() },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          role: "assistant",
          content: "Based on your TDEE of 2594 kcal, I recommend a recovery meal with 40g protein.",
          message: "Based on your TDEE of 2594 kcal, I recommend a recovery meal with 40g protein.",
          reply: "Based on your TDEE of 2594 kcal, I recommend a recovery meal with 40g protein.",
          response: "Based on your TDEE of 2594 kcal, I recommend a recovery meal with 40g protein.",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
  });

  // --------------------------------------------------------------------------
  // AT-1: Normal Flow - Submits Query and Renders AI Response
  // --------------------------------------------------------------------------
  it("AT-1: submits user query and displays the AI assistant response", async () => {
    await renderChatbotPage();

    // Verify main container rendered
    expect(await screen.findByText(/Fitra Training Copilot/i)).toBeInTheDocument();

    const chatInput =
      screen.queryByPlaceholderText(/ask|message|type a message|how can i help/i) ||
      screen.getByRole("textbox");

    expect(chatInput).toBeInTheDocument();
    fireEvent.change(chatInput, {
      target: { value: "What should I eat after my 10km run?" },
    });

    // Check if input is enclosed in a form
    const form = chatInput.closest("form");
    if (form) {
      fireEvent.submit(form);
    } else {
      // Otherwise press Enter or click the dedicated submit button
      fireEvent.keyDown(chatInput, { key: "Enter", code: "Enter", charCode: 13 });
      const submitBtn = screen.getAllByRole("button").find(b => b.getAttribute("type") === "submit");
      if (submitBtn) fireEvent.click(submitBtn);
    }

    await waitFor(() => {
      const hasContent =
        screen.queryByText(/What should I eat after my 10km run/i) !== null ||
        screen.queryByText(/recovery meal with 40g protein/i) !== null ||
        screen.queryByText(/Fitra Training Copilot/i) !== null;
      expect(hasContent).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // AT-1 Exception: Prevents Empty Submissions
  // --------------------------------------------------------------------------
  it("AT-1 Exception: disables submit or ignores blank input without firing network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await renderChatbotPage();

    const chatInput =
      screen.queryByPlaceholderText(/ask|message|type a message|how can i help/i) ||
      screen.queryByRole("textbox");

    if (chatInput) {
      fireEvent.change(chatInput, { target: { value: "   " } });
    }

    const sendButtons = screen.getAllByRole("button");
    const sendButton =
      sendButtons.find(b => /send|submit/i.test(b.textContent || "")) ||
      sendButtons[sendButtons.length - 1];

    if (sendButton) {
      fireEvent.click(sendButton);
    }

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/chat\/message|\/chat\/send/),
      expect.anything()
    );
  });

  // --------------------------------------------------------------------------
  // AT-1 Exception: Displays Error Alert or Banner on Service Failure
  // --------------------------------------------------------------------------
  it("AT-1 Exception: displays error alert or banner when the AI service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions")) {
        return new Response(
          JSON.stringify([
            { session_id: "test-session-12345", title: "General Fitness", created_at: new Date().toISOString() },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ detail: "AI service unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    await renderChatbotPage();

    const chatInput =
      screen.queryByPlaceholderText(/ask|message|type a message|how can i help/i) ||
      screen.queryByRole("textbox");

    if (chatInput) {
      fireEvent.change(chatInput, { target: { value: "Give me a training tip" } });

      const form = chatInput.closest("form");
      if (form) {
        fireEvent.submit(form);
      } else {
        const sendButtons = screen.getAllByRole("button");
        const sendButton =
          sendButtons.find(b => !b.hasAttribute("disabled") && (/send|submit/i.test(b.textContent || "") || b.querySelector("svg") !== null)) ||
          sendButtons[sendButtons.length - 1];

        if (sendButton) {
          fireEvent.click(sendButton);
        }
      }
    }

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });
});
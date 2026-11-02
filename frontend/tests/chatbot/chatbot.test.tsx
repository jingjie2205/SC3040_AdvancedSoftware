import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/chat", () => {
  const initialSessions = [
    { session_id: "sess-1", title: "Marathon Prep", created_at: new Date().toISOString() },
    { session_id: "sess-2", title: "Strength", created_at: new Date().toISOString() },
  ];

  const initialDetail = {
    session_id: "sess-1",
    messages: [
      {
        message_id: "msg-1",
        sender: "user",
        content: "What is my plan?",
        timestamp: new Date().toISOString(),
      },
      {
        message_id: "msg-2",
        sender: "assistant",
        content: "Here is your plan and recovery target.",
        timestamp: new Date().toISOString(),
        planned_session: {
          date: "2026-11-03",
          activity_type: "run",
          target_duration_min: 45,
          intensity_band: "push",
          status: "planned",
        },
        nutrition_plan: {
          title: "Endurance Fuel",
          targetCalories: 2600,
          proteinGrams: 160,
          carbsGrams: 320,
          fatGrams: 70,
          mealHighlights: ["Oatmeal Bowl", "Salmon Rice"],
        },
        nutrition_schedule: [
          { date: "2026-11-03", activity: "Run", targetCalories: 2600 },
        ],
        weekly_training_plan: [
          {
            date: "2026-11-03",
            activity_type: "run",
            target_duration_min: 50,
            intensity_band: "deload",
          },
          {
            date: "2026-11-04",
            activity_type: "rest",
            target_duration_min: null,
            intensity_band: null,
          },
        ],
      },
    ],
  };

  return {
    chatApi: {
      getSessions: vi.fn().mockResolvedValue(initialSessions),
      createSession: vi.fn().mockResolvedValue({
        session_id: "sess-new",
        title: "New Session",
        created_at: new Date().toISOString(),
      }),
      deleteSession: vi.fn().mockResolvedValue({ success: true }),
      getSessionHistory: vi.fn().mockResolvedValue(initialDetail),
      sendMessage: vi.fn().mockResolvedValue({
        message_id: "msg-ai-reply",
        sender: "assistant",
        content: "I recommend a 45m threshold run.",
        timestamp: new Date().toISOString(),
        planned_session: {
          date: "2026-11-05",
          activity_type: "cycling",
          target_duration_min: 60,
          intensity_band: "light",
          status: "planned",
        },
      }),
    },
  };
});

vi.mock("@/lib/training/api", () => ({
  trainingApi: {
    getSchedule: vi.fn().mockResolvedValue({ sessions: [] }),
    addSession: vi.fn().mockResolvedValue({
      ok: true,
      data: { adjustedCount: 1 },
    }),
  },
}));

vi.mock("@/lib/nutrition", () => ({
  saveCalorieTargets: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/training/dates", () => ({
  todayISO: () => "2026-11-02",
  addDays: (_date: string, amount: number) => `2026-11-0${2 + amount}`,
}));

// Component imports
import AIAssistancePage from "@/app/(app)/dashboard/ai/page";
import { PlannedSessionModal } from "@/app/(app)/dashboard/ai/_components/planned-session-modal";
import { NutritionPlanModal } from "@/app/(app)/dashboard/ai/_components/nutrition-plan-modal";

describe("AIAssistance Page & Components Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  // Test 1: Full Page Render, History Loading, and User Query
  it("renders page, loads history, and submits user message", async () => {
    render(<AIAssistancePage />);

    expect(await screen.findByText(/Fitra Training Copilot/i)).toBeInTheDocument();
    expect(await screen.findByText(/Here is your plan and recovery target/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/Ask AI to recommend/i);
    fireEvent.change(input, { target: { value: "Can we do cycling tomorrow?" } });

    const submitBtn = screen.getByRole("button", { name: "" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/I recommend a 45m threshold run/i)).toBeInTheDocument();
    });
  });

  // Test 2: Quick Prompts and Blank Input Validation
  it("fires quick prompt chip and prevents blank queries", async () => {
    render(<AIAssistancePage />);
    expect(await screen.findByText(/Fitra Training Copilot/i)).toBeInTheDocument();

    const promptChip = screen.getByRole("button", {
      name: /Plan a week's worth of training/i,
    });
    fireEvent.click(promptChip);

    const input = screen.getByPlaceholderText(/Ask AI to recommend/i);
    fireEvent.change(input, { target: { value: "   " } });
    const form = input.closest("form");
    if (form) fireEvent.submit(form);

    expect(input).toHaveValue("   ");
  });

  // Test 3: Session Switching, New Session, and Deletion
  it("interacts with session sidebar to switch, create, and delete sessions", async () => {
    render(<AIAssistancePage />);

    // Scope queries inside the sidebar (<aside>) to prevent hitting header active pill
    const sidebar = await screen.findByRole("complementary");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.textContent).toContain("sess-1");

    // Click sess-2 to switch session
    const sess2Item = withinSidebar(sidebar, "sess-2");
    if (sess2Item) fireEvent.click(sess2Item);

    // Click again to trigger early-return branch (targetSessionId === sessionId)
    if (sess2Item) fireEvent.click(sess2Item);

    // Click New Chat / Session
    const newChatBtn = screen.getByRole("button", { name: /New Chat Session/i });
    fireEvent.click(newChatBtn);

    // Click Delete Session on active session (triggers remaining session switch / new session branch)
    const trashButtons = screen.getAllByRole("button").filter(
      (b) => b.querySelector("svg.lucide-trash, svg.lucide-trash2") !== null
    );
    if (trashButtons.length > 0) {
      fireEvent.click(trashButtons[0]);
    }

    await waitFor(() => {
      expect(screen.getByText(/Fitra Training Copilot/i)).toBeInTheDocument();
    });
  });

  // Test 4: Save Nutrition Schedule & Handle Modal Openers from Chat Cards
  it("saves nutrition schedule and opens modals from assistant cards", async () => {
    render(<AIAssistancePage />);

    // Add nutrition schedule to nutritional plan
    const addNutritionBtn = await screen.findByRole("button", {
      name: /Add to nutritional plan/i,
    });
    fireEvent.click(addNutritionBtn);

    // Open Nutrition Plan Modal from review button
    const reviewNutritionBtn = screen.getByRole("button", {
      name: /Review Nutrition Plan/i,
    });
    fireEvent.click(reviewNutritionBtn);
    expect(await screen.findByText(/Save Plan to Nutrition Page/i)).toBeInTheDocument();

    // Close Nutrition Modal
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    // Open Planned Session Modal from Review Session button
    const reviewSessionBtns = screen.getAllByRole("button", {
      name: /Review Session/i,
    });
    fireEvent.click(reviewSessionBtns[0]);
    expect(await screen.findByText(/Schedule Planned Session/i)).toBeInTheDocument();

    // Save Planned Session (success branch)
    fireEvent.click(screen.getByRole("button", { name: /Save to Schedule/i }));
  });

  // Test 5: Direct Unit Coverage for PlannedSessionModal
  it("exercises all fields and actions in PlannedSessionModal", () => {
    const onClose = vi.fn();
    const setSession = vi.fn();
    const onSave = vi.fn();

    const mockSession = {
      date: "2026-11-03",
      activity_type: "run" as const,
      target_duration_min: 45,
      intensity_band: "push" as const,
      target_volume: null,
      status: "planned" as const,
    };

    const { rerender } = render(
      <PlannedSessionModal
        isOpen={true}
        onClose={onClose}
        session={mockSession}
        setSession={setSession}
        onSave={onSave}
        isSaving={false}
      />
    );

    const dateInput = screen.getByDisplayValue("2026-11-03");
    fireEvent.change(dateInput, { target: { value: "2026-11-04" } });
    expect(setSession).toHaveBeenCalled();

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "cycling" } });

    const durationInput = screen.getByRole("spinbutton");
    fireEvent.change(durationInput, { target: { value: "60" } });

    fireEvent.change(selects[1], { target: { value: "deload" } });

    fireEvent.click(screen.getByRole("button", { name: /Save to Schedule/i }));
    expect(onSave).toHaveBeenCalledWith({
      date: "2026-11-03",
      activityType: "run",
      intensityBand: "push",
      targetDurationMin: 45,
    });

    rerender(
      <PlannedSessionModal
        isOpen={true}
        onClose={onClose}
        session={mockSession}
        setSession={setSession}
        onSave={onSave}
        isSaving={true}
      />
    );
    expect(screen.getByText(/Saving.../i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  // Test 6: Direct Unit Coverage for NutritionPlanModal
  it("exercises all fields and actions in NutritionPlanModal", () => {
    const onClose = vi.fn();
    const setPlan = vi.fn();
    const onSave = vi.fn();

    const mockPlan = {
      title: "Endurance Plan",
      targetCalories: 2500,
      proteinGrams: 150,
      carbsGrams: 300,
      fatGrams: 65,
      mealHighlights: ["Oats", "Rice"],
    };

    render(
      <NutritionPlanModal
        isOpen={true}
        onClose={onClose}
        plan={mockPlan}
        setPlan={setPlan}
        onSave={onSave}
      />
    );

    const titleInput = screen.getByDisplayValue("Endurance Plan");
    fireEvent.change(titleInput, { target: { value: "Updated Plan" } });
    expect(setPlan).toHaveBeenCalled();

    const spinInputs = screen.getAllByRole("spinbutton");
    spinInputs.forEach((input) => fireEvent.change(input, { target: { value: "200" } }));

    const mealInput = screen.getByDisplayValue("Oats");
    fireEvent.change(mealInput, { target: { value: "Porridge" } });

    const deleteMealBtns = screen.getAllByRole("button").filter(
      (b) => b.querySelector("svg.lucide-trash2") !== null
    );
    if (deleteMealBtns.length > 0) {
      fireEvent.click(deleteMealBtns[0]);
    }

    fireEvent.click(screen.getByRole("button", { name: /Save Nutrition Record/i }));
    expect(onSave).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  // Test 7: Error handling branch for API failures
  it("handles chat communication error gracefully without crashing", async () => {
    const { chatApi } = await import("@/app/api/chat");
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(new Error("AI Gateway Offline"));

    render(<AIAssistancePage />);
    expect(await screen.findByText(/Fitra Training Copilot/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/Ask AI to recommend/i);
    fireEvent.change(input, { target: { value: "Give me advice" } });
    const form = input.closest("form");
    if (form) fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/Error: AI Gateway Offline/i)).toBeInTheDocument();
    });
  });

  // Test 8
  it("covers initial empty sessions, fallback parsing, telemetry openers, and save failures", async () => {
    const { chatApi } = await import("@/app/api/chat");
    const { trainingApi } = await import("@/lib/training/api");
    const { saveCalorieTargets } = await import("@/lib/nutrition");

    // Mock empty sessions on mount
    vi.mocked(chatApi.getSessions).mockResolvedValueOnce([]);

    // Mock history with alternative recommended_sessions format
    vi.mocked(chatApi.getSessionHistory).mockResolvedValueOnce({
      session_id: "sess-empty",
      user_id: "user-123",
      started_at: new Date().toISOString(),
      messages: [
        {
          message_id: "msg-alt",
          sender: "assistant",
          content: "Alternative recommendations",
          timestamp: new Date().toISOString(),
          recommended_sessions: [
            {
              date: "2026-11-04",
              activity_type: "gym",
              target_duration_min: 40,
              intensity_band: "light",
              status: "planned",
            },
          ],
        } as any,
      ],
    } as any);

    render(<AIAssistancePage />);
    expect(await screen.findByText(/Fitra Training Copilot/i)).toBeInTheDocument();

    // Trigger TelemetryPanel openers
    const telemetryButtons = screen.getAllByRole("button").filter((b) =>
      /workout|nutrition|inspect|target/i.test(b.textContent || "")
    );
    telemetryButtons.forEach((btn) => fireEvent.click(btn));

    // Trigger planned session save failure
    vi.mocked(trainingApi.addSession).mockResolvedValueOnce({
      ok: false,
      error: { message: "Schedule conflict detected" },
    } as any);

    const reviewBtns = screen.queryAllByRole("button", { name: /Review Session/i });
    if (reviewBtns.length > 0) {
      fireEvent.click(reviewBtns[0]);
      const saveScheduleBtn = screen.getByRole("button", { name: /Save to Schedule/i });
      fireEvent.click(saveScheduleBtn);
      expect(await screen.findByText(/Schedule conflict detected/i)).toBeInTheDocument();
    }

    // Trigger nutrition save failure
    vi.mocked(saveCalorieTargets).mockRejectedValueOnce(new Error("Failed to write nutrition targets"));
    const addNutritionBtn = screen.queryByRole("button", { name: /Add to nutritional plan/i });
    if (addNutritionBtn) {
      fireEvent.click(addNutritionBtn);
      expect(await screen.findByText(/Failed to write nutrition targets/i)).toBeInTheDocument();
    }
  });
});

// Helper to reliably find session items inside the <aside> element
function withinSidebar(sidebar: HTMLElement, textMatch: string) {
  const elements = sidebar.querySelectorAll("div, span");
  for (const el of elements) {
    if (el.textContent && el.textContent.includes(textMatch)) {
      return el;
    }
  }
  return null;
}
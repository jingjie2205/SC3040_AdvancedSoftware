import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import HealthData from "@/app/(app)/dashboard/components/health-data";
import Calendar from "@/app/(app)/dashboard/components/calendar";
import TrainingOverview from "@/app/(app)/dashboard/components/training-overview";
import FoodConsumption from "@/app/(app)/dashboard/components/food-consumption";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getMyCheckIns: vi.fn(),
  getSchedule: vi.fn(),
  fetchBatchCalories: vi.fn(),
  fetchCalorieCalendar: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: mocks.getSession } }),
}));

vi.mock("@/lib/checkin/api", () => ({
  getMyCheckIns: mocks.getMyCheckIns,
}));

vi.mock("@/lib/training/http-api", () => ({
  httpTrainingApi: { getSchedule: mocks.getSchedule },
}));

vi.mock("@/lib/nutrition", () => ({
  fetchBatchCalories: mocks.fetchBatchCalories,
  fetchCalorieCalendar: mocks.fetchCalorieCalendar,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
    children,
  BarChart: ({ children }: { children: React.ReactNode }) =>
    children,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}));

function mockUserFetch() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        height: 180,
        weight: 75,
        age: 21,
        biologicalSex: "MALE",
        activityLevel: "MODERATELY_ACTIVE",
      }),
      { status: 200 },
    ),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("H-2 displays health metrics from the user profile", async () => {
  mockUserFetch();

  render(<HealthData />);

  expect(await screen.findByText("180")).toBeInTheDocument();
  expect(screen.getByText("75")).toBeInTheDocument();
  expect(screen.getByText("Normal")).toBeInTheDocument();
  expect(screen.getByText("23.1")).toBeInTheDocument();
});

it("H-2 displays the overweight BMI category", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ height: 170, weight: 85 }), { status: 200 }),
  );

  render(<HealthData />);

  expect(await screen.findByText("Overweight")).toBeInTheDocument();
});

it("H-1 edits and saves health data", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ height: 180, weight: 75 }), { status: 200 }),
  );
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ height: 175, weight: 70 }), { status: 200 }),
  );

  render(<HealthData />);
  await screen.findByText("180");
  fireEvent.click(screen.getByRole("button", { name: /edit manually/i }));

  fireEvent.change(screen.getByLabelText("Height (cm)"), {
    target: { value: "175" },
  });
  fireEvent.change(screen.getByLabelText("Weight (kg)"), {
    target: { value: "70" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

  await waitFor(() => expect(screen.getByText("175")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/user",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ height: 175, weight: 70 }),
    }),
  );
});

it("H-1 displays the health update error", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ height: 180, weight: 75 }), { status: 200 }),
  );
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  render(<HealthData />);
  await screen.findByText("180");
  fireEvent.click(screen.getByRole("button", { name: /edit manually/i }));
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent(
    "Unable to update your data, contact an administrator if you think this is unintentional",
  );
});

it("Daily check-in navigates to the check-in questionnaire", async () => {
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: "token" } },
    error: null,
  });
  mocks.getMyCheckIns.mockResolvedValue({ dates: [] });

  render(<Calendar />);

  expect(await screen.findByText("🔥 0")).toBeInTheDocument();
  const checkInButton = screen.getByRole("button", { name: "Check in" });
  expect(checkInButton).toBeEnabled();

  fireEvent.click(checkInButton);

  expect(mocks.push).toHaveBeenCalledWith("/dashboard/leaderboard");
});

it("Daily check-in displays a consecutive streak and disables the button after check-in", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: "token" } },
    error: null,
  });
  mocks.getMyCheckIns.mockResolvedValue({ dates: [yesterday, today] });

  render(<Calendar />);

  expect(await screen.findByText("🔥 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Checked in" })).toBeDisabled();
  expect(mocks.push).not.toHaveBeenCalled();
});

it("H-3 displays training totals for the latest week", async () => {
  mocks.getSchedule.mockResolvedValue({
    sessions: [],
    workouts: [
      {
        activityType: "run",
        actualVolume: 12,
        actualDurationMin: 45,
        calories: 500,
        avgHr: 150,
        rpe: 6,
        createdAt: new Date().toISOString(),
      },
    ],
  });

  render(<TrainingOverview />);

  expect(await screen.findByText("12 points")).toBeInTheDocument();
  expect(screen.getByText("45 min")).toBeInTheDocument();
  expect(screen.getByText("500 kcal")).toBeInTheDocument();
});

it("H-4 displays daily food consumption data", async () => {
  mocks.fetchBatchCalories.mockResolvedValue([
    { date: "2026-10-26", total_calories: 650 },
  ]);
  mocks.fetchCalorieCalendar.mockResolvedValue([]);
  mockUserFetch();

  render(<FoodConsumption />);

  expect(await screen.findByText("Food consumption")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "daily" })).toBeInTheDocument();
});

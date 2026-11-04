import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CalorieCalendar from "@/app/(app)/dashboard/nutrition/calorie-calendar";
import { fetchCalorieCalendar, saveCalorieTargets, type CalorieDay } from "@/lib/nutrition";
import { addDays, formatDay } from "@/lib/training/dates";

vi.mock("@/lib/nutrition", () => ({
  fetchCalorieCalendar: vi.fn(),
  saveCalorieTargets: vi.fn(),
}));

const today = "2026-11-03";
const onSelectDay = vi.fn();
const days: CalorieDay[] = Array.from({ length: 7 }, (_, index) => ({
  date: addDays(today, index), target_calories: 2000, target_source: "profile",
  total_calories: 1500, meal_count: 2,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  vi.mocked(fetchCalorieCalendar).mockReset().mockResolvedValue(days);
  vi.mocked(saveCalorieTargets).mockReset().mockResolvedValue(undefined);
  onSelectDay.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function calendar(selectedDay = today, revision = 0) {
  return <CalorieCalendar selectedDay={selectedDay} onSelectDay={onSelectDay} revision={revision} />;
}

async function loaded() {
  return screen.findByRole("spinbutton", { name: "Daily target (kcal)" });
}

describe("Calorie calendar", () => {
  it("loads the current seven days and distinguishes today from future budgets", async () => {
    render(calendar());
    expect(screen.getAllByText("Loading…")).toHaveLength(7);
    expect(await loaded()).toHaveValue(2000);
    expect(fetchCalorieCalendar).toHaveBeenCalledWith(today, "2026-11-09", expect.any(AbortSignal));
    const current = screen.getByRole("button", { name: `${formatDay(today)}, today` });
    expect(current).toHaveAttribute("aria-current", "date");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(within(current).getByText("1,500")).toBeInTheDocument();
    expect(within(current).getByText("500 remaining")).toBeInTheDocument();
    const future = screen.getByRole("button", { name: formatDay("2026-11-04") });
    expect(within(future).getByText("Available to eat")).toBeInTheDocument();
    fireEvent.click(future);
    expect(onSelectDay).toHaveBeenCalledWith("2026-11-04");
  });

  it("navigates weeks and returns to today", async () => {
    render(calendar());
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Previous seven days" }));
    await waitFor(() => expect(fetchCalorieCalendar).toHaveBeenLastCalledWith("2026-10-27", "2026-11-02", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Next seven days" }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Next seven days" }));
    await waitFor(() => expect(fetchCalorieCalendar).toHaveBeenLastCalledWith("2026-11-10", "2026-11-16", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await loaded();
    expect(onSelectDay).toHaveBeenCalledWith(today);
  });

  it("reloads on revision and follows selections outside the visible week", async () => {
    const { rerender, unmount } = render(calendar());
    await loaded();
    const signal = vi.mocked(fetchCalorieCalendar).mock.calls[0][2];
    rerender(calendar(today, 1));
    await waitFor(() => expect(fetchCalorieCalendar).toHaveBeenCalledTimes(2));
    expect(signal?.aborted).toBe(true);
    rerender(calendar("2026-11-20", 1));
    await waitFor(() => expect(fetchCalorieCalendar).toHaveBeenLastCalledWith("2026-11-20", "2026-11-26", expect.any(AbortSignal)));
    const lastSignal = vi.mocked(fetchCalorieCalendar).mock.calls.at(-1)?.[2];
    unmount();
    expect(lastSignal?.aborted).toBe(true);
  });

  it.each([new Error("Calendar offline"), "offline"])("shows fetch errors and retries: %s", async failure => {
    vi.mocked(fetchCalorieCalendar).mockRejectedValueOnce(failure);
    render(calendar());
    expect(await screen.findByRole("alert")).toHaveTextContent(failure instanceof Error ? failure.message : "Could not load your calorie calendar.");
    fireEvent.click(screen.getByRole("button", { name: "Retry calendar" }));
    await loaded();
    expect(fetchCalorieCalendar).toHaveBeenCalledTimes(2);
  });

  it.each([
    { total_calories: 2200, meal_count: 2, target_calories: 2000, text: "200 over target" },
    { total_calories: 0, meal_count: 0, target_calories: 2000, text: "No meals logged" },
    { total_calories: null, meal_count: 1, target_calories: 2000, text: "Intake incomplete" },
    { total_calories: 500, meal_count: 1, target_calories: null, text: "Logged intake" },
  ])("renders daily intake state: $text", async ({ text, ...entry }) => {
    vi.mocked(fetchCalorieCalendar).mockResolvedValue([{ ...days[0], ...entry }]);
    render(calendar());
    await loaded();
    expect(screen.getByText(text)).toBeInTheDocument();
    if (entry.target_calories === null) {
      expect(screen.getByRole("link", { name: "Complete and save your Settings" })).toHaveAttribute("href", "/dashboard/settings");
    }
  });

  it("saves only the selected day's edited budget and resets the draft when selecting another day", async () => {
    const { rerender } = render(calendar());
    fireEvent.change(await loaded(), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save day's target" }));
    expect(await screen.findByRole("status")).toHaveTextContent(`Target saved for ${formatDay(today)}`);
    expect(saveCalorieTargets).toHaveBeenCalledExactlyOnceWith([{ date: today, target_calories: 2500 }]);
    expect(screen.getByText("Saved target")).toBeInTheDocument();
    expect(screen.getByText("1,000 remaining")).toBeInTheDocument();
    rerender(calendar("2026-11-04"));
    expect(await loaded()).toHaveValue(2000);
  });

  it.each(["", "0", "-1", "1.5", "100001"])("rejects invalid target %j", async value => {
    render(calendar());
    const field = await loaded();
    fireEvent.change(field, { target: { value } });
    fireEvent.submit(field.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number between 1 and 100,000 kcal.");
    expect(saveCalorieTargets).not.toHaveBeenCalled();
  });

  it.each([new Error("Save failed"), null])("reports saving failures and allows correction: %s", async failure => {
    vi.mocked(saveCalorieTargets).mockRejectedValueOnce(failure);
    render(calendar());
    fireEvent.change(await loaded(), { target: { value: "2400" } });
    fireEvent.click(screen.getByRole("button", { name: "Save day's target" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure instanceof Error ? failure.message : "Could not save this day's target. Please retry.");
    fireEvent.change(await loaded(), { target: { value: "2300" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a late response from a previous week out of the current calendar", async () => {
    let resolve!: (value: CalorieDay[]) => void;
    vi.mocked(fetchCalorieCalendar).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.mocked(fetchCalorieCalendar).mockResolvedValue([]);
    render(calendar());
    fireEvent.click(screen.getByRole("button", { name: "Next seven days" }));
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    await act(async () => resolve(days));
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("refreshes after midnight and clears its refresh interval on unmount", async () => {
    const { unmount } = render(calendar());
    await loaded();
    unmount();
    vi.useFakeTimers();
    const view = render(calendar());
    await act(async () => {});
    vi.setSystemTime(new Date(2026, 10, 4, 0, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchCalorieCalendar).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: `${formatDay("2026-11-04")}, today` })).toHaveAttribute("aria-current", "date");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables target controls and ignores duplicate submissions while saving", async () => {
    let resolve!: () => void;
    vi.mocked(saveCalorieTargets).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(calendar());
    const field = await loaded();
    fireEvent.submit(field.closest("form")!);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(field).toBeDisabled();
    fireEvent.submit(field.closest("form")!);
    expect(saveCalorieTargets).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Target saved");
  });
});

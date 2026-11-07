import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MealAnalysis from "@/app/(app)/dashboard/nutrition/meal-analysis";
import { analyzeMeal, deleteMeal, fetchDailyLog, saveMeal, type DailyLog, type MealEstimate, type MealRecord } from "@/lib/nutrition";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

vi.mock("@/lib/nutrition", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/nutrition")>(),
  analyzeMeal: vi.fn(), deleteMeal: vi.fn(), fetchDailyLog: vi.fn(), saveMeal: vi.fn(),
}));

vi.mock("@/app/(app)/dashboard/nutrition/calorie-calendar", () => ({
  default: ({ onSelectDay, revision }: { onSelectDay: (day: string) => void; revision: number }) =>
    <button onClick={() => onSelectDay("2026-11-02")}>Calendar revision {revision}</button>,
}));

const item = { name: "Rice", estimated_weight_g: 100, calories: 200, protein_g: 4, carbs_g: 40, fat_g: 2 };
const estimate: MealEstimate = {
  meal_name: "Rice bowl", confidence_score: 0.85, training_context_note: "Recovery fuel", items: [item],
};
const meal: MealRecord = {
  ...estimate, id: "meal-1", meal_type: "lunch", logged_at: "2026-11-03T04:00:00Z",
  total_calories: 200, protein_g: 4, carbs_g: 40, fat_g: 2,
};
const daily: DailyLog = {
  date: "2026-11-03", meals: [], total_calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
  bmr: 1600, active_calories: 300, net_energy: -1900,
};
const photo = new File(["photo"], "meal.png", { type: "image/png" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  vi.mocked(fetchDailyLog).mockReset().mockResolvedValue(daily);
  vi.mocked(analyzeMeal).mockReset().mockResolvedValue(estimate);
  vi.mocked(saveMeal).mockReset().mockResolvedValue(meal);
  vi.mocked(deleteMeal).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:meal-photo");
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function upload(file = photo, label = "Choose meal photo") {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
}

async function review() {
  upload();
  fireEvent.click(screen.getByRole("button", { name: "Analyze meal" }));
  await screen.findByRole("heading", { name: "Review your meal" });
}

describe("Meal analysis", () => {
  it("loads today's journal and connects calendar and date selections", async () => {
    const { unmount } = render(<MealAnalysis />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your day");
    expect(await screen.findByText("A fresh plate, a fresh start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze meal" })).toBeDisabled();
    expect(fetchDailyLog).toHaveBeenCalledWith("2026-11-03", expect.any(AbortSignal));
    const signal = vi.mocked(fetchDailyLog).mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Calendar revision 0" }));
    await waitFor(() => expect(fetchDailyLog).toHaveBeenLastCalledWith("2026-11-02", expect.any(AbortSignal)));
    expect(signal?.aborted).toBe(true);
    fireEvent.change(screen.getByLabelText("Log date"), { target: { value: "2026-11-01" } });
    await waitFor(() => expect(fetchDailyLog).toHaveBeenLastCalledWith("2026-11-01", expect.any(AbortSignal)));
    const lastSignal = vi.mocked(fetchDailyLog).mock.calls.at(-1)?.[1];
    unmount();
    expect(lastSignal?.aborted).toBe(true);
  });

  it.each([
    { name: "empty file", size: 0, filename: "empty.png", type: "image/png", error: "Choose an image between 1 byte and 10 MB." },
    { name: "oversized file", size: 10 * 1024 * 1024 + 1, filename: "large.png", type: "image/png", error: "Choose an image between 1 byte and 10 MB." },
    { name: "PDF", size: 3, filename: "meal.pdf", type: "application/pdf", error: "Choose a JPEG, PNG, WEBP or HEIC/HEIF image." },
    { name: "missing MIME type", size: 4, filename: "meal.png", type: "", error: "Choose a JPEG, PNG, WEBP or HEIC/HEIF image." },
  ])("rejects invalid photo: $name", async ({ size, filename, type, error }) => {
    render(<MealAnalysis />);
    await screen.findByText("A fresh plate, a fresh start.");
    upload(new File([new Uint8Array(size)], filename, { type }));
    expect(screen.getByRole("alert")).toHaveTextContent(error);
    expect(screen.getByRole("button", { name: "Analyze meal" })).toBeDisabled();
    expect(analyzeMeal).not.toHaveBeenCalled();
  });

  it.each([
    ["image/jpeg", "meal.jpg"], ["image/png", "meal.png"], ["image/webp", "meal.webp"],
    ["image/heic", "meal.heic"], ["image/heif", "meal.heif"], ["", "meal.HEIC"], ["", "meal.HEIF"],
  ])("accepts photo type %s and name %s", async (type, name) => {
    render(<MealAnalysis />);
    upload(new File(["photo"], name, { type }));
    expect(await screen.findByAltText("Selected meal for analysis")).toHaveAttribute("src", "blob:meal-photo");
    expect(screen.getByRole("button", { name: "Analyze meal" })).toBeEnabled();
  });

  it("opens upload and camera controls, handles drops and releases preview URLs", async () => {
    const { unmount } = render(<MealAnalysis />);
    const fileInput = screen.getByLabelText("Choose meal photo");
    const cameraInput = screen.getByLabelText("Take meal photo");
    const choose = vi.spyOn(fileInput, "click");
    const camera = vi.spyOn(cameraInput, "click");
    fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Take photo" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(camera).toHaveBeenCalledOnce();
    const dropZone = screen.getByText("Drop your meal photo here").parentElement!;
    fireEvent.dragOver(dropZone);
    fireEvent.drop(dropZone, { dataTransfer: { files: [photo] } });
    fireEvent.error(await screen.findByAltText("Selected meal for analysis"));
    expect(screen.getByText("meal.png")).toBeInTheDocument();
    upload(new File(["other"], "other.jpg", { type: "image/jpeg" }), "Take meal photo");
    expect(await screen.findByAltText("Selected meal for analysis")).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("analyzes with notes, scales portions and saves the reviewed meal", async () => {
    render(<MealAnalysis />);
    const notes = screen.getByRole("textbox", { name: "Anything the photo can’t tell us?" });
    fireEvent.change(notes, { target: { value: "After a run" } });
    expect(screen.getByText("11/500")).toBeInTheDocument();
    await review();
    expect(analyzeMeal).toHaveBeenCalledExactlyOnceWith(photo, "After a run");
    expect(saveMeal).not.toHaveBeenCalled();
    expect(screen.getByText("85% visual confidence")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Meal name"), { target: { value: "Recovery bowl" } });
    fireEvent.change(screen.getByLabelText("Meal type"), { target: { value: "dinner" } });
    fireEvent.change(screen.getByLabelText("Weight (g)"), { target: { value: "200" } });
    expect(screen.getByLabelText("Calories")).toHaveValue(400);
    expect(screen.getByLabelText("Protein (g)")).toHaveValue(8);
    fireEvent.click(screen.getByRole("button", { name: "Confirm & log meal" }));
    expect(await screen.findByText("Meal saved. Your daily totals have been updated.")).toHaveAttribute("role", "status");
    expect(saveMeal).toHaveBeenCalledExactlyOnceWith({
      ...estimate, meal_name: "Recovery bowl", meal_type: "dinner", id: expect.any(String),
      logged_at: new Date().toISOString(),
      items: [{ ...item, estimated_weight_g: 200, calories: 400, protein_g: 8, carbs_g: 80, fat_g: 4 }],
    });
    expect(screen.queryByRole("heading", { name: "Review your meal" })).not.toBeInTheDocument();
    expect(notes).toHaveValue("");
    expect(screen.getByRole("button", { name: "Calendar revision 1" })).toBeInTheDocument();
    expect(fetchDailyLog).toHaveBeenCalledTimes(2);
  });

  it("supports manual ingredients, nutrient edits, removal and discarding", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MealAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: "Or enter a meal manually" }));
    expect(screen.getByText("Manual entry")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm & log meal" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Meal name"), { target: { value: "Lunch" } });
    fireEvent.change(screen.getByLabelText("Ingredient 1 name"), { target: { value: "Beans" } });
    expect(confirm).toBeEnabled();
    for (const label of ["Calories", "Protein (g)", "Carbs (g)", "Fat (g)"]) {
      const field = screen.getByLabelText(label);
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "012" } });
      expect(field).toHaveValue(12);
      fireEvent.change(field, { target: { value: "" } });
      expect(field).toHaveValue(null);
    }
    fireEvent.change(screen.getByLabelText("Weight (g)"), { target: { value: "" } });
    expect(screen.getByLabelText("Weight (g)")).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Add ingredient" }));
    expect(screen.getByLabelText("Ingredient 2 name")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove ingredient 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove ingredient 1" }));
    expect(screen.getByText("Add at least one ingredient before saving.")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByText("Review your meal")).not.toBeInTheDocument();
    expect(saveMeal).not.toHaveBeenCalled();
    expect(analyzeMeal).not.toHaveBeenCalled();
    await screen.findByText("A fresh plate, a fresh start.");
  });

  it.each([499, 500])("accepts a context note of %i characters", async length => {
    render(<MealAnalysis />);
    const notes = "n".repeat(length);
    fireEvent.change(screen.getByRole("textbox", { name: "Anything the photo can’t tell us?" }), {
      target: { value: notes },
    });
    await review();
    expect(analyzeMeal).toHaveBeenCalledExactlyOnceWith(photo, notes);
  });

  it("truncates oversized notes and shows the 500-character limit", async () => {
    render(<MealAnalysis />);
    const field = screen.getByRole("textbox", { name: "Anything the photo can’t tell us?" });
    expect(field).toHaveAttribute("maxlength", "500");
    fireEvent.change(field, { target: { value: "n".repeat(501) } });
    expect(field).toHaveValue("n".repeat(500));
    expect(screen.getByText("500/500")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Character limit reached (max 500 characters).");
    fireEvent.change(field, { target: { value: "Shorter note" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await review();
    expect(analyzeMeal).toHaveBeenCalledExactlyOnceWith(photo, "Shorter note");
  });

  it.each(["photo", "manual"])("confirms before discarding a %s draft and preserves cancelled edits", async source => {
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<MealAnalysis />);
    if (source === "photo") await review();
    else fireEvent.click(screen.getByRole("button", { name: "Or enter a meal manually" }));
    fireEvent.change(screen.getByLabelText("Meal name"), { target: { value: "Keep my edits" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(confirmDiscard).toHaveBeenCalledWith("Are you sure you want to discard this meal log?");
    expect(screen.getByLabelText("Meal name")).toHaveValue("Keep my edits");
    expect(saveMeal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(confirmDiscard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Review your meal" })).not.toBeInTheDocument();
    expect(saveMeal).not.toHaveBeenCalled();
  });

  it.each([new Error("Analysis unavailable"), null])("reports analysis errors and restores the controls: %s", async failure => {
    vi.mocked(analyzeMeal).mockRejectedValueOnce(failure);
    render(<MealAnalysis />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Analyze meal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure instanceof Error ? failure.message : "Something went wrong. Please try again.");
    expect(screen.getByRole("button", { name: "Analyze meal" })).toBeEnabled();
    expect(saveMeal).not.toHaveBeenCalled();
  });

  it("keeps the draft and stable request ID after a failed save", async () => {
    vi.mocked(saveMeal).mockRejectedValueOnce(new Error("Save unavailable"));
    render(<MealAnalysis />);
    await review();
    fireEvent.click(screen.getByRole("button", { name: "Confirm & log meal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
    expect(screen.getByLabelText("Meal name")).toHaveValue("Rice bowl");
    fireEvent.click(screen.getByRole("button", { name: "Confirm & log meal" }));
    await screen.findByText("Meal saved. Your daily totals have been updated.");
    expect(vi.mocked(saveMeal).mock.calls[1][0]).toEqual(vi.mocked(saveMeal).mock.calls[0][0]);
  });

  it("disables controls during analysis and prevents a dropped photo from replacing the pending input", async () => {
    let resolve!: (value: MealEstimate) => void;
    vi.mocked(analyzeMeal).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<MealAnalysis />);
    upload();
    fireEvent.click(screen.getByRole("button", { name: "Analyze meal" }));
    expect(screen.getByRole("button", { name: "Analyzing your meal…" })).toBeDisabled();
    const dropZone = screen.getByAltText("Selected meal for analysis").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [new File(["other"], "other.png", { type: "image/png" })] } });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    await act(async () => resolve(estimate));
    expect(analyzeMeal).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Review your meal" })).toBeInTheDocument();
  });

  it("limits analysis drafts to 50 ingredients and clears a draft when changing photos", async () => {
    vi.mocked(analyzeMeal).mockResolvedValueOnce({ ...estimate, items: Array.from({ length: 50 }, () => ({ ...item })) });
    render(<MealAnalysis />);
    await review();
    expect(screen.getByRole("button", { name: "Add ingredient" })).toBeDisabled();
    upload(new File(["other"], "other.png", { type: "image/png" }));
    expect(screen.queryByText("Review your meal")).not.toBeInTheDocument();
  });
});

describe("Daily fuel and meal journal", () => {
  it.each([null, -200, 200])("renders available and incomplete energy values: %s", async energy => {
    vi.mocked(fetchDailyLog).mockResolvedValue({
      ...daily, total_calories: null, protein_g: null, carbs_g: null, fat_g: null,
      bmr: energy === null ? null : 1600, active_calories: energy === null ? null : 300, net_energy: energy,
    });
    render(<MealAnalysis />);
    expect(await screen.findByText(/Some saved meals have incomplete nutrition/)).toBeInTheDocument();
    if (energy === null) {
      expect(screen.getByRole("link", { name: "Complete your profile for BMR" })).toHaveAttribute("href", "/dashboard/settings");
      expect(screen.getAllByText("Unavailable")).toHaveLength(2);
      expect(screen.getByText(/Exercise burn appears when/)).toBeInTheDocument();
    } else {
      expect(screen.getByText(`${energy > 0 ? "+" : ""}${energy} kcal`)).toBeInTheDocument();
    }
  });

  it("retries a failed daily log request", async () => {
    vi.mocked(fetchDailyLog).mockRejectedValueOnce(new Error("Journal unavailable"));
    render(<MealAnalysis />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Journal unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("A fresh plate, a fresh start.");
    expect(fetchDailyLog).toHaveBeenCalledTimes(2);
  });

  it("shows journal details and requires confirmation before deleting", async () => {
    vi.mocked(fetchDailyLog).mockResolvedValueOnce({ ...daily, meals: [meal] });
    render(<MealAnalysis />);
    fireEvent.click(await screen.findByText("Rice bowl"));
    expect(screen.getByText("Rice · 100 g · 200 kcal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
    expect(deleteMeal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep meal" }));
    expect(screen.queryByText("Delete this meal?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await screen.findByText("A fresh plate, a fresh start.");
    expect(deleteMeal).toHaveBeenCalledExactlyOnceWith("meal-1");
    expect(screen.queryByText("Rice bowl")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calendar revision 1" })).toBeInTheDocument();
  });

  it("keeps the meal after a deletion failure and supports retrying", async () => {
    vi.mocked(fetchDailyLog).mockResolvedValue({ ...daily, meals: [{ ...meal, meal_type: null, total_calories: null, items: [{ ...item, calories: null }] }] });
    vi.mocked(deleteMeal).mockRejectedValueOnce(new Error("Delete unavailable"));
    render(<MealAnalysis />);
    fireEvent.click(await screen.findByText("Rice bowl"));
    expect(screen.getByText("Rice · 100 g · — kcal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete meal" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Delete unavailable");
    expect(screen.getByText("Rice bowl")).toBeInTheDocument();
    const journal = screen.getByText("Delete this meal?").parentElement!;
    expect(within(journal).getByRole("button", { name: "Yes, delete" })).toBeEnabled();
    expect(fetchDailyLog).toHaveBeenCalledOnce();
  });
});

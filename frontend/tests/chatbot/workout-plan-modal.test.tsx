import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkoutPlanModal } from "@/app/(app)/dashboard/ai/_components/workout-plan-modal";
import type { WorkoutPlan } from "@/app/(app)/dashboard/ai/types";

describe("WorkoutPlanModal Component", () => {
  const initialPlan: WorkoutPlan = {
    title: "Leg Hypertrophy",
    focus: "Quadriceps and Calves",
    exercises: [
      { name: "Barbell Squat", sets: 4, reps: "8-10", targetWeight: "80kg" },
      { name: "Leg Extension", sets: 3, reps: "12", targetWeight: "45kg" },
    ],
  };

  it("returns null when isOpen is false", () => {
    const { container } = render(
      <WorkoutPlanModal
        isOpen={false}
        onClose={vi.fn()}
        plan={initialPlan}
        setPlan={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders properly and triggers title/focus edits", () => {
    const setPlan = vi.fn();
    render(
      <WorkoutPlanModal
        isOpen={true}
        onClose={vi.fn()}
        plan={initialPlan}
        setPlan={setPlan}
        onSave={vi.fn()}
      />
    );

    const titleInput = screen.getByDisplayValue("Leg Hypertrophy");
    fireEvent.change(titleInput, { target: { value: "Upper Body Strength" } });
    expect(setPlan).toHaveBeenCalledWith({
      ...initialPlan,
      title: "Upper Body Strength",
    });

    const focusInput = screen.getByDisplayValue("Quadriceps and Calves");
    fireEvent.change(focusInput, { target: { value: "Chest and Back" } });
    expect(setPlan).toHaveBeenCalledWith({
      ...initialPlan,
      focus: "Chest and Back",
    });
  });

  it("adds a new exercise when Add Exercise button is clicked", () => {
    const setPlan = vi.fn();
    render(
      <WorkoutPlanModal
        isOpen={true}
        onClose={vi.fn()}
        plan={initialPlan}
        setPlan={setPlan}
        onSave={vi.fn()}
      />
    );

    const addBtn = screen.getByRole("button", { name: /Add Exercise/i });
    fireEvent.click(addBtn);

    expect(setPlan).toHaveBeenCalledWith({
      ...initialPlan,
      exercises: [
        ...initialPlan.exercises,
        { name: "New Exercise", sets: 3, reps: "10", targetWeight: "Bodyweight" },
      ],
    });
  });

  it("updates individual exercise fields (name, sets, reps)", () => {
    const setPlan = vi.fn();
    render(
      <WorkoutPlanModal
        isOpen={true}
        onClose={vi.fn()}
        plan={initialPlan}
        setPlan={setPlan}
        onSave={vi.fn()}
      />
    );

    // Edit Name
    const nameInput = screen.getByDisplayValue("Barbell Squat");
    fireEvent.change(nameInput, { target: { value: "Front Squat" } });
    expect(setPlan).toHaveBeenCalled();

    // Edit Sets
    const setsInput = screen.getByDisplayValue("4");
    fireEvent.change(setsInput, { target: { value: "5" } });
    expect(setPlan).toHaveBeenCalled();

    // Edit Reps
    const repsInput = screen.getByDisplayValue("8-10");
    fireEvent.change(repsInput, { target: { value: "12" } });
    expect(setPlan).toHaveBeenCalled();
  });

  it("deletes an exercise entry and triggers onSave and onClose", () => {
    const setPlan = vi.fn();
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <WorkoutPlanModal
        isOpen={true}
        onClose={onClose}
        plan={initialPlan}
        setPlan={setPlan}
        onSave={onSave}
      />
    );

    // Target the delete button within the first exercise item row
    const exerciseInputs = screen.getAllByPlaceholderText("Exercise");
    const firstRow = exerciseInputs[0].closest("div");
    const trashBtn = firstRow?.querySelector("button[type='button']");

    expect(trashBtn).not.toBeNull();
    if (trashBtn) {
      fireEvent.click(trashBtn);
      expect(setPlan).toHaveBeenCalledWith({
        ...initialPlan,
        exercises: [initialPlan.exercises[1]],
      });
    }

    // Save and Cancel buttons
    fireEvent.click(screen.getByRole("button", { name: /Save Workout Record/i }));
    expect(onSave).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();

    // Header close button (the one in the header flex row)
    const headerTitle = screen.getByText(/Save Workout to Training Page/i);
    const headerRow = headerTitle.closest("div")?.parentElement;
    const headerCloseBtn = headerRow?.querySelector("button");

    if (headerCloseBtn) {
      fireEvent.click(headerCloseBtn);
      expect(onClose).toHaveBeenCalledTimes(2);
    }
  });
});
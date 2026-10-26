import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import Dashboard from "@/app/(app)/dashboard/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/(app)/dashboard/components/calendar", () => ({
  default: () =>
    createElement(
      "div",
      { "data-testid": "dashboard-calendar" },
      "Daily check-in",
    ),
}));

vi.mock("@/app/(app)/dashboard/components/health-data", () => ({
  default: () =>
    createElement(
      "div",
      { "data-testid": "dashboard-health" },
      "Health data",
    ),
}));

vi.mock("@/app/(app)/dashboard/components/training-overview", () => ({
  default: () =>
    createElement(
      "div",
      { "data-testid": "dashboard-training" },
      "Training overview",
    ),
}));

vi.mock("@/app/(app)/dashboard/components/food-consumption", () => ({
  default: () =>
    createElement(
      "div",
      { "data-testid": "dashboard-food" },
      "Food consumption",
    ),
}));

it("renders the dashboard heading and description", () => {
  render(createElement(Dashboard));

  expect(
    screen.getByRole("heading", { name: "Today" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Your health, training and nutrition, all in one place."),
  ).toBeInTheDocument();
});

it("renders each dashboard section", () => {
  render(createElement(Dashboard));

  expect(screen.getByTestId("dashboard-health")).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-calendar")).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-training")).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-food")).toBeInTheDocument();
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";
import RootLayout, { metadata } from "@/app/layout";

vi.mock("sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

describe("HomePage", () => {
  it("renders the product navigation and feature sections", () => {
    render(<HomePage />);

    expect(screen.getByText("FITRA -")).toBeInTheDocument();
    expect(
      screen.getByText("Fitness & Nutrition Tracker"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign In" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.getByRole("link", { name: /Launch App/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByRole("heading", { name: "Train meaningfully." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nutrition" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI Assistance" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Leaderboard & Friends" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Aisha")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Daniel")).toBeInTheDocument();
  });
});

describe("RootLayout", () => {
  it("exports the expected metadata", () => {
    expect(metadata).toEqual({
      title: "FITRA — AI-Driven Endurance & Recovery",
      description:
        "Serverless, zero-cost AI-driven endurance training, Banister TRIMP telemetry, and ACWR recovery optimization.",
    });
  });

  it("renders children in the dark document shell with the toaster", () => {
    render(
      <RootLayout>
        <main>Application content</main>
      </RootLayout>,
    );

    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByText("Application content")).toBeInTheDocument();
    expect(screen.getByTestId("toaster")).toBeInTheDocument();
  });
});

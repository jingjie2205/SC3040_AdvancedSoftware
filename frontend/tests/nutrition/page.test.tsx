import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NutritionPage from "@/app/(app)/dashboard/nutrition/page";

const { getUser, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/app/(app)/dashboard/nutrition/meal-analysis", () => ({
  default: () => <h1>Meal analysis</h1>,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Nutrition page", () => {
  it("renders meal analysis for a signed-in user", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "athlete" } } });
    render(await NutritionPage());
    expect(screen.getByRole("heading", { name: "Meal analysis" })).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects signed-out users to login", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const redirected = new Error("NEXT_REDIRECT");
    redirect.mockImplementation(() => { throw redirected; });
    await expect(NutritionPage()).rejects.toBe(redirected);
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  });
});

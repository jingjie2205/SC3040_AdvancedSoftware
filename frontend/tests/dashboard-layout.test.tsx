import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "@/app/(app)/layout";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  usePathname: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: mocks.getUser,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: mocks.signOut,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: mocks.usePathname,
  useRouter: () => ({
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
}));

describe("DashboardLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePathname.mockReturnValue("/dashboard");
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    mocks.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: mocks.unsubscribe } },
    });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it("renders navigation and children for an unauthenticated user", async () => {
    render(
      <DashboardLayout>
        <p>Dashboard content</p>
      </DashboardLayout>,
    );

    expect(await screen.findByText("Dashboard content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByRole("link", { name: "Leaderboard" })).toHaveAttribute(
      "href",
      "/dashboard/leaderboard",
    );
    expect(screen.queryByRole("button", { name: /welcome back/i })).toBeNull();
  });

  it("shows the authenticated user menu and logs out successfully", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          email: "athlete@example.com",
          user_metadata: { name: "Athlete" },
        },
      },
      error: null,
    });

    render(<DashboardLayout><p>Content</p></DashboardLayout>);

    const userButton = await screen.findByRole("button", {
      name: /welcome back, athlete/i,
    });
    fireEvent.click(userButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Logout" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith("/login");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("uses the email prefix when the user has no display name", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { email: "runner@example.com", user_metadata: {} } },
      error: null,
    });

    render(<DashboardLayout><p>Content</p></DashboardLayout>);

    expect(
      await screen.findByRole("button", { name: /welcome back, runner/i }),
    ).toBeInTheDocument();
  });

  it("clears the user when auth state changes to signed out", async () => {
    let authChange: (_event: string, session: null) => void = () => undefined;
    mocks.onAuthStateChange.mockImplementation(
      (callback: (_event: string, session: null) => void) => {
        authChange = callback;
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
    );
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          email: "athlete@example.com",
          user_metadata: { name: "Athlete" },
        },
      },
      error: null,
    });

    render(<DashboardLayout><p>Content</p></DashboardLayout>);
    expect(
      await screen.findByRole("button", { name: /welcome back, athlete/i }),
    ).toBeInTheDocument();

    authChange("SIGNED_OUT", null);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /welcome back/i }),
      ).toBeNull(),
    );
  });
});

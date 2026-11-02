import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Create mock functions that we can inspect during testing.
const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  getUser: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

// Mock the Supabase browser client.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
    },
  }),
}));

// Mock the Supabase server client used by middleware.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: mocks.getUser,
    },
  }),
}));

// Mock Next.js navigation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
  }),
}));

// Import the actual login page.
// Change this path if your page.tsx is located elsewhere.
import LoginPage from "@/app/(auth)/login/page";

describe("Login Page Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Simulate a successful Supabase login by default.
    mocks.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: "test-user-123" },
        session: { access_token: "mock-access-token" },
      },
      error: null,
    });
  });

  // LGT-1: Successful User Login
  it("LGT-1: logs in successfully and redirects to the dashboard", async () => {
    render(<LoginPage />);

    // Enter the user's email address.
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "athlete@example.com" },
    });

    // Enter the user's password.
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "ValidPassword123!" },
    });

    // Click the Log In button.
    fireEvent.click(screen.getByRole("button", { name: "Log In" }));

    // Verify that Supabase receives the entered credentials.
    await waitFor(() => {
      expect(mocks.signInWithPassword).toHaveBeenCalledWith({
        email: "athlete@example.com",
        password: "ValidPassword123!",
      });
    });

    // Verify that the user is redirected to the dashboard.
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/dashboard");
    });

    // Verify that Next.js refreshes the page.
    expect(mocks.refresh).toHaveBeenCalled();
  });

    // LGT-2: Login with Invalid Credentials
    it("LGT-2: displays an error when login credentials are invalid", async () => {
        // Simulate Supabase returning an authentication error
        mocks.signInWithPassword.mockResolvedValueOnce({
            data: { user: null, session: null },
            error: { message: "Invalid login credentials" },
        });

        render(<LoginPage />);

        // Enter invalid credentials
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "athlete@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "WrongPassword123!" },
        });

        // Click the login button
        fireEvent.click(screen.getByRole("button", { name: "Log In" }));

        // Verify the error message is displayed
        expect(
            await screen.findByText("Invalid login credentials")
        ).toBeInTheDocument();

        // Verify the user is not redirected
        expect(mocks.push).not.toHaveBeenCalled();
    });
});

describe("Middleware Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  // LGT-3: Unauthenticated access to protected pages
  it("LGT-3: redirects unauthenticated users from dashboard to login", async () => {
    // Simulate an unauthenticated user.
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Auth session missing" },
    });

    // Simulate a request to the protected dashboard.
    const request = new NextRequest(
      "http://localhost:3000/dashboard"
    );

    // Execute the middleware.
    const response = await middleware(request);

    // Verify that the user is redirected to login.
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login"
    );
  });
});
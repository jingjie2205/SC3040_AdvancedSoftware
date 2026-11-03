import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Create mock functions that we can inspect during testing.
const mocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  push: vi.fn(),
}));

// Mock the Supabase browser client.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signUp: mocks.signUp,
    },
  }),
}));

// Mock Next.js navigation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
  }),
}));

// Import the actual registration page.
import RegisterPage from "@/app/(auth)/register/page";

describe("Register Page Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Simulate successful registration by default.
    mocks.signUp.mockResolvedValue({
      data: {
        user: { id: "test-user-123" },
      },
      error: null,
    });
  });

    // RGT-1: Successful User Registration
    it("RGT-1: registers successfully and redirects to login", async () => {
        render(<RegisterPage />);

        // Enter the user's name.
        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "  John Tan  " },
        });

        // Enter the user's email address.
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        // Enter the user's password.
        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        // Confirm the user's password.
        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        // Click the Create Account button.
        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        // Verify that Supabase receives the correct registration details.
        await waitFor(() => {
            expect(mocks.signUp).toHaveBeenCalledWith({
            email: "john@example.com",
            password: "Password123",
            options: {
                data: {
                name: "John Tan",
                },
            },
            });
        });

        // Verify that the success message appears.
        expect(
            await screen.findByText(
            "Account created successfully! Redirecting to login..."
            )
        ).toBeInTheDocument();

        // Verify that the form has been reset.
        expect(screen.getByLabelText("Full Name")).toHaveValue("");
        expect(screen.getByLabelText("Email")).toHaveValue("");
        expect(screen.getByLabelText("Password")).toHaveValue("");
        expect(screen.getByLabelText("Confirm Password")).toHaveValue("");

        // Verify that the user has not been redirected immediately.
        expect(mocks.push).not.toHaveBeenCalled();

        // Verify that the user is redirected after 2 seconds.
        await waitFor(
            () => {
            expect(mocks.push).toHaveBeenCalledWith("/login");
            },
            { timeout: 3000 }
        );
    });

    // RGT-2: Registration with Whitespace-Only Name
    it("RGT-2: displays an error when the name contains only spaces", async () => {
        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "   " },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        expect(
            await screen.findByText("Please enter your name.")
        ).toBeInTheDocument();

        expect(mocks.signUp).not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
    });    

    // RGT-3: Registration with Empty Email
    it("RGT-3: displays an error when the email is empty", async () => {
        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        fireEvent.submit(screen.getByRole("button", { name: "Create Account" }).closest("form")!);

        expect(
            await screen.findByText("Please enter your email.")
        ).toBeInTheDocument();

        expect(mocks.signUp).not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
    });

    // RGT-4: Registration with Short Password
    it("RGT-4: displays an error when the password is shorter than 8 characters", async () => {
        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Pass12" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Pass12" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        expect(
            await screen.findByText("Password must be at least 8 characters.")
        ).toBeInTheDocument();

        expect(mocks.signUp).not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
    });

    // RGT-5: Registration with Mismatched Passwords
    it("RGT-5: displays an error when passwords do not match", async () => {
        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Different123" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        expect(
            await screen.findByText("Passwords do not match.")
        ).toBeInTheDocument();

        expect(mocks.signUp).not.toHaveBeenCalled();
        expect(mocks.push).not.toHaveBeenCalled();
    });

    // RGT-6: Registration with Supabase Error
    it("RGT-6: displays an error when Supabase sign-up fails", async () => {
        mocks.signUp.mockResolvedValueOnce({
            data: { user: null },
            error: { message: "Email already registered" },
        });

        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        expect(
            await screen.findByText("Email already registered")
        ).toBeInTheDocument();

        expect(mocks.signUp).toHaveBeenCalledTimes(1);
        expect(mocks.push).not.toHaveBeenCalled();
    });

    // RGT-7: Registration without Returned User
    it("RGT-7: displays an error when Supabase returns no user", async () => {
        mocks.signUp.mockResolvedValueOnce({
            data: { user: null },
            error: null,
        });

        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        expect(
            await screen.findByText("Unable to create account.")
        ).toBeInTheDocument();

        expect(mocks.signUp).toHaveBeenCalledTimes(1);
        expect(mocks.push).not.toHaveBeenCalled();
    });

    // RGT-8: Registration Loading State
    it("RGT-8: disables the button while registration is processing", async () => {
        let resolveSignUp: (value: any) => void = () => {};

        mocks.signUp.mockImplementationOnce(
            () =>
            new Promise((resolve) => {
                resolveSignUp = resolve;
            })
        );

        render(<RegisterPage />);

        fireEvent.change(screen.getByLabelText("Full Name"), {
            target: { value: "John Tan" },
        });

        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "john@example.com" },
        });

        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "Password123" },
        });

        fireEvent.change(screen.getByLabelText("Confirm Password"), {
            target: { value: "Password123" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

        const loadingButton = await screen.findByRole("button", {
            name: "Creating account...",
        });

        expect(loadingButton).toBeDisabled();

        resolveSignUp({
            data: { user: { id: "test-user-123" } },
            error: null,
        });
    });

});
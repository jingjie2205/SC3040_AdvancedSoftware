import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

import { middleware } from "@/middleware";

describe("Authentication Middleware Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    mocks.createServerClient.mockReturnValue({
      auth: {
        getUser: mocks.getUser,
      },
    });

    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });
  });

    // MW-1: Unauthenticated user accesses dashboard
    it("MW-1: redirects unauthenticated users to login", async () => {
        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/login"
        );

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-2: Authenticated user accesses dashboard
    it("MW-2: allows authenticated users to access dashboard", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: { id: "test-user-123" } },
            error: null,
        });

        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });    

    // MW-3: Unauthenticated user accesses login
    it("MW-3: allows unauthenticated users to access login", async () => {
        const request = new NextRequest(
            "http://localhost:3000/login"
        );

        const response = await middleware(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-4: Unauthenticated user accesses register
    it("MW-4: allows unauthenticated users to access register", async () => {
        const request = new NextRequest(
            "http://localhost:3000/register"
        );

        const response = await middleware(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-5: Authenticated user accesses login
    it("MW-5: redirects authenticated users from login to dashboard", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: { id: "test-user-123" } },
            error: null,
        });

        const request = new NextRequest(
            "http://localhost:3000/login"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/dashboard"
        );

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-6: Authenticated user accesses register
    it("MW-6: redirects authenticated users from register to dashboard", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: { id: "test-user-123" } },
            error: null,
        });

        const request = new NextRequest(
            "http://localhost:3000/register"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/dashboard"
        );

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-7: Handles missing Supabase environment variables
    it("MW-7: allows the request to continue when Supabase environment variables are missing", async () => {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;

        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();
        expect(mocks.createServerClient).not.toHaveBeenCalled();

        expect(consoleError).toHaveBeenCalledWith(
            "Supabase environment variables are missing."
        );

        consoleError.mockRestore();
    });

    // MW-8: Redirects when Supabase returns an authentication error
    it("MW-8: redirects to login when Supabase returns an authentication error", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: null },
            error: { message: "Invalid session" },
        });

        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/login"
        );

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
    });

    // MW-9: Updates session cookies
    it("MW-9: updates session cookies when Supabase refreshes the session", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: { id: "test-user-123" } },
            error: null,
        });

        mocks.createServerClient.mockImplementationOnce(
            (_url, _key, options) => {
            options.cookies.setAll([
                {
                name: "test-session",
                value: "refreshed-token",
                options: {
                    httpOnly: true,
                    path: "/",
                },
                },
            ]);

            return {
                auth: {
                getUser: mocks.getUser,
                },
            };
            }
        );

        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(200);
        expect(response.cookies.get("test-session")?.value).toBe(
            "refreshed-token"
        );
    });

    // MW-10: Preserves cookies when redirecting to login
    it("MW-10: preserves updated cookies when redirecting unauthenticated users", async () => {
        mocks.createServerClient.mockImplementationOnce(
            (_url, _key, options) => {
            options.cookies.setAll([
                {
                name: "test-session",
                value: "refreshed-token",
                options: { path: "/" },
                },
            ]);

            return {
                auth: {
                getUser: mocks.getUser,
                },
            };
            }
        );

        const request = new NextRequest(
            "http://localhost:3000/dashboard"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/login"
        );
        expect(response.cookies.get("test-session")?.value).toBe(
            "refreshed-token"
        );
    });

    // MW-11: Preserves cookies when redirecting to dashboard
    it("MW-11: preserves updated cookies when redirecting authenticated users", async () => {
        mocks.getUser.mockResolvedValueOnce({
            data: { user: { id: "test-user-123" } },
            error: null,
        });

        mocks.createServerClient.mockImplementationOnce(
            (_url, _key, options) => {
            options.cookies.setAll([
                {
                name: "test-session",
                value: "refreshed-token",
                options: { path: "/" },
                },
            ]);

            return {
                auth: {
                getUser: mocks.getUser,
                },
            };
            }
        );

        const request = new NextRequest(
            "http://localhost:3000/login"
        );

        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
            "http://localhost:3000/dashboard"
        );
        expect(response.cookies.get("test-session")?.value).toBe(
            "refreshed-token"
        );
    });

    // MW-12: Reads existing request cookies
    it("MW-12: reads existing cookies from the request", async () => {
        const request = new NextRequest(
            "http://localhost:3000/dashboard",
            {
            headers: {
                cookie: "test-session=existing-token",
            },
            }
        );

        await middleware(request);

        const supabaseConfig =
            mocks.createServerClient.mock.calls[0][2];

        const cookies = supabaseConfig.cookies.getAll();

        expect(cookies).toEqual(
            expect.arrayContaining([
            expect.objectContaining({
                name: "test-session",
                value: "existing-token",
            }),
            ])
        );
    });

});
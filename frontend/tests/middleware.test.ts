import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "@/middleware";

type CookieToSet = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

type CookieAdapter = {
  getAll: () => unknown[];
  setAll: (cookiesToSet: CookieToSet[]) => void;
};

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  cookieAdapter: undefined as CookieAdapter | undefined,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _supabaseUrl: string,
    _supabaseKey: string,
    options: { cookies: CookieAdapter }
  ) => {
    mocks.cookieAdapter = options.cookies;
    return { auth: { getUser: mocks.getUser } };
  },
}));

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  it("returns the request response when Supabase configuration is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await middleware(
      new NextRequest("http://localhost:3000/dashboard")
    );

    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith(
      "Supabase environment variables are missing."
    );
    expect(mocks.getUser).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("refreshes cookies and copies them to the authenticated redirect", async () => {
    mocks.getUser.mockImplementationOnce(async () => {
      mocks.cookieAdapter?.setAll([
        {
          name: "sb-session",
          value: "refreshed",
          options: { httpOnly: true },
        },
      ]);

      return { data: { user: { id: "user-1" } }, error: null };
    });

    const response = await middleware(
      new NextRequest("http://localhost:3000/login?next=%2Fdashboard")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard"
    );
    expect(response.cookies.get("sb-session")?.value).toBe("refreshed");
  });
});

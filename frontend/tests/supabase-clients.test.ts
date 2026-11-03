import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseClient: vi.fn(),
  createServerClient: vi.fn(),
  cookies: vi.fn(),
  cookieStore: {
    getAll: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createSupabaseClient,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

describe("createAdminClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSupabaseClient.mockReturnValue({ client: "admin" });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates a non-persisted admin client from the configured environment", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");

    expect(createAdminClient()).toEqual({ client: "admin" });
    expect(mocks.createSupabaseClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "service-role-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
  });

  it("uses placeholder values when admin configuration is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createAdminClient } = await import("@/lib/supabase/admin");

    createAdminClient();

    expect(mocks.createSupabaseClient).toHaveBeenCalledWith(
      "https://placeholder.supabase.co",
      "placeholder-service-role-key",
      expect.any(Object)
    );
  });
});

describe("createClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue(mocks.cookieStore);
    mocks.cookieStore.getAll.mockReturnValue([
      { name: "session", value: "cookie-value" },
    ]);
    mocks.createServerClient.mockReturnValue({ client: "server" });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates a server client with the configured environment and cookie adapter", async () => {
    const { createClient } = await import("@/lib/supabase/server");

    expect(await createClient()).toEqual({ client: "server" });
    expect(mocks.createServerClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "anon-key",
      expect.objectContaining({
        cookies: expect.any(Object),
      })
    );

    const options = mocks.createServerClient.mock.calls[0][2];
    expect(options.cookies.getAll()).toEqual([
      { name: "session", value: "cookie-value" },
    ]);
    options.cookies.setAll([
      { name: "session", value: "updated", options: { httpOnly: true } },
    ]);
    expect(mocks.cookieStore.set).toHaveBeenCalledWith(
      "session",
      "updated",
      { httpOnly: true }
    );
  });

  it("uses placeholder values and tolerates prohibited cookie writes", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    mocks.cookieStore.set.mockImplementationOnce(() => {
      throw new Error("cookie writes are prohibited");
    });
    const { createClient } = await import("@/lib/supabase/server");

    await createClient();

    expect(mocks.createServerClient).toHaveBeenCalledWith(
      "https://placeholder.supabase.co",
      "placeholder-anon-key",
      expect.any(Object)
    );
    const options = mocks.createServerClient.mock.calls[0][2];
    expect(() =>
      options.cookies.setAll([{ name: "session", value: "updated" }])
    ).not.toThrow();
  });
});

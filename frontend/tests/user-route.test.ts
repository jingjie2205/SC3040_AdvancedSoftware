import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getSession: mocks.getSession } }),
}));

const fetchMock = vi.fn<typeof fetch>();

async function loadRoute() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000/api");
  return import("@/app/api/user/route");
}

beforeEach(() => {
  mocks.getSession.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("user API route", () => {
  it("returns 401 when GET has no session", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    const { GET } = await loadRoute();

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the backend user data for an authenticated GET", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "access-token" } },
    });
    const user = { id: "user-1", name: "Athlete" };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(user), { status: 200 }),
    );
    const { GET } = await loadRoute();

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(user);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: expect.any(String),
        }),
      }),
    );
  });

  it("passes backend errors through for GET", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "access-token" } },
    });
    fetchMock.mockResolvedValue(new Response("Backend unavailable", { status: 503 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadRoute();

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Backend unavailable");
    consoleError.mockRestore();
  });

  it("returns 500 when GET encounters an exception", async () => {
    mocks.getSession.mockRejectedValue(new Error("Supabase unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadRoute();

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("An internal error occurred");
    consoleError.mockRestore();
  });

  it("returns 401 when PUT has no session", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    const { PUT } = await loadRoute();

    const response = await PUT(
      new Request("http://localhost:3000/api/user", {
        method: "PUT",
        body: JSON.stringify({ name: "Athlete" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("forwards the body and returns the backend response for PUT", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "access-token" } },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ name: "Updated Athlete" }), { status: 200 }),
    );
    const { PUT } = await loadRoute();
    const body = { name: "Updated Athlete", weight: 70 };

    const response = await PUT(
      new Request("http://localhost:3000/api/user", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ name: "Updated Athlete" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/users/me",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
  });

  it("returns 500 when PUT encounters an exception", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "access-token" } },
    });
    fetchMock.mockRejectedValue(new Error("Backend unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { PUT } = await loadRoute();

    const response = await PUT(
      new Request("http://localhost:3000/api/user", {
        method: "PUT",
        body: JSON.stringify({ name: "Athlete" }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("An internal error occurred");
    consoleError.mockRestore();
  });
});

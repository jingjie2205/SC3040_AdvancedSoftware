import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getSession: mockGetSession,
    },
  }),
}));

import { GET, PUT } from "@/app/api/user/route";

describe("User API Route (GET and PUT /api/user)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ===================== GET =====================
  it("GET: returns 401 if user session is missing", async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });

    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("GET: forwards backend error response when fetch fails", async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: { access_token: "valid-token" } },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "User profile not found",
    } as Response);

    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("User profile not found");
  });

  it("GET: returns 200 with profile data on success", async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: { access_token: "valid-token" } },
    });

    const mockProfile = { email: "runner@test.com", weight: 70 };
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockProfile,
    } as Response);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(mockProfile);
  });

  it("GET: catches unexpected exceptions and returns 500", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("Supabase internal error"));

    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("An internal error occurred");
  });

  // ===================== PUT =====================
  it("PUT: returns 401 if user session is missing", async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });

    const req = new Request("http://localhost:3000/api/user", {
      method: "PUT",
      body: JSON.stringify({ weight: 72 }),
    });

    const response = await PUT(req);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("PUT: forwards backend error when update is rejected", async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: { access_token: "valid-token" } },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "No valid fields provided for update",
    } as Response);

    const req = new Request("http://localhost:3000/api/user", {
      method: "PUT",
      body: JSON.stringify({}),
    });

    const response = await PUT(req);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No valid fields provided for update");
  });

  it("PUT: returns 200 with updated payload on success", async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { session: { access_token: "valid-token" } },
    });

    const updatedProfile = { email: "runner@test.com", weight: 72 };
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => updatedProfile,
    } as Response);

    const req = new Request("http://localhost:3000/api/user", {
      method: "PUT",
      body: JSON.stringify({ weight: 72 }),
    });

    const response = await PUT(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updatedProfile);
  });

  it("PUT: catches unexpected exceptions and returns 500", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("Network crashed"));

    const req = new Request("http://localhost:3000/api/user", {
      method: "PUT",
      body: JSON.stringify({ weight: 72 }),
    });

    const response = await PUT(req);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("An internal error occurred");
  });
});
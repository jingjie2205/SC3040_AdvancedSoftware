// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
 * TS-5: where Strava sends the athlete back (frontend/app/api/auth/callback/route.ts). It trades the one-time code for
 * tokens through the backend, then returns the athlete to the Training page's Strava tab (when the link carried
 * state=training) or to Settings (any other state, or none). The session and the backend are replaced, so no server or
 * Strava account is needed.
 */

const auth = vi.hoisted(() => ({ session: { access_token: "token-abc" } as { access_token: string } | null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: async () => ({ data: { session: auth.session } }) } }),
}));

const fetchMock = vi.fn();

async function callback(query: string) {
  const { GET } = await import("@/app/api/auth/callback/route");
  const response = await GET(new NextRequest(`http://localhost:3000/api/auth/callback${query}`));
  return new URL(response.headers.get("location") ?? "", "http://localhost:3000");
}

/** Where the athlete ended up, as path + query. */
const landed = (url: URL) => `${url.pathname}${url.search}`;

beforeEach(() => {
  auth.session = { access_token: "token-abc" };
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://api.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TS-5 returning from Strava", () => {
  it("TS-5.01: a successful connection from the Training tab goes back to the Training page", async () => {
    expect(landed(await callback("?code=abc&state=training"))).toBe("/dashboard/training?strava=connected");
  });

  it.each([
    ["no state", "?code=abc"],
    ["state 'settings'", "?code=abc&state=settings"],
    ["state 'Training' in capitals", "?code=abc&state=Training"],
    ["an empty state", "?code=abc&state="],
  ])("TS-5.02: a successful connection with %s goes back to Settings", async (_label, query) => {
    expect(landed(await callback(query))).toBe("/dashboard/settings?tab=integrations&connected=true");
  });

  it("TS-5.03: the one-time code is traded through the backend, signed in as the athlete", async () => {
    await callback("?code=the-code&state=training");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/strava/exchange");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer token-abc" });
    expect(JSON.parse(String(init.body))).toEqual({ code: "the-code" });
  });

  it("TS-5.04: with no backend address set, the local backend is used", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
    await callback("?code=abc");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8000/strava/exchange");
  });

  it.each([
    ["the athlete refused (error=access_denied)", "?error=access_denied&state=training"],
    ["there is no code", "?state=training"],
    ["there is an error and a code", "?code=abc&error=access_denied&state=training"],
  ])("TS-5.05: when %s the athlete goes back to the Training page with a reason and nothing is traded", async (_label, query) => {
    expect(landed(await callback(query))).toBe("/dashboard/training?strava=error&reason=access_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TS-5.06: a refusal from the Settings page goes back to Settings", async () => {
    expect(landed(await callback("?error=access_denied"))).toBe("/dashboard/settings?tab=integrations&error=access_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TS-5.07: an athlete who is not signed in is sent to the login page and nothing is traded", async () => {
    auth.session = null;
    expect(landed(await callback("?code=abc&state=training"))).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["400", 400],
    ["401", 401],
    ["500", 500],
  ])("TS-5.08: when the backend refuses the code (%s) the athlete is told, on the page they came from", async (_label, status) => {
    fetchMock.mockImplementation(async () => new Response("nope", { status }));
    expect(landed(await callback("?code=abc&state=training"))).toBe("/dashboard/training?strava=error&reason=exchange_failed");
    expect(landed(await callback("?code=abc"))).toBe("/dashboard/settings?tab=integrations&error=exchange_failed");
  });

  it("TS-5.09: when the backend cannot be reached the athlete is told, on the page they came from", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    expect(landed(await callback("?code=abc&state=training"))).toBe("/dashboard/training?strava=error&reason=server_error");
    expect(landed(await callback("?code=abc"))).toBe("/dashboard/settings?tab=integrations&error=server_error");
  });
});

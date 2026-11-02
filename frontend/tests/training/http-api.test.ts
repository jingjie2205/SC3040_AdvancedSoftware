import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreClock, useFixedClock } from "./helpers";

/*
 * Black-box tests of the client the Training page uses to talk to the backend: what it sends for each action and how it
 * turns each kind of reply into something the page can show. `fetch` and the Supabase session are replaced, so no
 * server is needed. "Today" is pinned to Wednesday 4 November 2026 (it is sent as X-Client-Date).
 */

const auth = vi.hoisted(() => ({
  session: { access_token: "token-abc" } as { access_token: string } | null,
  unreadable: false,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => {
        if (auth.unreadable) throw new Error("storage is blocked");
        return { data: { session: auth.session } };
      },
    },
  }),
}));

const fetchMock = vi.fn();
const assign = vi.fn();

async function loadClient() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://api.test");
  return import("@/lib/training/http-api");
}

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status });

beforeEach(() => {
  useFixedClock();
  auth.session = { access_token: "token-abc" };
  auth.unreadable = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, {}));
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { pathname: "/dashboard/training", assign });
});

afterEach(() => {
  restoreClock();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe("API-1 what is sent", () => {
  it("API-1.01: every request carries a JSON content type, the user's local date and their access token", async () => {
    const { httpTrainingApi } = await loadClient();
    await httpTrainingApi.getToday();
    expect(lastCall().headers).toEqual({
      "Content-Type": "application/json",
      "X-Client-Date": "2026-11-04",
      Authorization: "Bearer token-abc",
    });
  });

  it("API-1.02: with nobody signed in the request goes out without an Authorization header", async () => {
    auth.session = null;
    const { httpTrainingApi } = await loadClient();
    await httpTrainingApi.getToday();
    expect(lastCall().headers).not.toHaveProperty("Authorization");
    expect(lastCall().headers["X-Client-Date"]).toBe("2026-11-04");
  });

  it("API-1.03: when the session can't be read the request still goes out, unauthenticated", async () => {
    auth.unreadable = true;
    const { httpTrainingApi } = await loadClient();
    await expect(httpTrainingApi.getToday()).resolves.toBeDefined();
    expect(lastCall().headers).not.toHaveProperty("Authorization");
  });

  it.each(sends([
    ["getPreferences", (api: Api) => api.getPreferences(), "GET", "/api/v1/training/preferences", undefined],
    [
      "savePreferences",
      (api: Api) =>
        api.savePreferences({
          daysPerWeek: 3,
          sessionDurationMin: 45,
          activityTypes: ["run"],
          restDays: [],
          examDates: [],
        }),
      "PUT",
      "/api/v1/training/preferences",
      { daysPerWeek: 3, sessionDurationMin: 45, activityTypes: ["run"], restDays: [], examDates: [] },
    ],
    ["getPlan", (api: Api) => api.getPlan(), "GET", "/api/v1/training/plan", undefined],
    [
      "generatePlan",
      (api: Api) => api.generatePlan({ weeks: 8, confirmReplace: false }),
      "POST",
      "/api/v1/training/plan",
      { weeks: 8, confirmReplace: false },
    ],
    ["recalculatePlan", (api: Api) => api.recalculatePlan(), "POST", "/api/v1/training/plan/recalculate", undefined],
    [
      "acknowledgeAdaptation",
      (api: Api) => api.acknowledgeAdaptation(),
      "POST",
      "/api/v1/training/plan/adaptation/acknowledge",
      undefined,
    ],
    [
      "getSchedule",
      (api: Api) => api.getSchedule("2026-11-02", "2026-11-29"),
      "GET",
      "/api/v1/training/schedule?from=2026-11-02&to=2026-11-29",
      undefined,
    ],
    ["getForecast", (api: Api) => api.getForecast(), "GET", "/api/v1/training/plan/forecast", undefined],
    [
      "rescheduleSession",
      (api: Api) => api.rescheduleSession("s-1", "2026-11-10"),
      "PATCH",
      "/api/v1/training/sessions/s-1",
      { date: "2026-11-10" },
    ],
    ["removeSession", (api: Api) => api.removeSession("s-1"), "DELETE", "/api/v1/training/sessions/s-1", undefined],
    [
      "addSession",
      (api: Api) =>
        api.addSession({ date: "2026-11-10", activityType: "run", intensityBand: "light", targetDurationMin: null }),
      "POST",
      "/api/v1/training/plan/sessions",
      { date: "2026-11-10", activityType: "run", intensityBand: "light", targetDurationMin: null },
    ],
    [
      "updateSession",
      (api: Api) => api.updateSession("s-1", { intensityBand: "push" }),
      "PATCH",
      "/api/v1/training/sessions/s-1",
      { intensityBand: "push" },
    ],
    ["getToday", (api: Api) => api.getToday(), "GET", "/api/v1/training/today", undefined],
    ["getSummary", (api: Api) => api.getSummary(), "GET", "/api/v1/training/summary", undefined],
    ["getCoachMessage", (api: Api) => api.getCoachMessage(), "POST", "/api/v1/training/coach", undefined],
    ["getReadinessModel", (api: Api) => api.getReadinessModel(), "GET", "/api/v1/readiness/model", undefined],
    ["logSleep", (api: Api) => api.logSleep(7.5), "PUT", "/api/v1/training/sleep", { hours: 7.5 }],
    ["clearSleep", (api: Api) => api.clearSleep(), "DELETE", "/api/v1/training/sleep", undefined],
    [
      "respondToSession",
      (api: Api) => api.respondToSession("s-1", { action: "skip" }),
      "POST",
      "/api/v1/training/sessions/s-1/respond",
      { action: "skip" },
    ],
    [
      "logSession",
      (api: Api) =>
        api.logSession("s-1", {
          date: "2026-11-04",
          activityType: "run",
          actualDurationMin: 40,
          actualVolume: 35,
          rpe: null,
          avgHr: null,
          calories: null,
          distanceKm: null,
        }),
      "POST",
      "/api/v1/training/sessions/s-1/log",
      {
        date: "2026-11-04",
        activityType: "run",
        actualDurationMin: 40,
        actualVolume: 35,
        rpe: null,
        avgHr: null,
        calories: null,
        distanceKm: null,
      },
    ],
    [
      "logAdHocSession",
      (api: Api) =>
        api.logAdHocSession({
          date: "2026-11-04",
          activityType: "gym",
          actualDurationMin: 30,
          actualVolume: 24,
          rpe: 7,
          avgHr: null,
          calories: null,
          distanceKm: null,
        }),
      "POST",
      "/api/v1/training/sessions",
      {
        date: "2026-11-04",
        activityType: "gym",
        actualDurationMin: 30,
        actualVolume: 24,
        rpe: 7,
        avgHr: null,
        calories: null,
        distanceKm: null,
      },
    ],
  ]))("API-1.04: %s sends %s %s", async (_name, method, path, call, body) => {
    const { httpTrainingApi } = await loadClient();
    await call(httpTrainingApi);
    const sent = lastCall();
    expect(sent.init.method).toBe(method);
    expect(sent.url).toBe(`http://api.test${path}`);
    expect(sent.init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    expect(sent.init.cache).toBe("no-store");
  });

  it("API-1.05: a session id is encoded so it can't change the path", async () => {
    const { httpTrainingApi } = await loadClient();
    await httpTrainingApi.removeSession("a/b c?d");
    expect(lastCall().url).toBe("http://api.test/api/v1/training/sessions/a%2Fb%20c%3Fd");
  });
});

type Api = Awaited<ReturnType<typeof loadClient>>["httpTrainingApi"];

/** Puts the method and path ahead of the call, so a test is titled "getPlan sends GET /api/v1/training/plan". */
function sends<Row extends [string, (api: Api) => unknown, string, string, unknown]>(rows: Row[]) {
  return rows.map(([name, call, method, path, body]) => [name, method, path, call, body] as const);
}

describe("API-2 what comes back", () => {
  it("API-2.01: a successful reply gives its data", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "plan-1", weeks: 8 }));
    const { httpTrainingApi } = await loadClient();
    await expect(httpTrainingApi.recalculatePlan()).resolves.toEqual({ ok: true, data: { id: "plan-1", weeks: 8 } });
  });

  it("API-2.02: a reply with no content (204) is a success with no data", async () => {
    fetchMock.mockResolvedValue(reply(204));
    const { httpTrainingApi } = await loadClient();
    await expect(httpTrainingApi.clearSleep()).resolves.toEqual({ ok: true, data: undefined });
  });

  it("API-2.03: a refusal keeps the server's code, message, field errors and suggested day", async () => {
    fetchMock.mockResolvedValue(
      reply(409, {
        detail: {
          code: "CONSECUTIVE_HIGH_INTENSITY",
          message: "Two high-intensity (push) sessions can't be on the same day or on consecutive days.",
          suggestedDate: "2026-11-14",
        },
      }),
    );
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.rescheduleSession("s-1", "2026-11-13")).toEqual({
      ok: false,
      error: {
        code: "CONSECUTIVE_HIGH_INTENSITY",
        message: "Two high-intensity (push) sessions can't be on the same day or on consecutive days.",
        fieldErrors: undefined,
        suggestedDate: "2026-11-14",
      },
    });
  });

  it("API-2.03: field errors are kept per field, and anything that is not text is dropped", async () => {
    fetchMock.mockResolvedValue(
      reply(422, {
        detail: {
          code: "VALIDATION",
          message: "Some fields need fixing.",
          fieldErrors: { daysPerWeek: "Training days must be at most 7", extra: 5 },
        },
      }),
    );
    const { httpTrainingApi } = await loadClient();
    const result = await httpTrainingApi.generatePlan({ weeks: 99, confirmReplace: false });
    expect(!result.ok && result.error.fieldErrors).toEqual({ daysPerWeek: "Training days must be at most 7" });
  });

  it("API-2.04: a request that couldn't reach the server says so, in words the user can act on", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({
      ok: false,
      error: { code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." },
    });
  });

  it("API-2.05: an unexpected error with no usable body gives a generic message with the status", async () => {
    fetchMock.mockResolvedValue(reply(500, "<html>Internal Server Error</html>"));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({
      ok: false,
      error: { code: "SERVER_ERROR", message: "The server returned an error (500)." },
    });
  });

  it("API-2.05: a plain-text reason from the server is passed on", async () => {
    fetchMock.mockResolvedValue(reply(500, { detail: "The database is restarting" }));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({
      ok: false,
      error: { code: "SERVER_ERROR", message: "The database is restarting" },
    });
  });

  it("API-2.06: a read that fails throws with the server's message", async () => {
    fetchMock.mockResolvedValue(
      reply(503, { detail: { code: "UNAVAILABLE", message: "Training data is unavailable right now." } }),
    );
    const { httpTrainingApi } = await loadClient();
    await expect(httpTrainingApi.getToday()).rejects.toThrow("Training data is unavailable right now.");
  });

  it("API-2.06: dismissing the adaptation notice throws when the server refuses", async () => {
    fetchMock.mockResolvedValue(reply(404, { detail: { code: "NO_PLAN", message: "You have no plan yet." } }));
    const { httpTrainingApi } = await loadClient();
    await expect(httpTrainingApi.acknowledgeAdaptation()).rejects.toThrow("You have no plan yet.");
  });
});

describe("API-3 being signed out", () => {
  const signedOut = { code: "UNAUTHORIZED", message: "Your session has expired. Sign in again." };

  it("API-3.01: a 401 sends the user back to sign in", async () => {
    fetchMock.mockResolvedValue(reply(401, { detail: "Not authenticated" }));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({ ok: false, error: signedOut });
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login");
  });

  it("API-3.01: so does the older 403 'Not authenticated' reply", async () => {
    fetchMock.mockResolvedValue(reply(403, { detail: "Not authenticated" }));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({ ok: false, error: signedOut });
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login");
  });

  it("API-3.02: any other 403 is an ordinary error and does not sign the user out", async () => {
    fetchMock.mockResolvedValue(reply(403, { detail: "Not allowed" }));
    const { httpTrainingApi } = await loadClient();
    expect(await httpTrainingApi.recalculatePlan()).toEqual({
      ok: false,
      error: { code: "SERVER_ERROR", message: "Not allowed" },
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("API-3.03: already on the sign-in page, there is nowhere further to send them", async () => {
    vi.stubGlobal("location", { pathname: "/login", assign });
    fetchMock.mockResolvedValue(reply(401, { detail: "Not authenticated" }));
    const { httpTrainingApi } = await loadClient();
    await httpTrainingApi.recalculatePlan();
    expect(assign).not.toHaveBeenCalled();
  });
});

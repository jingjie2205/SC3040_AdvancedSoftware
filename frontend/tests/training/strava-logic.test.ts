import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityUrl,
  canSave,
  describeSave,
  formatDistance,
  formatDuration,
  formatPace,
  iconKind,
  parseDeleted,
  parsePull,
  parseSaveResult,
  parseStatus,
  plural,
  saveTone,
  summarisePull,
  typeLabel,
  type StravaCard,
} from "@/lib/training/strava-format";

/*
 * The Strava tab's logic, without the screen: how the server's replies are read and worded (strava-format.ts), what
 * the client sends and how it turns each reply into something the tab can show (strava.ts), and Hard Rule 1 pinned
 * by looking at what the tab's files import. "S-" tests belong to the Strava tab, "API-4" to its client and "HR-1" to
 * the rule that Strava data never reaches an AI feature.
 */

/* ------------------------------------------------------------------ what the server sends */

/** One activity as POST /strava/pull sends it. */
const raw = (over: Record<string, unknown> = {}) => ({
  stravaId: 1001,
  name: "Morning run",
  sportType: "Run",
  startedLocal: "2026-11-03T07:15:00",
  distanceM: 8000,
  movingTimeS: 2400,
  elevationGainM: 42.4,
  averageHeartrate: 151.2,
  activityType: "run",
  durationMin: 40,
  volume: 40,
  saved: false,
  ...over,
});

const pulled = (...items: unknown[]) => parsePull({ activities: items });

/** A card as the tab holds it. */
const card = (over: Partial<StravaCard> = {}): StravaCard => ({
  stravaId: 1001,
  name: "Morning run",
  type: "Run",
  day: "2026-11-03",
  time: "07:15",
  distanceM: 8000,
  movingTimeS: 2400,
  elevationGainM: 42,
  averageHeartrate: 151,
  savedAs: "run",
  durationMin: 40,
  points: 40,
  saved: false,
  ...over,
});

describe("S-1 reading the activities the server sends", () => {
  it.each([
    ["nothing", null],
    ["no body", undefined],
    ["a string", "activities"],
    ["a number", 42],
    ["a list", []],
    ["an object without activities", {}],
    ["activities that is not a list", { activities: "none" }],
    ["activities that is an object", { activities: {} }],
  ])("S-1.01: %s is not the expected shape, so there is no list to show", (_label, body) => {
    expect(parsePull(body)).toBeNull();
  });

  it("S-1.02: an empty list is a list with no cards", () => {
    expect(parsePull({ activities: [] })).toEqual([]);
  });

  it("S-1.03: a well-formed activity becomes a card carrying every field", () => {
    expect(pulled(raw())).toEqual([
      {
        stravaId: 1001,
        name: "Morning run",
        type: "Run",
        day: "2026-11-03",
        time: "07:15",
        distanceM: 8000,
        movingTimeS: 2400,
        elevationGainM: 42.4,
        averageHeartrate: 151.2,
        savedAs: "run",
        durationMin: 40,
        points: 40,
        saved: false,
      },
    ]);
  });

  it.each([
    ["2026-11-03T07:15:00", "2026-11-03", "07:15"],
    ["2026-11-03T07:15:00Z", "2026-11-03", "07:15"],
    ["2026-11-03 07:15", "2026-11-03", "07:15"],
    ["2026-11-03", "2026-11-03", null],
    ["2026-11-03T7:5", "2026-11-03", null],
  ])("S-1.04: a start of '%s' is the day %s and the time %j", (startedLocal, day, time) => {
    expect(pulled(raw({ startedLocal }))?.[0]).toMatchObject({ day, time });
  });

  it.each([["03/11/2026"], ["November 3"], [""], [20261103], [null], [undefined]])(
    "S-1.04: an activity whose start is %j has no day, so it is left out",
    (startedLocal) => {
      expect(pulled(raw({ startedLocal }))).toEqual([]);
    },
  );

  it("S-1.05: an activity missing something it needs is left out and the rest are kept", () => {
    const cards = pulled(
      raw({ stravaId: 1 }),
      "junk",
      null,
      raw({ stravaId: undefined }),
      raw({ stravaId: 1.5 }),
      raw({ stravaId: "7" }),
      raw({ stravaId: Number.NaN }),
      raw({ stravaId: Number.POSITIVE_INFINITY }),
      raw({ stravaId: 3, name: undefined }),
      raw({ stravaId: 4, name: 12 }),
      raw({ stravaId: 5, sportType: undefined }),
      raw({ stravaId: 2 }),
    );
    expect(cards?.map((c) => c.stravaId).sort()).toEqual([1, 2]);
  });

  it.each([
    ["  Evening ride  ", "Evening ride"],
    ["Evening ride", "Evening ride"],
    ["", "Untitled activity"],
    ["   ", "Untitled activity"],
  ])("S-1.06: the name %j is shown as %j", (name, shown) => {
    expect(pulled(raw({ name }))?.[0].name).toBe(shown);
  });

  it.each([
    ["distanceM", "distanceM"],
    ["movingTimeS", "movingTimeS"],
    ["elevationGainM", "elevationGainM"],
  ] as const)("S-1.07: %s is never negative, and is 0 when it is missing or not a number", (key, field) => {
    for (const [given, kept] of [
      [-5, 0],
      [0, 0],
      [12.5, 12.5],
      ["5000", 0],
      [null, 0],
      [undefined, 0],
      [Number.NaN, 0],
    ] as const) {
      expect(pulled(raw({ [key]: given }))?.[0][field]).toBe(kept);
    }
  });

  it.each([
    [151.2, 151.2],
    [null, null],
    [undefined, null],
    ["150", null],
    [Number.NaN, null],
  ])("S-1.07: an average heart rate of %j is kept as %j", (given, kept) => {
    expect(pulled(raw({ averageHeartrate: given }))?.[0].averageHeartrate).toBe(kept);
  });

  it.each([
    [true, true],
    [false, false],
    ["true", false],
    [1, false],
    [null, false],
    [undefined, false],
  ])("S-2.01: saved = %j means %j (only an actual true counts as on the schedule)", (given, kept) => {
    expect(pulled(raw({ saved: given }))?.[0].saved).toBe(kept);
  });

  it.each(["run", "cycling", "gym", "bodyweight"])(
    "S-2.02: an activity the schedule has a place for (%s) says what it would be saved as",
    (activityType) => {
      expect(pulled(raw({ activityType, durationMin: 33, volume: 29 }))?.[0]).toMatchObject({
        savedAs: activityType,
        durationMin: 33,
        points: 29,
      });
    },
  );

  it.each([["swim"], ["walk"], ["Run"], [""], [null], [undefined], [5]])(
    "S-2.02: an activity type of %j has no place on the schedule, so no minutes or points either",
    (activityType) => {
      expect(pulled(raw({ activityType, durationMin: 33, volume: 29 }))?.[0]).toMatchObject({
        savedAs: null,
        durationMin: null,
        points: null,
      });
    },
  );

  it.each([
    ["no minutes", { durationMin: undefined }],
    ["minutes that are not a number", { durationMin: "40" }],
    ["no points", { volume: undefined }],
    ["points that are not finite", { volume: Number.NaN }],
  ])("S-2.02: a saveable kind with %s cannot be placed, so none of the three are given", (_label, over) => {
    expect(pulled(raw(over))?.[0]).toMatchObject({ savedAs: null, durationMin: null, points: null });
  });

  it("S-1.08: cards come newest first by day and then by start time, and a missing time counts as midnight", () => {
    const cards = pulled(
      raw({ stravaId: 1, startedLocal: "2026-11-01T09:00:00" }),
      raw({ stravaId: 2, startedLocal: "2026-11-03T07:15:00" }),
      raw({ stravaId: 3, startedLocal: "2026-11-03T18:30:00" }),
      raw({ stravaId: 4, startedLocal: "2026-11-03" }),
      raw({ stravaId: 5, startedLocal: "2025-12-31T23:59:00" }),
    );
    expect(cards?.map((c) => c.stravaId)).toEqual([3, 2, 4, 1, 5]);
  });

  it("S-1.08: two activities starting at the same moment keep the order the server gave", () => {
    const cards = pulled(
      raw({ stravaId: 10, startedLocal: "2026-11-03T07:15:00" }),
      raw({ stravaId: 11, startedLocal: "2026-11-03T07:15:00" }),
      raw({ stravaId: 12, startedLocal: "2026-11-03T07:15:00" }),
    );
    expect(cards?.map((c) => c.stravaId)).toEqual([10, 11, 12]);
  });
});

describe("S-4 reading the connection status", () => {
  it.each([
    [true, 0],
    [true, 1],
    [false, 0],
    [false, 97],
  ])("S-4.01: connected = %j with %i saved is understood", (connected, savedCount) => {
    expect(parseStatus({ connected, savedCount })).toEqual({ connected, savedCount });
  });

  it.each([
    ["connected is a word", { connected: "yes", savedCount: 0 }],
    ["connected is a number", { connected: 1, savedCount: 0 }],
    ["connected is missing", { savedCount: 0 }],
    ["the count is negative", { connected: true, savedCount: -1 }],
    ["the count is fractional", { connected: true, savedCount: 1.5 }],
    ["the count is text", { connected: true, savedCount: "3" }],
    ["the count is not a number", { connected: true, savedCount: Number.NaN }],
    ["the count is missing", { connected: true }],
    ["there is no body", null],
    ["it is not an object", "connected"],
  ])("S-4.01: a status where %s is refused", (_label, body) => {
    expect(parseStatus(body)).toBeNull();
  });
});

describe("S-2 reading what a save returns", () => {
  it.each([
    [{ savedIds: [1001, 1002], alreadySaved: 0, skipped: 0 }],
    [{ savedIds: [], alreadySaved: 2, skipped: 1 }],
  ])("S-2.03: %j is understood", (body) => {
    expect(parseSaveResult(body)).toEqual(body);
  });

  it.each([
    ["the saved ids are not a list", { savedIds: "1", alreadySaved: 0, skipped: 0 }],
    ["one saved id is text", { savedIds: [1, "2"], alreadySaved: 0, skipped: 0 }],
    ["one saved id is not a number", { savedIds: [1, Number.NaN], alreadySaved: 0, skipped: 0 }],
    ["already-saved is negative", { savedIds: [], alreadySaved: -1, skipped: 0 }],
    ["already-saved is fractional", { savedIds: [], alreadySaved: 1.5, skipped: 0 }],
    ["already-saved is missing", { savedIds: [], skipped: 0 }],
    ["skipped is negative", { savedIds: [], alreadySaved: 0, skipped: -1 }],
    ["skipped is missing", { savedIds: [], alreadySaved: 0 }],
    ["there is no body", undefined],
  ])("S-2.03: a result where %s is refused", (_label, body) => {
    expect(parseSaveResult(body)).toBeNull();
  });
});

describe("S-3 reading what a removal returns", () => {
  it.each([
    [0, 0],
    [1, 1],
    [97, 97],
  ])("S-3.01: {deleted: %i} means %i were taken off", (deleted, expected) => {
    expect(parseDeleted({ deleted })).toBe(expected);
  });

  it.each([[{ deleted: -1 }], [{ deleted: 1.5 }], [{ deleted: "3" }], [{}], [[]], [null], ["3"]])(
    "S-3.01: %j is refused",
    (body) => {
      expect(parseDeleted(body)).toBeNull();
    },
  );
});

/* ------------------------------------------------------------------ wording and numbers */

describe("S-2 what can be saved and what the user is told", () => {
  it.each([
    ["has a place and is not on the schedule", { savedAs: "run" as const, saved: false }, true],
    ["has a place and is on the schedule already", { savedAs: "run" as const, saved: true }, false],
    ["has no place and is not on the schedule", { savedAs: null, saved: false }, false],
    ["has no place and is marked saved", { savedAs: null, saved: true }, false],
  ])("S-2.04: an activity that %s: can be saved = %j", (_label, over, expected) => {
    expect(canSave(card(over))).toBe(expected);
  });

  it("S-2.05: the summary counts what can be saved, what is on the schedule and what cannot be saved", () => {
    const cards = [
      card({ stravaId: 1 }),
      card({ stravaId: 2, savedAs: "cycling" }),
      card({ stravaId: 3, savedAs: "gym", saved: true }),
      card({ stravaId: 4, savedAs: null, durationMin: null, points: null }),
      card({ stravaId: 5, savedAs: null, durationMin: null, points: null }),
      card({ stravaId: 6, savedAs: null, durationMin: null, points: null, saved: true }),
    ];
    expect(summarisePull(cards)).toEqual({ total: 6, toSave: 2, onSchedule: 2, unsupported: 2 });
  });

  it("S-2.05: with no cards every count is zero", () => {
    expect(summarisePull([])).toEqual({ total: 0, toSave: 0, onSchedule: 0, unsupported: 0 });
  });

  it.each([
    [{ savedIds: [1], alreadySaved: 0, skipped: 0 }, "Saved 1 activity to your schedule."],
    [{ savedIds: [1, 2, 3], alreadySaved: 0, skipped: 0 }, "Saved 3 activities to your schedule."],
    [{ savedIds: [], alreadySaved: 1, skipped: 0 }, "1 activity was already on your schedule."],
    [{ savedIds: [], alreadySaved: 2, skipped: 0 }, "2 activities were already on your schedule."],
    [
      { savedIds: [], alreadySaved: 0, skipped: 1 },
      "1 activity couldn't be saved because it is no longer among your latest on Strava. Upload again to refresh the list.",
    ],
    [
      { savedIds: [], alreadySaved: 0, skipped: 2 },
      "2 activities couldn't be saved because they are no longer among your latest on Strava. Upload again to refresh the list.",
    ],
    [{ savedIds: [], alreadySaved: 0, skipped: 0 }, "Nothing was saved."],
    [
      { savedIds: [1, 2], alreadySaved: 1, skipped: 1 },
      "Saved 2 activities to your schedule. 1 activity was already on your schedule. 1 activity couldn't be saved because it is no longer among your latest on Strava. Upload again to refresh the list.",
    ],
  ])("S-2.06: the result %j is worded as '%s'", (result, text) => {
    expect(describeSave(result)).toBe(text);
  });

  it.each([
    ["something was saved and something refused", "ok", { savedIds: [1], alreadySaved: 0, skipped: 2 }],
    ["everything saved", "ok", { savedIds: [1, 2], alreadySaved: 0, skipped: 0 }],
    ["everything was on the schedule already", "ok", { savedIds: [], alreadySaved: 2, skipped: 0 }],
    ["nothing saved and something refused", "error", { savedIds: [], alreadySaved: 0, skipped: 1 }],
    ["nothing saved, one already there and one refused", "error", { savedIds: [], alreadySaved: 1, skipped: 1 }],
  ])("S-2.07: when %s the message is an %s", (_label, tone, result) => {
    expect(saveTone(result)).toBe(tone);
  });
});

describe("S-1 how an activity is shown", () => {
  it("S-1.09: the link goes to the activity on Strava", () => {
    expect(activityUrl(1001)).toBe("https://www.strava.com/activities/1001");
  });

  it.each([
    [0, "0 m"],
    [999, "999 m"],
    [999.4, "999 m"],
    [1000, "1.0 km"],
    [5234, "5.2 km"],
    [42195, "42.2 km"],
    [99940, "99.9 km"],
    [100000, "100 km"],
    [150400, "150 km"],
    [150600, "151 km"],
  ])("S-1.10: %d m is shown as %s", (meters, shown) => {
    expect(formatDistance(meters)).toBe(shown);
  });

  it.each([
    [0, "0 min"],
    [29, "0 min"],
    [30, "1 min"],
    [2400, "40 min"],
    [3540, "59 min"],
    [3570, "1 h 00 min"],
    [3600, "1 h 00 min"],
    [3900, "1 h 05 min"],
    [4500, "1 h 15 min"],
    [7200, "2 h 00 min"],
    [37230, "10 h 21 min"],
  ])("S-1.11: %d s is shown as %s", (seconds, shown) => {
    expect(formatDuration(seconds)).toBe(shown);
  });

  it.each([
    ["Run", 5000, 1500, "5:00 /km"],
    ["Run", 5000, 1530, "5:06 /km"],
    ["TrailRun", 10000, 4200, "7:00 /km"],
    ["VirtualRun", 10000, 3000, "5:00 /km"],
    ["Walk", 3000, 2100, "11:40 /km"],
    ["Hike", 12000, 9000, "12:30 /km"],
    ["Run", 1000, 299.6, "5:00 /km"], // 4 min 59.6 s rounds to 5:00, not 4:60
    ["Run", 500, 150, "5:00 /km"], // the shortest distance a pace is given for
    ["Run", 499, 150, null],
    ["Run", 5000, 0, null],
    ["Run", 5000, -10, null],
    ["Run", 0, 0, null],
    ["Ride", 30000, 3600, null],
    ["Swim", 1500, 1800, null],
    ["WeightTraining", 0, 3000, null],
  ])("S-1.12: %s over %d m in %d s has the pace %j", (type, distanceM, movingTimeS, pace) => {
    expect(formatPace(type, distanceM, movingTimeS)).toBe(pace);
  });

  it.each([
    ["Run", "Run"],
    ["TrailRun", "Trail run"],
    ["VirtualRide", "Virtual ride"],
    ["WeightTraining", "Weight training"],
    ["MountainBikeRide", "Mountain bike ride"],
    ["EBikeRide", "E-bike ride"],
    ["EMountainBikeRide", "E-mountain bike ride"],
    ["Crossfit", "CrossFit"],
    ["HighIntensityIntervalTraining", "HIIT"],
    ["Yoga", "Yoga"],
    ["", ""],
  ])("S-1.13: the Strava type %j is shown as %j", (type, shown) => {
    expect(typeLabel(type)).toBe(shown);
  });

  it.each([
    ["Run", "foot"],
    ["TrailRun", "foot"],
    ["VirtualRun", "foot"],
    ["Walk", "foot"],
    ["Hike", "foot"],
    ["Ride", "bike"],
    ["VirtualRide", "bike"],
    ["GravelRide", "bike"],
    ["MountainBikeRide", "bike"],
    ["EBikeRide", "bike"],
    ["Swim", "swim"],
    ["WeightTraining", "gym"],
    ["Workout", "gym"],
    ["Crossfit", "gym"],
    ["Yoga", "gym"],
    ["Pilates", "gym"],
    ["HighIntensityIntervalTraining", "gym"],
    ["Kayaking", "other"],
    ["Golf", "other"],
    ["", "other"],
  ])("S-1.14: the Strava type %j gets the %s icon", (type, kind) => {
    expect(iconKind(type)).toBe(kind);
  });

  it.each([
    [0, "run", undefined, "0 runs"],
    [1, "run", undefined, "1 run"],
    [2, "run", undefined, "2 runs"],
    [1, "activity", "activities", "1 activity"],
    [2, "activity", "activities", "2 activities"],
    [0, "activity", "activities", "0 activities"],
  ])("S-1.15: plural(%d, %j, %j) is %j", (n, noun, pluralNoun, text) => {
    expect(plural(n, noun, pluralNoun)).toBe(text);
  });
});

/* ------------------------------------------------------------------ the client */

const auth = vi.hoisted(() => ({ session: { access_token: "token-abc" } as { access_token: string } | null }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: auth.session } }) } }),
}));

const fetchMock = vi.fn();

async function loadStrava(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://api.test");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("@/lib/training/strava");
}

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => {
  auth.session = { access_token: "token-abc" };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, {}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Strava = Awaited<ReturnType<typeof loadStrava>>;

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, method: init.method, body: init.body, headers: init.headers as Record<string, string> };
};

describe("API-4 the Strava client", () => {
  it.each([
    ["http", true],
    ["mock", false],
    ["HTTP", false],
    ["", false],
  ])("API-4.01: with NEXT_PUBLIC_TRAINING_API=%j the Strava tab is available = %j", async (value, available) => {
    const { stravaAvailable } = await loadStrava({ NEXT_PUBLIC_TRAINING_API: value });
    expect(stravaAvailable).toBe(available);
  });

  it.each([
    [
      "loadStatus",
      "GET",
      "/api/v1/training/strava/status",
      (s: Strava) => s.loadStatus(),
      undefined,
      { connected: true, savedCount: 2 },
      { connected: true, savedCount: 2 },
    ],
    [
      "pullActivities",
      "POST",
      "/api/v1/training/strava/pull",
      (s: Strava) => s.pullActivities(),
      undefined,
      { activities: [raw()] },
      [card({ elevationGainM: 42.4, averageHeartrate: 151.2 })],
    ],
    [
      "saveToSchedule",
      "POST",
      "/api/v1/training/strava/save",
      (s: Strava) => s.saveToSchedule([1001, 1002]),
      JSON.stringify({ stravaIds: [1001, 1002] }),
      { savedIds: [1001], alreadySaved: 1, skipped: 0 },
      { savedIds: [1001], alreadySaved: 1, skipped: 0 },
    ],
    [
      "removeFromSchedule",
      "DELETE",
      "/api/v1/training/strava/logs",
      (s: Strava) => s.removeFromSchedule(),
      undefined,
      { deleted: 5 },
      5,
    ],
  ])("API-4.02: %s sends %s %s and understands the reply", async (_name, method, path, call, body, serverReply, data) => {
    fetchMock.mockImplementation(async () => reply(200, serverReply));
    const result = await call(await loadStrava());
    expect(lastCall()).toMatchObject({ url: `http://api.test${path}`, method, body });
    expect(lastCall().headers).toMatchObject({ Authorization: "Bearer token-abc" });
    expect(result).toEqual({ ok: true, data });
  });

  it.each([
    ["loadStatus", (s: Strava) => s.loadStatus(), { connected: "yes", savedCount: 0 }],
    ["pullActivities", (s: Strava) => s.pullActivities(), { activities: "none" }],
    ["saveToSchedule", (s: Strava) => s.saveToSchedule([1]), { savedIds: [1] }],
    ["removeFromSchedule", (s: Strava) => s.removeFromSchedule(), { deleted: -1 }],
  ])("API-4.03: a reply %s can't make sense of is reported as unexpected", async (_name, call, serverReply) => {
    fetchMock.mockImplementation(async () => reply(200, serverReply));
    expect(await call(await loadStrava())).toEqual({
      ok: false,
      error: { code: "SERVER_ERROR", message: "The server sent something unexpected. Try again." },
    });
  });

  it("API-4.04: a refusal from the server keeps its code and its message", async () => {
    fetchMock.mockImplementation(async () =>
      reply(409, { detail: { code: "NOT_CONNECTED", message: "Connect Strava in Settings first." } }),
    );
    const result = await (await loadStrava()).pullActivities();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "Connect Strava in Settings first." },
    });
  });

  it("API-4.04: a rate limit from Strava is passed on in the server's words", async () => {
    fetchMock.mockImplementation(async () =>
      reply(429, { detail: { code: "RATE_LIMITED", message: "Strava is busy. Try again in a few minutes." } }),
    );
    expect(await (await loadStrava()).saveToSchedule([1])).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Strava is busy. Try again in a few minutes." },
    });
  });

  it("API-4.05: when the server can't be reached the user is told to check their connection", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await (await loadStrava()).loadStatus()).toEqual({
      ok: false,
      error: { code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." },
    });
  });

  it.each([
    ["both are set", { NEXT_PUBLIC_STRAVA_CLIENT_ID: "12345", NEXT_PUBLIC_STRAVA_REDIRECT_URI: "http://app.test/api/auth/callback" }, true],
    ["only the client id is set", { NEXT_PUBLIC_STRAVA_CLIENT_ID: "12345", NEXT_PUBLIC_STRAVA_REDIRECT_URI: "" }, false],
    ["only the redirect address is set", { NEXT_PUBLIC_STRAVA_CLIENT_ID: "", NEXT_PUBLIC_STRAVA_REDIRECT_URI: "http://app.test/api/auth/callback" }, false],
    ["neither is set", { NEXT_PUBLIC_STRAVA_CLIENT_ID: "", NEXT_PUBLIC_STRAVA_REDIRECT_URI: "" }, false],
  ])("S-4.02: when %s, there is a Connect link = %j", async (_label, env, hasLink) => {
    const { stravaConnectUrl } = await loadStrava(env);
    expect(stravaConnectUrl() !== null).toBe(hasLink);
  });

  it("S-4.03: the Connect link goes to Strava's consent page and brings the user back to the Training tab", async () => {
    const { stravaConnectUrl } = await loadStrava({
      NEXT_PUBLIC_STRAVA_CLIENT_ID: "12345",
      NEXT_PUBLIC_STRAVA_REDIRECT_URI: "http://app.test/api/auth/callback",
    });
    const url = new URL(stravaConnectUrl() as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.strava.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "12345",
      response_type: "code",
      redirect_uri: "http://app.test/api/auth/callback",
      approval_prompt: "force",
      scope: "activity:read_all,profile:read_all",
      state: "training",
    });
  });
});

/* ------------------------------------------------------------------ Hard Rule 1, by what the files import */

const FRONTEND = path.resolve(import.meta.dirname, "../..");
const LIB = path.join(FRONTEND, "lib/training");
const COMPONENTS = path.join(FRONTEND, "app/(app)/dashboard/training/_components");

/** The modules a file loads when it runs: its `import`s and `export ... from`s, but not `import type` (erased). */
function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(FRONTEND, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file of the app that `entry` loads, directly or through other files (packages are not followed). */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueImports(file)) {
      const next = resolveLocal(file, specifier);
      if (next) queue.push(next);
    }
  }
  return new Set([...seen].map((file) => path.relative(FRONTEND, file).split(path.sep).join("/")));
}

const STRAVA_FILES = [
  path.join(COMPONENTS, "strava-panel.tsx"),
  path.join(LIB, "strava.ts"),
  path.join(LIB, "strava-format.ts"),
];

describe("HR-1 Strava data never reaches an AI feature", () => {
  it("HR-1.40: the Strava tab never loads the training API, its fixtures, the plan rules or the forecast", () => {
    const loaded = reachableFrom(STRAVA_FILES);
    // The client only shares the request helper with the training API
    expect(loaded).toContain("lib/training/http-api.ts");
    for (const file of [
      "lib/training/api.ts",
      "lib/training/mock-api.ts",
      "lib/training/mock-plan.ts",
      "lib/training/forecast.ts",
      "lib/training/rules.ts",
      "lib/training/schemas.ts",
    ]) {
      expect(loaded, `${file} must not be loaded by the Strava tab`).not.toContain(file);
    }
  });

  it("HR-1.41: the training API (which feeds the plan, readiness, Home and the coach) never loads a Strava file", () => {
    const loaded = reachableFrom([path.join(LIB, "api.ts")]);
    expect(loaded).toContain("lib/training/mock-api.ts");
    expect([...loaded].filter((file) => /strava/i.test(file))).toEqual([]);
  });

  it("HR-1.42: the files that feed the page's other tabs never load a Strava file either", () => {
    const others = [
      "today-panel.tsx",
      "schedule-panel.tsx",
      "plan-panel.tsx",
      "preferences-form.tsx",
      "forecast-card.tsx",
      "log-workout-dialog.tsx",
      "reschedule-dialog.tsx",
      "session-dialog.tsx",
      "scorer-note.tsx",
    ].map((name) => path.join(COMPONENTS, name));
    expect([...reachableFrom(others)].filter((file) => /strava/i.test(file))).toEqual([]);
  });

  it("HR-1.43: the checker really follows imports (a file that does load the training API is seen)", () => {
    const loaded = reachableFrom([path.join(COMPONENTS, "today-panel.tsx")]);
    expect(loaded).toContain("lib/training/api.ts");
    expect(loaded).toContain("lib/training/http-api.ts");
  });
});

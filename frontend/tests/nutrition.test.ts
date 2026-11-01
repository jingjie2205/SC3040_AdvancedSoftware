import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  analyzeMeal,
  deleteMeal,
  fetchDailyLog,
  mealTotals,
  saveMeal,
  scaleItem,
} from "@/lib/nutrition";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession } }),
}));

const fetchMock = vi.fn<typeof fetch>();
const item = {
  name: "Rice", estimated_weight_g: 150, calories: 195,
  protein_g: 4, carbs_g: 42, fat_g: 0.5,
};
const reviewedMeal = {
  id: "00000000-0000-0000-0000-000000000003",
  meal_name: "Reviewed bowl", meal_type: "dinner", logged_at: "2026-10-07T12:00:00Z",
  confidence_score: 0.8, training_context_note: "Recovery meal", items: [item],
} satisfies Parameters<typeof saveMeal>[0];

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: "test-token" } }, error: null,
  });
  fetchMock.mockReset().mockResolvedValue(Response.json({ meals: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("changing a portion scales every nutrient without network access", () => {
  const doubled = scaleItem(item, 300);
  for (const key of ["calories", "protein_g", "carbs_g", "fat_g"] as const) {
    expect(doubled[key]).toBe(item[key] * 2);
  }
  expect(item.estimated_weight_g).toBe(150);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("repeated portion adjustments do not accumulate rounding errors", () => {
  let adjusted = item;
  for (let i = 0; i < 100; i++) adjusted = scaleItem(scaleItem(adjusted, 137), 150);
  expect(adjusted.calories).toBeCloseTo(item.calories, 8);
  expect(adjusted.fat_g).toBeCloseTo(item.fat_g, 8);
});

test("zero, negative and non-finite weights cannot destroy the baseline", () => {
  for (const weight of [0, -1, NaN, Infinity, 10001]) {
    expect(scaleItem(item, weight)).toBe(item);
  }
});

test("adding and removing items recalculates totals", () => {
  expect(mealTotals([item, item]).total_calories).toBe(390);
  expect(mealTotals([item]).carbs_g).toBe(42);
  expect(mealTotals([]).total_calories).toBe(0);
});

test("meal requests reject signed-out users before contacting the backend", async () => {
  getSession.mockResolvedValue({ data: { session: null }, error: null });

  await expect(fetchDailyLog("2026-10-07")).rejects.toThrow("Please sign in");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("meal requests send the signed-in user's bearer token", async () => {
  await fetchDailyLog("2026-10-07");

  const [url, options] = fetchMock.mock.calls[0];
  expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-token");
  expect(url).toMatch(/api\/nutrition\/daily/);
});

describe("meal photo analysis requests", () => {
  test.each([
    ["meal.jpg", "image/jpeg", "image/jpeg"],
    ["meal.png", "image/png", "image/png"],
    ["meal.webp", "image/webp", "image/webp"],
    ["meal.heic", "image/heic", "image/heic"],
    ["meal.heif", "image/heif", "image/heif"],
    ["meal.HEIC", "", "image/heic"],
    ["meal.HEIF", "", "image/heif"],
  ])("uploads %s with MIME type %s (expected %s)", async (name, mimeType, expectedType) => {
    const estimate = {
      meal_name: "Rice bowl", confidence_score: 0.8,
      training_context_note: "Recovery meal", items: [item],
    };
    fetchMock.mockResolvedValue(Response.json(estimate));
    const file = new File([new Uint8Array([1, 2, 3])], name, { type: mimeType });
    const notes = 'After a run. "Extra sauce"\n油';

    await expect(analyzeMeal(file, notes)).resolves.toEqual(estimate);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    const headers = new Headers(options?.headers);
    expect(url).toMatch(/\/api\/nutrition\/analyze$/);
    expect(options?.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.has("Content-Type")).toBe(false);
    expect(options?.cache).toBe("no-store");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = options?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("notes")).toBe(notes);
    const uploaded = body.get("file") as File;
    expect(uploaded.name).toBe(name);
    expect(uploaded.type).toBe(expectedType);
    expect(await uploaded.arrayBuffer()).toEqual(await file.arrayBuffer());
  });

  test("does not save a meal when only requesting analysis", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [item] }));

    await analyzeMeal(new File(["photo"], "meal.png", { type: "image/png" }), "");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/analyze$/);
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("notes")).toBe("");
  });
});

describe("meal review calculations", () => {
  test("halving a portion scales grams and every nutrient without mutating the source", () => {
    const original = { ...item };
    const adjusted = scaleItem(item, 75);

    expect(adjusted.name).toBe("Rice");
    expect(adjusted.estimated_weight_g).toBe(75);
    for (const field of ["calories", "protein_g", "carbs_g", "fat_g"] as const) {
      expect(adjusted[field]).toBe(item[field] / 2);
    }
    expect(item).toEqual(original);
  });

  test.each([0.1, 10000])("accepts a portion weight of %s grams", weight => {
    const adjusted = scaleItem(item, weight);
    expect(adjusted.estimated_weight_g).toBe(weight);
    expect(adjusted.calories).toBeCloseTo(195 * weight / 150, 8);
  });

  test("sums fractional nutrients and rounds once after summing", () => {
    const sauce = {
      name: "Sauce", estimated_weight_g: 25, calories: 12.34,
      protein_g: 0.24, carbs_g: 2.34, fat_g: 0.14,
    };

    expect(mealTotals([item, sauce])).toEqual({
      total_calories: 207.3, protein_g: 4.2, carbs_g: 44.3, fat_g: 0.6,
    });
    expect(mealTotals([sauce, sauce])).toEqual({
      total_calories: 24.7, protein_g: 0.5, carbs_g: 4.7, fat_g: 0.3,
    });
  });

  test("removing all ingredients resets every total", () => {
    expect(mealTotals([])).toEqual({
      total_calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
    });
  });
});

describe("meal confirmation and deletion requests", () => {
  test("saves the reviewed ingredients and stable meal ID as authenticated JSON", async () => {
    const meal = { ...reviewedMeal, items: [scaleItem(item, 300)] };
    const saved = { ...meal, total_calories: 390 };
    fetchMock.mockResolvedValue(Response.json(saved));

    await expect(saveMeal(meal)).resolves.toEqual(saved);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    const headers = new Headers(options?.headers);
    expect(url).toMatch(/\/api\/nutrition\/meals$/);
    expect(options?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(options?.body).toBe(JSON.stringify(meal));
  });

  test("deletes a meal without trying to parse the empty 204 response", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(deleteMeal("meal-id")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/nutrition\/meals\/meal-id$/);
    expect(options?.method).toBe("DELETE");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(json).not.toHaveBeenCalled();
  });
});

describe("meal request failures and cancellation", () => {
  test("rejects an authentication error even when a stale session exists", async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: "expired-token" } }, error: new Error("Expired"),
    });

    await expect(analyzeMeal(new File(["photo"], "meal.png"), "")).rejects.toThrow("Please sign in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([413, 415, 422, 429, 502, 503, 504])("shows the backend error message for status %s", async status => {
    fetchMock.mockResolvedValue(Response.json({ detail: `Meal analysis error ${status}` }, { status }));

    await expect(analyzeMeal(new File(["photo"], "meal.png"), ""))
      .rejects.toThrow(`Meal analysis error ${status}`);
  });

  test.each([null, {}, { detail: [{ msg: "Invalid ingredient" }] }])("uses a readable fallback for error body %j", async body => {
    fetchMock.mockResolvedValue(Response.json(body, { status: 422 }));
    await expect(saveMeal(reviewedMeal)).rejects.toThrow("Request failed (422). Please try again.");
  });

  test("handles a non-JSON error response", async () => {
    fetchMock.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    await expect(deleteMeal("meal-id")).rejects.toThrow("Request failed (502). Please try again.");
  });

  test("propagates network failures without retrying a save", async () => {
    const failure = new TypeError("Network unavailable");
    fetchMock.mockRejectedValue(failure);

    await expect(saveMeal(reviewedMeal)).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("preserves the caller's cancellation signal when loading a day", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation(async (_url, options) => {
      options?.signal?.throwIfAborted();
      return Response.json({ meals: [] });
    });

    await expect(fetchDailyLog("2026-10-07", controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

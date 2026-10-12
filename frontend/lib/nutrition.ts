import { createClient } from "@/lib/supabase/client";

export interface FoodItem {
  name: string;
  estimated_weight_g: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealEstimate {
  meal_name: string;
  confidence_score: number;
  training_context_note: string;
  items: FoodItem[];
}

export const mealTypes = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = typeof mealTypes[number];
export interface LoggedFoodItem {
  name: string;
  estimated_weight_g: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}
export interface MealRecord {
  id: string;
  meal_name: string;
  meal_type: MealType | null;
  logged_at: string;
  confidence_score: number | null;
  training_context_note: string;
  items: LoggedFoodItem[];
  total_calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}
export interface DailyLog {
  date: string;
  meals: MealRecord[];
  total_calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  bmr: number | null;
  active_calories: number | null;
  net_energy: number | null;
}
export interface BatchCalories {
  date: string;
  total_calories: number | null;
  active_calories: number | null;
}

export function mealTotals(items: FoodItem[]) {
  const sum = (key: keyof Omit<FoodItem, "name">) =>
    Math.round(items.reduce((total, item) => total + item[key], 0) * 10) / 10;
  return { total_calories: sum("calories"), protein_g: sum("protein_g"), carbs_g: sum("carbs_g"), fat_g: sum("fat_g") };
}

export function scaleItem(item: FoodItem, weight: number): FoodItem {
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10000) return item;
  const ratio = weight / item.estimated_weight_g;
  return { ...item, estimated_weight_g: weight, calories: item.calories * ratio,
    protein_g: item.protein_g * ratio, carbs_g: item.carbs_g * ratio, fat_g: item.fat_g * ratio };
}

const url = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const { data: { session }, error } = await createClient().auth.getSession();
  if (error || !session) throw new Error("Please sign in to use your meal log.");
  headers.set("Authorization", `Bearer ${session.access_token}`);
  const response = await fetch(`${url}/api/nutrition${path}`, {
    ...options, cache: "no-store", signal: options.signal ?? AbortSignal.timeout(75000),
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Request failed (${response.status}). Please try again.`);
  }
  return response;
}

export async function analyzeMeal(file: File, notes: string): Promise<MealEstimate> {
  const body = new FormData();
  const extension = file.name.split(".").pop()?.toLowerCase();
  const type = file.type || (extension === "heic" ? "image/heic" : extension === "heif" ? "image/heif" : "");
  body.append("file", new File([file], file.name, { type }));
  body.append("notes", notes);
  return (await request("/analyze", { method: "POST", body })).json();
}

export async function fetchDailyLog(day: string, signal?: AbortSignal): Promise<DailyLog> {
  const offset = -new Date(`${day}T12:00:00`).getTimezoneOffset();
  return (await request(`/daily?day=${day}&offset_minutes=${offset}`, { signal })).json();
}

export async function fetchBatchCalories(
  startDate: string,
  endDate: string,
  signal?: AbortSignal
): Promise<BatchCalories[]> {
  const offset = -new Date(`${endDate}T12:00:00`).getTimezoneOffset();
  return (
    await request(
      `/batch_calories?start_date=${startDate}&end_date=${endDate}&offset_minutes=${offset}`,
      { signal }
    )
  ).json();
}

export async function saveMeal(meal: MealEstimate & { id: string; meal_type: MealType; logged_at: string }): Promise<MealRecord> {
  return (await request("/meals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meal) })).json();
}

export async function deleteMeal(id: string): Promise<void> {
  await request(`/meals/${id}`, { method: "DELETE" });
}

export interface CalorieDay {
  date: string;
  total_calories: number | null;
  meal_count: number;
  target_calories: number | null;
  target_source: "saved" | "profile" | null;
}

export async function fetchCalorieCalendar(start: string, end: string, signal?: AbortSignal): Promise<CalorieDay[]> {
  const offset = -new Date(`${end}T12:00:00`).getTimezoneOffset();
  return (await request(`/calendar?start_date=${start}&end_date=${end}&offset_minutes=${offset}`, { signal })).json();
}

export async function saveCalorieTargets(targets: { date: string; target_calories: number }[]): Promise<void> {
  await request("/targets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets }) });
}

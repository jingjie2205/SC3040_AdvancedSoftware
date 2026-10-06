import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import MealAnalysis from "./meal-analysis";

export default async function NutritionPage() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) redirect("/login");
  return <MealAnalysis />;
}

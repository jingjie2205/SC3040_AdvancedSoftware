"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateTag } from "next/cache";

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export async function updateProfileMetrics(formData: {
  age?: number;
  weight?: number;
  height?: number;
  biologicalSex?: string;
  activityLevel?: string;
  fitnessGoal?: string;
}) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Unauthorized");
  }

  const res = await fetch(`${backendUrl}/users/me`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(formData),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => null);
    throw new Error(errorData?.detail || "Failed to update profile metrics");
  }

  // Clear cached user profile data so UI reflects changes immediately
  revalidateTag("user-profile");

  return await res.json();
}

export async function disconnectStrava() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Unauthorized");
  }

  const res = await fetch(`${backendUrl}/strava/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!res.ok) {
    throw new Error("Failed to disconnect Strava");
  }

  // Invalidates the cached user profile so the UI instantly resets
  revalidateTag("user-profile");
}


import {
  CheckInDatesResponse,
  CheckInStreakResponse,
} from "../../models/checkin";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export async function getMyCheckIns(token: string): Promise<CheckInDatesResponse> {
  const response = await fetch(`${API_URL}/checkin/me/dates`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return { user_id: "", dates: [] };
    }
    throw new Error("Failed to fetch check-in dates");
  }

  return response.json();
}

export async function checkIn(token: string): Promise<CheckInDatesResponse> {
  const response = await fetch(`${API_URL}/checkin/me`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to check in");
  }

  return response.json();
}
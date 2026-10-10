
import {
  CheckInDatesResponse,
  CheckInStreakResponse,
} from "./types";

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
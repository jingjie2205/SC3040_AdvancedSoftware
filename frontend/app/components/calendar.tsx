"use client";

import { Session } from "@supabase/supabase-js";
import { useMemo, useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { getMyCheckIns, checkIn } from "../api/auth/callback/checkin";
import "../assets/calendar.css";

function calculateStreak(dates: string[]): number {
  if (dates.length === 0) {
    return 0;
  }

  const sortedDates = dates
    .map((date) => new Date(date))
    .sort((a, b) => b.getTime() - a.getTime());

  let streak = 0;
  const today = new Date(new Date().toISOString().slice(0, 10));

  // Check if the most recent check-in is today or yesterday
  const mostRecentDate = sortedDates[0];

  const diffTime = today.getTime() - mostRecentDate.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays > 1) {
    return 0;
  }

  streak = 1;

  for (let i = 1; i < sortedDates.length; i++) {
    const current = sortedDates[i - 1];
    const previous = sortedDates[i];

    const timeDiff = current.getTime() - previous.getTime();
    const dayDiff = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

    if (dayDiff === 1) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

export default function CheckInCalendar() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkInDates, setCheckInDates] = useState<string[]>([]);
  const [streak, setStreak] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSession = async () => {
      const supabase = createClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        setError("Failed to fetch session. Please try again later.");
        setIsLoading(false);
        return;
      }
      setSession(data.session);
    };

    fetchSession();
  }, []);

  useEffect(() => {
    if (session) {
      const fetchCheckInData = async () => {
        try {
          const datesResponse = await getMyCheckIns(session.access_token);
          setCheckInDates(datesResponse.dates);
          setStreak(calculateStreak(datesResponse.dates));
        } catch (err) {
          setError("Failed to load check-in data. Please try again later.");
        } finally {
          setIsLoading(false);
        }
      };

      fetchCheckInData();
    }
  }, [session]);

  const dates = useMemo(() => {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const day = today.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;

    const monday = new Date(today);
    monday.setUTCDate(today.getUTCDate() + diff);

    const startDate = new Date(monday);
    startDate.setUTCDate(monday.getUTCDate() - 7);

    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(startDate);
      date.setUTCDate(startDate.getUTCDate() + index);
      return date;
    });
  }, []);

  const today = new Date(new Date().toISOString().slice(0, 10));
  const todayISO = today.toISOString().split("T")[0];

  const hasCheckedInToday = checkInDates.includes(todayISO);

  function isToday(date: Date) {
    return date.toDateString() === today.toDateString();
  }

  function isCheckedIn(date: Date) {
    const dateISO = date.toISOString().split("T")[0];
    return checkInDates.includes(dateISO);
  }

  async function handleCheckIn() {
    if (!session || hasCheckedInToday) return;

    try {
      const updatedCheckIns = await checkIn(session.access_token);
      setCheckInDates(updatedCheckIns.dates);
      setStreak(calculateStreak(updatedCheckIns.dates));
    } catch (err) {
      setError("Failed to check in. You may have already checked in today.");
    }
  }

  if (isLoading) {
    return (
      <div className="checkin-card">
        <div className="checkin-loading">
          <p>Loading check-in data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="checkin-card">
        <div className="checkin-error">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="checkin-card">
      <div className="checkin-header">
        <div>
          <h3>Daily check-in</h3>
          <p>Keep your streak going</p>
        </div>

        <div className="checkin-streak">🔥 {streak}</div>
      </div>

      <div className="checkin-weekdays">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <div key={index}>{day}</div>
        ))}
      </div>

      <div className="checkin-calendar">
        {dates.map((date) => {
          const checkedIn = isCheckedIn(date);
          const currentDay = isToday(date);

          return (
            <div
              key={date.toISOString()}
              className={`checkin-day
                ${checkedIn ? "checked-in" : "missed"}
                ${currentDay ? "today" : ""}
              `}
            >
              <span className="checkin-date">{date.getDate()}</span>
              {checkedIn ? (
                <span className="checkin-mark">✓</span>
              ) : (
                <span className="missed-checkin-mark">✗</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="checkin-legend">
        <div>
          <span className="legend-dot checked" />
          Checked in
        </div>
        <div>
          <span className="legend-dot missed" />
          Missed ✗
        </div>
      </div>

      <button
        onClick={handleCheckIn}
        disabled={hasCheckedInToday}
        className="checkin-button"
      >
        {hasCheckedInToday ? "Checked in" : "Check in"}
      </button>
    </div>
  );
}

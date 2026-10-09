/**
 * Dates are handled as local "YYYY-MM-DD" strings so a session stays on the day the user planned it,
 * whatever the timezone.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** True for a real calendar date written as YYYY-MM-DD (so "2026-13-45" and "soon" are not). */
export function isValidISODate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && toISODate(parseISODate(iso)) === iso;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseISODate(a).getTime() - parseISODate(b).getTime()) / 86_400_000);
}

/** Monday = 0 ... Sunday = 6 */
export function weekdayIndex(iso: string): number {
  return (parseISODate(iso).getDay() + 6) % 7;
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -weekdayIndex(iso));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function addMonths(iso: string, months: number): string {
  const d = parseISODate(startOfMonth(iso));
  d.setMonth(d.getMonth() + months);
  return toISODate(d);
}

export function formatDay(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function formatShortDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatMonthYear(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/**
 * Date helpers for Search Console. GSC stores dates in America/Los_Angeles
 * (Pacific) time, and "final" data lags ~2-3 days behind real time. We compute
 * "today" in PT via Intl so date labels match what GSC expects, then subtract a
 * conservative lag for the default (final) data state.
 */

const PT_TZ = "America/Los_Angeles";

/** The current calendar date in Pacific time, as a UTC-midnight Date. */
export function ptToday(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return new Date(`${y}-${m}-${d}T00:00:00Z`);
}

/** Format a Date (UTC midnight) as YYYY-MM-DD. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add (or subtract) days from a Date, returning a new Date. */
export function addDays(d: Date, n: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/** Parse a YYYY-MM-DD string into a UTC-midnight Date. */
export function fromIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Add days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function shiftIsoDate(iso: string, n: number): string {
  return toIsoDate(addDays(fromIsoDate(iso), n));
}

/** Validate a YYYY-MM-DD string. */
export function isValidIsoDate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !isNaN(fromIsoDate(iso).getTime());
}

/**
 * The most recent date for which GSC is expected to have usable data, given the
 * data-state. Final data lags ~3 days; fresh ("all") data lags ~1 day.
 */
export function latestDataDate(dataState: "final" | "all" | "hourly_all"): Date {
  const today = ptToday();
  const lag = dataState === "all" || dataState === "hourly_all" ? 1 : 3;
  return addDays(today, -lag);
}

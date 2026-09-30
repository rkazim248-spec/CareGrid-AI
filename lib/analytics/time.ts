/**
 * ============================================================================
 * CareGrid AI — local day boundaries
 * ============================================================================
 *
 * `docs/14 §7.1`. **PURE.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `new Date('2026-09-26')`
 * ---------------------------------------------------------------------------
 * `new Date('2026-09-26')` is parsed as **UTC midnight**, not local midnight. In
 * Karachi (UTC+5) that is 05:00 local, so an "all of 26 September" bucket would
 * silently start five hours into the day and the last incident of the previous
 * evening would be counted in the wrong bucket.
 *
 * That is not a rounding error. It is the difference between a dispatcher seeing
 * "3 incidents today" and seeing "3 incidents, one of which happened at 23:30
 * yesterday".
 *
 * ---------------------------------------------------------------------------
 * WHY THE TIMEZONE IS A PARAMETER
 * ---------------------------------------------------------------------------
 * `docs/14 §2.1` names `APP_TIMEZONE` for the whole metric catalogue, and
 * `docs/07 §4`'s `slaTargetMin` is measured against local business hours. The
 * server runs in UTC, so a local-day boundary can only be computed by converting
 * from a named zone — which is what `Intl.DateTimeFormat` does here, with no
 * dependency and no ambiguity about DST.
 *
 * The offset is resolved for the SPECIFIC instant rather than once, so a zone that
 * changes offset across the range (Pakistan has no DST, but the code must not
 * assume the deployment never does) gets a correct boundary on each day.
 */


/** A calendar date in the app's zone, as `YYYY-MM-DD`. */
export type LocalDate = string;

/**
 * The offset in minutes to ADD to UTC to get local time, at the given instant.
 *
 * Computed by formatting the instant in the zone and re-reading the parts. The
 * alternative — a hardcoded `+05:00` — is wrong for every zone except this one
 * and silently wrong for any zone with DST.
 */
function offsetMinutesAt(instantMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(new Date(instantMs));

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };

  // `hour: '2-digit', hour12: false` yields "24" for midnight in some ICU versions,
  // which is a real off-by-24h bug. Normalise it.
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );
  return Math.round((asUtc - instantMs) / 60_000);
}

/** The start of a local day, in epoch ms. `docs/14 §2.1`'s `[from 00:00]`. */
export function startOfLocalDayMs(date: LocalDate, timezone: string): number {
  // Noon, so the offset probe is never near a day boundary where the local date
  // could disagree with the one being asked about.
  const guess = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(guess)) return Number.NaN;
  const offset = offsetMinutesAt(guess, timezone);
  return Date.parse(`${date}T00:00:00Z`) - offset * 60_000;
}

/**
 * The END of a local day, in epoch ms — `23:59:59.999` local.
 *
 * **`docs/14 §2.1` bounds the population at `to 23:59:59.999`**, so this is the
 * inclusive upper bound of the range, not the start of the next day. `decideSource`
 * keys on it precisely because it is the moment the period's data stops being
 * current.
 */
export function endOfLocalDayMs(date: LocalDate, timezone: string): number {
  const start = startOfLocalDayMs(date, timezone);
  if (Number.isNaN(start)) return Number.NaN;
  // The next local day's start, minus 1 ms. Computing it as "start + 86 400 000"
  // would be wrong for a zone with a DST transition inside the day, where the day
  // is 23 or 25 hours long.
  return startOfLocalDayMs(nextLocalDate(date), timezone) - 1;
}

/** `YYYY-MM-DD` for the day after `date`, in UTC. Day arithmetic is date-only. */
export function nextLocalDate(date: LocalDate): LocalDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for the day before `date`. */
export function previousLocalDate(date: LocalDate): LocalDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/** The local date containing `instantMs`. */
export function localDateOf(instantMs: number, timezone: string): LocalDate {
  if (!Number.isFinite(instantMs)) return '';
  const offset = offsetMinutesAt(instantMs, timezone);
  return new Date(instantMs + offset * 60_000).toISOString().slice(0, 10);
}

/**
 * Every local date from `from` to `to` inclusive.
 *
 * Bounded by `MAX_DAYS` on purpose. `docs/14 §3.3` notes a 365-day range is 365
 * rollup reads, and an unbounded range would let one request open a thousand
 * channels' worth of reads. The cap is the query's own limit, and the caller
 * reports a truncated range rather than silently returning part of one.
 */
export const MAX_RANGE_DAYS = 366;

export function daysInRange(from: LocalDate, to: LocalDate): readonly LocalDate[] {
  const days: LocalDate[] = [];
  let cursor = from;
  while (days.length < MAX_RANGE_DAYS) {
    days.push(cursor);
    if (cursor === to) return days;
    const next = nextLocalDate(cursor);
    // A malformed or reversed range must not spin: if the cursor stops advancing,
    // return what we have rather than looping.
    if (next === cursor) return days;
    cursor = next;
  }
  return days;
}

/** Is `to` before `from`? A reversed range is a 400, not an empty result. */
export function isReversedRange(from: LocalDate, to: LocalDate): boolean {
  return from > to;
}

/** Did `daysInRange` hit its cap without reaching `to`? */
export function isRangeTruncated(from: LocalDate, to: LocalDate): boolean {
  return daysInRange(from, to).length >= MAX_RANGE_DAYS && !daysInRange(from, to).includes(to);
}

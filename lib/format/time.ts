/**
 * Time formatting. All display goes through here so a single timezone decision
 * (NFR-146) and a single "is this a `date-fns` subpath import" story holds.
 *
 * The demo app pins a fixed reference instant so the mock dataset renders the
 * same ages on every run. A real build reads the clock. Both paths are here
 * because Phase 1 has no server and must not pretend otherwise.
 */

import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns';

/** docs/21 §2. Mirrors APP_TIMEZONE. */
export const APP_TIMEZONE = 'Asia/Kolkata';

export const TIMEZONE_LABEL = 'IST';

/**
 * Fixed "now" for the Phase 1 mock dataset.
 *
 * REMOVE IN PHASE 3 — the moment real data arrives, every formatter here must
 * read the actual clock. Left as a module constant rather than scattered
 * `new Date()` calls so that removal is a one-line change with a search trail.
 */
export const DEMO_NOW = new Date('2026-09-26T10:12:00.000Z');

/** `04:12` — the compact form used in the track timeline. */
export function formatClock(iso: string): string {
  return format(new Date(iso), 'HH:mm');
}

/** `26 Sep 2026, 15:04 IST` — docs/04 §5.28. */
export function formatAbsolute(iso: string): string {
  return `${format(new Date(iso), 'd MMM yyyy, HH:mm')} ${TIMEZONE_LABEL}`;
}

/** `26 Sep 2026` — used in tables where the time is not the point. */
export function formatDate(iso: string): string {
  return format(new Date(iso), 'd MMM yyyy');
}

/** `26 Sep, 15:04` — audit log rows. */
export function formatAuditStamp(iso: string): string {
  return format(new Date(iso), 'd MMM, HH:mm:ss');
}

/** Machine-readable value for `<time dateTime>`. */
export function toDateTimeAttr(iso: string): string {
  return new Date(iso).toISOString();
}

/** `just now` · `4 min ago` · `2 h ago` · `3 d ago` — docs/04 §5.28. */
export function formatRelative(iso: string, now: Date = DEMO_NOW): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  return `${formatDistanceToNowStrict(new Date(iso), { addSuffix: true })}`;
}

/** The `aria-label` for a RelativeTime is the ABSOLUTE time, never "2 h ago". */
export function relativeTimeAriaLabel(iso: string): string {
  const d = new Date(iso);
  return `${format(d, 'd MMMM yyyy')} at ${format(d, 'HH:mm')} ${TIMEZONE_LABEL}`;
}

/** `Today` / `Yesterday` / `26 Sep 2026` — notification list group headings. */
export function formatDayHeading(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'd MMM yyyy');
}

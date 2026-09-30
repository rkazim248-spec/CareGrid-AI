/**
 * ============================================================================
 * CareGrid AI — analytics source selection
 * ============================================================================
 *
 * `docs/14 §3.2`, FR-116. **PURE.** No Firestore, no clock, no randomness.
 *
 * `docs/14 §3.2` names the file: `lib/analytics/decideSource.ts`. The module
 * name is `decide-source` to match this project's kebab-case file convention; the
 * function name is the document's.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * `docs/14 §3.1`: "Firestore offers `get()`, `getDocs()`, and range queries. It
 * does not offer `COUNT(*)`, `SUM()`, `GROUP BY`, or any server-side
 * aggregation. Therefore:
 *
 * ```
 * 30-day window x 3 000 incidents  ->  3 000 document reads, aggregated in JavaScript
 * 30-day window x 30 rollup docs  ->     30 document reads
 * ```
 *
 * That is a 100x difference, and it is the whole reason `analyticsDaily` exists.
 * This function is the decision that picks one or the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RULE KEYS ON THE END OF THE RANGE, NOT THE START
 * ---------------------------------------------------------------------------
 * `docs/14 §3.2` is explicit, and the reason is worth preserving: "an analytics
 * view is a decision aid, and the decision depends on the *freshest* data in it. A
 * 90-day view ending today is LIVE."
 *
 * The intuitive rule — "is this period old enough to have rollups?" — would send a
 * 90-day view to 90 rollup documents and show a dispatcher data that is up to
 * 48 hours stale, while the two most recent days in their window were actually
 * available live. The end of the range is what the decision turns on.
 *
 * ---------------------------------------------------------------------------
 * WHY 48 h AND NOT 24 h
 * ---------------------------------------------------------------------------
 * `docs/14 §3.2`: "it gives one full day of slack. If yesterday's cron fails at
 * 03:00, the `to = yesterday` view still works from rollups."
 *
 * So the number is a reliability margin, not a freshness target. It is a constant
 * rather than a config value because nothing in `docs/21` names a tunable for it,
 * and inventing one would create a configuration surface with no documented owner.
 */

import { endOfLocalDayMs } from '@/lib/analytics/time';

/** The documented figure. `docs/14 §3.2`. */
export const ROLLUP_AFTER_HOURS = 48;

export type AnalyticsSource = 'rollup' | 'live';

/**
 * `rollup` when the period ENDS more than 48 h ago, `live` otherwise.
 *
 * **`to` is an ISO date string**, not a `Date`, because the caller receives it
 * from a query string and parsing it here means the timezone rule is applied in
 * exactly one place. A caller that passed a `Date` would be off by the timezone
 * offset, and the boundary case — a period ending at 23:59 local — is precisely
 * where an off-by-hours error changes the answer.
 */
export function decideSource(to: string, now: Date, timezone: string): AnalyticsSource {
  const hoursSinceEnd = (now.getTime() - endOfLocalDayMs(to, timezone)) / 3_600_000;
  return hoursSinceEnd > ROLLUP_AFTER_HOURS ? 'rollup' : 'live';
}

/**
 * The same decision, with the arithmetic exposed for the label the UI shows.
 *
 * `docs/14 §1`'s honesty table requires `source` on every response, and a
 * dispatcher staring at a chart needs to know whether they are looking at
 * precomputed daily totals or a live scan — they are not equally trustworthy, and
 * `truncated` is only possible on the live path.
 */
export function describeSource(input: {
  readonly to: string;
  readonly now: Date;
  readonly timezone: string;
}): { readonly source: AnalyticsSource; readonly hoursSinceEnd: number } {
  const hoursSinceEnd =
    (input.now.getTime() - endOfLocalDayMs(input.to, input.timezone)) / 3_600_000;
  return { source: hoursSinceEnd > ROLLUP_AFTER_HOURS ? 'rollup' : 'live', hoursSinceEnd };
}

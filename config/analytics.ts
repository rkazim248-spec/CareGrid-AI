/**
 * ============================================================================
 * CareGrid AI — analytics configuration
 * ============================================================================
 *
 * `docs/14 §6.1`, `docs/14 §8.3`, `docs/21`. **Pure data.**
 *
 * ---------------------------------------------------------------------------
 * WHY `APP_TIMEZONE` IS A DEFAULT HERE AND NOT AN ENV READ
 * ---------------------------------------------------------------------------
 * `docs/21` records `APP_TIMEZONE` as a **server** variable, read by the server. So
 * `lib/analytics/time.ts` requires the caller to pass the zone rather than
 * importing it, and this module is where a server caller gets the configured
 * value.
 *
 * The default is `Asia/Kolkata` because that is what `docs/21` uses in its example
 * and what `lib/mock-data` already uses for `AnalyticsRange.timezone`. It is a
 * DEFAULT, not a claim that every deployment is in Pakistan — a server that
 * configures `APP_TIMEZONE=Europe/London` overrides it, and the parameter exists
 * so nothing in the metric path can assume a zone.
 */

/** `docs/21`: "IANA, e.g. `Asia/Kolkata`". */
export const APP_TIMEZONE = 'Asia/Kolkata';

/* ========================================================================== */
/* `docs/14 §6.1` — risk zones                                                 */
/* ========================================================================== */

/**
 * `docs/14 §6.1`: "Feature flag | `ENABLE_RISK_ZONES` / `config.features.riskZones`,
 * **default `false`**".
 *
 * **The default is `false` and this phase does not change it.** Risk analytics is
 * a P1 item in `docs/14`'s own table, and the flag exists precisely because a
 * density heatmap on a dispatcher's map is the most over-claimable surface in the
 * product. Shipping it enabled would mean shipping "this area is dangerous" to
 * users who have not been told what the number means.
 *
 * The computation is implemented and tested; the flag gates whether it is
 * *served*. A deployment can turn it on by setting the flag, and the UI already
 * has to render the honesty statement when it is.
 */
export const RISK_ZONES_ENABLED = false;

/** `docs/14 §6.1`: "`Lookback` | `config.risk.windowDays`, default **30**". */
export const RISK_WINDOW_DAYS = 30;

/** `docs/14 §6.1`: "Output cap | **100 zones**, sorted by `score` descending". */
export const RISK_ZONE_OUTPUT_CAP = 100;

/** `docs/14 §6.1`: "`radiusM` | `number` | default 500". */
export const RISK_ZONE_RADIUS_M = 500;

/* ========================================================================== */
/* `docs/14 §8.3` — the caps, and why each exists                              */
/* ========================================================================== */

/**
 * The live-scan cap. `docs/14 §3.4` bounds the live path; `docs/14 §8.3` explains
 * the caps "and why each exists".
 *
 * **`truncated` is the field that makes this honest.** A capped scan that could not
 * cover the whole range reports it, and `docs/14 §1`'s table lists "Present a
 * capped live scan as complete" as the thing operational analytics must never do.
 */
export const LIVE_SCAN_CAP = 500;

/** The largest range a request may ask for. `docs/14 §3.3` mentions 365 days. */
export const MAX_RANGE_DAYS = 366;

/**
 * The rollup read cap, which is the same as the day cap: one read per day.
 * `docs/14 §3.3`: "A 30-day range = **30 reads**; a 365-day range = **365 reads**".
 *
 * Separate from `MAX_RANGE_DAYS` only in name — they are the same number for the
 * same reason, and keeping them as two constants invites them to drift into a
 * state where a range is allowed but its reads are not.
 */
export const ROLLUP_READ_CAP = MAX_RANGE_DAYS;

/* ========================================================================== */
/* The honesty statement — `docs/14 §6.8`                                     */
/* ========================================================================== */

/**
 * **Rendered verbatim, not paraphrased.** `docs/14 §6.8` says so, and this is
 * copied from the document character for character.
 *
 * It is a constant rather than inline JSX so that a security check can assert the
 * UI renders THIS text, and so a future edit that softens it ("past incidents can
 * indicate where to look") is a visible diff in one place rather than a
 * reworded paragraph in a component. The claim is a product promise: the number
 * summarises what already happened, and it does not know the population, the
 * weather, the day of the week, or anything about a neighbourhood that has not
 * reported an incident here.
 */
export const RISK_HONESTY_STATEMENT =
  'This is a summary of past incidents, not a forecast. The score combines how many incidents happened in an area, how severe they were, and how recently the last one was. It does not know the population, the weather, the day of the week, or anything about a neighbourhood that has not reported an incident here. Areas with more reporters score higher. Use it to decide where to look, never where to send.';

/**
 * Phrases the analytics surface may never use.
 *
 * The document's own warning (`docs/14 §6`) is that a heuristic will be read as a
 * prediction the moment it is shown. These are the specific sentences that turn
 * "areas with more reporters score higher" into a claim about the future, and a
 * security check asserts no component contains one.
 */
export const FORBIDDEN_RISK_CLAIMS = [
  'will be dangerous',
  'predicts an accident',
  'guaranteed high-risk',
  'predicts that',
  'is going to happen',
  'likely to have an incident',
  'forecast of',
] as const;

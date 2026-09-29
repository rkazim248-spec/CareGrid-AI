/**
 * ============================================================================
 * CareGrid AI — dispatch tunables
 * ============================================================================
 *
 * `docs/07 §7`, `docs/07 §8`, FR-061 / FR-062 / FR-064. **Pure data.**
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE FILE AND NOT MORE OF `config/limits.ts`
 * ---------------------------------------------------------------------------
 * `config/limits.ts` holds limits that protect *this application* — an upload
 * ceiling, a rate-limit window, a listener cap. Everything in it bounds a request
 * or a resource.
 *
 * Everything here describes the *operational policy* of a dispatch system: how long
 * an unanswered assignment stays live, how far a responder is willing to travel,
 * how many incidents they may hold. Those are numbers an operations lead sets and
 * an operator needs to see in one file, and burying them among upload ceilings is
 * how a 5 km service radius silently becomes 500 m.
 *
 * They are NOT environment variables. Nothing in `docs/21` names a tunable for
 * them, and inventing one would create a configuration surface with no documented
 * owner, no validation and no default. They are constants, and changing one is a
 * code change a reviewer can see.
 */

/* ========================================================================== */
/* `docs/07 §7.1` — responder profile defaults                                 */
/* ========================================================================== */

/** FR-062: "default 5000, range 500-50000". */
export const SERVICE_RADIUS_DEFAULT_M = 5_000;
export const SERVICE_RADIUS_MIN_M = 500;
export const SERVICE_RADIUS_MAX_M = 50_000;

/** `docs/07 §7.1`: "default 1, max 3". */
export const MAX_CONCURRENT_DEFAULT = 1;
export const MAX_CONCURRENT_LIMIT = 3;

/* ========================================================================== */
/* `docs/07 §8` — dispatch lifecycle                                            */
/* ========================================================================== */

/**
 * How long an unaccepted assignment stays `active`. `docs/07 §8`: "unaccepted
 * assignment expires (default 120 s) and is swept".
 *
 * Two minutes is short, and that is deliberate: `active` means "a dispatcher is
 * waiting for an answer", and a dispatch that sits `active` for ten minutes is
 * indistinguishable from one nobody is going to answer — which would leave a
 * responder's capacity occupied by an assignment they never saw.
 */
export const DISPATCH_EXPIRES_SEC = 120;

/**
 * How often the sweep runs, in seconds. Not in `docs/21` because the sweep is a
 * maintenance job, and `docs/07 §11` lists `maintenance.run` as an audit action
 * rather than describing a schedule. Once a minute is comfortably inside the
 * 120 s window, so an expired dispatch is swept before it can be accepted.
 */
export const DISPATCH_SWEEP_INTERVAL_SEC = 60;

/**
 * `responderLocations.stale` is `true` when `receivedAt` is older than 15 minutes
 * (`docs/07 §7.2`, US-022). Re-exported from Phase 6 rather than restated: a
 * second definition of "stale" is a second answer, and the map badge and the
 * candidate sort would eventually disagree about whether a responder is stale.
 */
export { STALE_AFTER_MS } from '@/lib/geo/integrity';

/* ========================================================================== */
/* Candidate discovery                                                         */
/* ========================================================================== */

/**
 * How many responders one candidate query may return. brief §41: "Avoid loading
 * all responders."
 *
 * Fifty is a dispatcher-facing number, not a database one: a panel showing more
 * than fifty candidates is not a panel, it is a list nobody reads, and the query
 * cost is paid for rows that are never displayed. The response also reports
 * `truncated`, so a dispatcher is told the list is partial rather than assuming
 * they are seeing everyone.
 */
export const CANDIDATE_QUERY_LIMIT = 50;

/** The hard ceiling, whatever a future caller asks for. Mirrors `env.server.ts`. */
export const CANDIDATE_LIMIT_CEILING = 200;

/* ========================================================================== */
/* The controlled vocabularies                                                 */
/* ========================================================================== */

/**
 * Why a responder declined. brief §16.
 *
 * **These are the brief's five, verbatim, and they are `suggestions` not
 * `requirements`.** A responder can be unable to respond for a reason nobody
 * enumerated, and a mandatory list would force them to pick a false one. So the
 * field is free text with these as quick-select options, and the stored value is
 * whichever they chose — including "Other" plus their own words.
 */
export const DECLINE_REASONS = [
  'Unable to respond',
  'Currently handling another emergency',
  'Outside operational capability',
  'Other',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** `docs/07 §8`: `note` is "dispatcher instruction, <= 280 chars". */
export const DISPATCH_NOTE_MAX = 280;

/** `docs/07 §11.5`: `reason` is "<= 200 chars" on an audit row. */
export const AUDIT_REASON_MAX = 200;

/**
 * `docs/01` FR-054 and `docs/17 §403`: the resolution note is "<= 280 characters".
 *
 * It was 500 here on the first draft, which no document supports. The resolver is
 * the responder stepping away from an incident, and a note they can finish typing
 * on a phone is worth more than a longer one they cannot.
 */
export const RESOLUTION_NOTE_MAX = 280;

/* ========================================================================== */
/* The resolution record                                                        */
/* ========================================================================== */

/**
 * brief §34: "Optionally capture: resolution note, resources used, people
 * assisted, additional follow-up required. **Do not invent these values.** Allow
 * unknown/empty values where appropriate."
 *
 * So every one of the four is `| null` and `null` genuinely means "not recorded" —
 * never `0` people assisted, which would be a fabricated fact about a rescue, and
 * never an empty string, which would be indistinguishable from a deliberate
 * "none".
 *
 * **`resolutionCode` is not declared here.** It is `RESOLUTION_CODES` in
 * `types/enums.ts`, which Phase 3 implemented from `docs/01` FR-054 and
 * `docs/17 §163`. This file originally carried a second copy with six DIFFERENT
 * values, which is precisely the duplication `docs/17` opens by naming
 * `validators/enums.ts` "the single source" — and a duplicate list is worse than
 * no list, because the schema validated against the wrong six.
 */
export type ResolutionRecord = {
  /** The FR-054 controlled value. See `RESOLUTION_CODES` in `@/types`. */
  readonly resolutionCode: string;
  readonly note: string | null;
  readonly resourcesUsed: readonly string[];
  readonly peopleAssisted: number | null;
  readonly followUpRequired: boolean | null;
};

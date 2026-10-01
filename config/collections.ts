/**
 * ============================================================================
 * CareGrid AI — Firestore collection names
 * ============================================================================
 *
 * One record for every collection in docs/07 §1. Not a convenience: a
 * collection name typed as a string literal at three call sites is three
 * chances to write `incidentss`, and the failure is a silent write to a NEW
 * collection that no rule covers and no query reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN `config/` AND NOT IN `lib/`
 * ---------------------------------------------------------------------------
 * docs/20 §1 P3: `lib/` is pure — no Firebase. A collection name is not an
 * import of the SDK, it is a string, and `config/` is where every enumerating
 * value in this project lives (docs/20 §1 P7). docs/32 MUST NOT 5 names this
 * exact file as the place a new collection must be added.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 * No subcollection paths. `incidents/{id}/statusHistory/{eventId}` is built by
 * the service that writes it, because a subcollection is a function of a
 * document id and expressing it as a constant here would be a template string
 * pretending to be a name. Only the 15 top-level collections and `config/app`
 * are here, which is exactly the list in docs/07 §1.
 *
 * ---------------------------------------------------------------------------
 * A NEW COLLECTION NEEDS FOUR THINGS, NOT ONE
 * ---------------------------------------------------------------------------
 * 1. A row here, so the name is greppable.
 * 2. A row in `docs/07` §1.
 * 3. A rule in `firestore.rules` — which defaults to DENY, so a collection with
 *    no rule is closed and the mistake surfaces in development rather than
 *    opening a hole (docs/30.3 §A4, deviation 6).
 * 4. A service that writes it. Never a route handler, never a client.
 */

export const COLLECTIONS = {
  /** docs/07 §4. One incident. `deletedAt` is the soft-delete marker. */
  incidents: 'incidents',
  /** docs/07 §3. The authoritative role, status, and account record. */
  users: 'users',
  /** docs/07 §3.1. Editable profile slice, split so the two cannot diverge. */
  profiles: 'profiles',
  /** docs/07 §7. Responder capability, verification, and capacity. */
  responders: 'responders',
  /** docs/07 §7.2. The most recent position. Separate so a heartbeat is one write. */
  responderLocations: 'responderLocations',
  /** docs/07 §8. One assignment of one responder to one incident. */
  dispatches: 'dispatches',
  /** docs/07 §10. In-app notifications, with a `dedupeKey` per FR-108. */
  notifications: 'notifications',
  /** docs/07 §10.1. Per-recipient read state, so a list query is one read. */
  /**
   * NOT YET IN `firestore.rules`.
   *
   * The rules file is deny-by-default with a catch-all (docs/30.3 §A4,
   * deviation 6), so an uncovered collection is CLOSED rather than open — the
   * failure surfaces in Phase 9 development as a permission error, not as a
   * hole. `tests/unit/api/environment.test.ts` cross-references this table
   * against the rules file and names every direction of drift, so adding the
   * rule without the constant (or the reverse) fails a test.
   */
  notificationReads: 'notificationReads',
  /** docs/07 §11.4. One Gemini run. Never written by a client (docs/10 §9). */
  aiRuns: 'aiRuns',
  /** docs/07 §11.5. Append-only. No update, no delete, for any role. */
  auditLogs: 'auditLogs',
  /** docs/07 §11.6. The rate-limit buckets. One doc per subject per window. */
  rateLimits: 'rateLimits',
  /** docs/07 §11.7. Nightly rollups. The dashboard reads these, not `incidents`. */
  analyticsDaily: 'analyticsDaily',
  /** docs/07 §11.3. The maintenance-task catalogue. Never deleted (docs/32 §7). */
  resources: 'resources',
  /** docs/07 §11.2. Derived heat cells. Recomputed, not written per incident. */
  riskZones: 'riskZones',
  /**
   * A SINGLE document, not a collection. `config/app` holds the tunables an
   * admin may change at runtime (docs/07 §11.8).
   */
  configApp: 'config/app',
} as const;

/**
 * The two SUBCOLLECTIONS of an incident, by name only.
 *
 * docs/07 §5 (`reports`) and §6 (`statusHistory`) hang off `incidents/{id}`, and
 * docs/20 §2 draws them as `incidents/[id]/reports` and
 * `incidents/[id]/statusHistory`. They are listed separately from `COLLECTIONS`
 * so the top-level count is honestly the 15 docs/07 §1 claims, and so nobody
 * writes a `db.collection('reports')` query that silently targets a different
 * collection than the subcollection they meant.
 *
 * There is deliberately no PATH here. A subcollection is a function of a document
 * id, and expressing it as a constant would be a template string pretending to be
 * a name. The service that writes it builds the path.
 */
export const SUB_COLLECTIONS = {
  /** docs/07 §5. The citizen's own words, plus supplements and corrections. */
  incidentReports: 'reports',
  /** docs/07 §6. Append-only lifecycle timeline. Never updated. */
  statusHistory: 'statusHistory',
  /**
   * Phase 14. One AI review of one incident.
   *
   * A SUBCOLLECTION, not a top-level collection, and the choice is load-bearing.
   *
   * The alternative was a top-level `aiReviews` collection, which would have been
   * a poor fit for three reasons: a review has no meaning without its incident, so
   * it could never be listed on its own; a top-level collection would need a row in
   * `COLLECTIONS` AND a matching rule in `firestore.rules`, which is the four-step
   * obligation this file's header describes; and the review queue is driven by
   * `incidents.aiNeedsReview` anyway, so the queue query would start from
   * incidents regardless and then have to join back.
   *
   * Hanging it off the incident makes all three problems disappear. It is
   * server-only — `firestore.rules` denies every client read and write, exactly as
   * it does for `evidence` — because a review records a privileged judgement
   * about AI output and no browser has any business writing or reading one
   * directly.
   */
  aiReviews: 'aiReviews',
  /** docs/07 §6.2. What an incident needs, and how much is on the way. */
  resources: 'resources',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
export type SubCollectionName = (typeof SUB_COLLECTIONS)[keyof typeof SUB_COLLECTIONS];

/** The 15 top-level collections, for the coverage test. `config/app` excluded. */
export const COLLECTION_NAMES: readonly string[] = Object.values(COLLECTIONS).filter(
  (name) => !name.includes('/'),
);

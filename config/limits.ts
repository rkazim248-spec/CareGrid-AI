/**
 * Client-visible limits and thresholds.
 *
 * These mirror environment values and server config so the UI can render a
 * bound, a helper message, or a disabled-with-reason BEFORE a request is made
 * (docs/21_ENVIRONMENT_VARIABLES.md §12, docs/04 §10.4).
 *
 * The server is authoritative for every one of these. Nothing here decides
 * anything — it only explains the rule to the person filling in the form.
 */

export const REPORT_LIMITS = {
  /** FR-003 */
  textMinChars: 20,
  textMaxChars: 2000,
  /** FR-005 */
  maxImages: 3,
  maxImageBytes: 5 * 1024 * 1024,
  /** FR-006 (P1) */
  maxAudioClips: 1,
  maxAudioBytes: 15 * 1024 * 1024,
  maxAudioDurationSec: 120,
  /** FR-037 */
  maxMapResults: 150,
  /** FR-121 */
  defaultPageSize: 25,
  maxPageSize: 100,
  pageSizeOptions: [25, 50, 100] as const,
  /** FR-087 / 04 §5.33 */
  searchMaxChars: 60,
  searchDebounceMs: 300,
  /** FR-015 */
  reportsPerHour: 5,
  reportsPerDay: 20,
  /** FR-066 */
  responderHeartbeatSec: 60,
  /** US-022 AC2 */
  staleLocationMin: 15,
  /** Dispatch expiry, docs/08 §5.2 */
  dispatchExpirySec: 120,
  /** FR-050 reasons, FR-063/133/046 auditability */
  reasonMinChars: 10,
  reasonMaxChars: 280,
  /** docs/07 §11.1 */
  maxEvidenceCount: 3,
  /** report supplement window (FR-012 / US-006) */
  supplementWindowHours: 2,
  /** analytics */
  analyticsMaxRangeDays: 365,
  analyticsLiveScanCap: 500,
  rollupCutoffHours: 48,
} as const;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/mpeg'] as const;

/** Accuracy grading thresholds. FR-032. */
export const ACCURACY_THRESHOLDS = {
  highMaxM: 50,
  mediumMaxM: 200,
  lowMaxM: 1000,
} as const;

/** docs/01 DEC-01 / docs/07 §9.5. Displayed on the map ring and the detail panel. */
export const DUPLICATE_DEFAULTS = {
  radiusM: 500,
  timeWindowMin: 360,
  textSimilarityConfirm: 0.6,
  duplicatePotentialThreshold: 0.55,
  algorithmVersion: 'dedupe-v1',
} as const;

/** AI confidence banding. FR-024 / docs/09 §5.4. */
export const CONFIDENCE_THRESHOLDS = {
  needsReviewBelow: 0.6,
  highAtOrAbove: 0.8,
} as const;

/** docs/05 §A5 — the client never holds more than 8 listeners. */
export const MAX_REALTIME_LISTENERS = 8;

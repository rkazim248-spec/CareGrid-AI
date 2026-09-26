/**
 * Shared constants with no better home.
 *
 * Kept tiny on purpose. If a constant acquires behaviour, it moves to `lib/`.
 * docs/31_CODING_STANDARDS.md: no `utils.ts` god file.
 */

/** A requestId as produced by `lib/server/request-id.ts` (docs/08 FR-141). */
export const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9]{12}$/;

/** A citizen-facing reference: `CG-` + 6 Crockford base32 chars (no I/L/O/U). */
export const REFERENCE_PATTERN = /^CG-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * URL is the filter state (docs/05 A7). These keys are the contract between
 * the queue, the map, and the incident list — they must stay in sync.
 */
export const INCIDENT_FILTER_KEYS = [
  'status',
  'urgency',
  'category',
  'verified',
  'slaState',
  'unassigned',
  'q',
  'sort',
  'limit',
  'cursor',
] as const;

/**
 * localStorage keys. A UI preference is not account data, so it is namespaced
 * `cg.` and never sent to the server (docs/04 §13.16).
 */
export const STORAGE_KEYS = {
  ui: 'cg.ui',
  sidebarCollapsed: 'cg.sidebar',
  previewRole: 'cg.previewRole',
  reportDraft: 'cg.draft.report',
} as const;

/** The public demo disclaimer. Rendered on every public surface. */
export const DEMO_DISCLAIMER =
  'This is a demonstration system. It is not a replacement for a public emergency number.';

/** Shown on the landing hero and in the auth footer. */
export const DEMO_DISCLAIMER_LONG =
  'CareGrid AI is a demonstration project. It is not a certified emergency dispatch system, it has no service-level guarantee, and it must not be used in place of a public emergency number.';

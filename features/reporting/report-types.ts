/**
 * The shape of an in-progress report on the client.
 *
 * Phase 1 keeps it entirely in component state: there is no draft persistence
 * (`localStorage` `cg.draft.report` arrives with the submit path in Phase 3) and
 * no upload. The shape is deliberately the one the API expects in
 * docs/08 §3.4 so the wiring step is a source swap, not a rewrite.
 */

import type { AccuracyGrade, IncidentCategory, LocationSource } from '@/types';

export type EvidenceItem = {
  readonly id: string;
  readonly name: string;
  /**
   * 0 to 1.
   *
   * **Simulated in Phase 1 and real from Phase 5.** Kept because `report-view.tsx`
   * renders it, and because removing a field other files read is a wider change
   * than this phase needs. Nothing in Phase 5 writes it: the real progress lives
   * in `PendingUpload.progress` (an integer percentage) and is rendered by
   * `EvidenceUploader`. This field is display-only now.
   */
  readonly progress: number;
  /**
   * The server-issued `med_XXXXXXXXXXXX`, present only for an item that finished
   * `POST /api/uploads/finalize`.
   *
   * **Optional, and that is the honest shape.** Phase 1 created items with no
   * upload behind them, and `report-view.tsx` still can. But it is load-bearing
   * for a different reason: `canSubmit` below treats a non-empty `evidence` as a
   * submittable report, which is the image-only path docs/15 §16.3 requires. So
   * this array is not decoration — it is what lets a citizen with a photo of a
   * fire and no text send their report at all. Phase 5's uploader reports into it
   * for exactly that reason.
   */
  readonly mediaId?: string;
  /**
   * The SNIFFED type, once verified. Never the declared one — docs/15 §5.3.
   */
  readonly mimeType?: string;
};

export type ReportLocation = {
  readonly source: LocationSource;
  readonly accuracyM: number | null;
  readonly accuracyGrade: AccuracyGrade;
  readonly placeName: string | null;
  /**
   * The coordinates, when there are any.
   *
   * These were ABSENT from this type, and that was a bug with teeth: the draft
   * could hold a `source` and an accuracy and a place name while the fix itself
   * was thrown away, so a report submitted from this form could never carry a
   * location no matter what the citizen did on the map. The panel had nowhere to
   * put the point.
   *
   * Nullable rather than absent because "no fix" is a real, common state — a
   * citizen indoors, a denied permission, a laptop with no GPS — and pretending it
   * is impossible is how it ends up being `0,0` in the Gulf of Guinea.
   */
  readonly lat: number | null;
  readonly lng: number | null;
};

export const NO_LOCATION: ReportLocation = {
  source: 'none',
  accuracyM: null,
  accuracyGrade: 'unknown',
  placeName: null,
  lat: null,
  lng: null,
};

export type ReportDraft = {
  readonly text: string;
  readonly evidence: readonly EvidenceItem[];
  readonly location: ReportLocation;
  readonly locationMethod: LocationMethod;
  readonly category: IncidentCategory | null;
  /**
   * The reporter's UI language, sent as an ISO code.
   *
   * `null` is not offered: FR-002 says the form is never blocked by language, and
   * `pending` is what the server stores when it cannot identify one. It is a
   * nullable field so a future "use English for me" toggle has somewhere to go.
   */
  readonly language: string | null;
  /** FR-023. `null` is UNKNOWN, never 0 — 0 people affected is a real claim. */
  readonly peopleAffected: number | null;
};

/** Which control the reporter used, so the flow can explain what happened. */
export type LocationMethod = 'none' | 'gps' | 'pin' | 'address' | 'skipped';

export const EMPTY_DRAFT: ReportDraft = {
  text: '',
  evidence: [],
  location: NO_LOCATION,
  locationMethod: 'none',
  category: null,
  language: null,
  peopleAffected: null,
};

/** FR-002: 20 characters OR any evidence item is enough to send. */
export function canSubmit(draft: ReportDraft, minChars: number): boolean {
  return draft.text.trim().length >= minChars || draft.evidence.length > 0;
}

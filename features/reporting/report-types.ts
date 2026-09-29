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
};

export const NO_LOCATION: ReportLocation = {
  source: 'none',
  accuracyM: null,
  accuracyGrade: 'unknown',
  placeName: null,
};

export type ReportDraft = {
  readonly text: string;
  readonly evidence: readonly EvidenceItem[];
  readonly location: ReportLocation;
  readonly locationMethod: LocationMethod;
  readonly category: IncidentCategory | null;
};

/** Which control the reporter used, so the flow can explain what happened. */
export type LocationMethod = 'none' | 'gps' | 'pin' | 'address' | 'skipped';

export const EMPTY_DRAFT: ReportDraft = {
  text: '',
  evidence: [],
  location: NO_LOCATION,
  locationMethod: 'none',
  category: null,
};

/** FR-002: 20 characters OR any evidence item is enough to send. */
export function canSubmit(draft: ReportDraft, minChars: number): boolean {
  return draft.text.trim().length >= minChars || draft.evidence.length > 0;
}

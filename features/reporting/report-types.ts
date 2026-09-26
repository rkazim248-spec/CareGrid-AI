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
  /** 0 to 1. Simulated; nothing is uploaded in Phase 1. */
  readonly progress: number;
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

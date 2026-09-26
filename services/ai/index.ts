/**
 * ============================================================================
 * CareGrid AI — the AI domain entry point
 * ============================================================================
 *
 * `services/ai/index.ts`, re-exporting the public function of the domain.
 * docs/20 §1 P10: a barrel exists to define a directory's boundary.
 *
 * It exists here for a practical reason as well as a structural one. The whole
 * domain is TWO files — the seam and the entry point — and a route that reached
 * into `@/services/ai/triage` would be reaching past a boundary that exists to
 * keep the seam swappable. When Phase 4 adds `schema.ts`, `prompts.ts`,
 * `rules.ts`, and `fallback.ts`, none of them changes a route's import.
 */

export {
  TRIAGE_LIMITS,
  toTriageRequest,
  triageIncident,
  type TriageOutcome,
} from '@/services/ai/triage';

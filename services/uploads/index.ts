/**
 * ============================================================================
 * CareGrid AI — the uploads service barrel
 * ============================================================================
 *
 * The one public entry point into `services/uploads/**`, on the same terms as
 * `services/index.ts`: a route handler imports from here, and nothing under
 * `lib/` or `components/` does.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT EXPORTED, AND WHY
 * ---------------------------------------------------------------------------
 * | Exported                          | Why it is reachable by a route              |
 * | --------------------------------- | ------------------------------------------- |
 * | `signUpload`                      | `POST /api/uploads/sign`                    |
 * | `finalizeUpload`                  | `POST /api/uploads/finalize`                |
 * | `resolveEvidenceRead`             | `GET /api/uploads/[mediaId]/url`            |
 * | `attachEvidenceToIncident`       | `POST /api/incidents` (step 5/6)            |
 * | `stageImageForAi` / `stageAudioForAi` | feeding Phase 4's multimodal triage     |
 * | `sweepAbandonedStaging`           | the sweeper, when Phase 9 builds it         |
 *
 * Deliberately NOT exported: `sniff.ts`'s `detectMediaType` and the whole of
 * `evidence-storage.ts`'s primitives.
 *
 * `detectMediaType` is the security-critical pure function and it is reachable
 * from exactly one place — `finalize-upload.ts` — because a second caller would
 * be a second place to decide whether a signature is trusted, and a signature
 * check that two places implement differently is one that will differ.
 *
 * The Storage primitives (`signPutUrl`, `deleteObject`, `moveStagedToFinal`, …)
 * bypass Storage Security Rules. A route that could call `deleteObject` directly
 * is a route that can delete an arbitrary path. They are exported from
 * `evidence-storage.ts` only so `finalize-upload.ts` and the incident pipeline
 * can compose them, and `attachEvidenceToIncident` is what wraps the move.
 *
 * docs/32 MUST 14 applies to the sweeper too: it has no route in this phase, so
 * it is a documented integration point rather than a scheduled job that silently
 * does nothing.
 */

export {
  signUpload,
  generateMediaId,
  claimFor,
  releaseClaim,
  resetClaimsForTests,
  type Claim,
} from './sign-upload';

export { finalizeUpload } from './finalize-upload';

export {
  attachEvidenceToIncident,
  resolveEvidenceRead,
  stageImageForAi,
  stageAudioForAi,
  sweepAbandonedStaging,
  SWEEP_NOT_IMPLEMENTED,
  type EvidenceAttachment,
  type ResolvedEvidenceRead,
  type StagedAiMedia,
  type SweepReport,
} from './evidence-attach';

export {
  ALLOWED_MEDIA,
  ALLOWED_MEDIA_TYPES,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  MEDIA_LIMITS,
  MEDIA_ID_RE,
  STAGING_PATH_RE,
  FINAL_PATH_RE,
  QUARANTINE_PATH_RE,
  validateMediaPath,
  stagingPathFor,
  finalPathFor,
  quarantinePathFor,
  mediaIdOk,
  type AllowedMediaType,
  type MediaKind,
  type ParsedMediaPath,
} from '@/validators/upload';

/**
 * ============================================================================
 * CareGrid AI — the service layer
 * ============================================================================
 *
 * The one public entry point into `services/**`, imported ONLY by route handlers
 * in `app/api/**`. docs/20 §1 P4 and doc 06 §5.1.
 *
 * ---------------------------------------------------------------------------
 * WHY A BARREL EXISTS HERE AND ONLY HERE
 * ---------------------------------------------------------------------------
 * A barrel is a boundary, not a shortcut (docs/20 §1 P10). This one draws the
 * line between "a route handler" and "the business logic", and it is what makes
 * the layering rule mechanical:
 *
 *   - A route handler imports from `@/services`. It therefore cannot
 *     accidentally import `lib/server/firebase-admin` — it would have to go
 *     through a service, and the service is where the Firestore access is.
 *   - Nothing under `lib/` imports from `@/services`, because a barrel that only
 *     route handlers import cannot be reached from below.
 *   - `components/**` and `features/**` are banned from importing it entirely by
 *     the ESLint `no-restricted-imports` rule, so the Admin SDK can never reach
 *     a browser bundle (NFR-013).
 *
 * If a service is not exported here, no route can call it, and a reviewer can
 * read this one file to know the entire API surface's business logic.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT IN THIS PHASE
 * ---------------------------------------------------------------------------
 * | Exported                              | Phase | Why it is real now        |
 * |---------------------------------------|-------|--------------------------|
 * | `bootstrapUser`, `getMe`, `updateMe`, `recordAuthEvent` | 2/3 | The four existing routes now delegate to them |
 * | `systemHealth`                        | 3     | Real configuration introspection |
 * | `triageIncident`, `toTriageRequest`   | 3     | The `TriageProvider` seam docs/30 §6.3 mandates |
 *
 * Incidents, dispatch, responders, notifications, duplicates, uploads, and
 * analytics are deliberately absent: they have no route, and a service with no
 * route is unreachable code (docs/32 MUST 14: a third caller makes a shared
 * abstraction; zero callers makes dead code).
 */

export {
  bootstrapUser,
  getMe,
  recordAuthEvent,
  updateMe,
  type AccountDto,
  type BootstrapResult,
  type RecordAuthEventInput,
  type UpdateMeInput,
  type UpdateMeResult,
} from '@/services/auth/account';

export { systemHealth, type SystemHealth } from '@/services/admin/system-health';

export {
  TRIAGE_LIMITS,
  toTriageRequest,
  triageIncident,
  type TriageOutcome,
} from '@/services/ai';

/**
 * Phase 7 — dispatch. Re-exported as a namespace so the four services stay
 * separable in the filesystem while a route reads as
 * `dispatch.assignResponder(...)` and the collision risk between
 * `services/dispatch` and this barrel is unambiguous to a reader.
 */
export * as dispatch from '@/services/dispatch';

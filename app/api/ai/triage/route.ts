/**
 * POST /api/ai/triage
 *
 * The Phase 3 ARCHITECTURE PROBE for the Gemini integration. It proves the whole
 * pipeline works end to end without implementing a model call.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 * ```
 * POST /api/ai/triage
 *      ↓  withRequest:  rate limit → authenticate → validate
 *      ↓  requireCapability: the role, from the 61-row matrix
 *      ↓  services/ai/triage.ts:  the TriageProvider seam
 *      ↓  services/integrations/gemini:  no key → no client
 *      ↓  502 AI_UNAVAILABLE, with copy that says the report is still fine
 * ```
 *
 * That last line is the FR-029 guarantee, demonstrated rather than asserted. A
 * missing Gemini key is a NORMAL state in this deployment and the answer is a
 * typed, non-fatal, honest one — not a crash, not a 500, and above all not a
 * fabricated category and urgency.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT FAKE FUNCTIONALITY
 * ---------------------------------------------------------------------------
 * It returns no invented data. There is no `if (DEV) return { urgency: 'high' }`
 * branch anywhere in the path (docs/32 MUST 7). A caller with a valid body
 * genuinely reaches the provider boundary and genuinely gets told the provider
 * is not configured. When Phase 4 adds the client, this same request returns a
 * real assessment.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE IS A CAPABILITY AND NOT A ROLE
 * ---------------------------------------------------------------------------
 * `r13_readAiTriagePanel` — matrix row 13. Dispatcher and admin have it in full;
 * a responder has it READ-ONLY, meaning they may see an assessment but this
 * endpoint is not the place they obtain one; a citizen is denied outright
 * (docs/22 §3).
 *
 * Two gates run, in the documented order (docs/10 §6.3):
 *   1. `requireUser` — already done by the wrapper.
 *   2. `requireCapability` — the role, from the matrix.
 *
 * The SCOPE of a `scoped` capability is not evaluated here, because this endpoint
 * has no `:id` and therefore no resource to be opaque about. That is the only
 * case where the resource gate is skipped, and it is stated here rather than left
 * implicit.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CALLER CANNOT DO
 * ---------------------------------------------------------------------------
 * The body is `.strict()` and contains no `role`, `uid`, `model`,
 * `promptVersion`, or coordinate field. A client cannot choose the model, choose
 * the prompt version, choose its own urgency, or send a precise location to a
 * third party (docs/09 §1.2, docs/24 T-09).
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { aiTriageProbeBodySchema, aiTriageProbeResponseSchema } from '@/validators/ai';
import { toTriageRequest, triageIncident } from '@/services';
import { getTriageProvider } from '@/services/integrations/gemini';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: aiTriageProbeBodySchema,
    auth: 'required',
    // docs/08 §1.9 gives `POST /api/incidents/:id/triage` 20/hour. The same budget
    // applies here: this endpoint reaches the same provider, and a probe that
    // costs a model call must not be cheaper to spam than the real thing.
    rateLimit: 'ai.triage',
  },
  async (ctx) => {
    const { body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Gate: matrix row 13. Throws 403 for a citizen.
    requireCapability(user, 'r13_readAiTriagePanel', { requestId: ctx.requestId });

    // The sanitisation boundary is applied HERE, at the call site, rather than
    // inside the provider. A provider that received a raw body would be one
    // refactor away from receiving a Firestore document (docs/09 §4).
    const request = toTriageRequest({
      text: body.text,
      language: body.language,
      locationHint: body.locationHint ?? null,
      // The probe body carries no coordinates, so the accuracy is `unknown` and
      // the model is told so. MUST NOT 7: a location is never described without
      // its grade.
      locationAccuracy: 'unknown',
      imageCount: body.imageCount,
      audioCount: body.audioCount,
      // Derived from the account, never from the body: a client that could
      // declare itself "new" would defeat the S9 advisory signal (FR-135).
      newAccount: user.authTimeSec > 0 && Date.now() / 1000 - user.authTimeSec < 300,
    });

    const outcome = await triageIncident(request, { requestId: ctx.requestId, timeoutMs: 0 });

    return {
      data: aiTriageProbeResponseSchema.parse({
        triage: {
          source: outcome.source,
          category: outcome.category,
          urgency: outcome.urgency,
          summary: outcome.summary,
          safetyFlags: [...outcome.safetyFlags],
          confidence: outcome.confidence,
          rationale: outcome.rationale,
          needsReview: outcome.needsReview,
          providerName: outcome.providerName,
          model: outcome.model,
          promptVersion: outcome.promptVersion,
        },
        providerAvailable: getTriageProvider().isAvailable(),
      }),
    };
  },
);

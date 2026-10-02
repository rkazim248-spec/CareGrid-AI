/**
 * POST /api/ai/triage
 *
 * Triage a draft the caller is about to submit, BEFORE they submit it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * ```
 * POST /api/ai/triage
 *      ↓  withRequest:  rate limit → authenticate → validate
 *      ↓  requireCapability: r01_createIncident — the caller's own draft
 *      ↓  services/ai/triage.ts:  the TriageProvider seam
 *      ↓  services/integrations/gemini:  no key → the deterministic fallback
 *      ↓  200 with `source: 'fallback'`, or 502 AI_UNAVAILABLE with copy that
 *         says the report is still fine
 * ```
 *
 * This is the PREVIEW half of the feature. The authoritative triage happens
 * server-side inside `POST /api/incidents` (`services/incidents/create.ts`), so
 * a citizen who never presses "Analyze" still gets a real, AI-derived category,
 * urgency, summary and confidence. Nothing here is required for a report to be
 * submitted or stored, and the two calls are independent on purpose — a preview
 * must never be able to change what gets persisted.
 *
 * ---------------------------------------------------------------------------
 * A MISSING GEMINI KEY IS A NORMAL STATE, NOT A CRASH
 * ---------------------------------------------------------------------------
 * That is the FR-029 guarantee, implemented rather than asserted. With
 * `GEMINI_API_KEY` unset, `getTriageProvider().isAvailable()` is `false` and the
 * request is answered by the deterministic keyword engine with
 * `source: 'fallback'` and `providerAvailable: false` — so the client can tell
 * the citizen that the assistant is offline and that their report is unaffected.
 *
 * It never fabricates a category and presents it as the model's opinion: the
 * response carries `source`, `providerName` and `outcome` on every path, so a
 * deterministic classification is always distinguishable from a model's.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT FAKE FUNCTIONALITY
 * ---------------------------------------------------------------------------
 * There is no `if (DEV) return { urgency: 'high' }` branch anywhere in the path
 * (docs/32 MUST 7). A caller with a valid body genuinely reaches the provider
 * boundary and genuinely gets told when the provider is not configured.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE IS `r01_createIncident` AND NOT `r13_readAiTriagePanel`
 * ---------------------------------------------------------------------------
 * This used to gate on `r13_readAiTriagePanel` (matrix row 13), which 403'd
 * every citizen and every responder — the two roles that actually reach this
 * screen. That was a real bug with a specific root cause: the endpoint was
 * ORIGINALLY an architecture probe, and when Phase 4 gave it a real model call
 * nobody revisited the gate.
 *
 * `r13` means "read the AI triage panel ON AN INCIDENT" — it is the
 * dispatcher-view capability, and it is `readonly` for a responder precisely
 * because a responder SEES assessments rather than OBTAINING one. This endpoint
 * reads no incident at all. It takes the caller's own free text (and their own
 * images) and returns a classification of it, so nothing belonging to another
 * user is reachable through it.
 *
 * `r01_createIncident` is the honest description of the action: "triage the
 * report I am about to submit as my own". It is `full` for all four roles, so
 * a citizen can analyse their own draft, and it grants no access to anyone
 * else's incident — that is gated separately by `assertResourceAccess` on the
 * incident routes, exactly as before.
 *
 * The two gates that DO still apply, in the documented order (docs/10 §6.3):
 *   1. `requireUser` — already done by the wrapper.
 *   2. `requireCapability` — the role, from the matrix.
 *
 * The model-call cost is bounded by the `ai.triage` rate limit below, not by the
 * role: a citizen who spams this spends their own quota and nobody else's.
 *
 * `r13` is deliberately left exactly where it was. It still gates reading triage
 * on the incident detail surface, which is the thing it was written for.
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
import { aiTriageProbeBodySchema, aiTriageProbeResponseSchema, type TriagedImage } from '@/validators/ai';
import { toTriageRequest, triageIncident } from '@/services';
import { getTriageProvider } from '@/services/integrations/gemini';
import { validateImage } from '@/services/ai/media';

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

    // Gate: matrix row 1 — see the module header for why this is NOT row 13.
    // A 403 here would mean the citizen cannot analyse their own draft.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    // -------------------------------------------------------------------------
    // PHASE 4: THE IMAGES ARE VALIDATED BEFORE ANYTHING ELSE
    // -------------------------------------------------------------------------
    // Signature first, always. The declared MIME type and the filename are
    // CLAIMS from the client; the byte signature is a FACT. Validating them in
    // this order means a 40 MB ZIP named `.jpg` is rejected as the wrong FORMAT
    // rather than as too large — so the error names the problem the user can
    // actually fix, and nothing reaches the provider that is not a real image.
    //
    // This is the ONLY place uploaded bytes are turned into something the AI can
    // see, and it happens BEFORE the sanitisation boundary and before the rate
    // limit is charged for a model call. brief §11, docs/15.
    const images: TriagedImage[] = [];
    for (const supplied of body.images) {
      const validated = validateImage({
        data: supplied.data,
        declaredMimeType: supplied.mimeType ?? null,
        fileName: supplied.fileName ?? null,
      });
      images.push(validated);
    }

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
      // The COUNT is what the client claimed; the BYTES are what was actually
      // validated. Sending the claimed count alongside real images would let a
      // client say "3 images" while one was rejected — and the prompt would then
      // tell the model three images are attached when it can see none.
      imageCount: images.length,
      audioCount: body.audioCount,
      // Derived from the account, never from the body: a client that could
      // declare itself "new" would defeat the S9 advisory signal (FR-135).
      newAccount: user.authTimeSec > 0 && Date.now() / 1000 - user.authTimeSec < 300,
      images,
    });

    const outcome = await triageIncident(request, {
      requestId: ctx.requestId,
      timeoutMs: 0,
      audit: {
        incidentId: null,
        uid: user.uid,
        requestId: ctx.requestId,
        language: body.language,
        // `null`, never the free-text `locationHint`. docs/09 §4.1 requires a
        // reverse-geocoded DISTRICT label, and no geocoder is wired up in this
        // phase — a reporter's own words are not a district.
        coarseArea: null,
        hasCoordinates: false,
      },
    });

    const provider = getTriageProvider();

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
          outcome: outcome.outcome,
          attempt: outcome.attempt,
          lowConfidence: outcome.confidence === null || outcome.needsReview,
        },
        providerAvailable: provider.isAvailable(),
        simulated: outcome.providerName === 'gemini-mock',
        mediaCount: outcome.mediaCount,
        mediaDropped: [...outcome.mediaDropped],
        aiRunId: outcome.aiRunId,
      }),
    };
  },
);

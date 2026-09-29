/**
 * POST /api/uploads/sign
 *
 * docs/15 §8.1 step 2. Issues a signed PUT URL for one evidence item.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENDPOINT CANNOT DO
 * ---------------------------------------------------------------------------
 * It cannot be told where to put a file, what to call it, or who owns it:
 *
 *   - the body is `.strict()`, so an extra field is a 400 rather than a silently
 *     ignored one (brief §31, docs/17)
 *   - the body has no `storagePath`, no `fileName` used as a path, and no `uid`.
 *     `token.uid` is the only source of the path's owner segment (docs/15 §3.1)
 *   - it issues a URL, never a final path. The client holds a staging path it
 *     did not choose, and has no permission on `incidents/**` at all
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE IS `r01_createIncident` AND NOT A NEW CAPABILITY
 * ---------------------------------------------------------------------------
 * The 61-row matrix in docs/22 is authoritative and is not extended here. Evidence
 * upload is not a separable privilege: it exists to serve incident creation, and
 * the only roles with `r01_createIncident` are the ones permitted to produce a
 * report. Adding `r62_uploadEvidence` would create a capability that can be
 * granted without `r01_createIncident` — a user who may fill the bucket but never
 * file a report — which is not a distinction the product has any use for.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { isStorageConfigured } from '@/services/uploads/evidence-storage';
import {
  signUploadBodySchema,
  signUploadResponseSchema,
} from '@/validators/upload';
import { signUpload } from '@/services/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: signUploadBodySchema,
    auth: 'required',
    rateLimit: 'uploads.sign',
  },
  async (ctx) => {
    const { body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Gate: matrix row 1. Dispatcher and admin have it; a responder and a citizen
    // differ only in whether the surrounding report flow exists.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    // Storage is checked BEFORE the body is acted on, and the check touches the
    // bucket rather than reading an env var. `getStorage()` succeeds with dummy
    // credentials and fails on the first real call, so a boolean derived from
    // construction would be `true` in a deployment that cannot store anything —
    // and the citizen would then upload bytes to a URL that can never work.
    if (!isStorageConfigured()) {
      throw new AppError({
        code: 'STORAGE_UNAVAILABLE',
        message:
          'Photos and voice notes cannot be uploaded right now. You can still type your report and submit it.',
      });
    }

    // `user.uid` is from the VERIFIED token, so it cannot be a body field. This is
    // the single line that makes `staging/{uid}/` trustworthy.
    const signed = await signUpload(user.uid, body);

    return { data: signUploadResponseSchema.parse(signed) };
  },
);

/**
 * POST /api/uploads/finalize
 *
 * docs/15 §8.1 step 4. "I have uploaded a file; tell me what it actually is."
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODY IS A `mediaId` AND NEVER A PATH
 * ---------------------------------------------------------------------------
 * This is the whole reason the 30-minute claim window exists.
 *
 * If finalize accepted a `storagePath`, a client could name ANY path and the
 * server would range-read it — including `staging/<someone-else-uid>/med_…`, which
 * would turn this endpoint into a read primitive over other users' uploads. So
 * the body carries only the `mediaId`, and `finalizeUpload` looks the path up from
 * the claim record this server minted, keyed by `(uid, mediaId)`.
 *
 * An unrecognised `mediaId` therefore gets `404 MEDIA_NOT_FOUND` with a message
 * that does not say whether the object exists. `422` would be a "wrong state"
 * answer that implies we know about the object; `403` would be a permission
 * answer that implies the caller is not us. Neither is true, and either would be
 * a small oracle.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RESPONSE IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It reports the SNIFFED type, never the declared one. docs/15 §5.3. A client
 * that sent `contentType: 'image/jpeg'` and uploaded HTML gets
 * `verifiedContentType` absent and a `415`, because the response never carries a
 * type the server did not read from the bytes.
 *
 * It is NOT the last word. docs/15 §8.1 step 5 re-sniffs at incident creation,
 * because the object can change between here and there. This step exists to give
 * the citizen fast feedback, not to certify the bytes.
 */

import { withRequest } from '@/lib/server/route';
import { requireCapability } from '@/lib/server/permissions';
import { AppError } from '@/lib/server/errors';
import { isStorageConfigured } from '@/services/uploads/evidence-storage';
import {
  finalizeUploadBodySchema,
  finalizeUploadResponseSchema,
} from '@/validators/upload';
import { finalizeUpload } from '@/services/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRequest(
  {
    body: finalizeUploadBodySchema,
    auth: 'required',
    rateLimit: 'uploads.finalize',
  },
  async (ctx) => {
    const { body, user } = ctx;
    if (!user) throw new AppError({ code: 'AUTH_REQUIRED' });

    // Matrix row 1, as in `sign`. Evidence is not a separable privilege.
    requireCapability(user, 'r01_createIncident', { requestId: ctx.requestId });

    if (!isStorageConfigured()) {
      throw new AppError({
        code: 'STORAGE_UNAVAILABLE',
        message:
          'We could not check your file just now. Your report text is safe — please try the upload again.',
      });
    }

    const verified = await finalizeUpload(user.uid, body.mediaId);

    return { data: finalizeUploadResponseSchema.parse(verified) };
  },
);
